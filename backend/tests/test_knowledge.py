import importlib
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from schemas.config import NoteAdapterConfig
from schemas.knowledge import KnowledgeConfig, KnowledgeSiyuanSyncRequest, KnowledgeSyncAllResponse
from services import storage
from services.knowledge import db, graph, index_health, indexing, retrieval, siyuan_sync, sync_all, topics, vector_store
from services.knowledge.db import IndexedChunk
from services.note.base import DocNode, NotebookInfo
from services.note.siyuan import SiYuanAdapter
from tests.helpers import IsolatedBackendState


class KnowledgeTestCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.workspace = IsolatedBackendState(f"knowledge-test-{self._testMethodName}")
        self.tmp_dir = self.workspace.setup()
        self.old_get_note_adapter = storage.get_note_adapter
        self.old_get_knowledge_config = storage.get_knowledge_config
        self.old_siyuan_adapter = siyuan_sync.SiYuanAdapter

    def tearDown(self) -> None:
        storage.get_note_adapter = self.old_get_note_adapter
        storage.get_knowledge_config = self.old_get_knowledge_config
        siyuan_sync.SiYuanAdapter = self.old_siyuan_adapter
        self.workspace.teardown()

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

    async def test_incremental_index_skips_ready_unchanged_embedding_and_retries_errors(self) -> None:
        config = KnowledgeConfig(
            embedding={
                "enabled": True,
                "baseURL": "http://example.test/v1",
                "apiKey": "test-key",
                "model": "test-embedding",
            }
        )
        calls = 0

        async def fake_embed_texts(_embedding_config, texts):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise RuntimeError("temporary embedding outage")
            return [[1.0, 0.0] for _ in texts]

        with (
            patch("services.knowledge.indexing.embed_texts", side_effect=fake_embed_texts),
            patch("services.knowledge.indexing.vector_store.availability", return_value=(True, None)),
            patch("services.knowledge.indexing.vector_store.replace_document") as replace_document,
        ):
            first, first_error = await indexing.index_document(
                config=config,
                source_type="markdown",
                title="增量向量测试",
                content="# 增量向量测试\n\nAlphaIncrementalEmbedding 会进入向量库。",
                path="incremental-embedding.md",
            )
            retry, retry_error = await indexing.index_document(
                config=config,
                source_type="markdown",
                title="增量向量测试",
                content="# 增量向量测试\n\nAlphaIncrementalEmbedding 会进入向量库。",
                path="incremental-embedding.md",
            )
            skipped, skipped_error = await indexing.index_document(
                config=config,
                source_type="markdown",
                title="增量向量测试",
                content="# 增量向量测试\n\nAlphaIncrementalEmbedding 会进入向量库。",
                path="incremental-embedding.md",
            )

        status = db.get_document_index_status(first.document_id)

        self.assertTrue(first.indexed)
        self.assertIn("embedding 失败", first_error or "")
        self.assertFalse(retry.indexed)
        self.assertIsNone(retry_error)
        self.assertFalse(skipped.indexed)
        self.assertIsNone(skipped_error)
        self.assertEqual(calls, 2)
        self.assertEqual(replace_document.call_count, 1)
        self.assertIsNotNone(status)
        self.assertEqual(status.embedding_status, "ready")
        self.assertEqual(status.chunk_count, retry.chunk_count)
        self.assertEqual(status.paragraph_count, retry.paragraph_count)

    async def test_reindex_deletes_stale_markdown_documents(self) -> None:
        notes_dir = self.tmp_dir / "incremental-notes"
        notes_dir.mkdir()
        keep = notes_dir / "keep.md"
        stale = notes_dir / "stale.md"
        keep.write_text("# 保留文档\n\nKeepNeedle 应该保留。", encoding="utf-8")
        stale.write_text("# 删除文档\n\nStaleNeedle 应该被清理。", encoding="utf-8")

        config = KnowledgeConfig(markdownPaths=[str(notes_dir)])
        first = await indexing.reindex_all(config)
        stale.unlink()
        second = await indexing.reindex_all(config)
        keep_search = await retrieval.search_knowledge("KeepNeedle", 5)
        stale_search = await retrieval.search_knowledge("StaleNeedle", 5)
        markdown_docs = db.list_document_index_statuses(source_type="markdown", limit=20)

        self.assertTrue(first.ok, first.errors)
        self.assertEqual(first.documentsIndexed, 2)
        self.assertTrue(second.ok, second.errors)
        self.assertEqual(second.documentsIndexed, 0)
        self.assertEqual(second.documentsSkipped, 1)
        self.assertEqual(second.documentsDeleted, 1)
        self.assertEqual(len(keep_search.items), 1)
        self.assertEqual(len(stale_search.items), 0)
        self.assertEqual([doc.title for doc in markdown_docs], ["保留文档"])

    async def test_index_health_repairs_missing_fts_rows(self) -> None:
        config = KnowledgeConfig()
        await indexing.index_document(
            config=config,
            source_type="markdown",
            title="索引健康测试",
            content="# 索引健康测试\n\nIndexHealthNeedle 应该能通过 FTS 被召回。",
            path="index-health.md",
        )

        healthy = index_health.inspect_index_health()
        self.assertEqual(healthy.missingFtsRows, 0)
        self.assertEqual(healthy.orphanFtsRows, 0)

        with db.connection() as conn:
            conn.execute("DELETE FROM chunk_fts")

        broken = index_health.inspect_index_health()
        self.assertGreater(broken.missingFtsRows, 0)
        self.assertIn("missing_fts_rows", broken.repairableIssues)

        repaired = index_health.repair_index()
        search = await retrieval.search_knowledge("IndexHealthNeedle", 5)

        self.assertTrue(repaired.ok)
        self.assertTrue(repaired.repaired)
        self.assertGreater(repaired.missingFtsRowsInserted, 0)
        self.assertEqual(repaired.health.missingFtsRows, 0)
        self.assertEqual(len(search.items), 1)

    async def test_sync_all_records_run_metadata_and_recent_logs(self) -> None:
        notes_dir = self.tmp_dir / "sync-notes"
        notes_dir.mkdir()
        (notes_dir / "sync.md").write_text("# 同步日志\n\nSyncLogNeedle 会进入知识库。", encoding="utf-8")
        storage.get_knowledge_config = lambda: KnowledgeConfig(markdownPaths=[str(notes_dir)])
        storage.get_note_adapter = lambda: None

        result = await sync_all.sync_all_knowledge()
        logs = sync_all.list_sync_logs()
        search = await retrieval.search_knowledge("SyncLogNeedle", 5)

        self.assertTrue(result.ok, result.errors)
        self.assertTrue(result.runId)
        self.assertEqual(result.status, "success")
        self.assertIsNotNone(result.startedAt)
        self.assertIsNotNone(result.endedAt)
        self.assertGreaterEqual(result.durationMs, 0)
        self.assertEqual(result.documentsIndexed, 1)
        self.assertEqual(len(search.items), 1)
        self.assertGreaterEqual(len(logs.items), 1)
        self.assertEqual(logs.items[0].runId, result.runId)
        reloaded_sync_all = importlib.reload(sync_all)
        persisted_logs = reloaded_sync_all.list_sync_logs()
        self.assertGreaterEqual(len(persisted_logs.items), 1)
        self.assertEqual(persisted_logs.items[0].runId, result.runId)

        local = next(source for source in result.sources if source.source == "local")
        siyuan = next(source for source in result.sources if source.source == "siyuan")
        self.assertEqual(local.status, "success")
        self.assertIsNotNone(local.startedAt)
        self.assertIsNotNone(local.endedAt)
        self.assertGreaterEqual(local.durationMs, 0)
        self.assertEqual(siyuan.status, "skipped")
        self.assertTrue(siyuan.skipped)

    async def test_sync_logs_are_capped_in_sqlite_and_response(self) -> None:
        stats = db.get_stats()
        for index in range(db.SYNC_LOG_RETENTION_LIMIT + 5):
            timestamp = f"2026-06-27T00:{index // 60:02d}:{index % 60:02d}+00:00"
            db.save_sync_run(
                KnowledgeSyncAllResponse(
                    ok=True,
                    runId=f"run-{index:03d}",
                    status="success",
                    startedAt=timestamp,
                    endedAt=timestamp,
                    stats=stats,
                )
            )

        stored = db.list_sync_runs(limit=200)
        visible = sync_all.list_sync_logs()

        self.assertEqual(len(stored), db.SYNC_LOG_RETENTION_LIMIT)
        self.assertEqual(len(visible.items), db.SYNC_LOG_VISIBLE_LIMIT)
        self.assertEqual(stored[0].runId, "run-104")
        self.assertEqual(stored[-1].runId, "run-005")
        self.assertEqual(visible.items[0].runId, "run-104")
        self.assertEqual(visible.items[-1].runId, "run-085")

    async def test_search_hits_chunks_but_returns_paragraph(self) -> None:
        config = KnowledgeConfig()
        content = (
            "# RAG 分段测试\n\n"
            "## 长段落\n\n"
            f"{'前置背景说明 ' * 220}"
            "UniqueNeedleAlpha "
            f"{'后续上下文延展 ' * 220}"
        )
        await indexing.index_document(
            config=config,
            source_type="markdown",
            title="RAG 分段测试",
            content=content,
            path="paragraph.md",
        )

        search = await retrieval.search_knowledge("UniqueNeedleAlpha", 5)

        self.assertEqual(len(search.items), 1)
        item = search.items[0]
        self.assertIsNotNone(item.paragraphId)
        self.assertNotEqual(item.paragraphId, item.chunkId)
        self.assertIn("UniqueNeedleAlpha", item.matchedContent or "")
        self.assertIn("前置背景说明", item.content)
        self.assertIn("后续上下文延展", item.content)
        self.assertGreater(len(item.content), len(item.matchedContent or ""))

    async def test_vector_store_migrates_old_table_schema_for_paragraph_ids(self) -> None:
        old_lance_dir = vector_store.LANCE_DIR
        vector_store.LANCE_DIR = self.tmp_dir / "data" / "knowledge.lance"
        try:
            import lancedb

            vector_store.LANCE_DIR.mkdir(parents=True, exist_ok=True)
            lance = lancedb.connect(str(vector_store.LANCE_DIR))
            lance.create_table(
                vector_store.TABLE_NAME,
                data=[
                    {
                        "chunk_id": "old:c0",
                        "document_id": "old",
                        "title": "旧表",
                        "source_type": "markdown",
                        "path": "",
                        "url": "",
                        "content": "旧向量",
                        "vector": [0.0, 0.0],
                    }
                ],
            )

            chunks = [
                IndexedChunk(
                    id="new:p0:c0",
                    document_id="new",
                    paragraph_id="new:p0",
                    title="新段落",
                    source_type="markdown",
                    url=None,
                    path="new.md",
                    content="新向量",
                )
            ]
            vector_store.replace_document(chunks, [[1.0, 0.0]])

            table = lance.open_table(vector_store.TABLE_NAME)
            self.assertIn("paragraph_id", table.schema.names)
            records = {row["chunk_id"]: row for row in vector_store.list_records()}
            self.assertEqual(records["old:c0"]["paragraph_id"], "")
            self.assertEqual(records["new:p0:c0"]["paragraph_id"], "new:p0")
        finally:
            vector_store.LANCE_DIR = old_lance_dir

    async def test_hit_test_reports_fts_scores_and_vector_unavailable(self) -> None:
        config = KnowledgeConfig()
        await indexing.index_document(
            config=config,
            source_type="markdown",
            title="调试台测试",
            content="Alpha 检索诊断会展示 FTS 排名和 RRF 分数。",
            path="debug.md",
        )

        fts = await retrieval.hit_test_knowledge("Alpha 检索诊断", 5, "fts", 0)
        vector = await retrieval.hit_test_knowledge("Alpha 检索诊断", 5, "vector", 0)

        self.assertTrue(fts.ok)
        self.assertEqual(fts.searchMode, "fts")
        self.assertEqual(fts.sourceMode, "fts")
        self.assertEqual(len(fts.items), 1)
        self.assertEqual(fts.items[0].rank, 1)
        self.assertEqual(fts.items[0].matchedBy, ["fts"])
        self.assertEqual(fts.items[0].ftsRank, 1)
        self.assertGreater(fts.items[0].rrfScore, 0)
        self.assertFalse(vector.ok)
        self.assertIn("Embedding", vector.error or "")

    async def test_graph_builds_tags_headings_and_wikilinks(self) -> None:
        config = KnowledgeConfig()
        await indexing.index_document(
            config=config,
            source_type="markdown",
            title="Alpha Note",
            path="Alpha Note.md",
            content=(
                "---\n"
                "tags: [rag, graph]\n"
                "---\n\n"
                "# Alpha Note\n\n"
                "## Runtime Map\n\n"
                "关联 [[Beta Note]] 和 [[Unindexed Idea]]。"
            ),
        )
        await indexing.index_document(
            config=config,
            source_type="markdown",
            title="Beta Note",
            path="Beta Note.md",
            content="# Beta Note\n\n图谱目标节点。",
        )

        first = graph.rebuild_graph()
        second = graph.rebuild_graph()
        all_graph = graph.get_graph(layer="all", limit=100)
        concepts = graph.get_graph(layer="concepts", query="Runtime", limit=100)
        documents = graph.get_graph(layer="documents", query="Beta", limit=100)

        self.assertTrue(first.ok)
        self.assertEqual(first.nodes, second.nodes)
        self.assertEqual(first.edges, second.edges)
        self.assertIn("tag", {node.kind for node in all_graph.nodes})
        self.assertIn("heading", {node.kind for node in all_graph.nodes})
        self.assertIn("concept", {node.kind for node in all_graph.nodes})
        self.assertIn("has_tag", {edge.kind for edge in all_graph.edges})
        self.assertIn("has_heading", {edge.kind for edge in all_graph.edges})
        self.assertIn("links_to_document", {edge.kind for edge in all_graph.edges})
        self.assertTrue(any(node.label == "Runtime Map" for node in concepts.nodes))
        self.assertTrue(any(node.label == "Beta Note" for node in documents.nodes))

    async def test_graph_builds_markdown_links_and_title_mentions(self) -> None:
        config = KnowledgeConfig()
        await indexing.index_document(
            config=config,
            source_type="markdown",
            title="Alpha Link Hub",
            path=str(self.tmp_dir / "notes" / "Alpha Link Hub.md"),
            content=(
                "# Alpha Link Hub\n\n"
                "参考 [Beta Path](notes/Beta%20Path.md)，也会在正文里提到 Gamma Mention。"
            ),
        )
        await indexing.index_document(
            config=config,
            source_type="markdown",
            title="Beta Path",
            path=str(self.tmp_dir / "notes" / "Beta Path.md"),
            content="# Beta Path\n\n被 Markdown 相对路径链接。",
        )
        await indexing.index_document(
            config=config,
            source_type="markdown",
            title="Gamma Mention",
            path=str(self.tmp_dir / "notes" / "Gamma Mention.md"),
            content="# Gamma Mention\n\n被标题提及链接。",
        )

        graph.rebuild_graph()
        documents = graph.get_graph(layer="documents", query="Alpha Link Hub", limit=100)
        node_labels = {node.id: node.label for node in documents.nodes}
        linked_labels = {
            node_labels[edge.target]
            for edge in documents.edges
            if edge.kind == "links_to_document" and node_labels.get(edge.source) == "Alpha Link Hub"
        }

        self.assertIn("Beta Path", linked_labels)
        self.assertIn("Gamma Mention", linked_labels)

    async def test_graph_rebuild_adds_semantic_similarity_edges(self) -> None:
        config = KnowledgeConfig()
        alpha, _ = await indexing.index_document(
            config=config,
            source_type="markdown",
            title="Alpha Semantic",
            path="alpha-semantic.md",
            content="# Alpha Semantic\n\n语义图谱测试 Alpha。",
        )
        beta, _ = await indexing.index_document(
            config=config,
            source_type="markdown",
            title="Beta Semantic",
            path="beta-semantic.md",
            content="# Beta Semantic\n\n语义图谱测试 Beta。",
        )
        gamma, _ = await indexing.index_document(
            config=config,
            source_type="markdown",
            title="Gamma Semantic",
            path="gamma-semantic.md",
            content="# Gamma Semantic\n\n不相似的语义图谱测试 Gamma。",
        )

        vector_store.replace_document(
            [
                IndexedChunk(
                    id=f"{alpha.document_id}:semantic:c0",
                    document_id=alpha.document_id,
                    paragraph_id=f"{alpha.document_id}:semantic",
                    title="Alpha Semantic",
                    source_type="markdown",
                    url=None,
                    path="alpha-semantic.md",
                    content="Alpha Semantic",
                )
            ],
            [[1.0, 0.0]],
        )
        vector_store.replace_document(
            [
                IndexedChunk(
                    id=f"{beta.document_id}:semantic:c0",
                    document_id=beta.document_id,
                    paragraph_id=f"{beta.document_id}:semantic",
                    title="Beta Semantic",
                    source_type="markdown",
                    url=None,
                    path="beta-semantic.md",
                    content="Beta Semantic",
                )
            ],
            [[0.98, 0.02]],
        )
        vector_store.replace_document(
            [
                IndexedChunk(
                    id=f"{gamma.document_id}:semantic:c0",
                    document_id=gamma.document_id,
                    paragraph_id=f"{gamma.document_id}:semantic",
                    title="Gamma Semantic",
                    source_type="markdown",
                    url=None,
                    path="gamma-semantic.md",
                    content="Gamma Semantic",
                )
            ],
            [[0.0, 1.0]],
        )

        rebuilt = graph.rebuild_graph()
        documents = graph.get_graph(layer="documents", limit=100)
        semantic_edges = [edge for edge in documents.edges if edge.kind == "semantic_similar"]
        node_labels = {node.id: node.label for node in documents.nodes}

        self.assertTrue(rebuilt.ok)
        self.assertEqual(len(semantic_edges), 1)
        edge = semantic_edges[0]
        self.assertEqual(
            {node_labels[edge.source], node_labels[edge.target]},
            {"Alpha Semantic", "Beta Semantic"},
        )
        self.assertGreater(edge.weight, 0.99)

    async def test_graph_rebuild_skips_semantic_edges_when_vector_store_fails(self) -> None:
        config = KnowledgeConfig()
        await indexing.index_document(
            config=config,
            source_type="markdown",
            title="Vector Down Alpha",
            path="vector-down-alpha.md",
            content="# Vector Down Alpha\n\n图谱显式关系仍然可用。",
        )

        with patch("services.knowledge.graph.vector_store.list_records", side_effect=RuntimeError("vector down")):
            rebuilt = graph.rebuild_graph()
            documents = graph.get_graph(layer="documents", limit=100)

        self.assertTrue(rebuilt.ok)
        self.assertNotIn("semantic_similar", {edge.kind for edge in documents.edges})

    async def test_topics_build_workbench_from_explicit_signals(self) -> None:
        config = KnowledgeConfig()
        await indexing.index_document(
            config=config,
            source_type="markdown",
            title="RAG Indexing",
            path=str(self.tmp_dir / "rag" / "RAG Indexing.md"),
            content=(
                "---\n"
                "tags: [rag, retrieval]\n"
                "---\n\n"
                "# RAG Indexing\n\n"
                "## Hybrid Search\n\n"
                "混合检索会连接 [[Vector Search]] 和全文检索。"
            ),
        )
        await indexing.index_document(
            config=config,
            source_type="markdown",
            title="Retrieval Notes",
            path=str(self.tmp_dir / "rag" / "Retrieval Notes.md"),
            content=(
                "---\n"
                "tags: [rag]\n"
                "---\n\n"
                "# Retrieval Notes\n\n"
                "这里记录 RAG 召回和排序。"
            ),
        )

        first = topics.rebuild_topics()
        second = topics.rebuild_topics()
        listing = topics.list_topics(query="rag", limit=20)
        topic = next(item for item in listing.topics if item.title == "rag")
        detail = topics.get_topic_detail(topic.id)
        missing_model = await topics.enrich_topics(topic.id)

        self.assertTrue(first.ok)
        self.assertEqual(first.topics, second.topics)
        self.assertTrue(listing.ok)
        self.assertGreaterEqual(listing.stats.topics, 1)
        self.assertTrue(detail.ok)
        self.assertEqual(len(detail.documents), 2)
        self.assertTrue(any(item.kind == "tag" and item.label == "rag" for item in detail.evidence))
        self.assertIn("共享标签", detail.documents[0].reason)
        self.assertTrue(any(item.anchor == "Hybrid Search" for item in detail.documents))
        self.assertFalse(missing_model.ok)
        self.assertIn("modelConfig", missing_model.error or "")

        storage._state["noteAdapter"] = NoteAdapterConfig(provider="local").model_dump()
        exported = await topics.export_topic(topic.id)
        self.assertTrue(exported.ok, exported.error)
        self.assertEqual(exported.provider, "local")
        topic_map = self.tmp_dir / "data" / "notes" / "topic-map.md"
        self.assertTrue(topic_map.exists())
        content = topic_map.read_text(encoding="utf-8")
        self.assertIn("## 代表笔记", content)
        self.assertIn("RAG Indexing", content)

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

    async def test_siyuan_adapter_allows_empty_token_for_local_no_auth(self) -> None:
        adapter = SiYuanAdapter(NoteAdapterConfig(provider="siyuan", endpoint="http://127.0.0.1:6806"))

        self.assertEqual(adapter._headers(), {})

    async def test_siyuan_adapter_uses_sql_for_docs_and_markdown_fallback(self) -> None:
        adapter = SqlOnlySiyuanAdapter(NoteAdapterConfig(provider="siyuan", endpoint="http://fake-siyuan"))

        docs = await adapter.list_docs("nb1")
        h_path, content = await adapter.export_markdown("doc1")

        self.assertEqual(len(docs), 1)
        self.assertEqual(docs[0].id, "doc1")
        self.assertEqual(docs[0].name, "SQL 文档")
        self.assertEqual(h_path, "/SQL 文档")
        self.assertIn("# SQL 文档", content)
        self.assertIn("SQL 正文", content)
        self.assertIn("## SQL 小节", content)


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


