from __future__ import annotations

from pathlib import Path
from typing import Any

from services import storage
from services.knowledge.db import IndexedChunk

LANCE_DIR = storage.DATA_DIR / "knowledge.lance"
TABLE_NAME = "chunks"
REQUIRED_COLUMNS = {"paragraph_id": "''"}


def availability() -> tuple[bool, str | None]:
    try:
        import lancedb  # noqa: F401
    except Exception as exc:
        return False, f"LanceDB 不可用: {type(exc).__name__}: {exc}"
    return True, None


def replace_document(chunks: list[IndexedChunk], vectors: list[list[float]]) -> None:
    if not chunks or not vectors:
        return
    if len(chunks) != len(vectors):
        raise ValueError("chunk 数量与 embedding 数量不一致")

    import lancedb

    LANCE_DIR.mkdir(parents=True, exist_ok=True)
    db = lancedb.connect(str(LANCE_DIR))
    records = [
        {
            "chunk_id": chunk.id,
            "document_id": chunk.document_id,
            "paragraph_id": chunk.paragraph_id or "",
            "title": chunk.title,
            "source_type": chunk.source_type,
            "path": chunk.path or "",
            "url": chunk.url or "",
            "content": chunk.content,
            "vector": vector,
        }
        for chunk, vector in zip(chunks, vectors, strict=True)
    ]

    names = set(_table_names(db))
    if TABLE_NAME not in names:
        db.create_table(TABLE_NAME, data=records)
        return

    table = _ensure_table_schema(db, db.open_table(TABLE_NAME))
    document_id = _quote(chunks[0].document_id)
    try:
        table.delete(f"document_id = '{document_id}'")
    except Exception:
        pass
    table.add(records)


def delete_documents(document_ids: list[str]) -> None:
    ids = [document_id for document_id in dict.fromkeys(document_ids) if document_id]
    if not ids:
        return

    import lancedb

    db = lancedb.connect(str(LANCE_DIR))
    if TABLE_NAME not in set(_table_names(db)):
        return
    table = _ensure_table_schema(db, db.open_table(TABLE_NAME))
    for document_id in ids:
        try:
            table.delete(f"document_id = '{_quote(document_id)}'")
        except Exception:
            pass


def search(vector: list[float], limit: int) -> list[dict[str, Any]]:
    import lancedb

    db = lancedb.connect(str(LANCE_DIR))
    if TABLE_NAME not in set(_table_names(db)):
        return []
    table = db.open_table(TABLE_NAME)
    rows = table.search(vector).limit(limit).to_list()
    return [dict(row) for row in rows]


def list_records(limit: int = 2000) -> list[dict[str, Any]]:
    import lancedb

    db = lancedb.connect(str(LANCE_DIR))
    if TABLE_NAME not in set(_table_names(db)):
        return []
    table = db.open_table(TABLE_NAME)
    rows = _table_rows(table)
    return [dict(row) for row in rows[: max(1, min(limit, 10000))]]


def inspect_table(query: str = "", limit: int = 100, migrate: bool = False) -> dict[str, Any]:
    import lancedb

    clean_query = (query or "").strip().lower()
    limit = max(1, min(int(limit or 100), 500))
    db = lancedb.connect(str(LANCE_DIR))
    table_names = set(_table_names(db))
    if TABLE_NAME not in table_names:
        return {
            "table_exists": False,
            "table_name": TABLE_NAME,
            "path": str(LANCE_DIR),
            "row_count": 0,
            "columns": [],
            "required_columns": sorted(REQUIRED_COLUMNS.keys()),
            "missing_columns": sorted(REQUIRED_COLUMNS.keys()),
            "records": [],
        }

    table = db.open_table(TABLE_NAME)
    if migrate:
        table = _ensure_table_schema(db, table)
    column_names = _schema_names(table)
    rows = _table_rows(table)
    if clean_query:
        rows = [row for row in rows if _record_matches(row, clean_query)]
    return {
        "table_exists": True,
        "table_name": TABLE_NAME,
        "path": str(LANCE_DIR),
        "row_count": _count_rows(table, rows),
        "columns": _schema_columns(table),
        "required_columns": sorted(REQUIRED_COLUMNS.keys()),
        "missing_columns": sorted(name for name in REQUIRED_COLUMNS if name not in column_names),
        "records": [_summarize_record(row) for row in rows[:limit]],
    }


