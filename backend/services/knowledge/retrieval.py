from __future__ import annotations

from schemas.knowledge import KnowledgeCitation, KnowledgeSearchResponse
from services import storage
from services.knowledge import db, vector_store
from services.knowledge.embeddings import embed_texts, embedding_config_ready
from logger import logger


async def search_knowledge(query: str, limit: int = 8) -> KnowledgeSearchResponse:
    clean_query = query.strip()
    if not clean_query:
        return KnowledgeSearchResponse(ok=False, query=query, sourceMode="fts", error="请输入搜索内容")

    limit = max(1, min(limit, 20))
    config = storage.get_knowledge_config()
    fts_items = db.search_fts(clean_query, limit * 2)
    vector_items: list[KnowledgeCitation] = []
    vector_used = False

    if embedding_config_ready(config.embedding) and vector_store.availability()[0]:
        try:
            vectors = await embed_texts(config.embedding, [clean_query])
            vector_rows = vector_store.search(vectors[0], limit * 2)
            vector_items = vector_rows_to_citations(vector_rows)
            vector_used = bool(vector_items)
        except Exception as exc:
            logger.warning(f"向量检索失败,回退 FTS: {type(exc).__name__}: {exc}")

    merged = rrf_merge(fts_items, vector_items, limit)
    source_mode = "hybrid" if vector_used and fts_items else "vector" if vector_used else "fts"
    return KnowledgeSearchResponse(ok=True, query=clean_query, sourceMode=source_mode, items=merged)


def vector_rows_to_citations(rows: list[dict]) -> list[KnowledgeCitation]:
    chunk_ids = [str(row.get("chunk_id", "")) for row in rows if row.get("chunk_id")]
    details = db.get_chunks_by_ids(chunk_ids)
    items: list[KnowledgeCitation] = []
    for index, row in enumerate(rows):
        chunk_id = str(row.get("chunk_id", ""))
        item = details.get(chunk_id)
        if not item:
            continue
        distance = row.get("_distance")
        item.score = 1 / (1 + float(distance)) if distance is not None else 1 / (1 + index)
        items.append(item)
    return items


def rrf_merge(
    fts_items: list[KnowledgeCitation],
    vector_items: list[KnowledgeCitation],
    limit: int,
) -> list[KnowledgeCitation]:
    by_id: dict[str, KnowledgeCitation] = {}
    scores: dict[str, float] = {}
    for source in (fts_items, vector_items):
        for rank, item in enumerate(source, start=1):
            by_id.setdefault(item.chunkId, item)
            scores[item.chunkId] = scores.get(item.chunkId, 0) + 1 / (60 + rank)
    ranked = sorted(by_id.values(), key=lambda item: scores.get(item.chunkId, 0), reverse=True)
    for item in ranked:
        item.score = round(scores.get(item.chunkId, 0), 6)
    return ranked[:limit]

