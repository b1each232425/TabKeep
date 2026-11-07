"""本地资讯语义排序共用的 embedding 清理、缓存和打分逻辑。"""

from __future__ import annotations

import hashlib
import html
import json
import math
import re
from pathlib import Path
from threading import Lock
from typing import Awaitable, Callable

from schemas.knowledge import EmbeddingConfig
from services import storage
from services.knowledge.embeddings import embed_texts


MAX_EMBED_TEXTS_PER_REQUEST = 24
BODY_TEXT_LIMIT = 5_000
TOPIC_TEXT_LIMIT = 300
URL_PATTERN = re.compile(r"https?://\S+", re.IGNORECASE)
HTML_TAG_PATTERN = re.compile(r"<[^>]+>")
_CACHE_WRITE_LOCK = Lock()


def body_embedding_text(row: dict[str, object]) -> str:
    """准备正文向量输入，不包含标题、网址或来源信息。"""
    body = str(row.get("content") or "")
    body = URL_PATTERN.sub(" ", body)
    body = html.unescape(HTML_TAG_PATTERN.sub(" ", body))
    return re.sub(r"\s+", " ", body).strip()[:BODY_TEXT_LIMIT]


def topic_embedding_text(topic: dict[str, object]) -> str:
    label = str(topic.get("label") or topic.get("key") or "").strip()
    keywords = [str(value).strip() for value in topic.get("keywords", []) if str(value).strip()]
    return re.sub(r"\s+", " ", " ".join([label, *keywords])).strip()[:TOPIC_TEXT_LIMIT]


def model_signature(config: EmbeddingConfig) -> str:
    value = f"{config.baseURL.rstrip('/')}\0{config.model}"
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def embedding_cache_path() -> Path:
    # Keep using the existing cache so evaluation vectors are reused by formal ranking.
    return storage.DATA_DIR / "news_recommendation_evaluations" / "embedding-cache.json"


def load_embedding_cache(path: Path | None = None) -> dict[str, list[float]]:
    cache_path = path or embedding_cache_path()
    if not cache_path.exists():
        return {}
    try:
        raw = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(raw, dict):
        return {}
    cache: dict[str, list[float]] = {}
    for key, value in raw.items():
        if isinstance(key, str) and isinstance(value, list):
            try:
                vector = [float(component) for component in value]
            except (TypeError, ValueError):
                continue
            if vector and all(math.isfinite(component) for component in vector):
                cache[key] = vector
    return cache


