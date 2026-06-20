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

        search = self.client.post(
            "/knowledge/search",
            json={"query": "接口重建索引", "limit": 5},
            headers=self.headers,
        )
        self.assertEqual(search.status_code, 200, search.text)
        self.assertEqual(len(search.json()["items"]), 1)

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


if __name__ == "__main__":
    unittest.main()
