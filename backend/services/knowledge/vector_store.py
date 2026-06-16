from __future__ import annotations

from pathlib import Path
from typing import Any

from services import storage
from services.knowledge.db import IndexedChunk

LANCE_DIR = storage.DATA_DIR / "knowledge.lance"
TABLE_NAME = "chunks"


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
            "title": chunk.title,
            "source_type": chunk.source_type,
            "path": chunk.path or "",
            "url": chunk.url or "",
            "content": chunk.content,
            "vector": vector,
        }
        for chunk, vector in zip(chunks, vectors, strict=True)
    ]

    names = set(db.table_names())
    if TABLE_NAME not in names:
        db.create_table(TABLE_NAME, data=records)
        return

    table = db.open_table(TABLE_NAME)
    document_id = _quote(chunks[0].document_id)
    try:
        table.delete(f"document_id = '{document_id}'")
    except Exception:
        pass
    table.add(records)


def search(vector: list[float], limit: int) -> list[dict[str, Any]]:
    import lancedb

    db = lancedb.connect(str(LANCE_DIR))
    if TABLE_NAME not in set(db.table_names()):
        return []
    table = db.open_table(TABLE_NAME)
    rows = table.search(vector).limit(limit).to_list()
    return [dict(row) for row in rows]


def _quote(value: str) -> str:
    return value.replace("'", "''")

