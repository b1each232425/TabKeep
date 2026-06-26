from __future__ import annotations

from schemas.knowledge import KnowledgeCitation, KnowledgeHitTestItem, KnowledgeHitTestResponse, KnowledgeSearchResponse
from services import storage
from services.knowledge import db, vector_store
from services.knowledge.embeddings import embed_texts, embedding_config_ready
from services.knowledge.rerank import rerank_citations, rerank_config_from_embedding, rerank_config_ready
from logger import logger

VALID_SEARCH_MODES = {"fts", "vector", "hybrid"}
RRF_K = 60


async def search_knowledge(query: str, limit: int = 8) -> KnowledgeSearchResponse:
    clean_query = query.strip()
    if not clean_query:
        return KnowledgeSearchResponse(ok=False, query=query, sourceMode="fts", error="请输入搜索内容")

    limit = max(1, min(limit, 20))
    config = storage.get_knowledge_config()
    rerank_config = rerank_config_from_embedding(config.embedding)
    candidate_limit = max(limit, min(int(rerank_config.topN or 20), 50)) if rerank_config_ready(rerank_config) else limit
    fts_items = db.search_fts(clean_query, candidate_limit * 2)
    vector_items: list[KnowledgeCitation] = []
    vector_used = False

    if embedding_config_ready(config.embedding) and vector_store.availability()[0]:
        try:
            vectors = await embed_texts(config.embedding, [clean_query])
            vector_rows = vector_store.search(vectors[0], candidate_limit * 2)
            vector_items = vector_rows_to_citations(vector_rows)
            vector_used = bool(vector_items)
        except Exception as exc:
            logger.warning(f"向量检索失败,回退 FTS: {type(exc).__name__}: {exc}")

    merged = rrf_merge(fts_items, vector_items, candidate_limit)
    rerank_used = False
    rerank_message = None
    if rerank_config_ready(rerank_config) and merged:
        try:
            reranked = await rerank_citations(rerank_config, clean_query, merged)
            merged = reranked.items
            rerank_used = reranked.used
            rerank_message = reranked.message
        except Exception as exc:
            rerank_message = f"Rerank 失败，已使用 RRF 排序: {type(exc).__name__}: {exc}"
            logger.warning(rerank_message)
    source_mode = "hybrid" if vector_used and fts_items else "vector" if vector_used else "fts"
    return KnowledgeSearchResponse(
        ok=True,
        query=clean_query,
        sourceMode=source_mode,
        items=merged[:limit],
        rerankUsed=rerank_used,
        rerankMessage=rerank_message,
    )


