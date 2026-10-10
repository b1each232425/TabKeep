"""知识库服务门面。

路由层只依赖这个模块；具体实现分散在 indexing / retrieval / qa / siyuan_sync。
这样后续继续扩展知识图谱、来源打开、增量同步时，不会把单个文件堆成一团。
"""

from services.knowledge.indexing import index_document, index_saved_note, reindex_all
from services.knowledge.evaluation import (
    delete_eval_case,
    get_eval_run,
    list_eval_cases,
    list_eval_run_summaries,
    run_eval,
    save_eval_case,
)
from services.knowledge.graph import get_graph, rebuild_graph
from services.knowledge.index_health import inspect_index_health, repair_index
from services.knowledge.qa import ask_knowledge
from services.knowledge.retrieval import hit_test_knowledge, search_knowledge
from services.knowledge.siyuan_sync import precheck_siyuan_sync, sync_siyuan_notes
from services.knowledge.standalone_export import export_skill_archive, generate_skill_draft
from services.knowledge.sync_all import list_sync_logs, sync_all_knowledge
from services.knowledge.topics import enrich_topics, export_topic, get_topic_detail, list_topics, rebuild_topics
from services.knowledge.vector_debug import inspect_vector_store
from schemas.knowledge import (
    KnowledgeDocumentIndexListResponse,
    KnowledgeDocumentIndexStatus,
    RgbEvalImportRequest,
    RgbEvalRunRecord,
    RgbEvalRunRequest,
    RgbEvalRunSummary,
    RgbEvalRunResponse,
    RgbEvalStatusResponse,
)
from services.knowledge import db as knowledge_db
from services.knowledge import rgb_benchmark


def list_document_indexes(
    source_type: str | None = None,
    limit: int = 200,
) -> KnowledgeDocumentIndexListResponse:
    statuses = knowledge_db.list_document_index_statuses(source_type=source_type, limit=limit)
    items = [
        KnowledgeDocumentIndexStatus(
            documentId=status.id,
            sourceType=status.source_type,
            title=status.title,
            url=status.url,
            path=status.path,
            noteId=status.note_id,
            contentHash=status.content_hash,
            contentBytes=status.content_bytes,
            paragraphCount=status.paragraph_count,
            chunkCount=status.chunk_count,
            indexStatus=status.index_status,
            embeddingStatus=status.embedding_status,
            lastError=status.last_error,
            updatedAt=status.updated_at,
            indexedAt=status.indexed_at,
            lastSeenAt=status.last_seen_at,
        )
        for status in statuses
    ]
    return KnowledgeDocumentIndexListResponse(ok=True, total=len(items), items=items)


def get_rgb_eval_status() -> RgbEvalStatusResponse:
    return rgb_benchmark.get_status()


async def import_rgb_eval_dataset(request: RgbEvalImportRequest) -> RgbEvalStatusResponse:
    return await rgb_benchmark.import_dataset(request)


async def import_official_rgb_eval_dataset() -> RgbEvalStatusResponse:
    return await rgb_benchmark.import_official_dataset()


async def run_rgb_eval(request: RgbEvalRunRequest) -> RgbEvalRunResponse:
    return await rgb_benchmark.run_evaluation(request)


def list_rgb_eval_runs(limit: int = 20) -> list[RgbEvalRunSummary]:
    return rgb_benchmark.list_run_summaries(limit)


def get_rgb_eval_run(run_id: str) -> RgbEvalRunRecord | None:
    return rgb_benchmark.get_run(run_id)

__all__ = [
    "ask_knowledge",
    "delete_eval_case",
    "enrich_topics",
    "export_skill_archive",
    "generate_skill_draft",
    "export_topic",
    "get_graph",
    "get_eval_run",
    "get_rgb_eval_run",
    "get_rgb_eval_status",
    "get_topic_detail",
    "hit_test_knowledge",
    "index_document",
    "index_saved_note",
    "inspect_vector_store",
    "inspect_index_health",
    "list_document_indexes",
    "list_eval_cases",
    "list_eval_run_summaries",
    "list_rgb_eval_runs",
    "list_sync_logs",
    "list_topics",
    "precheck_siyuan_sync",
    "reindex_all",
    "rebuild_graph",
    "rebuild_topics",
    "repair_index",
    "run_eval",
    "run_rgb_eval",
    "import_rgb_eval_dataset",
    "import_official_rgb_eval_dataset",
    "save_eval_case",
    "search_knowledge",
    "sync_all_knowledge",
    "sync_siyuan_notes",
]