def _save_embedding_cache(entries: dict[str, list[float]], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with _CACHE_WRITE_LOCK:
        current = load_embedding_cache(path)
        current.update(entries)
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_text(json.dumps(current, ensure_ascii=False), encoding="utf-8")
        temporary.replace(path)


async def embed_cached(
    config: EmbeddingConfig,
    texts: list[str],
    *,
    embedder: Callable[[EmbeddingConfig, list[str]], Awaitable[list[list[float]]]] | None = None,
    cache_path: Path | None = None,
) -> list[list[float]]:
    """调用配置的 embedding provider，按 provider/model/正文摘要复用本机向量。"""
    if not texts:
        return []
    path = cache_path or embedding_cache_path()
    signature = model_signature(config)
    keys = [
        hashlib.sha256(f"{signature}\0{text}".encode("utf-8")).hexdigest()
        for text in texts
    ]
    cached = load_embedding_cache(path)
    result: list[list[float] | None] = [cached.get(key) for key in keys]
    missing: dict[str, tuple[str, list[int]]] = {}
    for index, (key, text) in enumerate(zip(keys, texts, strict=True)):
        if result[index] is None:
            if key not in missing:
                missing[key] = (text, [])
            missing[key][1].append(index)

    call_embedder = embedder or embed_texts
    missing_entries = list(missing.items())
    for offset in range(0, len(missing_entries), MAX_EMBED_TEXTS_PER_REQUEST):
        chunk = missing_entries[offset:offset + MAX_EMBED_TEXTS_PER_REQUEST]
        vectors = await call_embedder(config, [text for _key, (text, _indices) in chunk])
        if len(vectors) != len(chunk):
            raise ValueError("embedding 服务返回的向量数量不匹配")
        new_entries: dict[str, list[float]] = {}
        for (key, (_text, indices)), raw_vector in zip(chunk, vectors, strict=True):
            vector = [float(component) for component in raw_vector]
            if not vector or not all(math.isfinite(component) for component in vector):
                raise ValueError("embedding 服务返回了无效向量")
            new_entries[key] = vector
            for index in indices:
                result[index] = vector
        _save_embedding_cache(new_entries, path)

    dimensions = {len(vector) for vector in result if vector is not None}
    if len(dimensions) > 1 or any(vector is None for vector in result):
        raise ValueError("embedding 服务返回的向量维度不一致")
    return [vector for vector in result if vector is not None]


def cosine(left: list[float], right: list[float]) -> float:
    if len(left) != len(right):
        raise ValueError("embedding 向量维度不匹配")
    left_norm = math.sqrt(sum(value * value for value in left))
    right_norm = math.sqrt(sum(value * value for value in right))
    if left_norm <= 0 or right_norm <= 0:
        return 0.0
    return sum(a * b for a, b in zip(left, right, strict=True)) / (left_norm * right_norm)


def semantic_scores(
    profile_topics: list[dict[str, object]],
    topic_vectors: list[list[float]],
    item_vectors: dict[str, list[float]],
) -> dict[str, dict[str, object]]:
    scored: dict[str, dict[str, object]] = {}
    for item_id, item_vector in item_vectors.items():
        positive: list[tuple[float, str]] = []
        negative: list[tuple[float, str]] = []
        for topic, topic_vector in zip(profile_topics, topic_vectors, strict=True):
            strength = math.tanh(abs(float(topic.get("score") or 0.0)) / 2.5)
            contribution = max(0.0, cosine(item_vector, topic_vector)) * strength
            label = str(topic.get("label") or topic.get("key") or "")
            if float(topic.get("score") or 0.0) > 0:
                positive.append((contribution, label))
            elif float(topic.get("score") or 0.0) < 0:
                negative.append((contribution, label))
        positive.sort(reverse=True)
        negative.sort(reverse=True)
        positive_score = positive[0][0] if positive else 0.0
        negative_penalty = 0.72 * negative[0][0] if negative else 0.0
        scored[item_id] = {
            "positive_score": positive_score,
            "negative_penalty": negative_penalty,
            "positive_labels": [label for score, label in positive[:3] if score > 0],
            "negative_labels": [label for score, label in negative[:2] if score > 0],
        }
    return scored


async def scores_for_candidates(
    config: EmbeddingConfig,
    profile_topics: list[dict[str, object]],
    candidates: list[dict[str, object]],
    *,
    embedder: Callable[[EmbeddingConfig, list[str]], Awaitable[list[list[float]]]] | None = None,
) -> dict[str, dict[str, object]]:
    topic_pairs = [
        (topic, topic_embedding_text(topic))
        for topic in profile_topics
        if topic_embedding_text(topic)
    ]
    item_texts: dict[str, str] = {}
    for row in candidates:
        item_id = str(row.get("id") or "")
        if not item_id:
            continue
        text = body_embedding_text(row)
        if text:
            item_texts[item_id] = text
    if not topic_pairs or not item_texts:
        return {}
    topic_vectors = await embed_cached(
        config, [text for _topic, text in topic_pairs], embedder=embedder
    )
    item_ids = list(item_texts)
    item_vectors = await embed_cached(
        config, [item_texts[item_id] for item_id in item_ids], embedder=embedder
    )
    return semantic_scores(
        [topic for topic, _text in topic_pairs],
        topic_vectors,
        dict(zip(item_ids, item_vectors, strict=True)),
    )
