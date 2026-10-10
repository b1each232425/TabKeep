import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from schemas.knowledge import KnowledgeAskRequest, KnowledgeCitation, KnowledgeSearchResponse
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

