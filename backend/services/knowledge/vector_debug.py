from __future__ import annotations

from schemas.knowledge import KnowledgeVectorColumn, KnowledgeVectorInspectResponse, KnowledgeVectorRecord
from services.knowledge import db, vector_store


def inspect_vector_store(
    query: str | None = None,
    limit: int = 100,
    migrate: bool = False,
) -> KnowledgeVectorInspectResponse:
    vector_ok, vector_message = vector_store.availability()
    if not vector_ok:
        return KnowledgeVectorInspectResponse(
            ok=False,
            vectorAvailable=False,
            vectorMessage=vector_message,
            tableName=vector_store.TABLE_NAME,
            path=str(vector_store.LANCE_DIR),
            requiredColumns=sorted(vector_store.REQUIRED_COLUMNS.keys()),
            missingColumns=sorted(vector_store.REQUIRED_COLUMNS.keys()),
            query=(query or "").strip(),
            limit=max(1, min(limit, 500)),
            error=vector_message,
        )

    try:
        payload = vector_store.inspect_table(query=query or "", limit=limit, migrate=migrate)
        records = payload.get("records", [])
        metadata = db.get_vector_record_metadata([str(record.get("chunk_id") or "") for record in records])
        return KnowledgeVectorInspectResponse(
            ok=True,
            vectorAvailable=True,
            vectorMessage=vector_message,
            tableExists=bool(payload.get("table_exists")),
            tableName=str(payload.get("table_name") or vector_store.TABLE_NAME),
            path=str(payload.get("path") or vector_store.LANCE_DIR),
            rowCount=int(payload.get("row_count") or 0),
            columns=[
                KnowledgeVectorColumn(name=str(column.get("name") or ""), type=str(column.get("type") or ""))
                for column in payload.get("columns", [])
            ],
            requiredColumns=[str(item) for item in payload.get("required_columns", [])],
            missingColumns=[str(item) for item in payload.get("missing_columns", [])],
            schemaReady=not payload.get("missing_columns"),
            query=(query or "").strip(),
            limit=max(1, min(limit, 500)),
            records=[record_to_response(record, metadata.get(str(record.get("chunk_id") or ""), {})) for record in records],
        )
    except Exception as exc:
        error = f"LanceDB 检查失败: {type(exc).__name__}: {exc}"
        return KnowledgeVectorInspectResponse(
            ok=False,
            vectorAvailable=True,
            vectorMessage=vector_message,
            tableName=vector_store.TABLE_NAME,
            path=str(vector_store.LANCE_DIR),
            requiredColumns=sorted(vector_store.REQUIRED_COLUMNS.keys()),
            query=(query or "").strip(),
            limit=max(1, min(limit, 500)),
            error=error,
        )


def record_to_response(record: dict, metadata: dict) -> KnowledgeVectorRecord:
    paragraph_content = str(metadata.get("paragraph_content") or "")
    return KnowledgeVectorRecord(
        chunkId=str(record.get("chunk_id") or ""),
        documentId=str(record.get("document_id") or metadata.get("document_id") or ""),
        paragraphId=str(record.get("paragraph_id") or metadata.get("paragraph_id") or "") or None,
        title=str(record.get("title") or metadata.get("document_title") or ""),
        sourceType=str(record.get("source_type") or metadata.get("source_type") or ""),
        path=record.get("path") or metadata.get("path"),
        url=record.get("url") or metadata.get("url"),
        content=str(record.get("content") or ""),
        contentPreview=str(record.get("content_preview") or ""),
        vectorDims=int(record.get("vector_dims") or 0),
        vectorPreview=[float(value) for value in record.get("vector_preview", [])],
        documentTitle=metadata.get("document_title"),
        paragraphTitle=metadata.get("paragraph_title"),
        paragraphContentPreview=clip(paragraph_content) if paragraph_content else None,
        paragraphCharLen=metadata.get("paragraph_char_len"),
    )


def clip(value: str, limit: int = 520) -> str:
    text = (value or "").strip()
    if len(text) <= limit:
        return text
    return f"{text[:limit].rstrip()}..."
