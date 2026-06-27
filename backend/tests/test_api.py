import sys
import unittest
import warnings
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

warnings.filterwarnings("ignore", message="Using `httpx` with `starlette.testclient` is deprecated")

from fastapi.testclient import TestClient

from main import app
from schemas.knowledge import (
    DEFAULT_EMBEDDING_BASE_URL,
    DEFAULT_EMBEDDING_MODEL,
    KnowledgeCitation,
    KnowledgeEvalCase,
)
from services.knowledge import db, vector_store
from services.knowledge.evaluation import (
    is_refusal_answer,
    is_relevant,
    match_answer_keywords,
    matched_expectations,
)
from services.knowledge.rerank import RerankResult
from tests.helpers import IsolatedBackendState


class ApiTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.workspace = IsolatedBackendState(f"api-test-{self._testMethodName}")
        self.tmp_dir = self.workspace.setup()
        self.client = TestClient(app)
        self.token = "test-token"
        self.headers = {"X-TabKeep-Token": self.token}

    def tearDown(self) -> None:
        self.workspace.teardown()

    def initialize_config(self, extra: dict | None = None) -> None:
        body = {
            "apiToken": self.token,
            "modelConfig": {
                "model": "test-model",
                "baseURL": "http://example.test/v1",
                "apiKey": "test-key",
            },
            "tabCategories": [{"id": "dev", "name": "开发", "description": "技术开发"}],
            "noteAdapter": {"provider": "local"},
        }
        if extra:
            body.update(extra)
        response = self.client.post("/config/sync", json=body)
        self.assertEqual(response.status_code, 200, response.text)

    def test_config_sync_initializes_token_and_protects_routes(self) -> None:
        response = self.client.get("/config")
        self.assertEqual(response.status_code, 401)

        self.initialize_config()

        bad = self.client.get("/config", headers={"X-TabKeep-Token": "wrong"})
        self.assertEqual(bad.status_code, 401)

        ok = self.client.get("/config", headers=self.headers)
        self.assertEqual(ok.status_code, 200)
        data = ok.json()
        self.assertEqual(data["modelConfig"]["model"], "test-model")
        self.assertEqual(data["tabCategories"][0]["name"], "开发")

    def test_knowledge_config_defaults_to_siliconflow_embedding_provider(self) -> None:
        self.initialize_config()

        saved = self.client.post(
            "/knowledge/config",
            json={
                "enabled": True,
                "markdownPaths": [],
                "maxFileBytes": 1_000_000,
                "embedding": {
                    "enabled": True,
                    "baseURL": "",
                    "apiKey": "sf-test-key",
                    "model": "",
                },
            },
            headers=self.headers,
        )

        self.assertEqual(saved.status_code, 200, saved.text)
        embedding = saved.json()["embedding"]
        self.assertTrue(embedding["enabled"])
        self.assertEqual(embedding["baseURL"], DEFAULT_EMBEDDING_BASE_URL)
        self.assertEqual(embedding["model"], DEFAULT_EMBEDDING_MODEL)
        self.assertEqual(embedding["apiKey"], "sf-test-key")

        loaded = self.client.get("/knowledge/config", headers=self.headers)
        self.assertEqual(loaded.status_code, 200, loaded.text)
        self.assertEqual(loaded.json()["embedding"]["baseURL"], DEFAULT_EMBEDDING_BASE_URL)
        self.assertEqual(loaded.json()["embedding"]["model"], DEFAULT_EMBEDDING_MODEL)

    def test_auth_can_be_disabled_for_local_development(self) -> None:
        with patch.dict("os.environ", {"TABKEEP_DISABLE_AUTH": "1"}):
            config = self.client.get("/config")
            self.assertEqual(config.status_code, 200, config.text)

            self.initialize_config()
            resync = self.client.post(
                "/config/sync",
                json={
                    "apiToken": "fresh-dev-token",
                    "modelConfig": {
                        "model": "dev-model",
                        "baseURL": "http://example.test/v1",
                        "apiKey": "dev-key",
                    },
                },
                headers={"X-TabKeep-Token": "stale-token"},
            )
            self.assertEqual(resync.status_code, 200, resync.text)

            tabs = [
                {
                    "id": 1,
                    "title": "No Auth",
                    "url": "https://example.test/no-auth",
                    "active": True,
                    "pinned": False,
                }
            ]
            saved = self.client.post("/tabs/", json=tabs)
            self.assertEqual(saved.status_code, 200, saved.text)

    def test_tabs_roundtrip_requires_auth(self) -> None:
        self.initialize_config()
        tabs = [
            {
                "id": 1,
                "title": "TabKeep",
                "url": "https://example.test",
                "active": True,
                "pinned": False,
            }
        ]

        unauthorized = self.client.post("/tabs/", json=tabs)
        self.assertEqual(unauthorized.status_code, 401)

        saved = self.client.post("/tabs/", json=tabs, headers=self.headers)
        self.assertEqual(saved.status_code, 200)
        self.assertEqual(saved.json()["received"], 1)

        loaded = self.client.get("/tabs/", headers=self.headers)
        self.assertEqual(loaded.status_code, 200)
        self.assertEqual(loaded.json()[0]["title"], "TabKeep")

    def test_notes_save_auto_indexes_into_knowledge(self) -> None:
        self.initialize_config()
        payload = {
            "title": "自动入库测试",
            "url": "https://example.test/note",
            "excerpt": "短摘要",
            "content": "这是一条会自动进入 RAG 知识库的内容。",
            "notebook_id": "inbox",
            "target_doc": None,
            "mode": "summary",
        }

        saved = self.client.post("/notes/save", json=payload, headers=self.headers)
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertTrue(saved.json()["ok"])

        search = self.client.post(
            "/knowledge/search",
            json={"query": "自动进入 RAG", "limit": 5},
            headers=self.headers,
        )
        self.assertEqual(search.status_code, 200, search.text)
        data = search.json()
        self.assertTrue(data["ok"])
        self.assertEqual(len(data["items"]), 1)
        self.assertEqual(data["items"][0]["sourceType"], "tabkeep_note")

    def test_knowledge_reindex_from_markdown_path(self) -> None:
        notes_dir = self.tmp_dir / "markdown-source"
        notes_dir.mkdir()
        (notes_dir / "rag.md").write_text(
            "---\ntags: [rag, graph]\n---\n\n# 知识库接口测试\n\n## 图谱接口\n\n接口重建索引可以搜索。相关 [[related]]。",
            encoding="utf-8",
        )
        (notes_dir / "related.md").write_text("# related\n\n图谱关联文档。", encoding="utf-8")
        self.initialize_config(
            {
                "knowledgeConfig": {
                    "enabled": True,
                    "markdownPaths": [str(notes_dir)],
                    "maxFileBytes": 1_000_000,
                    "embedding": {
                        "enabled": False,
                        "baseURL": "",
                        "apiKey": "",
                        "model": "",
                    },
                }
            }
        )

        reindex = self.client.post("/knowledge/reindex", headers=self.headers)
        self.assertEqual(reindex.status_code, 200, reindex.text)
        self.assertEqual(reindex.json()["documentsIndexed"], 2)

        documents = self.client.get(
            "/knowledge/documents",
            params={"sourceType": "markdown", "limit": 10},
            headers=self.headers,
        )
        self.assertEqual(documents.status_code, 200, documents.text)
        document_data = documents.json()
        self.assertTrue(document_data["ok"])
        self.assertEqual(document_data["total"], 2)
        self.assertEqual(
            {item["sourceType"] for item in document_data["items"]},
            {"markdown"},
        )
        self.assertTrue(all(item["contentHash"] for item in document_data["items"]))
        self.assertTrue(all(item["paragraphCount"] >= 1 for item in document_data["items"]))
        self.assertTrue(all(item["chunkCount"] >= 1 for item in document_data["items"]))

        search = self.client.post(
            "/knowledge/search",
            json={"query": "接口重建索引", "limit": 5},
            headers=self.headers,
        )
        self.assertEqual(search.status_code, 200, search.text)
        self.assertEqual(len(search.json()["items"]), 1)

        hit_test = self.client.post(
            "/knowledge/hit-test",
            json={"query": "接口重建索引", "limit": 5, "searchMode": "fts", "minScore": 0},
            headers=self.headers,
        )
        self.assertEqual(hit_test.status_code, 200, hit_test.text)
        hit_data = hit_test.json()
        self.assertTrue(hit_data["ok"])
        self.assertEqual(hit_data["searchMode"], "fts")
        self.assertEqual(hit_data["sourceMode"], "fts")
        self.assertGreaterEqual(len(hit_data["items"]), 1)
        self.assertEqual(hit_data["items"][0]["matchedBy"], ["fts"])
        self.assertIn("rrfScore", hit_data["items"][0])

        graph = self.client.get(
            "/knowledge/graph",
            params={"layer": "concepts", "query": "图谱", "limit": 100},
            headers=self.headers,
        )
        self.assertEqual(graph.status_code, 200, graph.text)
        graph_data = graph.json()
        self.assertTrue(graph_data["ok"])
        self.assertGreaterEqual(graph_data["stats"]["nodes"], 2)
        self.assertTrue(any(node["kind"] == "heading" for node in graph_data["nodes"]))

        first_rebuild = self.client.post("/knowledge/graph/rebuild", headers=self.headers)
        second_rebuild = self.client.post("/knowledge/graph/rebuild", headers=self.headers)
        self.assertEqual(first_rebuild.status_code, 200, first_rebuild.text)
        self.assertEqual(second_rebuild.status_code, 200, second_rebuild.text)
        self.assertEqual(first_rebuild.json()["nodes"], second_rebuild.json()["nodes"])
        self.assertEqual(first_rebuild.json()["edges"], second_rebuild.json()["edges"])

        topics = self.client.get(
            "/knowledge/topics",
            params={"query": "rag", "limit": 20},
            headers=self.headers,
        )
        self.assertEqual(topics.status_code, 200, topics.text)
        topics_data = topics.json()
        self.assertTrue(topics_data["ok"])
        self.assertGreaterEqual(topics_data["stats"]["topics"], 1)

        topic_id = topics_data["topics"][0]["id"]
        detail = self.client.get(f"/knowledge/topics/{topic_id}", headers=self.headers)
        self.assertEqual(detail.status_code, 200, detail.text)
        detail_data = detail.json()
        self.assertTrue(detail_data["ok"])
        self.assertGreaterEqual(len(detail_data["documents"]), 1)
        self.assertGreaterEqual(len(detail_data["evidence"]), 1)

        export = self.client.post(f"/knowledge/topics/{topic_id}/export", headers=self.headers)
        self.assertEqual(export.status_code, 200, export.text)
        export_data = export.json()
        self.assertTrue(export_data["ok"], export_data.get("error"))
        self.assertEqual(export_data["provider"], "local")

    def test_knowledge_sync_all_runs_local_and_skips_unconfigured_siyuan(self) -> None:
        notes_dir = self.tmp_dir / "markdown-source"
        notes_dir.mkdir()
        (notes_dir / "one.md").write_text("# 一键同步\n\n统一按钮会索引本地 Markdown。", encoding="utf-8")
        self.initialize_config(
            {
                "knowledgeConfig": {
                    "enabled": True,
                    "markdownPaths": [str(notes_dir)],
                    "maxFileBytes": 1_000_000,
                    "embedding": {
                        "enabled": False,
                        "baseURL": "",
                        "apiKey": "",
                        "model": "",
                    },
                },
                "noteAdapter": {"provider": "local"},
            }
        )

        response = self.client.post("/knowledge/sync/all", headers=self.headers)

        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertTrue(data["ok"], data.get("errors"))
        self.assertEqual(data["documentsIndexed"], 1)
        sources = {source["source"]: source for source in data["sources"]}
        self.assertFalse(sources["local"]["skipped"])
        self.assertTrue(sources["siyuan"]["skipped"])
        self.assertIn("未配置", sources["siyuan"]["reason"])

    def test_knowledge_sync_all_skips_sources_without_configuration(self) -> None:
        self.initialize_config(
            {
                "knowledgeConfig": {
                    "enabled": True,
                    "markdownPaths": [],
                    "maxFileBytes": 1_000_000,
                    "embedding": {
                        "enabled": False,
                        "baseURL": "",
                        "apiKey": "",
                        "model": "",
                    },
                },
                "noteAdapter": {"provider": "local"},
            }
        )

        response = self.client.post("/knowledge/sync/all", headers=self.headers)

        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertTrue(data["ok"], data.get("errors"))
        self.assertEqual(data["documentsIndexed"], 0)
        sources = {source["source"]: source for source in data["sources"]}
        self.assertTrue(sources["local"]["skipped"])
        self.assertTrue(sources["siyuan"]["skipped"])

    def test_knowledge_eval_cases_run_retrieval_metrics(self) -> None:
        self.initialize_config()
        db.upsert_document(
            source_type="markdown",
            title="RAG 评估记录",
            content="# RAG 评估记录\n\nAlphaEvalTarget 是用于验证检索评估台的命中词。",
            path="rag-eval.md",
        )

        created = self.client.post(
            "/knowledge/eval/cases",
            json={
                "question": "AlphaEvalTarget",
                "expectedText": "AlphaEvalTarget",
                "expectedPath": "rag-eval.md",
                "note": "测试评估台",
            },
            headers=self.headers,
        )
        self.assertEqual(created.status_code, 200, created.text)
        case = created.json()
        self.assertEqual(case["question"], "AlphaEvalTarget")

        listed = self.client.get("/knowledge/eval/cases", headers=self.headers)
        self.assertEqual(listed.status_code, 200, listed.text)
        self.assertEqual(len(listed.json()), 1)

        result = self.client.post(
            "/knowledge/eval/run",
            json={"caseIds": [case["id"]], "limit": 5, "searchMode": "fts"},
            headers=self.headers,
        )

        self.assertEqual(result.status_code, 200, result.text)
        data = result.json()
        self.assertTrue(data["ok"])
        self.assertEqual(data["total"], 1)
        self.assertEqual(data["hitCount"], 1)
        self.assertEqual(data["recallAtK"], 1)
        self.assertGreater(data["mrr"], 0)
        self.assertEqual(data["top1Accuracy"], 1)
        self.assertEqual(data["rankDistribution"], [{"rank": 1, "count": 1}])
        self.assertEqual(data["results"][0]["rank"], 1)
        self.assertTrue(data["results"][0]["hits"][0]["relevant"])
        self.assertIn("text", data["results"][0]["hits"][0]["matchedExpectations"])

    def test_knowledge_eval_answer_keywords_accept_aliases(self) -> None:
        answer = (
            "当来源片段不足时，系统应明确说没有足够依据。"
            "划词翻译依赖快捷键和翻译结果展示。"
            "固定区域翻译框适合重复翻译同一区域。"
            "OCR 文本可以使用段落模式处理。"
            "直接照抄标题会导致指标虚高。"
        )
        matched, missing = match_answer_keywords(
            answer,
            [
                "不足时说明资料不足",
                "Selection",
                "Translate",
                "Region",
                "Box",
                "paragraph",
                "指标会虚高",
            ],
        )

        self.assertEqual(missing, [])
        self.assertIn("不足时说明资料不足", matched)
        self.assertIn("paragraph", matched)

    def test_knowledge_eval_refusal_accepts_evidence_absence_phrasing(self) -> None:
        self.assertTrue(
            is_refusal_answer("没有任何信息表明 TabKeep 能够诊断疾病，也无法依据现有资料断定。")
        )

    def test_knowledge_eval_runs_answer_quality_when_requested(self) -> None:
        self.initialize_config()
        db.upsert_document(
            source_type="markdown",
            title="答案评估记录",
            content=(
                "# 答案评估记录\n\n"
                "AlphaAnswerTarget 的正确答案来自本地知识库，并且需要引用检索上下文。"
            ),
            path="answer-eval.md",
        )

        created = self.client.post(
            "/knowledge/eval/cases",
            json={
                "question": "AlphaAnswerTarget 本地知识库 检索上下文",
                "caseType": "natural",
                "expectedText": "AlphaAnswerTarget 的正确答案来自本地知识库",
                "expectedPath": "answer-eval.md",
                "expectedAnswer": "AlphaAnswerTarget 的正确答案来自本地知识库。",
                "answerKeywords": "AlphaAnswerTarget, 本地知识库, 检索上下文",
            },
            headers=self.headers,
        )
        self.assertEqual(created.status_code, 200, created.text)
        case = created.json()
        self.assertEqual(case["expectedAnswer"], "AlphaAnswerTarget 的正确答案来自本地知识库。")
        self.assertEqual(case["answerKeywords"], "AlphaAnswerTarget, 本地知识库, 检索上下文")
        self.assertFalse(case["shouldRefuse"])

        async def fake_chat_completion(_config, messages):
            self.assertTrue(any("AlphaAnswerTarget" in str(message) for message in messages))
            return "AlphaAnswerTarget 的正确答案来自本地知识库，并且这点由检索上下文支撑。"

        with patch("services.knowledge.evaluation.chat_completion", side_effect=fake_chat_completion):
            result = self.client.post(
                "/knowledge/eval/run",
                json={
                    "caseIds": [case["id"]],
                    "limit": 5,
                    "searchMode": "fts",
                    "evaluateAnswer": True,
                },
                headers=self.headers,
            )

        self.assertEqual(result.status_code, 200, result.text)
        data = result.json()
        self.assertEqual(data["retrievalEvaluated"], 1)
        self.assertEqual(data["hitCount"], 1)
        self.assertEqual(data["answerEligible"], 1)
        self.assertEqual(data["answerLimit"], 1)
        self.assertEqual(data["answerEvaluated"], 1)
        self.assertEqual(data["answerPassCount"], 1)
        self.assertEqual(data["answerAccuracy"], 1)
        item = data["results"][0]
        self.assertTrue(item["answerEvaluated"])
        self.assertTrue(item["answerOk"])
        self.assertEqual(item["answerIssueType"], "ok")
        self.assertIn("本地知识库", item["matchedAnswerKeywords"])
        self.assertEqual(item["missingAnswerKeywords"], [])

    def test_knowledge_eval_answer_limit_caps_model_calls(self) -> None:
        self.initialize_config()
        db.upsert_document(
            source_type="markdown",
            title="答案抽样记录",
            content=(
                "# 答案抽样记录\n\n"
                "AlphaLimitOne 来自第一条知识。\n\n"
                "AlphaLimitTwo 来自第二条知识。"
            ),
            path="answer-limit.md",
        )
        case_ids: list[str] = []
        for question, expected in [
            ("AlphaLimitOne", "AlphaLimitOne 来自第一条知识"),
            ("AlphaLimitTwo", "AlphaLimitTwo 来自第二条知识"),
        ]:
            created = self.client.post(
                "/knowledge/eval/cases",
                json={
                    "question": question,
                    "expectedText": expected,
                    "expectedPath": "answer-limit.md",
                    "expectedAnswer": expected,
                    "answerKeywords": question,
                },
                headers=self.headers,
            )
            self.assertEqual(created.status_code, 200, created.text)
            case_ids.append(created.json()["id"])

        calls = 0

        async def fake_chat_completion(_config, _messages):
            nonlocal calls
            calls += 1
            return "AlphaLimitOne 来自第一条知识。"

        with patch("services.knowledge.evaluation.chat_completion", side_effect=fake_chat_completion):
            result = self.client.post(
                "/knowledge/eval/run",
                json={
                    "caseIds": case_ids,
                    "limit": 5,
                    "searchMode": "fts",
                    "evaluateAnswer": True,
                    "answerLimit": 1,
                },
                headers=self.headers,
            )

        self.assertEqual(result.status_code, 200, result.text)
        data = result.json()
        self.assertEqual(data["answerEligible"], 2)
        self.assertEqual(data["answerLimit"], 1)
        self.assertEqual(data["answerEvaluated"], 1)
        self.assertEqual(calls, 1)

    def test_knowledge_eval_supports_refusal_only_cases(self) -> None:
        self.initialize_config()
        created = self.client.post(
            "/knowledge/eval/cases",
            json={
                "question": "TabKeep 是否能办理医保报销？",
                "caseType": "negative",
                "shouldRefuse": True,
                "note": "无上下文时应拒答",
            },
            headers=self.headers,
        )
        self.assertEqual(created.status_code, 200, created.text)
        case = created.json()
        self.assertEqual(case["caseType"], "negative")
        self.assertTrue(case["shouldRefuse"])

        result = self.client.post(
            "/knowledge/eval/run",
            json={
                "caseIds": [case["id"]],
                "limit": 5,
                "searchMode": "fts",
                "evaluateAnswer": True,
            },
            headers=self.headers,
        )

        self.assertEqual(result.status_code, 200, result.text)
        data = result.json()
        self.assertEqual(data["retrievalEvaluated"], 0)
        self.assertEqual(data["hitCount"], 0)
        self.assertEqual(data["answerEligible"], 1)
        self.assertEqual(data["answerLimit"], 1)
        self.assertEqual(data["answerEvaluated"], 1)
        self.assertEqual(data["answerPassCount"], 1)
        self.assertEqual(data["refusalEvaluated"], 1)
        self.assertEqual(data["refusalPassCount"], 1)
        self.assertEqual(data["refusalAccuracy"], 1)
        item = data["results"][0]
        self.assertEqual(item["issueType"], "not_evaluated")
        self.assertTrue(item["answerOk"])
        self.assertTrue(item["refusalOk"])

    def test_knowledge_eval_text_match_is_relevant_when_title_is_not_exact(self) -> None:
        self.initialize_config()
        db.upsert_document(
            source_type="markdown",
            title="RAG 链路学习笔记",
            content="# RAG 链路学习笔记\n\n## 5. 文档入库链路\n\n### 5.4 向量索引\n\n写入向量时会调用 vector_store.replace_document()。",
            path="rag-chain.md",
        )

        created = self.client.post(
            "/knowledge/eval/cases",
            json={
                "question": "vector_store.replace_document",
                "caseType": "challenge",
                "expectedText": "vector_store.replace_document()",
                "expectedPath": "rag-chain.md",
                "expectedTitle": "RAG 链路学习笔记 / 5.4 向量索引",
            },
            headers=self.headers,
        )
        self.assertEqual(created.status_code, 200, created.text)
        self.assertEqual(created.json()["caseType"], "challenge")

        result = self.client.post(
            "/knowledge/eval/run",
            json={"caseIds": [created.json()["id"]], "limit": 5, "searchMode": "fts"},
            headers=self.headers,
        )

        self.assertEqual(result.status_code, 200, result.text)
        data = result.json()
        self.assertEqual(data["hitCount"], 1)
        self.assertEqual(data["typeSummaries"][0]["caseType"], "challenge")
        self.assertEqual(data["typeSummaries"][0]["hitCount"], 1)
        self.assertEqual(data["results"][0]["issueType"], "ok")
        hit = data["results"][0]["hits"][0]
        self.assertTrue(hit["relevant"])
        self.assertIn("text", hit["matchedExpectations"])

    def test_knowledge_eval_normalizes_expected_text_markdown_noise(self) -> None:
        case = KnowledgeEvalCase(
            id="case-normalized-text",
            question="TabKeep 收藏保存后如何自动进入知识库？",
            expectedText="index_saved_note()",
            expectedPath="siyuan://blocks/auto-index",
            expectedTitle="4.1 TabKeep 收藏自动入库",
            expectedDocumentId="",
            expectedParagraphId="",
            note="",
            createdAt="",
            updatedAt="",
        )
        item = KnowledgeCitation(
            documentId="doc-auto-index",
            paragraphId="para-auto-index",
            chunkId="chunk-auto-index",
            title="未命名 / TabKeep RAG 链路学习笔记 / 4. 数据来源链路 / 4.1 TabKeep 收藏自动入库",
            paragraphTitle="4.1 TabKeep 收藏自动入库",
            sourceType="markdown",
            path="siyuan://blocks/auto-index",
            content="保存 TabKeep 笔记后会自动调用 `index\u200b_saved_note()` 写入知识库。",
            matchedContent="自动调用 `index\u200b_saved_note()` 写入知识库。",
        )

        matches = matched_expectations(case, item)

        self.assertIn("path", matches)
        self.assertIn("title", matches)
        self.assertIn("text", matches)
        self.assertTrue(is_relevant(case, matches))

    def test_knowledge_eval_path_title_can_confirm_brittle_expected_text(self) -> None:
        item = KnowledgeCitation(
            documentId="doc-auto-index",
            paragraphId="para-auto-index",
            chunkId="chunk-auto-index",
            title="未命名 / TabKeep RAG 链路学习笔记 / 4. 数据来源链路 / 4.1 TabKeep 收藏自动入库",
            paragraphTitle="4.1 TabKeep 收藏自动入库",
            sourceType="markdown",
            path="siyuan://blocks/auto-index",
            content="保存后由 index_saved_note() 进入知识库。",
            matchedContent="保存后由 index_saved_note() 进入知识库。",
        )
        case = KnowledgeEvalCase(
            id="case-path-title-fallback",
            question="TabKeep 收藏保存后如何自动进入知识库？",
            expectedText="legacy_auto_save_anchor()",
            expectedPath="siyuan://blocks/auto-index",
            expectedTitle="4.1 TabKeep 收藏自动入库",
            expectedDocumentId="",
            expectedParagraphId="",
            note="",
            createdAt="",
            updatedAt="",
        )
        path_only_case = case.model_copy(update={"expectedTitle": ""})

        matches = matched_expectations(case, item)
        path_only_matches = matched_expectations(path_only_case, item)

        self.assertNotIn("text", matches)
        self.assertIn("path", matches)
        self.assertIn("title", matches)
        self.assertTrue(is_relevant(case, matches))
        self.assertFalse(is_relevant(path_only_case, path_only_matches))

    def test_knowledge_hit_test_reranks_candidates_when_configured(self) -> None:
        self.initialize_config(
            {
                "knowledgeConfig": {
                    "enabled": True,
                    "markdownPaths": [],
                    "maxFileBytes": 1_000_000,
                    "embedding": {
                        "enabled": True,
                        "baseURL": "https://api.siliconflow.cn/v1",
                        "apiKey": "test-shared-key",
                        "model": "BAAI/bge-m3",
                    },
                }
            }
        )
        db.upsert_document(
            source_type="markdown",
            title="Alpha 一号",
            content="# Alpha 一号\n\nAlphaRerankTarget 排序测试 A。",
            path="alpha-a.md",
        )
        db.upsert_document(
            source_type="markdown",
            title="Alpha 二号",
            content="# Alpha 二号\n\nAlphaRerankTarget 排序测试 B。",
            path="alpha-b.md",
        )

        async def fake_rerank(rerank_config, _query, items):
            self.assertEqual(rerank_config.apiKey, "test-shared-key")
            self.assertEqual(rerank_config.model, "BAAI/bge-reranker-v2-m3")
            ranked = list(reversed(items))
            for index, item in enumerate(ranked, start=1):
                item.rerankScore = 1 - index / 10
            return RerankResult(items=ranked, used=True)

        with patch("services.knowledge.retrieval.rerank_citations", side_effect=fake_rerank):
            result = self.client.post(
                "/knowledge/hit-test",
                json={"query": "AlphaRerankTarget", "limit": 2, "searchMode": "fts"},
                headers=self.headers,
            )

        self.assertEqual(result.status_code, 200, result.text)
        data = result.json()
        self.assertTrue(data["rerankUsed"])
        self.assertEqual(len(data["items"]), 2)
        first = data["items"][0]
        self.assertIn("rerank", first["matchedBy"])
        self.assertEqual(first["rrfRank"], 2)
        self.assertIsNotNone(first["rerankScore"])

    def test_knowledge_vector_inspect_links_chunks_to_paragraphs(self) -> None:
        self.initialize_config()
        _, chunks = db.upsert_document(
            source_type="markdown",
            title="向量调试文档",
            content="# 向量调试文档\n\n## 段落一\n\nAlphaVectorDebug 会进入向量表。",
            path="vector-debug.md",
        )
        vector_store.replace_document(chunks, [[1.0, 0.0] for _ in chunks])

        response = self.client.get(
            "/knowledge/vector/inspect",
            params={"query": "AlphaVectorDebug", "limit": 10},
            headers=self.headers,
        )

        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertTrue(data["ok"], data.get("error"))
        self.assertTrue(data["tableExists"])
        self.assertTrue(data["schemaReady"])
        self.assertGreaterEqual(data["rowCount"], 1)
        self.assertEqual(len(data["records"]), 1)
        record = data["records"][0]
        self.assertIn("AlphaVectorDebug", record["content"])
        self.assertIsNotNone(record["paragraphId"])
        self.assertIn("AlphaVectorDebug", record["paragraphContentPreview"])


if __name__ == "__main__":
    unittest.main()
