import shutil
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from schemas.config import NoteAdapterConfig
from schemas.knowledge import KnowledgeConfig, KnowledgeSiyuanSyncRequest
from services import storage
from services.knowledge import db, indexing, retrieval, siyuan_sync
from services.note.base import DocNode, NotebookInfo


class KnowledgeTestCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.tmp_dir = ROOT.parent / "tmp" / f"knowledge-test-{self._testMethodName}"
        if self.tmp_dir.exists():
            shutil.rmtree(self.tmp_dir)
        self.tmp_dir.mkdir(parents=True)

        self.old_data_dir = storage.DATA_DIR
        self.old_config_file = storage.CONFIG_FILE
        self.old_db_path = db.DB_PATH
        self.old_get_note_adapter = storage.get_note_adapter
        self.old_get_knowledge_config = storage.get_knowledge_config
        self.old_siyuan_adapter = siyuan_sync.SiYuanAdapter

        storage.DATA_DIR = self.tmp_dir
        storage.CONFIG_FILE = self.tmp_dir / "config.json"
        db.DB_PATH = self.tmp_dir / "knowledge.db"

    def tearDown(self) -> None:
        storage.DATA_DIR = self.old_data_dir
        storage.CONFIG_FILE = self.old_config_file
        db.DB_PATH = self.old_db_path
        storage.get_note_adapter = self.old_get_note_adapter
        storage.get_knowledge_config = self.old_get_knowledge_config
        siyuan_sync.SiYuanAdapter = self.old_siyuan_adapter
        if self.tmp_dir.exists():
            shutil.rmtree(self.tmp_dir)

    async def test_reindex_indexes_markdown_and_skips_large_files(self) -> None:
        notes_dir = self.tmp_dir / "notes"
        notes_dir.mkdir()
        (notes_dir / "small.md").write_text("# RAG 小笔记\n\n混合检索可以工作。", encoding="utf-8")
        (notes_dir / "large.md").write_text("超大内容" * 100, encoding="utf-8")

        config = KnowledgeConfig(markdownPaths=[str(notes_dir)], maxFileBytes=200)
        result = await indexing.reindex_all(config)
        search = await retrieval.search_knowledge("混合检索", 5)
        large_search = await retrieval.search_knowledge("超大内容", 5)

        self.assertTrue(result.ok)
        self.assertEqual(result.documentsIndexed, 1)
        self.assertEqual(len(search.items), 1)
        self.assertEqual(len(large_search.items), 0)

    async def test_reindexing_same_document_removes_old_fts_terms(self) -> None:
        config = KnowledgeConfig()
        await indexing.index_document(
            config=config,
            source_type="smoke",
            title="同一文档",
            content="旧内容 Alpha",
            path="same.md",
        )
        await indexing.index_document(
            config=config,
            source_type="smoke",
            title="同一文档",
            content="新内容 Beta",
            path="same.md",
        )

        old_search = await retrieval.search_knowledge("Alpha", 5)
        new_search = await retrieval.search_knowledge("Beta", 5)

        self.assertEqual(len(old_search.items), 0)
        self.assertEqual(len(new_search.items), 1)

    async def test_siyuan_sync_indexes_exported_markdown_and_reports_errors(self) -> None:
        storage.get_knowledge_config = lambda: KnowledgeConfig()
        storage.get_note_adapter = lambda: NoteAdapterConfig(
            provider="siyuan",
            endpoint="http://127.0.0.1:6806",
            token="test-token",
        )
        siyuan_sync.SiYuanAdapter = FakeSiyuanAdapter

        result = await siyuan_sync.sync_siyuan_notes(KnowledgeSiyuanSyncRequest())
        search = await retrieval.search_knowledge("SiYuan 同步测试", 5)

        self.assertFalse(result.ok)
        self.assertEqual(result.notebooksScanned, 1)
        self.assertEqual(result.documentsFound, 3)
        self.assertEqual(result.documentsIndexed, 1)
        self.assertEqual(result.documentsSkipped, 1)
        self.assertEqual(len(result.errors), 1)
        self.assertEqual(len(search.items), 1)
        self.assertEqual(search.items[0].sourceType, "siyuan")

    async def test_siyuan_precheck_reports_missing_config(self) -> None:
        storage.get_knowledge_config = lambda: KnowledgeConfig()
        storage.get_note_adapter = lambda: None

        result = await siyuan_sync.precheck_siyuan_sync()

        self.assertFalse(result.ok)
        self.assertIn("SiYuan", result.error or "")


class FakeSiyuanAdapter:
    def __init__(self, _config: NoteAdapterConfig) -> None:
        self.endpoint = "http://fake-siyuan"

    async def list_notebooks(self) -> list[NotebookInfo]:
        return [NotebookInfo(id="nb1", name="测试笔记本")]

    async def list_docs(self, _notebook_id: str) -> list[DocNode]:
        return [
            DocNode(id="doc1", name="有效文档", path="/有效文档", type="Page"),
            DocNode(id="doc2", name="空文档", path="/空文档", type="Page"),
            DocNode(id="doc3", name="失败文档", path="/失败文档", type="Page"),
        ]

    async def export_markdown(self, doc_id: str) -> tuple[str, str]:
        if doc_id == "doc1":
            return "/有效文档", "# 有效文档\n\nSiYuan 同步测试内容。"
        if doc_id == "doc2":
            return "/空文档", ""
        raise RuntimeError("导出失败")


if __name__ == "__main__":
    unittest.main()