class SqlOnlySiyuanAdapter(SiYuanAdapter):
    async def _post(self, path: str, payload: dict) -> dict:
        if path == "/api/export/exportMdContent":
            raise RuntimeError("导出接口不可用")
        if path != "/api/query/sql":
            raise RuntimeError(f"不应调用 {path}")

        stmt = str(payload.get("stmt") or "")
        if "WHERE type = 'd'" in stmt:
            return {
                "code": 0,
                "data": [
                    {
                        "id": "doc1",
                        "path": "/doc1.sy",
                        "hpath": "/SQL 文档",
                        "content": "SQL 文档",
                        "type": "d",
                    }
                ],
            }
        if "WHERE id = 'doc1'" in stmt:
            return {
                "code": 0,
                "data": [{"id": "doc1", "hpath": "/SQL 文档", "content": "SQL 文档"}],
            }
        if "WHERE root_id = 'doc1'" in stmt:
            return {
                "code": 0,
                "data": [
                    {"id": "doc1", "type": "d", "content": "SQL 文档", "markdown": "", "sort": 0},
                    {"id": "p1", "type": "p", "content": "SQL 正文", "markdown": "", "sort": 10},
                    {"id": "h1", "type": "h", "subtype": "h2", "content": "SQL 小节", "markdown": "", "sort": 20},
                ],
            }
        return {"code": 0, "data": []}


if __name__ == "__main__":
    unittest.main()
