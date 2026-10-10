import json
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from schemas.knowledge import KnowledgeConfig, RgbEvalImportRequest, RgbEvalRunRequest
from main import app
from services import storage
from services.knowledge import db, indexing, retrieval, rgb_benchmark, vector_store
from tests.helpers import IsolatedBackendState


class RgbBenchmarkTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.workspace = IsolatedBackendState(f"rgb-benchmark-{self._testMethodName}")
        self.workspace.setup()

    def tearDown(self) -> None:
        self.workspace.teardown()

    async def test_import_isolated_fts_and_end_to_end_retrieval_metrics(self) -> None:
        await indexing.index_document(
            config=KnowledgeConfig(),
            source_type="test",
            title="Primary corpus only",
            content="MAININDEXONLYTOKEN is stored in the user knowledge base.",
            path="primary.md",
        )
        payload = [
            {
                "id": 101,
                "query": "RGBPOSITIVEALPHA",
                "answer": ["测试答案"],
                "positive": ["RGBPOSITIVEALPHA 是 RGB 独立语料的相关段落。"],
                "negative": ["RGBNEGATIVEALPHA 是无关段落。"],
            },
            {
                "id": 102,
                "query": "RGBPOSITIVEBETA",
                "answer": ["另一个答案"],
                "positive": ["RGBPOSITIVEBETA 是另一条相关段落。"],
                "negative": ["RGBPOSITIVEALPHA 是 RGB 独立语料的相关段落。"],
            },
        ]
        imported = await rgb_benchmark.import_dataset(
            RgbEvalImportRequest(
                fileName="zh_refine.jsonl",
                content="\n".join(json.dumps(item, ensure_ascii=False) for item in payload),
            )
        )

        self.assertTrue(imported.imported)
        self.assertEqual(imported.caseCount, 2)
        self.assertEqual(imported.passageCount, 3)
        self.assertEqual(db.search_fts_hits("RGBPOSITIVEALPHA", 5), [])
        self.assertEqual(rgb_benchmark.search_fts_hits("MAININDEXONLYTOKEN", 5), [])

        rgb_result = await retrieval.hit_test_knowledge(
            "RGBPOSITIVEALPHA",
            limit=3,
            search_mode="fts",
            corpus_profile="rgb",
        )
        notes_result = await retrieval.hit_test_knowledge(
            "MAININDEXONLYTOKEN",
            limit=3,
            search_mode="fts",
        )
        self.assertTrue(rgb_result.ok)
        self.assertEqual(rgb_result.items[0].documentId, "rgb-zh-refine")
        self.assertEqual(notes_result.items[0].title, "Primary corpus only")

        cases, _, _, _ = rgb_benchmark._load_cases(0)
        self.assertEqual(cases[0]["positive_ids"][0], cases[1]["negative_ids"][0])

        run = await rgb_benchmark.run_evaluation(
            RgbEvalRunRequest(caseLimit=1, limit=3, searchMode="fts")
        )
        self.assertTrue(run.ok)
        self.assertEqual(run.evaluated, 1)
        self.assertEqual(run.recallAtK, 1, run.model_dump_json())
        self.assertEqual(run.mrr, 1)
        self.assertEqual(run.top1Accuracy, 1)
        self.assertIsNotNone(rgb_benchmark.get_run(run.runId))
        self.assertEqual(rgb_benchmark.list_run_summaries()[0].runId, run.runId)

    async def test_invalid_dataset_is_rejected_before_replacing_existing_corpus(self) -> None:
        valid = {
            "id": 1,
            "query": "valid query",
            "positive": ["VALIDRGBPASSAGE"],
            "negative": [],
        }
        await rgb_benchmark.import_dataset(
            RgbEvalImportRequest(fileName="original.jsonl", content=json.dumps(valid))
        )
        with self.assertRaisesRegex(ValueError, "positive"):
            await rgb_benchmark.import_dataset(
                RgbEvalImportRequest(
                    fileName="broken.jsonl",
                    content=json.dumps({"id": 2, "query": "missing positive", "positive": []}),
                )
            )

        status = rgb_benchmark.get_status()
        self.assertEqual(status.fileName, "original.jsonl")
        self.assertEqual(status.caseCount, 1)
        self.assertEqual(len(rgb_benchmark.search_fts_hits("VALIDRGBPASSAGE", 5)), 1)

    async def test_official_dataset_import_downloads_once_and_builds_index(self) -> None:
        record = {
            "id": 11,
            "query": "OFFICIALRGBTOKEN",
            "positive": ["OFFICIALRGBTOKEN 对应官方语料段落。"],
            "negative": [],
        }
        with patch(
            "services.knowledge.rgb_benchmark._download_official_dataset",
            new=AsyncMock(return_value=json.dumps(record, ensure_ascii=False)),
        ) as download:
            first = await rgb_benchmark.import_official_dataset()
            second = await rgb_benchmark.import_official_dataset()

        self.assertTrue(first.imported)
        self.assertEqual(first.fileName, "zh_refine.json")
        self.assertEqual(first.caseCount, 1)
        self.assertEqual(second.datasetVersion, first.datasetVersion)
        download.assert_awaited_once_with()

    async def test_vector_hit_test_reads_the_rgb_vector_index(self) -> None:
        passage = "RGBVECTORONLYTOKEN 的相关知识段落。"
        await rgb_benchmark.import_dataset(
            RgbEvalImportRequest(
                fileName="zh_refine.jsonl",
                content=json.dumps(
                    {"id": 1, "query": "RGBVECTORONLYTOKEN", "positive": [passage], "negative": []},
                    ensure_ascii=False,
                ),
            )
        )
        storage.set_knowledge_config(
            KnowledgeConfig(
                embedding={
                    "enabled": True,
                    "baseURL": "https://embedding.example/v1",
                    "apiKey": "test-key",
                    "model": "test-embedding",
                }
            )
        )
        passage_id = rgb_benchmark._passage_id(passage)
        fake_row = {
            "chunk_id": passage_id,
            "title": "RGB test passage",
            "content": passage,
            "_distance": 0.1,
        }
        with (
            patch("services.knowledge.retrieval.embed_texts", new=AsyncMock(return_value=[[0.1, 0.2]])),
            patch("services.knowledge.retrieval.rerank_config_ready", return_value=False),
            patch.object(rgb_benchmark, "vector_index_available", return_value=True),
            patch.object(rgb_benchmark, "search_vectors", return_value=[fake_row]) as rgb_search,
            patch("services.knowledge.retrieval.vector_store.search", side_effect=AssertionError("main index used")),
        ):
            response = await retrieval.hit_test_knowledge(
                "RGBVECTORONLYTOKEN",
                limit=3,
                search_mode="vector",
                corpus_profile="rgb",
            )

        self.assertTrue(response.ok)
        self.assertTrue(response.items[0].vectorRank)
        self.assertEqual(response.items[0].chunkId, passage_id)
        rgb_search.assert_called_once()

    async def test_import_builds_vectors_in_a_separate_lance_directory(self) -> None:
        passage = "RGBLANCEISOLATIONTOKEN 需要进入独立向量索引。"
        storage.set_knowledge_config(
            KnowledgeConfig(
                embedding={
                    "enabled": True,
                    "baseURL": "https://embedding.example/v1",
                    "apiKey": "test-key",
                    "model": "test-embedding",
                }
            )
        )
        with patch(
            "services.knowledge.rgb_benchmark.embed_texts",
            new=AsyncMock(return_value=[[0.1, 0.2, 0.3]]),
        ):
            status = await rgb_benchmark.import_dataset(
                RgbEvalImportRequest(
                    fileName="zh_refine.jsonl",
                    content=json.dumps(
                        {
                            "id": 9,
                            "query": "RGBLANCEISOLATIONTOKEN",
                            "positive": [passage],
                            "negative": [],
                        },
                        ensure_ascii=False,
                    ),
                )
            )

        self.assertTrue(status.vectorAvailable)
        self.assertEqual(status.vectorCount, 1)
        vector_hits = rgb_benchmark.search_vectors([0.1, 0.2, 0.3], 3)
        self.assertEqual(vector_hits[0]["chunk_id"], rgb_benchmark._passage_id(passage))
        self.assertFalse(vector_store.inspect_table()["table_exists"])

        storage.set_knowledge_config(
            KnowledgeConfig(
                embedding={
                    "enabled": True,
                    "baseURL": "https://embedding.example/v1",
                    "apiKey": "test-key",
                    "model": "different-embedding-space",
                }
            )
        )
        stale = rgb_benchmark.get_status()
        self.assertFalse(stale.vectorAvailable)
        self.assertIn("配置已变化", stale.warning or "")

    def test_parse_rejects_malformed_jsonl_with_line_number(self) -> None:
        with self.assertRaisesRegex(ValueError, "第 2 行"):
            rgb_benchmark.parse_zh_refine(
                '{"id":1,"query":"q","positive":["p"]}\nnot-json'
            )


class RgbBenchmarkApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.workspace = IsolatedBackendState(f"rgb-benchmark-api-{self._testMethodName}")
        self.workspace.setup()
        self.client = TestClient(app)
        self.headers = {"X-TabKeep-Token": "rgb-test-token"}
        storage._state["apiToken"] = "rgb-test-token"

    def tearDown(self) -> None:
        self.workspace.teardown()

    def test_rgb_import_run_and_history_are_available_through_api(self) -> None:
        record = {
            "id": 7,
            "query": "RGBAPIPOSITIVETOKEN",
            "positive": ["RGBAPIPOSITIVETOKEN 的对应知识段落。"],
            "negative": ["另一段无关文本。"],
        }
        imported = self.client.post(
            "/knowledge/eval/rgb/import",
            headers=self.headers,
            json={"fileName": "zh_refine.jsonl", "content": json.dumps(record, ensure_ascii=False)},
        )
        self.assertEqual(imported.status_code, 200, imported.text)
        self.assertEqual(imported.json()["caseCount"], 1)

        status = self.client.get("/knowledge/eval/rgb/status", headers=self.headers)
        self.assertEqual(status.status_code, 200, status.text)
        self.assertTrue(status.json()["imported"])

        run = self.client.post(
            "/knowledge/eval/rgb/run",
            headers=self.headers,
            json={"caseLimit": 0, "limit": 5, "searchMode": "fts", "minScore": 0},
        )
        self.assertEqual(run.status_code, 200, run.text)
        run_id = run.json()["runId"]
        self.assertEqual(run.json()["evaluated"], 1)

        history = self.client.get("/knowledge/eval/rgb/runs", headers=self.headers)
        self.assertEqual(history.status_code, 200, history.text)
        self.assertEqual(history.json()[0]["runId"], run_id)

        detail = self.client.get(f"/knowledge/eval/rgb/runs/{run_id}", headers=self.headers)
        self.assertEqual(detail.status_code, 200, detail.text)
        self.assertEqual(detail.json()["result"]["dataset"], "rgb-zh-refine")

    def test_official_rgb_dataset_can_be_imported_through_api(self) -> None:
        record = {
            "id": 8,
            "query": "RGBOFFICIALAPITOKEN",
            "positive": ["RGBOFFICIALAPITOKEN 对应的段落。"],
            "negative": [],
        }
        with patch(
            "services.knowledge.rgb_benchmark._download_official_dataset",
            new=AsyncMock(return_value=json.dumps(record, ensure_ascii=False)),
        ) as download:
            response = self.client.post(
                "/knowledge/eval/rgb/import-official",
                headers=self.headers,
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["imported"])
        self.assertEqual(response.json()["fileName"], "zh_refine.json")
        download.assert_awaited_once_with()


if __name__ == "__main__":
    unittest.main()
