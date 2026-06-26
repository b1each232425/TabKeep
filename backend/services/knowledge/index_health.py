from __future__ import annotations

from datetime import datetime

from schemas.knowledge import (
    KnowledgeIndexHealthIssue,
    KnowledgeIndexHealthResponse,
    KnowledgeIndexRepairResponse,
)
from services.knowledge import db, vector_store


def inspect_index_health() -> KnowledgeIndexHealthResponse:
    vector_ok, vector_message = vector_store.availability()
    snapshot = db.inspect_index_health()
    vector_rows = 0
    vector_missing_sql_rows = 0
    vector_missing_paragraph_rows = 0
    vector_schema_ready = False
    missing_vector_columns: list[str] = []
    vector_error: str | None = None

    if vector_ok:
        try:
            vector_payload = vector_store.inspect_table(limit=1)
            vector_rows = int(vector_payload.get("row_count") or 0)
            missing_vector_columns = [str(item) for item in vector_payload.get("missing_columns", [])]
            vector_schema_ready = not missing_vector_columns and bool(vector_payload.get("table_exists"))

            vector_records = vector_store.list_records(limit=10000)
            chunk_ids = [str(record.get("chunk_id") or "") for record in vector_records if record.get("chunk_id")]
            metadata = db.get_vector_record_metadata(chunk_ids)
            for record in vector_records:
                chunk_id = str(record.get("chunk_id") or "")
                paragraph_id = str(record.get("paragraph_id") or "")
                meta = metadata.get(chunk_id)
                if not meta:
                    vector_missing_sql_rows += 1
                    continue
                if paragraph_id and not meta.get("paragraph_content"):
                    vector_missing_paragraph_rows += 1
        except Exception as exc:
            vector_error = f"LanceDB 健康检查失败: {type(exc).__name__}: {exc}"

    issues = build_issues(
        snapshot=snapshot,
        vector_missing_sql_rows=vector_missing_sql_rows,
        vector_missing_paragraph_rows=vector_missing_paragraph_rows,
        missing_vector_columns=missing_vector_columns,
        vector_error=vector_error,
    )
    repairable = [issue.key for issue in issues if issue.repairable]
    status = "healthy" if not issues else "attention"
    stats = db.get_stats(vector_ok, vector_message or vector_error)
    return KnowledgeIndexHealthResponse(
        ok=not any(issue.severity == "error" for issue in issues),
        status=status,
        checkedAt=datetime.now().isoformat(timespec="seconds"),
        documents=int(snapshot["documents"]),
        paragraphs=int(snapshot["paragraphs"]),
        chunks=int(snapshot["chunks"]),
        ftsRows=int(snapshot["ftsRows"]),
        vectorRows=vector_rows,
        orphanChunks=int(snapshot["orphanChunks"]),
        orphanParagraphs=int(snapshot["orphanParagraphs"]),
        orphanFtsRows=int(snapshot["orphanFtsRows"]),
        missingFtsRows=int(snapshot["missingFtsRows"]),
        vectorMissingSqlRows=vector_missing_sql_rows,
        vectorMissingParagraphRows=vector_missing_paragraph_rows,
        staleMarkdownDocuments=int(snapshot["staleMarkdownDocuments"]),
        embeddingStatusCounts=dict(snapshot["embeddingStatusCounts"]),
        vectorAvailable=vector_ok,
        vectorMessage=vector_message or vector_error,
        vectorSchemaReady=vector_schema_ready,
        missingVectorColumns=missing_vector_columns,
        issues=issues,
        repairableIssues=repairable,
        stats=stats,
        error=vector_error,
    )


def repair_index() -> KnowledgeIndexRepairResponse:
    errors: list[str] = []
    repaired = False
    orphan_deleted = 0
    missing_inserted = 0
    try:
        result = db.repair_fts_index()
        orphan_deleted = int(result["orphanFtsRowsDeleted"])
        missing_inserted = int(result["missingFtsRowsInserted"])
        repaired = orphan_deleted > 0 or missing_inserted > 0
    except Exception as exc:
        errors.append(f"FTS 修复失败: {type(exc).__name__}: {exc}")

    health = inspect_index_health()
    return KnowledgeIndexRepairResponse(
        ok=not errors,
        repaired=repaired,
        orphanFtsRowsDeleted=orphan_deleted,
        missingFtsRowsInserted=missing_inserted,
        health=health,
        errors=errors,
    )


def build_issues(
    *,
    snapshot: dict,
    vector_missing_sql_rows: int,
    vector_missing_paragraph_rows: int,
    missing_vector_columns: list[str],
    vector_error: str | None,
) -> list[KnowledgeIndexHealthIssue]:
    issues: list[KnowledgeIndexHealthIssue] = []
    if int(snapshot["orphanChunks"]) > 0:
        issues.append(
            KnowledgeIndexHealthIssue(
                key="orphan_chunks",
                label="孤儿 chunks",
                severity="error",
                count=int(snapshot["orphanChunks"]),
                message="chunks 表存在找不到 document 的记录，需要重建索引。",
            )
        )
    if int(snapshot["orphanParagraphs"]) > 0:
        issues.append(
            KnowledgeIndexHealthIssue(
                key="orphan_paragraphs",
                label="孤儿 paragraphs",
                severity="error",
                count=int(snapshot["orphanParagraphs"]),
                message="paragraphs 表存在找不到 document 的记录，需要重建索引。",
            )
        )
    if int(snapshot["orphanFtsRows"]) > 0:
        issues.append(
            KnowledgeIndexHealthIssue(
                key="orphan_fts_rows",
                label="孤儿 FTS 行",
                count=int(snapshot["orphanFtsRows"]),
                message="FTS 表存在找不到 chunk 的旧记录，可以安全清理。",
                repairable=True,
            )
        )
    if int(snapshot["missingFtsRows"]) > 0:
        issues.append(
            KnowledgeIndexHealthIssue(
                key="missing_fts_rows",
                label="缺失 FTS 行",
                count=int(snapshot["missingFtsRows"]),
                message="部分 chunks 没有对应 FTS 索引，可以安全补建。",
                repairable=True,
            )
        )
    if vector_missing_sql_rows > 0:
        issues.append(
            KnowledgeIndexHealthIssue(
                key="vector_missing_sql_rows",
                label="向量孤儿记录",
                count=vector_missing_sql_rows,
                message="LanceDB 中存在 SQLite 找不到的 chunk，建议重建语义索引。",
            )
        )
    if vector_missing_paragraph_rows > 0:
        issues.append(
            KnowledgeIndexHealthIssue(
                key="vector_missing_paragraph_rows",
                label="向量段落缺失",
                count=vector_missing_paragraph_rows,
                message="部分向量记录关联的 paragraph 缺失，建议同步知识库。",
            )
        )
    if missing_vector_columns:
        issues.append(
            KnowledgeIndexHealthIssue(
                key="missing_vector_columns",
                label="向量 schema 缺字段",
                count=len(missing_vector_columns),
                message="LanceDB 表缺少新版本字段，可在向量库页迁移 schema。",
            )
        )
    if int(snapshot["staleMarkdownDocuments"]) > 0:
        issues.append(
            KnowledgeIndexHealthIssue(
                key="stale_markdown_documents",
                label="源文件可能已删除",
                count=int(snapshot["staleMarkdownDocuments"]),
                message="部分 Markdown 文档的源路径不存在，建议同步或重建索引后检查。",
            )
        )
    if vector_error:
        issues.append(
            KnowledgeIndexHealthIssue(
                key="vector_health_error",
                label="向量健康检查失败",
                severity="warning",
                count=1,
                message=vector_error,
            )
        )
    return issues
