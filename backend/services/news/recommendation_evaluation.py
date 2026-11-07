"""仅供开发使用的本机资讯推荐对照评估工具。"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import html
import json
import math
import random
import re
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from schemas.knowledge import EmbeddingConfig
from services import storage
from services.knowledge.embeddings import embed_texts, embedding_config_ready
from services.news import db, interest, semantic


DEFAULT_SAMPLE_SIZE = 30
MAX_EMBED_TEXTS_PER_REQUEST = semantic.MAX_EMBED_TEXTS_PER_REQUEST
BODY_TEXT_LIMIT = semantic.BODY_TEXT_LIMIT
RRF_RANK_CONSTANT = interest.RRF_RANK_CONSTANT
LABEL_INTERESTED = "interested"
LABEL_NOT_INTERESTED = "not_interested"
LABEL_UNSURE = "unsure"
ALLOWED_LABELS = {LABEL_INTERESTED, LABEL_NOT_INTERESTED, LABEL_UNSURE}
URL_PATTERN = re.compile(r"https?://\S+", re.IGNORECASE)
HTML_TAG_PATTERN = re.compile(r"<[^>]+>")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _parse_time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _evaluation_dir() -> Path:
    return storage.DATA_DIR / "news_recommendation_evaluations"


def _run_path(run_id: str) -> Path:
    if not re.fullmatch(r"[a-f0-9]{12}", run_id):
        raise ValueError("评估批次 ID 格式无效")
    return _evaluation_dir() / f"{run_id}.json"


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def _read_run(run_id: str) -> dict[str, Any]:
    path = _run_path(run_id)
    if not path.exists():
        raise ValueError("找不到评估批次；请先执行 prepare")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError("评估批次文件无法读取") from exc
    if not isinstance(value, dict) or value.get("id") != run_id:
        raise ValueError("评估批次文件格式无效")
    return value


def _item_fingerprint(row: dict[str, object]) -> str:
    title = str(row.get("title") or "")
    content = str(row.get("content") or "")
    digest = hashlib.blake2b(f"{title}\0{content}".encode("utf-8"), digest_size=20)
    return digest.hexdigest()


def _clean_display_text(value: str) -> str:
    cleaned = URL_PATTERN.sub(" ", value)
    cleaned = HTML_TAG_PATTERN.sub(" ", cleaned)
    cleaned = html.unescape(cleaned)
    return re.sub(r"\s+", " ", cleaned).strip()


def _body_embedding_text(row: dict[str, object]) -> str:
    return semantic.body_embedding_text(row)


def _candidate_pool() -> list[dict[str, object]]:
    return [
        row
        for row in db.list_recommendation_candidates()
        if not row.get("user_feedback")
        and str(row.get("title") or "").strip()
        and _clean_display_text(str(row.get("content") or ""))
    ]


def _publication_month(row: dict[str, object]) -> str:
    value = str(row.get("published_at") or row.get("fetched_at") or "").strip()
    if not value:
        return "undated"
    try:
        published = _parse_time(value)
    except (TypeError, ValueError, OverflowError):
        return "undated"
    return published.strftime("%Y-%m")


def _previously_evaluated_items() -> tuple[set[str], set[str]]:
    """读取本机历史批次的 ID 与内容指纹，避免重复进入独立评估样本。"""
    used_ids: set[str] = set()
    used_fingerprints: set[str] = set()
    directory = _evaluation_dir()
    if not directory.exists():
        return used_ids, used_fingerprints

    for path in sorted(directory.glob("*.json")):
        run_id = path.stem
        if not re.fullmatch(r"[a-f0-9]{12}", run_id):
            continue
        try:
            manifest = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError("历史评估批次元数据无法读取，暂不能保证新样本独立") from error
        if (
            not isinstance(manifest, dict)
            or manifest.get("id") != run_id
            or not isinstance(manifest.get("items"), list)
        ):
            raise ValueError("历史评估批次格式无效，暂不能保证新样本独立")
        for record in manifest["items"]:
            if not isinstance(record, dict):
                raise ValueError("历史评估批次条目格式无效，暂不能保证新样本独立")
            item_id = str(record.get("itemId") or "")
            fingerprint = str(record.get("contentFingerprint") or "")
            if not item_id or not fingerprint:
                raise ValueError("历史评估批次缺少去重信息，暂不能保证新样本独立")
            used_ids.add(item_id)
            used_fingerprints.add(fingerprint)
    return used_ids, used_fingerprints


def _balanced_source_time_rows(
    rows: list[dict[str, object]],
    count: int,
    seed: int,
    rank_band_by_id: dict[str, str] | None = None,
) -> list[dict[str, object]]:
    """以推荐位置、来源和发布时间月份的交叉分层轮转抽样。"""
    randomizer = random.Random(seed)
    buckets: dict[tuple[str, str, str], list[dict[str, object]]] = {}
    for row in rows:
        item_id = str(row.get("id") or "")
        position_key = (rank_band_by_id or {}).get(item_id, "unranked")
        source_key = str(row.get("source_id") or "")
        stratum = (position_key, source_key, _publication_month(row))
        buckets.setdefault(stratum, []).append(row)
    strata = sorted(buckets)
    randomizer.shuffle(strata)
    for bucket in buckets.values():
        randomizer.shuffle(bucket)

    selected: list[dict[str, object]] = []
    while strata and len(selected) < count:
        next_strata: list[tuple[str, str]] = []
        for stratum in strata:
            bucket = buckets[stratum]
            if bucket and len(selected) < count:
                selected.append(bucket.pop())
            if bucket:
                next_strata.append(stratum)
        strata = next_strata
    return selected


def prepare_evaluation(sample_size: int = DEFAULT_SAMPLE_SIZE, seed: int = 20261019) -> dict[str, object]:
    """创建只含资讯条目 ID 和版本信息的本机评估批次。"""
    if sample_size < 6:
        raise ValueError("评估样本至少需要 6 篇资讯")
    profile = interest.current_profile()
    profile_topics = [
        {
            "key": str(topic.get("key") or ""),
            "label": str(topic.get("label") or ""),
            "score": float(topic.get("score") or 0.0),
            "evidenceCount": int(topic.get("evidenceCount") or 0),
            "keywords": [str(value) for value in topic.get("keywords", [])],
        }
        for topic in profile.get("topics", [])
    ]
    if not any(float(topic["score"]) > 0 for topic in profile_topics):
        raise ValueError("当前还没有正向兴趣画像，先积累打开或赞踩行为后再评估")

    previously_used_ids, previously_used_fingerprints = _previously_evaluated_items()
    raw_candidates = _candidate_pool()
    candidates: list[dict[str, object]] = []
    seen_ids: set[str] = set()
    seen_fingerprints: set[str] = set()
    for row in raw_candidates:
        item_id = str(row.get("id") or "")
        fingerprint = _item_fingerprint(row)
        if (
            not item_id
            or item_id in previously_used_ids
            or fingerprint in previously_used_fingerprints
            or item_id in seen_ids
            or fingerprint in seen_fingerprints
        ):
            continue
        candidates.append(row)
        seen_ids.add(item_id)
        seen_fingerprints.add(fingerprint)
    if len(candidates) < sample_size:
        raise ValueError(
            f"需要 {sample_size} 篇未用于历史评估且内容不重复的资讯；当前只有 {len(candidates)} 篇。"
            "请等新资讯积累后再创建批次。"
        )
    # Preparing a blind evaluation sample must never trigger an embedding request.
    all_candidate_count = len(raw_candidates)
    baseline_result = interest.keyword_recommended_items(None, max(all_candidate_count, 1), 0)
    candidate_by_id = {str(row["id"]): row for row in candidates}
    baseline_rank: dict[str, int] = {}
    for rank, row in enumerate(baseline_result.get("items", []), start=1):
        item_id = str(row.get("id") or "")
        if item_id in candidate_by_id:
            baseline_rank[item_id] = rank
    baseline_ids = [item_id for item_id in candidate_by_id if item_id in baseline_rank]
    baseline_ids.sort(key=lambda item_id: baseline_rank[item_id])
    ranked_count = len(baseline_result.get("items", []))
    rank_band_one = math.ceil(ranked_count / 3)
    rank_band_two = math.ceil(ranked_count * 2 / 3)
    rank_band_by_id = {
        item_id: (
            "top" if rank <= rank_band_one
            else "middle" if rank <= rank_band_two
            else "tail"
        )
        for item_id, rank in baseline_rank.items()
    }
    rank_band_by_id.update({str(row["id"]): "unranked" for row in candidates if str(row["id"]) not in baseline_rank})
    primary_count = max(1, sample_size // 3)
    selected_ids: set[str] = set()
    groups: list[tuple[str, list[dict[str, object]]]] = []

    primary_window = [
        candidate_by_id[item_id]
        for item_id in baseline_ids
    ]
    primary_rows = _balanced_source_time_rows(
        primary_window,
        min(primary_count, len(primary_window)),
        seed,
        rank_band_by_id,
    )
    groups.append(("keyword_recommendations", primary_rows))
    selected_ids.update(str(row["id"]) for row in primary_rows)

    recent_unranked_rows = sorted(
        (
            row for row in candidates
            if str(row["id"]) not in selected_ids
            and str(row["id"]) not in baseline_rank
        ),
        key=lambda row: (str(row.get("published_at") or row.get("fetched_at") or ""), str(row["id"])),
        reverse=True,
    )
    recent_count = max(1, sample_size // 3)
    recent_window = recent_unranked_rows[:min(len(recent_unranked_rows), recent_count * 3)]
    recent_selection = _balanced_source_time_rows(
        recent_window,
        min(recent_count, len(recent_window)),
        seed + 1,
        rank_band_by_id,
    )
    groups.append(("recent_not_ranked", recent_selection))
    selected_ids.update(str(row["id"]) for row in recent_selection)

    random_rows = [row for row in candidates if str(row["id"]) not in selected_ids]
    remaining_count = sample_size - len(selected_ids)
    random_selection = _balanced_source_time_rows(
        random_rows, remaining_count, seed + 2, rank_band_by_id
    )
    groups.append(("source_time_balanced_random", random_selection))
    selected_ids.update(str(row["id"]) for row in random_selection)

    now = _now()
    profile_events = db.list_interest_events(
        str(profile.get("windowStart") or "0001-01-01T00:00:00Z"),
        str(profile.get("windowEnd") or _iso(now)),
    )
    source_scores = interest._source_affinity_scores(profile_events, now)
    run_id = uuid.uuid4().hex[:12]
    group_by_id = {
        str(row["id"]): group
        for group, rows in groups
        for row in rows
    }
    records = []
    for row in candidates:
        item_id = str(row["id"])
        if item_id not in selected_ids:
            continue
        rank = baseline_rank.get(item_id)
        rank_band = rank_band_by_id[item_id]
        records.append({
            "itemId": item_id,
            "contentFingerprint": _item_fingerprint(row),
            "sampleGroup": group_by_id.get(item_id, "other"),
            "keywordRank": rank,
            "keywordRankBand": rank_band,
            "sourceId": str(row.get("source_id") or ""),
            "publishedMonth": _publication_month(row),
        })
    random.Random(seed).shuffle(records)
    manifest: dict[str, object] = {
        "id": run_id,
        "createdAt": _iso(now),
        "rankingTime": _iso(now),
        "seed": seed,
        "algorithmVersion": interest.ALGORITHM_VERSION,
        "sampleSize": len(records),
        "profile": {
            "windowStart": profile.get("windowStart"),
            "windowEnd": profile.get("windowEnd"),
            "topics": profile_topics,
        },
        "sourceScores": source_scores,
        "items": records,
        "labels": {},
    }
    _write_json(_run_path(run_id), manifest)
    return {
        "runId": run_id,
        "sampleSize": len(records),
        "algorithmVersion": interest.ALGORITHM_VERSION,
        "path": str(_run_path(run_id)),
        "labelCommand": f"python -m services.news.recommendation_evaluation label --run-id {run_id}",
    }


def label_evaluation(run_id: str, input_fn: Any = input, output_fn: Any = print) -> int:
    """在终端逐篇收集本机评估标签，不生成兴趣行为事件。"""
    manifest = _read_run(run_id)
    labels = dict(manifest.get("labels") or {})
    item_records = list(manifest.get("items") or [])
    for index, record in enumerate(item_records, start=1):
        item_id = str(record.get("itemId") or "")
        if item_id in labels:
            continue
        item = db.get_item(item_id)
        if item is None or _item_fingerprint(item) != str(record.get("contentFingerprint") or ""):
            raise ValueError("评估资讯已删除或内容已变化；请重新创建评估批次")
        title = _clean_display_text(str(item.get("title") or ""))
        content = _clean_display_text(str(item.get("content") or ""))[:900]
        output_fn(f"\n[{index}/{len(item_records)}] {title}\n{content or '（没有正文摘要）'}")
        output_fn("只按正文主题判断兴趣：1=感兴趣，0=不感兴趣，?=不确定，q=保存并退出")
        while True:
            answer = str(input_fn("标注> ")).strip().lower()
            if answer in {"1", "0", "?", "q"}:
                break
            output_fn("请输入 1、0、? 或 q。")
        if answer == "q":
            break
        labels[item_id] = {
            "1": LABEL_INTERESTED,
            "0": LABEL_NOT_INTERESTED,
            "?": LABEL_UNSURE,
        }[answer]
        manifest["labels"] = labels
        _write_json(_run_path(run_id), manifest)
    return len(labels)


def get_evaluation_batch(run_id: str) -> dict[str, object]:
    """返回开发评估页所需的盲测内容，不暴露来源和基线名次。"""
    manifest = _read_run(run_id)
    labels = dict(manifest.get("labels") or {})
    items: list[dict[str, object]] = []
    for record in manifest.get("items", []):
        item_id = str(record.get("itemId") or "")
        item = db.get_item(item_id)
        if item is None or _item_fingerprint(item) != str(record.get("contentFingerprint") or ""):
            raise ValueError("评估资讯已删除或内容已变化；请重新创建评估批次")
        items.append(
            {
                "itemId": item_id,
                "title": _clean_display_text(str(item.get("title") or "")),
                "excerpt": _clean_display_text(str(item.get("content") or ""))[:900],
                "label": labels.get(item_id),
            }
        )
    return {
        "runId": run_id,
        "algorithmVersion": str(manifest.get("algorithmVersion") or ""),
        "sampleSize": len(items),
        "items": items,
    }


def save_evaluation_labels(run_id: str, labels_to_save: dict[str, str | None]) -> dict[str, object]:
    """只更新独立评估文件中的人工标签，不写入兴趣行为事件。"""
    manifest = _read_run(run_id)
    item_ids = {
        str(record.get("itemId") or "")
        for record in manifest.get("items", [])
    }
    unknown_ids = set(labels_to_save) - item_ids
    if unknown_ids:
        raise ValueError("标注中包含不属于此评估批次的资讯")
    labels = dict(manifest.get("labels") or {})
    for item_id, label in labels_to_save.items():
        if label is None:
            labels.pop(item_id, None)
        elif label in ALLOWED_LABELS:
            labels[item_id] = label
        else:
            raise ValueError("标注类型无效")
    manifest["labels"] = labels
    _write_json(_run_path(run_id), manifest)
    determinate_labels = {
        str(item_id): str(label)
        for item_id, label in labels.items()
        if str(label) in {LABEL_INTERESTED, LABEL_NOT_INTERESTED}
    }
    return {
        "labeledCount": len(labels),
        "sampleSize": len(item_ids),
        "readyToEvaluate": _metrics_are_sufficient(determinate_labels),
    }


def _model_signature(config: EmbeddingConfig) -> str:
    return semantic.model_signature(config)


def _embedding_cache_path() -> Path:
    return semantic.embedding_cache_path()


def _load_embedding_cache() -> dict[str, list[float]]:
    return semantic.load_embedding_cache(_embedding_cache_path())


async def _embed_cached(
    config: EmbeddingConfig,
    texts: list[str],
) -> list[list[float]]:
    return await semantic.embed_cached(
        config,
        texts,
        embedder=embed_texts,
        cache_path=_embedding_cache_path(),
    )


def _cosine(left: list[float], right: list[float]) -> float:
    return semantic.cosine(left, right)


def _topic_embedding_text(topic: dict[str, object]) -> str:
    return semantic.topic_embedding_text(topic)


def _semantic_scores(
    profile_topics: list[dict[str, object]],
    topic_vectors: list[list[float]],
    item_vectors: dict[str, list[float]],
) -> dict[str, dict[str, object]]:
    return semantic.semantic_scores(profile_topics, topic_vectors, item_vectors)


def _dcg(relevances: list[int], limit: int) -> float:
    return sum(
        relevance / math.log2(index + 2)
        for index, relevance in enumerate(relevances[:limit])
    )


def _ranking_metrics(
    ranked: list[dict[str, object]],
    labels: dict[str, str],
) -> dict[str, float | int | None]:
    """按整批确定标签计算排序指标；未进入推荐榜的文章按未推荐处理。"""
    relevant_ids = {item_id for item_id, label in labels.items() if label == LABEL_INTERESTED}
    ordered_ids = list(dict.fromkeys(
        str(item["row"]["id"])
        for item in ranked
        if str(item["row"]["id"]) in labels
    ))
    relevances = [1 if item_id in relevant_ids else 0 for item_id in ordered_ids]
    ideal = [1] * len(relevant_ids) + [0] * (len(labels) - len(relevant_ids))
    ideal_dcg = _dcg(ideal, len(labels))
    ndcg = _dcg(relevances, len(labels)) / ideal_dcg if ideal_dcg > 0 else 0.0
    relevant_seen = 0
    precision_sum = 0.0
    for rank, relevance in enumerate(relevances, start=1):
        if relevance:
            relevant_seen += 1
            precision_sum += relevant_seen / rank
    average_precision = precision_sum / len(relevant_ids) if relevant_ids else 0.0

    rank_by_id = {item_id: rank for rank, item_id in enumerate(ordered_ids, start=1)}
    negative_ids = {
        item_id for item_id, label in labels.items()
        if label == LABEL_NOT_INTERESTED
    }
    pairwise_auc: float | None = None
    if relevant_ids and negative_ids:
        correctly_ordered_pairs = 0.0
        for positive_id in relevant_ids:
            positive_rank = rank_by_id.get(positive_id)
            for negative_id in negative_ids:
                negative_rank = rank_by_id.get(negative_id)
                if positive_rank is None and negative_rank is None:
                    correctly_ordered_pairs += 0.5
                elif positive_rank is not None and negative_rank is None:
                    correctly_ordered_pairs += 1.0
                elif positive_rank is not None and negative_rank is not None:
                    correctly_ordered_pairs += float(positive_rank < negative_rank)
        pairwise_auc = correctly_ordered_pairs / (len(relevant_ids) * len(negative_ids))

    return {
        "ndcgAll": ndcg,
        "averagePrecision": average_precision,
        "pairwiseAuc": pairwise_auc,
        "coverage": len(ordered_ids) / len(labels) if labels else 0.0,
        "rankedCount": len(ordered_ids),
        "judgedCount": len(labels),
    }


def _random_ranking_baseline(labels: dict[str, str]) -> dict[str, float | None]:
    """计算按本批正负比例随机打乱时的期望指标，作为分布基线。"""
    determinate_labels = [
        label for label in labels.values()
        if label in {LABEL_INTERESTED, LABEL_NOT_INTERESTED}
    ]
    total_count = len(determinate_labels)
    relevant_count = sum(label == LABEL_INTERESTED for label in determinate_labels)
    negative_count = sum(label == LABEL_NOT_INTERESTED for label in determinate_labels)
    if total_count == 0:
        return {"ndcgAll": 0.0, "averagePrecision": 0.0, "pairwiseAuc": None}

    discounts = [1 / math.log2(rank + 1) for rank in range(1, total_count + 1)]
    ideal_dcg = _dcg([1] * relevant_count, total_count)
    expected_dcg = (relevant_count / total_count) * sum(discounts)
    ndcg = expected_dcg / ideal_dcg if ideal_dcg > 0 else 0.0

    harmonic_sum = sum(1 / rank for rank in range(1, total_count + 1))
    positive_probability = relevant_count / total_count
    pair_probability = (
        relevant_count * (relevant_count - 1) / (total_count * (total_count - 1))
        if total_count > 1
        else 0.0
    )
    expected_ap = (
        (positive_probability * harmonic_sum + pair_probability * (total_count - harmonic_sum))
        / relevant_count
        if relevant_count > 0
        else 0.0
    )
    return {
        "ndcgAll": ndcg,
        "averagePrecision": expected_ap,
        "pairwiseAuc": 0.5 if relevant_count and negative_count else None,
    }


def _reciprocal_rank_fusion(
    keyword_ranked: list[dict[str, object]],
    semantic_ranked: list[dict[str, object]],
    rank_constant: int = RRF_RANK_CONSTANT,
) -> list[dict[str, object]]:
    """使用正式推荐共用的 RRF 实现。"""
    return interest._reciprocal_rank_fusion(
        keyword_ranked, semantic_ranked, rank_constant=rank_constant
    )


def _metrics_are_sufficient(labels: dict[str, str]) -> bool:
    positives = sum(label == LABEL_INTERESTED for label in labels.values())
    negatives = sum(label == LABEL_NOT_INTERESTED for label in labels.values())
    return len(labels) >= 10 and positives >= 3 and negatives >= 3


def _sample_coverage(records: list[dict[str, Any]]) -> dict[str, object]:
    rank_bands = {"top": 0, "middle": 0, "tail": 0, "unranked": 0}
    for record in records:
        band = str(record.get("keywordRankBand") or "unranked")
        rank_bands[band] = rank_bands.get(band, 0) + 1
    return {
        "sourceCount": len({str(record.get("sourceId") or "") for record in records if record.get("sourceId")}),
        "publicationMonthCount": len({
            str(record.get("publishedMonth") or "")
            for record in records
            if record.get("publishedMonth") and record.get("publishedMonth") != "undated"
        }),
        "keywordRankBands": rank_bands,
    }


def _sample_group_summaries(
    manifest: dict[str, Any],
    labels: dict[str, str],
    rankings: dict[str, list[dict[str, object]]],
) -> dict[str, dict[str, object]]:
    records = [record for record in manifest.get("items", []) if isinstance(record, dict)]
    saved_labels = dict(manifest.get("labels") or {})
    grouped_ids: dict[str, list[str]] = {}
    for record in records:
        item_id = str(record.get("itemId") or "")
        group = str(record.get("sampleGroup") or "other")
        if item_id:
            grouped_ids.setdefault(group, []).append(item_id)

    summaries: dict[str, dict[str, object]] = {}
    for group, item_ids in grouped_ids.items():
        group_labels = {item_id: labels[item_id] for item_id in item_ids if item_id in labels}
        group_saved_labels = {
            item_id: str(saved_labels[item_id])
            for item_id in item_ids
            if str(saved_labels.get(item_id) or "") in ALLOWED_LABELS
        }
        summaries[group] = {
            "sampleCount": len(item_ids),
            "labeledCount": len(group_saved_labels),
            "judgedCount": len(group_labels),
            "interestedCount": sum(label == LABEL_INTERESTED for label in group_saved_labels.values()),
            "notInterestedCount": sum(label == LABEL_NOT_INTERESTED for label in group_saved_labels.values()),
            "unsureCount": sum(label == LABEL_UNSURE for label in group_saved_labels.values()),
            "randomBaseline": _random_ranking_baseline(group_labels),
            "metrics": {
                mode: _ranking_metrics(ranked, group_labels)
                for mode, ranked in rankings.items()
            },
        }
    return summaries


async def evaluate_run(run_id: str) -> dict[str, object]:
    """显式执行语义对照；资讯正文只传给配置的 embedding provider。"""
    manifest = _read_run(run_id)
    labels = {
        str(item_id): str(label)
        for item_id, label in dict(manifest.get("labels") or {}).items()
        if str(label) in {LABEL_INTERESTED, LABEL_NOT_INTERESTED}
    }
    if not _metrics_are_sufficient(labels):
        raise ValueError("至少需要 10 条确定标签，且感兴趣与不感兴趣各至少 3 条")

    config = storage.get_knowledge_config().embedding
    if not embedding_config_ready(config):
        raise ValueError("请先在知识库设置中启用并配置 embedding 模型，再显式运行 evaluate")

    records = {str(row.get("itemId")): row for row in manifest.get("items", [])}
    all_candidates = db.list_recommendation_candidates()
    candidates_by_id = {str(row.get("id")): row for row in all_candidates}
    selected_rows: list[dict[str, object]] = []
    for item_id in labels:
        record = records.get(item_id)
        item = candidates_by_id.get(item_id)
        if record is None or item is None:
            raise ValueError("评估资讯已删除；请重新创建评估批次")
        if _item_fingerprint(item) != str(record.get("contentFingerprint") or ""):
            raise ValueError("评估资讯已更新；请重新创建评估批次")
        selected_rows.append(item)

    profile = dict(manifest.get("profile") or {})
    profile_topics = [dict(topic) for topic in profile.get("topics", [])]
    topics_with_text = [
        (topic, _topic_embedding_text(topic))
        for topic in profile_topics
        if _topic_embedding_text(topic)
    ]
    if not any(float(topic.get("score") or 0.0) > 0 for topic, _text in topics_with_text):
        raise ValueError("评估批次没有可用的正向兴趣主题；请重新创建批次")

    item_texts: dict[str, str] = {}
    for row in selected_rows:
        # 只发送正文，不发送资讯 URL、原始浏览器历史或来源信息。
        body = _body_embedding_text(row)
        if body:
            item_texts[str(row["id"])] = body
    if len(item_texts) < 6:
        raise ValueError("标注资讯中有正文的条目不足 6 篇，无法评估语义排序")

    topic_vectors = await _embed_cached(config, [text for _topic, text in topics_with_text])
    item_ids = list(item_texts)
    item_vectors_flat = await _embed_cached(config, [item_texts[item_id] for item_id in item_ids])
    semantic_topics = [topic for topic, _text in topics_with_text]
    semantic_scores = _semantic_scores(
        semantic_topics,
        topic_vectors,
        dict(zip(item_ids, item_vectors_flat, strict=True)),
    )

    source_scores = {
        str(source_id): float(score)
        for source_id, score in dict(manifest.get("sourceScores") or {}).items()
    }
    ranking_time = _parse_time(str(manifest.get("rankingTime") or _iso(_now())))
    selected_ids = set(labels)
    profile_events: list[dict[str, object]] = []
    rankings = {
        mode: interest._rank_candidate_rows(
            all_candidates,
            profile_topics,
            profile_events,
            ranking_time,
            selected_ids=selected_ids,
            semantic_scores=semantic_scores,
            ranking_mode=mode,
            source_scores_override=source_scores,
        )
        for mode in ("keyword", "semantic", "hybrid")
    }
    rankings["rrf"] = _reciprocal_rank_fusion(rankings["keyword"], rankings["semantic"])
    metrics = {
        mode: _ranking_metrics(ranked, labels)
        for mode, ranked in rankings.items()
    }
    sample_records = [record for record in manifest.get("items", []) if isinstance(record, dict)]
    sample_groups = _sample_group_summaries(manifest, labels, rankings)
    baseline = metrics["keyword"]
    baseline_auc = float(baseline["pairwiseAuc"] or 0.0)
    eligible = [
        mode
        for mode in ("semantic", "hybrid", "rrf")
        if float(metrics[mode]["ndcgAll"]) > float(baseline["ndcgAll"])
        and float(metrics[mode]["averagePrecision"]) >= float(baseline["averagePrecision"])
        and float(metrics[mode]["pairwiseAuc"] or 0.0) >= baseline_auc
        and float(metrics[mode]["coverage"]) >= float(baseline["coverage"])
    ]
    random_baseline = _random_ranking_baseline(labels)
    result: dict[str, object] = {
        "runId": run_id,
        "algorithmVersion": manifest.get("algorithmVersion"),
        "embeddingModel": config.model,
        "rrfRankConstant": RRF_RANK_CONSTANT,
        "sampleSize": len(records),
        "judgedCount": len(labels),
        "metricsSufficient": _metrics_are_sufficient(labels),
        "metrics": metrics,
        "sampleCoverage": _sample_coverage(sample_records),
        "sampleGroups": sample_groups,
        "randomBaseline": random_baseline,
        "recommendation": (
            f"初步支持继续验证：{', '.join(eligible)} 排序的全量 NDCG 提高，AP、AUC 和覆盖率未下降；线上排序保持不变。"
            if eligible
            else "当前样本中没有对照方案同时改善全量排序指标并维持 AP、AUC 和覆盖率；线上排序保持不变。"
        ),
        "topItems": {
            mode: [
                {
                    "itemId": str(item["row"]["id"]),
                    "label": labels.get(str(item["row"]["id"]), LABEL_UNSURE),
                    "reason": str(item["reason"]),
                }
                for item in ranked[:10]
            ]
            for mode, ranked in rankings.items()
        },
    }
    report_path = _evaluation_dir() / f"{run_id}-report.json"
    _write_json(report_path, result)
    result["reportPath"] = str(report_path)
    return result


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="TabKeep 本机资讯推荐评估工具")
    subparsers = parser.add_subparsers(dest="command", required=True)
    prepare_parser = subparsers.add_parser("prepare", help="本机抽取 30 篇资讯作为盲测样本")
    prepare_parser.add_argument("--size", type=int, default=DEFAULT_SAMPLE_SIZE)
    prepare_parser.add_argument("--seed", type=int, default=20261019)
    label_parser = subparsers.add_parser("label", help="在终端标注样本；标签不进入推荐画像")
    label_parser.add_argument("--run-id", required=True)
    evaluate_parser = subparsers.add_parser("evaluate", help="显式调用 embedding 服务并比较四种排序")
    evaluate_parser.add_argument("--run-id", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    storage.init()
    db.init_db()
    try:
        if args.command == "prepare":
            result = prepare_evaluation(args.size, args.seed)
            print(f"已在本机准备 {result['sampleSize']} 篇盲测资讯，批次：{result['runId']}")
            print(f"批次文件：{result['path']}")
            print(f"下一步：python -m services.news.recommendation_evaluation label --run-id {result['runId']}")
            return 0
        if args.command == "label":
            count = label_evaluation(args.run_id)
            print(f"已在本机保存 {count} 条标签。标签没有写入兴趣事件。")
            print(f"完成后显式运行：python -m services.news.recommendation_evaluation evaluate --run-id {args.run_id}")
            return 0
        result = asyncio.run(evaluate_run(args.run_id))
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    except Exception as exc:
        # 不输出 provider 的请求异常文本，避免异常信息泄露配置或输入内容。
        print(f"评估失败：{type(exc).__name__}。可检查配置或稍后重试。", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
