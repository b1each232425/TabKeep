from __future__ import annotations

from dataclasses import dataclass

import httpx

from schemas.knowledge import EmbeddingConfig, KnowledgeCitation, RerankConfig


DEFAULT_RERANK_MODEL = "BAAI/bge-reranker-v2-m3"
DEFAULT_RERANK_TOP_N = 20


@dataclass
class RerankResult:
    items: list[KnowledgeCitation]
    used: bool
    message: str | None = None


def rerank_config_from_embedding(config: EmbeddingConfig) -> RerankConfig:
    return RerankConfig(
        enabled=bool(config.enabled and config.baseURL.strip() and config.apiKey.strip()),
        baseURL=config.baseURL,
        apiKey=config.apiKey,
        model=DEFAULT_RERANK_MODEL,
        topN=DEFAULT_RERANK_TOP_N,
    )


def rerank_config_ready(config: RerankConfig) -> bool:
    return bool(config.enabled and config.baseURL.strip() and config.apiKey.strip() and config.model.strip())


async def rerank_citations(
    config: RerankConfig,
    query: str,
    items: list[KnowledgeCitation],
) -> RerankResult:
    if not items:
        return RerankResult(items=items, used=False)
    if not rerank_config_ready(config):
        return RerankResult(items=items, used=False, message="Rerank 未配置或未启用")

    top_n = max(1, min(int(config.topN or 20), len(items), 50))
    candidates = items[:top_n]
    documents = [citation_text(item) for item in candidates]
    payload = {
        "model": config.model.strip(),
        "query": query,
        "documents": documents,
        "top_n": len(documents),
        "return_documents": False,
    }
    endpoint = f"{config.baseURL.strip().rstrip('/')}/rerank"
    headers = {
        "Authorization": f"Bearer {config.apiKey.strip()}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(endpoint, json=payload, headers=headers)
        response.raise_for_status()
        data = response.json()

    ordered: list[KnowledgeCitation] = []
    seen_indexes: set[int] = set()
    for result in data.get("results", []):
        try:
            index = int(result.get("index"))
        except (TypeError, ValueError):
            continue
        if index < 0 or index >= len(candidates) or index in seen_indexes:
            continue
        score = result.get("relevance_score")
        item = candidates[index]
        if score is not None:
            item.rerankScore = round(float(score), 6)
            item.score = item.rerankScore
        ordered.append(item)
        seen_indexes.add(index)

    if not ordered:
        return RerankResult(items=items, used=False, message="Rerank 返回为空，已保留原排序")

    ordered.extend(item for index, item in enumerate(candidates) if index not in seen_indexes)
    ordered.extend(items[top_n:])
    return RerankResult(items=ordered, used=True)


def citation_text(item: KnowledgeCitation) -> str:
    parts = [
        f"标题: {item.paragraphTitle or item.title}",
        f"路径: {item.path or item.url or item.documentId}",
        f"内容: {item.matchedContent or item.content}",
    ]
    return "\n".join(part for part in parts if part.strip())