async def hit_test_knowledge(
    query: str,
    limit: int = 8,
    search_mode: str = "hybrid",
    min_score: float = 0,
) -> KnowledgeHitTestResponse:
    clean_query = query.strip()
    normalized_mode = normalize_search_mode(search_mode)
    if not clean_query:
        return KnowledgeHitTestResponse(
            ok=False,
            query=query,
            searchMode=normalized_mode,
            sourceMode="fts",
            error="请输入搜索内容",
        )

    limit = max(1, min(limit, 50))
    min_score = max(0, float(min_score or 0))
    config = storage.get_knowledge_config()
    vector_ok, vector_message = vector_store.availability()
    vector_ready = embedding_config_ready(config.embedding) and vector_ok
    if not embedding_config_ready(config.embedding):
        vector_message = "Embedding 未配置或未启用"

    rerank_config = rerank_config_from_embedding(config.embedding)
    rerank_ready = rerank_config_ready(rerank_config)
    candidate_limit = max(limit, min(int(rerank_config.topN or 20), 50)) if rerank_ready else limit
    fts_hits = db.search_fts_hits(clean_query, candidate_limit * 3) if normalized_mode in {"fts", "hybrid"} else []
    vector_rows: list[dict] = []
    vector_error: str | None = None
    if normalized_mode in {"vector", "hybrid"}:
        if vector_ready:
            try:
                vectors = await embed_texts(config.embedding, [clean_query])
                vector_rows = vector_store.search(vectors[0], candidate_limit * 3)
            except Exception as exc:
                vector_error = f"向量检索失败: {type(exc).__name__}: {exc}"
                logger.warning(vector_error)
        elif normalized_mode == "vector":
            return KnowledgeHitTestResponse(
                ok=False,
                query=clean_query,
                searchMode=normalized_mode,
                sourceMode="vector",
                vectorAvailable=False,
                vectorMessage=vector_message,
                error=vector_message or "向量检索不可用",
            )

    candidates: dict[str, dict] = {}
    for rank, hit in enumerate(fts_hits, start=1):
        item = candidates.setdefault(citation_key(hit.citation), {"citation": hit.citation, "rrf": 0.0})
        fts_score = 1 / rank
        if item.get("ftsRank") is None:
            item["ftsRank"] = rank
            item["ftsScore"] = fts_score
            item["ftsRawRank"] = hit.raw_rank
        item["rrf"] = float(item["rrf"]) + 1 / (RRF_K + rank)

    vector_citations = vector_rows_to_citation_map(vector_rows)
    for rank, row in enumerate(vector_rows, start=1):
        chunk_id = str(row.get("chunk_id", ""))
        citation = vector_citations.get(chunk_id)
        if not citation:
            continue
        item = candidates.setdefault(citation_key(citation), {"citation": citation, "rrf": 0.0})
        distance = row.get("_distance")
        vector_score = 1 / (1 + float(distance)) if distance is not None else 1 / rank
        if item.get("vectorRank") is None:
            item["vectorRank"] = rank
            item["vectorScore"] = vector_score
            item["vectorDistance"] = float(distance) if distance is not None else None
        item["rrf"] = float(item["rrf"]) + 1 / (RRF_K + rank)

    ranked = sorted(
        candidates.values(),
        key=lambda item: (
            -float(item["rrf"]),
            item.get("ftsRank") or 999999,
            item.get("vectorRank") or 999999,
            item["citation"].title.lower(),
        ),
    )

    result_items: list[KnowledgeHitTestItem] = []
    for item in ranked:
        best_score = max(float(item.get("ftsScore") or 0), float(item.get("vectorScore") or 0))
        if best_score < min_score:
            continue
        citation: KnowledgeCitation = item["citation"]
        matched_by = []
        if item.get("ftsRank") is not None:
            matched_by.append("fts")
        if item.get("vectorRank") is not None:
            matched_by.append("vector")
        citation_payload = citation.model_dump()
        citation_payload["score"] = round(float(item["rrf"]), 6)
        result_items.append(
            KnowledgeHitTestItem(
                **citation_payload,
                rank=len(result_items) + 1,
                matchedBy=matched_by,
                ftsRank=item.get("ftsRank"),
                ftsScore=_round_optional(item.get("ftsScore")),
                ftsRawRank=_round_optional(item.get("ftsRawRank")),
                vectorRank=item.get("vectorRank"),
                vectorScore=_round_optional(item.get("vectorScore")),
                vectorDistance=_round_optional(item.get("vectorDistance")),
                rrfScore=round(float(item["rrf"]), 6),
                rrfRank=len(result_items) + 1,
            )
        )
        if len(result_items) >= candidate_limit:
            break

    rerank_used = False
    rerank_message = None
    if rerank_ready and result_items:
        try:
            reranked = await rerank_citations(rerank_config, clean_query, result_items)
            rerank_used = reranked.used
            rerank_message = reranked.message
            if reranked.used:
                result_items = [
                    KnowledgeHitTestItem(
                        **item.model_dump(exclude={"rank", "matchedBy"}),
                        rank=index,
                        matchedBy=[*item.matchedBy, "rerank"] if "rerank" not in item.matchedBy else item.matchedBy,
                    )
                    for index, item in enumerate(reranked.items, start=1)
                ]
        except Exception as exc:
            rerank_message = f"Rerank 失败，已使用 RRF 排序: {type(exc).__name__}: {exc}"
            logger.warning(rerank_message)

    result_items = result_items[:limit]

    source_mode = "hybrid" if any("fts" in item.matchedBy for item in result_items) and any(
        "vector" in item.matchedBy for item in result_items
    ) else "vector" if any("vector" in item.matchedBy for item in result_items) else "fts"
    return KnowledgeHitTestResponse(
        ok=True,
        query=clean_query,
        searchMode=normalized_mode,
        sourceMode=source_mode,
        items=result_items,
        vectorAvailable=vector_ready,
        vectorMessage=vector_error or vector_message,
        rerankUsed=rerank_used,
        rerankMessage=rerank_message,
    )


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


def vector_rows_to_citation_map(rows: list[dict]) -> dict[str, KnowledgeCitation]:
    chunk_ids = [str(row.get("chunk_id", "")) for row in rows if row.get("chunk_id")]
    details = db.get_chunks_by_ids(chunk_ids)
    items: dict[str, KnowledgeCitation] = {}
    for index, row in enumerate(rows):
        chunk_id = str(row.get("chunk_id", ""))
        item = details.get(chunk_id)
        if not item:
            continue
        distance = row.get("_distance")
        item.score = 1 / (1 + float(distance)) if distance is not None else 1 / (1 + index)
        items[chunk_id] = item
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
            key = citation_key(item)
            by_id.setdefault(key, item)
            scores[key] = scores.get(key, 0) + 1 / (RRF_K + rank)
    ranked = sorted(by_id.values(), key=lambda item: scores.get(citation_key(item), 0), reverse=True)
    for item in ranked:
        item.score = round(scores.get(citation_key(item), 0), 6)
    return ranked[:limit]


def normalize_search_mode(search_mode: str | None) -> str:
    mode = (search_mode or "hybrid").strip().lower()
    return mode if mode in VALID_SEARCH_MODES else "hybrid"


def _round_optional(value: object) -> float | None:
    if value is None:
        return None
    return round(float(value), 6)


def citation_key(item: KnowledgeCitation) -> str:
    return item.paragraphId or item.chunkId