def _quote(value: str) -> str:
    return value.replace("'", "''")


def _table_names(db: Any) -> list[str]:
    if hasattr(db, "list_tables"):
        result = db.list_tables()
        if hasattr(result, "tables"):
            return list(result.tables)
        return list(result)
    return list(db.table_names())


def _ensure_table_schema(db: Any, table: Any) -> Any:
    missing = {name: expression for name, expression in REQUIRED_COLUMNS.items() if name not in _schema_names(table)}
    if not missing:
        return table

    try:
        table.add_columns(missing)
    except Exception:
        _rebuild_table_with_columns(db, table, missing)
    return db.open_table(TABLE_NAME)


def _schema_names(table: Any) -> set[str]:
    schema = table.schema
    names = getattr(schema, "names", None)
    if names is not None:
        return set(names)
    return {field.name for field in schema}


def _schema_columns(table: Any) -> list[dict[str, str]]:
    schema = table.schema
    return [{"name": field.name, "type": str(field.type)} for field in schema]


def _count_rows(table: Any, fallback_rows: list[dict[str, Any]]) -> int:
    if hasattr(table, "count_rows"):
        return int(table.count_rows())
    return len(fallback_rows)


def _rebuild_table_with_columns(db: Any, table: Any, missing: dict[str, str]) -> None:
    rows = [dict(row) for row in _table_rows(table)]
    for row in rows:
        for name in missing:
            row.setdefault(name, "")
    db.drop_table(TABLE_NAME)
    if rows:
        db.create_table(TABLE_NAME, data=rows)


def _table_rows(table: Any) -> list[dict[str, Any]]:
    if hasattr(table, "to_list"):
        return [dict(row) for row in table.to_list()]
    if hasattr(table, "to_arrow"):
        return [dict(row) for row in table.to_arrow().to_pylist()]
    if hasattr(table, "to_pandas"):
        return [dict(row) for row in table.to_pandas().to_dict(orient="records")]
    raise RuntimeError("当前 LanceDB Table 不支持导出记录,无法执行 schema 迁移")


def _summarize_record(row: dict[str, Any]) -> dict[str, Any]:
    vector = _vector_values(row.get("vector"))
    content = str(row.get("content") or "")
    return {
        "chunk_id": str(row.get("chunk_id") or ""),
        "document_id": str(row.get("document_id") or ""),
        "paragraph_id": str(row.get("paragraph_id") or "") or None,
        "title": str(row.get("title") or ""),
        "source_type": str(row.get("source_type") or ""),
        "path": str(row.get("path") or "") or None,
        "url": str(row.get("url") or "") or None,
        "content": content,
        "content_preview": _clip(content),
        "vector_dims": len(vector),
        "vector_preview": [round(float(value), 6) for value in vector[:8]],
    }


def _record_matches(row: dict[str, Any], query: str) -> bool:
    haystack = "\n".join(
        str(row.get(key) or "")
        for key in ("chunk_id", "document_id", "paragraph_id", "title", "source_type", "path", "url", "content")
    ).lower()
    return query in haystack


def _vector_values(value: Any) -> list[float]:
    if value is None:
        return []
    if hasattr(value, "tolist"):
        value = value.tolist()
    try:
        return [float(item) for item in value]
    except TypeError:
        return []


def _clip(value: str, limit: int = 360) -> str:
    text = (value or "").strip()
    if len(text) <= limit:
        return text
    return f"{text[:limit].rstrip()}..."
