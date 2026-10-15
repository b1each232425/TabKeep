import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from schemas.knowledge import KnowledgeAskRequest, KnowledgeCitation, KnowledgeMessage, KnowledgeSearchResponse
from services.knowledge import qa


def make_search_result(question: str, *, top_score: float | None = 0.8) -> KnowledgeSearchResponse:
    citations = [
        KnowledgeCitation(
            documentId=f"doc-{index}",
            chunkId=f"doc-{index}:chunk-0",
            title=f"测试笔记 {index}",
            sourceType="markdown",
            path=f"notes/{index}.md",
            content=f"这是用于测试 TopK 自适应的检索证据段落 {index}。",
            rerankScore=top_score if index == 0 else 0.7,
        )
        for index in range(10)
    ]
    return KnowledgeSearchResponse(
        ok=True,
        query=question,
        sourceMode="hybrid",
        items=citations,
    )


def source_count(messages: list[dict[str, str]]) -> int:
    return messages[1]["content"].count("[来源 ")


class KnowledgeAskAdaptiveTopKTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.model_config = SimpleNamespace(model="test-model", baseURL="https://example.test/v1", apiKey="test-key")
        self.common_patches = [
            patch.object(qa.storage, "get_model_config", return_value=self.model_config),
            patch.object(qa.db, "ensure_session", return_value="test-session"),
            patch.object(qa.db, "add_message"),
        ]
        for item in self.common_patches:
            item.start()

    def tearDown(self) -> None:
        for item in reversed(self.common_patches):
            item.stop()

    async def test_default_ask_uses_five_contexts_after_retrieving_ten(self) -> None:
        question = "InnoDB 的普通问题是什么？"
        result = make_search_result(question)
        with (
            patch.object(qa, "search_knowledge", new=AsyncMock(return_value=result)) as search,
            patch.object(qa, "chat_completion", new=AsyncMock(return_value="基于来源的回答。")) as completion,
        ):
            response = await qa.ask_knowledge(KnowledgeAskRequest(question=question))

        self.assertEqual(KnowledgeAskRequest(question=question).limit, 5)
        search.assert_awaited_once_with(question, 10)
        self.assertEqual(completion.await_count, 1)
        self.assertEqual(source_count(completion.await_args.args[1]), 5)
        self.assertEqual(len(response.citations), 5)

    async def test_multi_evidence_query_expands_before_answer_generation(self) -> None:
        question = "比较聚簇索引和二级索引的区别"
        result = make_search_result(question)
        with (
            patch.object(qa, "search_knowledge", new=AsyncMock(return_value=result)),
            patch.object(qa, "chat_completion", new=AsyncMock(return_value="对比回答。")) as completion,
        ):
            response = await qa.ask_knowledge(KnowledgeAskRequest(question=question))

        self.assertEqual(completion.await_count, 1)
        self.assertEqual(source_count(completion.await_args.args[1]), 10)
        self.assertEqual(len(response.citations), 10)

    async def test_low_rerank_leader_expands_before_answer_generation(self) -> None:
        question = "某个检索信号偏弱的问题"
        result = make_search_result(question, top_score=0.29)
        with (
            patch.object(qa, "search_knowledge", new=AsyncMock(return_value=result)),
            patch.object(qa, "chat_completion", new=AsyncMock(return_value="回答。")) as completion,
        ):
            response = await qa.ask_knowledge(KnowledgeAskRequest(question=question))

        self.assertEqual(completion.await_count, 1)
        self.assertEqual(source_count(completion.await_args.args[1]), 10)
        self.assertEqual(len(response.citations), 10)

    async def test_insufficient_k5_answer_retries_once_with_ten_and_returns_matching_citations(self) -> None:
        question = "一个普通问题"
        result = make_search_result(question)
        with (
            patch.object(qa, "search_knowledge", new=AsyncMock(return_value=result)),
            patch.object(
                qa,
                "chat_completion",
                new=AsyncMock(side_effect=["现有资料不足，无法根据这些来源回答。", "补充上下文后的回答。"]),
            ) as completion,
        ):
            response = await qa.ask_knowledge(KnowledgeAskRequest(question=question))

        self.assertEqual(completion.await_count, 2)
        self.assertEqual(source_count(completion.await_args_list[0].args[1]), 5)
        self.assertEqual(source_count(completion.await_args_list[1].args[1]), 10)
        self.assertEqual(response.answer, "补充上下文后的回答。")
        self.assertEqual(len(response.citations), 10)

    async def test_failed_expansion_keeps_the_k5_answer_and_citations(self) -> None:
        question = "一个普通问题"
        result = make_search_result(question)
        with (
            patch.object(qa, "search_knowledge", new=AsyncMock(return_value=result)),
            patch.object(
                qa,
                "chat_completion",
                new=AsyncMock(side_effect=["资料不足，无法回答。", RuntimeError("temporary failure")]),
            ) as completion,
        ):
            response = await qa.ask_knowledge(KnowledgeAskRequest(question=question))

        self.assertEqual(completion.await_count, 2)
        self.assertEqual(response.answer, "资料不足，无法回答。")
        self.assertEqual(len(response.citations), 5)


class FollowUpQueryContextTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.model_config = SimpleNamespace(model="test-model", baseURL="https://example.test/v1", apiKey="test-key")
        self.common_patches = [
            patch.object(qa.storage, "get_model_config", return_value=self.model_config),
            patch.object(qa.db, "ensure_session", return_value="test-session"),
            patch.object(qa.db, "add_message"),
        ]
        for item in self.common_patches:
            item.start()

    def tearDown(self) -> None:
        for item in reversed(self.common_patches):
            item.stop()

    async def test_cue_and_history_enable_contextual_query_only_for_followups(self) -> None:
        question = "它的索引失效原因呢？"
        history = [
            KnowledgeMessage(
                id="user-1",
                sessionId="session-1",
                role="user",
                content="MySQL 的 LIKE 前缀匹配什么时候不能用索引？",
                createdAt="2026-10-12T10:00:00",
            ),
            KnowledgeMessage(
                id="assistant-1",
                sessionId="session-1",
                role="assistant",
                content="LIKE 模式以通配符开头时通常不能使用普通索引。",
                createdAt="2026-10-12T10:00:01",
            ),
        ]
        result = make_search_result(question)
        search_kwargs: dict[str, object] = {}

        async def fake_search(_query: str, _limit: int, **kwargs: object) -> KnowledgeSearchResponse:
            search_kwargs.update(kwargs)
            rewriter = kwargs.get("query_rewriter")
            if rewriter:
                await rewriter()  # type: ignore[operator]
            return result

        with (
            patch.object(qa, "FOLLOW_UP_QUERY_CONTEXT_ENABLED", True),
            patch.object(qa.db, "list_recent_messages", return_value=history) as list_history,
            patch.object(
                qa,
                "rewrite_query_for_retrieval",
                new=AsyncMock(return_value="MySQL LIKE 前缀匹配的索引失效原因"),
            ) as rewrite,
            patch.object(qa, "search_knowledge", new=AsyncMock(side_effect=fake_search)) as search,
            patch.object(qa, "chat_completion", new=AsyncMock(return_value="基于来源的回答。")),
        ):
            response = await qa.ask_knowledge(KnowledgeAskRequest(question=question, sessionId="session-1"))

        self.assertTrue(response.ok)
        list_history.assert_called_once_with("session-1", 6)
        search.assert_awaited_once()
        self.assertEqual(search.await_args.args, (question, 10))
        self.assertTrue(search_kwargs["use_rewritten_query_for_rerank"])
        rewrite.assert_awaited_once()
        self.assertEqual(rewrite.await_args.args, (question, self.model_config))
        self.assertIn("MySQL 的 LIKE 前缀匹配", rewrite.await_args.kwargs["conversation_history"])
        self.assertIn("LIKE 模式以通配符开头", rewrite.await_args.kwargs["conversation_history"])

    async def test_contextualization_does_not_read_history_when_feature_is_disabled(self) -> None:
        question = "它的索引失效原因呢？"
        result = make_search_result(question)
        self.assertFalse(qa.FOLLOW_UP_QUERY_CONTEXT_ENABLED)
        with (
            patch.object(qa.db, "list_recent_messages") as list_history,
            patch.object(qa, "rewrite_query_for_retrieval", new=AsyncMock()) as rewrite,
            patch.object(qa, "search_knowledge", new=AsyncMock(return_value=result)) as search,
            patch.object(qa, "chat_completion", new=AsyncMock(return_value="基于来源的回答。")) as completion,
        ):
            response = await qa.ask_knowledge(KnowledgeAskRequest(question=question, sessionId="session-1"))

        self.assertTrue(response.ok)
        list_history.assert_not_called()
        rewrite.assert_not_awaited()
        search.assert_awaited_once_with(question, 10)
        completion.assert_awaited_once()

    async def test_self_contained_query_does_not_load_history_when_feature_is_enabled(self) -> None:
        question = "MySQL 8.0 的索引下推原理是什么？"
        result = make_search_result(question)
        with (
            patch.object(qa, "FOLLOW_UP_QUERY_CONTEXT_ENABLED", True),
            patch.object(qa.db, "list_recent_messages") as list_history,
            patch.object(qa, "rewrite_query_for_retrieval", new=AsyncMock()) as rewrite,
            patch.object(qa, "search_knowledge", new=AsyncMock(return_value=result)) as search,
            patch.object(qa, "chat_completion", new=AsyncMock(return_value="基于来源的回答。")) as completion,
        ):
            response = await qa.ask_knowledge(KnowledgeAskRequest(question=question, sessionId="session-1"))

        self.assertTrue(response.ok)
        list_history.assert_not_called()
        rewrite.assert_not_awaited()
        search.assert_awaited_once_with(question, 10)
        completion.assert_awaited_once()

    async def test_followup_without_session_does_not_load_history(self) -> None:
        question = "它呢？"
        result = make_search_result(question)
        with (
            patch.object(qa, "FOLLOW_UP_QUERY_CONTEXT_ENABLED", True),
            patch.object(qa.db, "list_recent_messages") as list_history,
            patch.object(qa, "rewrite_query_for_retrieval", new=AsyncMock()) as rewrite,
            patch.object(qa, "search_knowledge", new=AsyncMock(return_value=result)) as search,
            patch.object(qa, "chat_completion", new=AsyncMock(return_value="基于来源的回答。")),
        ):
            response = await qa.ask_knowledge(KnowledgeAskRequest(question=question))

        self.assertTrue(response.ok)
        list_history.assert_not_called()
        rewrite.assert_not_awaited()
        search.assert_awaited_once_with(question, 10)

    async def test_followup_with_empty_history_uses_original_query(self) -> None:
        question = "它呢？"
        result = make_search_result(question)
        with (
            patch.object(qa, "FOLLOW_UP_QUERY_CONTEXT_ENABLED", True),
            patch.object(qa.db, "list_recent_messages", return_value=[]) as list_history,
            patch.object(qa, "rewrite_query_for_retrieval", new=AsyncMock()) as rewrite,
            patch.object(qa, "search_knowledge", new=AsyncMock(return_value=result)) as search,
            patch.object(qa, "chat_completion", new=AsyncMock(return_value="基于来源的回答。")),
        ):
            response = await qa.ask_knowledge(KnowledgeAskRequest(question=question, sessionId="session-1"))

        self.assertTrue(response.ok)
        list_history.assert_called_once_with("session-1", 6)
        rewrite.assert_not_awaited()
        search.assert_awaited_once_with(question, 10)

    async def test_explicit_followup_rewriter_remains_available_while_general_rewrite_is_disabled(self) -> None:
        rewriter = AsyncMock(return_value="完整查询")
        result = make_search_result("它呢？")
        with patch.object(qa, "retrieve_knowledge", new=AsyncMock(return_value=result)) as retrieve:
            await qa.search_knowledge(
                "它呢？",
                8,
                query_rewriter=rewriter,
                use_rewritten_query_for_rerank=True,
            )

        retrieve.assert_awaited_once_with(
            "它呢？",
            8,
            query_rewriter=rewriter,
            use_rewritten_query_for_rerank=True,
        )

