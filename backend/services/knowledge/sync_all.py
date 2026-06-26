from __future__ import annotations

from collections import deque
from datetime import datetime, timezone
from time import perf_counter
from uuid import uuid4

from schemas.knowledge import (
    KnowledgeReindexResponse,
    KnowledgeSyncLogResponse,
    KnowledgeSiyuanSyncRequest,
    KnowledgeSiyuanSyncResponse,
    KnowledgeSyncAllResponse,
    KnowledgeSyncSourceResult,
)
from services import storage
from services.knowledge import db, vector_store
from services.knowledge.indexing import collect_roots, reindex_all
from services.knowledge.siyuan_sync import sync_siyuan_notes


_SYNC_HISTORY: deque[KnowledgeSyncAllResponse] = deque(maxlen=20)


async def sync_all_knowledge() -> KnowledgeSyncAllResponse:
    started_at = now_iso()
    started_perf = perf_counter()
    run_id = uuid4().hex
    config = storage.get_knowledge_config()
    vector_ok, vector_message = vector_store.availability()
    stats = db.get_stats(vector_ok, vector_message)
    if not config.enabled:
        result = finalize_sync_result(
            KnowledgeSyncAllResponse(
                ok=False,
                runId=run_id,
                status="failed",
                startedAt=started_at,
                errors=["知识库已关闭"],
                stats=stats,
            ),
            started_perf,
        )
        remember_sync_result(result)
        return result

    sources: list[KnowledgeSyncSourceResult] = []
    if collect_roots(config):
        local_started = now_iso()
        local_perf = perf_counter()
        local_result = await reindex_all(config)
        sources.append(finish_source_result(local_source_result(local_result), local_started, local_perf))
    else:
        sources.append(
            KnowledgeSyncSourceResult(
                source="local",
                label="本地 / Markdown / Obsidian",
                ok=True,
                status="skipped",
                skipped=True,
                reason="未配置 Markdown / Obsidian 路径，也没有本地收藏笔记",
            )
        )

    note_config = storage.get_note_adapter()
    if note_config and note_config.provider == "siyuan":
        siyuan_started = now_iso()
        siyuan_perf = perf_counter()
        siyuan_result = await sync_siyuan_notes(KnowledgeSiyuanSyncRequest())
        sources.append(finish_source_result(siyuan_source_result(siyuan_result), siyuan_started, siyuan_perf))
    else:
        sources.append(
            KnowledgeSyncSourceResult(
                source="siyuan",
                label="SiYuan",
                ok=True,
                status="skipped",
                skipped=True,
                reason="未配置 SiYuan 笔记集成",
            )
        )

    errors = [error for source in sources for error in source.errors]
    result = finalize_sync_result(
        KnowledgeSyncAllResponse(
            ok=all(source.ok for source in sources),
            runId=run_id,
            status=sync_status(sources, errors),
            startedAt=started_at,
            sources=sources,
            documentsFound=sum(source.documentsFound for source in sources),
            documentsIndexed=sum(source.documentsIndexed for source in sources),
            documentsSkipped=sum(source.documentsSkipped for source in sources),
            chunksIndexed=sum(source.chunksIndexed for source in sources),
            errors=errors[:20],
            stats=db.get_stats(vector_ok, vector_message),
        ),
        started_perf,
    )
    remember_sync_result(result)
    return result


def list_sync_logs() -> KnowledgeSyncLogResponse:
    return KnowledgeSyncLogResponse(items=list(_SYNC_HISTORY))


def local_source_result(result: KnowledgeReindexResponse) -> KnowledgeSyncSourceResult:
    return KnowledgeSyncSourceResult(
        source="local",
        label="本地 / Markdown / Obsidian",
        ok=result.ok,
        status="success" if result.ok else "error",
        documentsIndexed=result.documentsIndexed,
        documentsSkipped=result.documentsSkipped,
        chunksIndexed=result.chunksIndexed,
        errors=result.errors,
    )


def siyuan_source_result(result: KnowledgeSiyuanSyncResponse) -> KnowledgeSyncSourceResult:
    return KnowledgeSyncSourceResult(
        source="siyuan",
        label="SiYuan",
        ok=result.ok,
        status="success" if result.ok else "error",
        notebooksScanned=result.notebooksScanned,
        documentsFound=result.documentsFound,
        documentsIndexed=result.documentsIndexed,
        documentsSkipped=result.documentsSkipped,
        chunksIndexed=result.chunksIndexed,
        errors=result.errors,
    )


def finish_source_result(
    result: KnowledgeSyncSourceResult,
    started_at: str,
    started_perf: float,
) -> KnowledgeSyncSourceResult:
    result.startedAt = started_at
    result.endedAt = now_iso()
    result.durationMs = elapsed_ms(started_perf)
    if result.skipped:
        result.status = "skipped"
    elif not result.ok:
        result.status = "error"
    elif result.errors:
        result.status = "warning"
    else:
        result.status = "success"
    return result


def finalize_sync_result(
    result: KnowledgeSyncAllResponse,
    started_perf: float,
) -> KnowledgeSyncAllResponse:
    result.endedAt = now_iso()
    result.durationMs = elapsed_ms(started_perf)
    if not result.status:
        result.status = "success" if result.ok else "failed"
    return result


def sync_status(sources: list[KnowledgeSyncSourceResult], errors: list[str]) -> str:
    active_sources = [source for source in sources if not source.skipped]
    if errors or any(not source.ok for source in sources):
        return "failed" if not any(source.ok for source in active_sources) else "partial"
    if not active_sources:
        return "skipped"
    return "success"


def remember_sync_result(result: KnowledgeSyncAllResponse) -> None:
    _SYNC_HISTORY.appendleft(result)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def elapsed_ms(started_perf: float) -> int:
    return max(0, round((perf_counter() - started_perf) * 1000))
