"""本地资讯行为、兴趣画像和话题建议。"""

import asyncio
import hashlib
import json
import logging
import math
import re
import uuid
from collections import Counter
from threading import Event, Lock
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlsplit

import jieba

from schemas.config import ModelConfig
from services import llm, storage
from services.knowledge.embeddings import embedding_config_ready
from services.news import browser_history, db, semantic
from services.news.url_utils import canonicalize_url


ALGORITHM_VERSION = "local-keywords-v5"
PROFILE_WINDOW_DAYS = 90
_FEEDBACK_BODY_CHAR_LIMIT = 5_000
_RECOMMENDATION_BODY_CHAR_LIMIT = 5_000
_SOURCE_SCORE_LIMIT = 0.12
_SOURCE_SCORE_SCALE = 2.5
_FRESHNESS_SCORE_LIMIT = 0.12
_FRESHNESS_DECAY_DAYS = 3.5
_DIVERSITY_TOP_ITEMS = 20
_DIVERSITY_REUSE_PENALTY = 0.075
_MIN_IDF_SPECIFICITY = 0.08
_TOKEN_RE = re.compile(r"[\u3040-\u30ff\u3400-\u9fff]+|[a-zA-Z][a-zA-Z0-9+#.]*")
_CJK_RE = re.compile(r"[\u3040-\u30ff\u3400-\u9fff]+")
_URL_OR_DOMAIN_TITLE_RE = re.compile(
    r"^(?:https?://)?(?:[a-z0-9-]+\.)+[a-z0-9-]+(?::\d+)?(?:[/?#][^\s]*)?$",
    re.IGNORECASE,
)
_GENERIC_HISTORY_TITLES = {
    "首页", "主页", "搜索", "搜索结果", "登录", "注册", "热门", "热门视频",
    "推荐", "动态", "我的", "个人主页", "个人中心", "收藏", "历史记录", "消息",
}
_NORMALIZED_GENERIC_HISTORY_TITLES = frozenset(
    re.sub(r"[\W_]+", "", value.casefold())
    for value in _GENERIC_HISTORY_TITLES
)
_HISTORY_SITE_TITLE_ALIASES = {
    "bilibili.com": {"哔哩哔哩", "哔哩哔哩弹幕网", "哔哩哔哩゜゜つロ干杯", "哔哩"},
    "pixiv.net": {"pixiv"},
}
_STOP_WORDS = {
    "一个", "一些", "什么", "怎么", "为什么", "今天", "昨天", "现在", "终于", "以及",
    "这是", "那个", "这个", "我们", "他们", "如果", "因为", "可以", "已经", "还是",
    "没有", "不是", "自己", "大家", "关于", "进行", "分享", "最新", "新闻", "资讯",
    "开始", "继续", "目前", "之后", "此前", "其中", "情况", "方面", "相关", "表示",
    "认为", "发生", "使用", "看到", "觉得", "内容", "问题", "时候", "部分",
    "the", "and", "for", "with", "from", "this", "that", "have", "your", "you",
    "are", "was", "were", "will", "about", "into", "after", "when", "what", "how",
}
_EVENT_WEIGHTS = {
    # 来源选择和曝光不直接代表对其文章主题有兴趣。
    "subscription_added": 0.0,
    "reader_impression": 0.0,
    # 外链点击和匹配资讯的浏览历史只作为较弱的内容兴趣信号。
    "open_original": 0.45,
    "history_visit": 0.25,
    # 明确点赞是较强正向信号；不感兴趣反馈与之强度相当、方向相反。
    "like": 3.0,
    "not_interested": -3.0,
    "less_like_this": -2.0,
    "suggestion_accepted": 2.5,
    "suggestion_dismissed": -1.0,
}
_SOURCE_EVENT_WEIGHTS = {
    "subscription_added": 0.25,
    "reader_impression": 0.0,
    "open_original": 0.45,
    "history_visit": 0.25,
    "like": 1.1,
    "not_interested": -1.1,
    "less_like_this": -0.85,
    "suggestion_accepted": 0.8,
    "suggestion_dismissed": -0.4,
}
_IMPORT_CANCEL_LOCK = Lock()
_IMPORT_CANCEL_EVENTS: dict[str, Event] = {}
_TOKENIZED_ITEMS_LOCK = Lock()
_TOKENIZED_ITEMS: dict[str, tuple[str, set[str], set[str]]] = {}
RRF_RANK_CONSTANT = 60
_LOGGER = logging.getLogger(__name__)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _parse_datetime(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _tokens(value: str) -> set[str]:
    """用中文词语和英文词项组成集合，避免字符 n-gram 产生大量伪主题。"""
    tokens: set[str] = set()
    separated = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", value)
    for match in _TOKEN_RE.finditer(separated):
        raw = match.group(0)
        if _CJK_RE.fullmatch(raw):
            words = [word.strip().lower() for word in jieba.cut(raw, cut_all=False)]
        else:
            words = [raw]
        normalized_words = [word.strip(".").lower() for word in words]
        tokens.update(
            word for word in normalized_words
            if len(word) >= 2 and word not in _STOP_WORDS
        )
        # 同时保留相邻中文词组成的短语，弥补专业术语被分词器切开的情况。
        for start in range(len(normalized_words)):
            for size in (2, 3):
                phrase_words = normalized_words[start:start + size]
                if len(phrase_words) != size:
                    continue
                if any(
                    len(word) < 2 or word in _STOP_WORDS or not _CJK_RE.fullmatch(word)
                    for word in phrase_words
                ):
                    continue
                phrase = "".join(phrase_words)
                if 2 <= len(phrase) <= 12 and phrase not in _STOP_WORDS:
                    tokens.add(phrase)
    return tokens


def _normalized_history_title(value: str) -> str:
    """移除站点标题比较时无意义的空白和标点。"""
    return re.sub(r"[\W_]+", "", value.casefold())


def _clean_history_title(title: str, canonical_url: str | None) -> str:
    """清理浏览历史标题里的网址、站点品牌和通用页面标签。"""
    stripped_title = title.strip()
    if not stripped_title or _URL_OR_DOMAIN_TITLE_RE.fullmatch(stripped_title):
        return ""

    normalized_title = _normalized_history_title(stripped_title)
    if normalized_title in _NORMALIZED_GENERIC_HISTORY_TITLES:
        return ""

    if not canonical_url:
        return stripped_title
    try:
        hostname = (urlsplit(canonical_url).hostname or "").casefold().removeprefix("www.")
    except ValueError:
        return stripped_title
    if not hostname:
        return stripped_title

    site_aliases = {hostname, hostname.split(".", 1)[0]}
    for domain, aliases in _HISTORY_SITE_TITLE_ALIASES.items():
        if hostname == domain or hostname.endswith(f".{domain}"):
            site_aliases.update(aliases)

    if any(normalized_title == _normalized_history_title(alias) for alias in site_aliases):
        return ""

    # 站点名只在标题首尾且由分隔符隔开时移除，保留标题中间的实体提及。
    cleaned = stripped_title
    separators = r"[\s\-–—|·:：/]+"
    for alias in sorted(site_aliases, key=len, reverse=True):
        escaped_alias = re.escape(alias)
        cleaned = re.sub(
            rf"^\s*{escaped_alias}{separators}", "", cleaned, flags=re.IGNORECASE
        )
        cleaned = re.sub(
            rf"{separators}{escaped_alias}\s*$", "", cleaned, flags=re.IGNORECASE
        )
    cleaned = re.sub(r"^[\s\-–—|·:：/]+|[\s\-–—|·:：/]+$", "", cleaned)
    normalized_cleaned = _normalized_history_title(cleaned)
    if not cleaned or normalized_cleaned in _NORMALIZED_GENERIC_HISTORY_TITLES:
        return ""
    return cleaned


def _is_non_content_history_title(title: str, canonical_url: str | None) -> bool:
    """判断浏览历史标题是否只包含站点或通用页面信息。"""
    return not _clean_history_title(title, canonical_url)


def _history_site_tokens(canonical_url: str | None) -> set[str]:
    """从浏览历史 URL 派生站点名词项，避免标题中的站点署名变成兴趣。"""
    if not canonical_url:
        return set()
    try:
        hostname = (urlsplit(canonical_url).hostname or "").casefold().removeprefix("www.")
    except ValueError:
        return set()
    if not hostname:
        return set()

    aliases = {hostname, hostname.split(".", 1)[0]}
    for domain, site_names in _HISTORY_SITE_TITLE_ALIASES.items():
        if hostname == domain or hostname.endswith(f".{domain}"):
            aliases.add(domain.split(".", 1)[0])
            aliases.update(site_names)
    return {token for alias in aliases for token in _tokens(alias)}


def _idf_weights(documents: list[set[str]]) -> dict[str, float]:
    """按本地资讯语料的文档频率计算归一化 IDF，语料中常见词权重为零。"""
    if not documents:
        return {}
    if len(documents) == 1:
        # 只有一篇候选资讯时无法判断词频，保留基础匹配以免推荐被整体关闭。
        return {token: 1.0 for token in documents[0]}
    document_frequency: Counter[str] = Counter()
    for tokens in documents:
        document_frequency.update(tokens)
    normalizer = math.log(len(documents) + 1)
    if normalizer <= 0:
        return {}
    weights: dict[str, float] = {}
    for token, frequency in document_frequency.items():
        specificity = math.log((len(documents) + 1) / (frequency + 1)) / normalizer
        # 很多来源都会出现的词即使不是全语料共有，也不应单独触发推荐。
        weights[token] = specificity if specificity >= _MIN_IDF_SPECIFICITY else 0.0
    return weights


def _tokenize_recommendation_candidates(
    rows: list[dict[str, object]],
    source_id: str | None,
) -> tuple[list[tuple[dict[str, object], set[str], set[str]]], list[set[str]]]:
    """缓存候选资讯分词结果，并返回完整语料供 IDF 统计。"""
    selected: list[tuple[dict[str, object], set[str], set[str]]] = []
    corpus_documents: list[set[str]] = []
    active_ids: set[str] = set()
    with _TOKENIZED_ITEMS_LOCK:
        for row in rows:
            item_id = str(row.get("id") or "")
            if not item_id:
                continue
            active_ids.add(item_id)
            title = str(row.get("title") or "")
            content = str(row.get("content") or "")[:_RECOMMENDATION_BODY_CHAR_LIMIT]
            fingerprint = hashlib.blake2b(
                f"{title}\0{content}".encode("utf-8"), digest_size=16
            ).hexdigest()
            cached = _TOKENIZED_ITEMS.get(item_id)
            if cached is None or cached[0] != fingerprint:
                title_tokens = _tokens(title)
                content_tokens = _tokens(content)
                _TOKENIZED_ITEMS[item_id] = (fingerprint, title_tokens, content_tokens)
            else:
                _fingerprint, title_tokens, content_tokens = cached
            corpus_documents.append(title_tokens | content_tokens)
            if source_id is None or str(row.get("source_id") or "") == source_id:
                selected.append((row, title_tokens, content_tokens))
        for stale_id in _TOKENIZED_ITEMS.keys() - active_ids:
            del _TOKENIZED_ITEMS[stale_id]
    return selected, corpus_documents


def record_reader_events(events: list[dict[str, str]]) -> int:
    """将阅读页行为转成只关联本地条目的事件。"""
    timestamp = _iso(_now())
    records: list[dict[str, object]] = []
    for event in events:
        item = db.get_item(event["item_id"])
        if item is None:
            continue
        event_type = event["event_type"]
        records.append(
            {
                "id": uuid.uuid4().hex,
                "origin": "reader",
                "event_type": event_type,
                "occurred_at": timestamp,
                "source_id": item["source_id"],
                "news_item_id": item["id"],
                "canonical_url": item.get("canonical_url") or canonicalize_url(
                    str(item["url"]) if item.get("url") else None
                ),
                "title": item["title"],
                "topic_key": event.get("topic_key"),
                "dedupe_key": f"reader:{event['event_key']}",
                "created_at": timestamp,
            }
        )
    return db.insert_interest_events(records)


def record_extension_history_visits(visits: list[dict[str, str]]) -> int:
    """保存扩展明确授权后同步的浏览器访问事件。"""
    timestamp = _iso(_now())
    normalized: list[tuple[dict[str, str], str]] = []
    for visit in visits:
        canonical_url = canonicalize_url(visit["url"])
        if canonical_url:
            normalized.append((visit, canonical_url))
    matched_items = db.find_items_by_canonical_urls([url for _visit, url in normalized])
    records: list[dict[str, object]] = []
    for visit, canonical_url in normalized:
        matched_item = matched_items.get(canonical_url)
        records.append(
            {
                "id": uuid.uuid4().hex,
                "origin": "browser_extension",
                "event_type": "history_visit",
                "occurred_at": _iso(_parse_datetime(visit["visited_at"])),
                "source_id": matched_item.get("source_id") if matched_item else None,
                "news_item_id": matched_item.get("id") if matched_item else None,
                "canonical_url": canonical_url,
                "title": visit["title"][:500],
                "transition": visit["transition"][:64],
                "dedupe_key": f"extension:{visit['client_id']}:{visit['visit_id']}",
                "created_at": timestamp,
            }
        )
    return db.insert_interest_events(records)


def record_subscription_added(source_id: str) -> bool:
    """记录用户新增或恢复订阅的低权重兴趣信号。"""
    source = db.get_source(source_id)
    if source is None:
        return False
    timestamp = _iso(_now())
    return db.insert_interest_event(
        {
            "id": uuid.uuid4().hex,
            "origin": "subscription",
            "event_type": "subscription_added",
            "occurred_at": timestamp,
            "source_id": source_id,
            "canonical_url": canonicalize_url(str(source["url"])),
            "title": str(source["title"]),
            "dedupe_key": f"subscription:{source_id}:{timestamp}",
            "created_at": timestamp,
        }
    )


def start_browser_history_import(
    profile_id: str,
    range_start: datetime,
    range_end: datetime,
) -> dict[str, object]:
    """创建一个可取消的历史导入任务。"""
    profile = next((item for item in browser_history.list_profiles() if item["id"] == profile_id), None)
    if profile is None:
        raise FileNotFoundError("没有找到所选浏览器配置文件，请刷新列表后重试")
    timestamp = _iso(_now())
    batch_id = uuid.uuid4().hex
    start_text = _iso(range_start)
    end_text = _iso(range_end)
    db.create_interest_import_batch(
        batch_id,
        profile["browser"],
        profile_id,
        start_text,
        end_text,
        timestamp,
    )
    with _IMPORT_CANCEL_LOCK:
        _IMPORT_CANCEL_EVENTS[batch_id] = Event()
    return {
        "batchId": batch_id,
        "browser": profile["browser"],
        "visitsRead": 0,
        "eventsAdded": 0,
        "status": "running",
        "error": None,
    }


def run_browser_history_import(
    batch_id: str,
    profile_id: str,
    range_start: datetime,
    range_end: datetime,
) -> None:
    """后台执行导入；取消时回滚尚未提交的事件。"""
    batch = db.get_interest_import_batch(batch_id)
    if batch is None or str(batch["status"]) != "running":
        return
    with _IMPORT_CANCEL_LOCK:
        cancel_event = _IMPORT_CANCEL_EVENTS.get(batch_id)
    if cancel_event is None:
        cancel_event = Event()
    timestamp = _iso(_now())
    visits_read = 0
    try:
        browser, visits = browser_history.read_visits(
            profile_id, range_start, range_end, cancel_event=cancel_event
        )
        visits_read = len(visits)
        if cancel_event.is_set():
            raise InterruptedError("浏览器历史导入已取消")
        records: list[dict[str, object]] = []
        for visit in visits:
            canonical_url = canonicalize_url(visit["url"])
            if not canonical_url:
                continue
            matched_item = db.find_item_by_canonical_url(canonical_url)
            records.append(
                {
                    "id": uuid.uuid4().hex,
                    "origin": "browser_history",
                    "event_type": "history_visit",
                    "occurred_at": visit["visited_at"],
                    "source_id": matched_item.get("source_id") if matched_item else None,
                    "news_item_id": matched_item.get("id") if matched_item else None,
                    "canonical_url": canonical_url,
                    "title": visit["title"][:500],
                    "dedupe_key": f"browser:{profile_id}:{visit['visit_id']}",
                    "import_batch_id": batch_id,
                    "created_at": timestamp,
                }
            )
        events_added = db.insert_interest_events(records, cancel_event)
        db.finish_interest_import_batch(
            batch_id, "completed", visits_read, events_added, _iso(_now())
        )
    except InterruptedError:
        db.finish_interest_import_batch(
            batch_id, "cancelled", visits_read, 0, _iso(_now())
        )
    except Exception as error:
        message = str(error) if isinstance(error, (FileNotFoundError, RuntimeError)) else "浏览器历史导入失败，请检查配置文件后重试"
        db.finish_interest_import_batch(
            batch_id,
            "failed",
            visits_read,
            0,
            _iso(_now()),
            message,
        )
    finally:
        with _IMPORT_CANCEL_LOCK:
            _IMPORT_CANCEL_EVENTS.pop(batch_id, None)


def get_browser_history_import(batch_id: str) -> dict[str, object] | None:
    """返回不包含浏览器本地路径的导入进度。"""
    batch = db.get_interest_import_batch(batch_id)
    if batch is None:
        return None
    return {
        "batchId": batch["id"],
        "browser": batch["browser"],
        "visitsRead": batch["visits_read"],
        "eventsAdded": batch["events_added"],
        "status": batch["status"],
        "error": batch["error"],
    }


def cancel_browser_history_import(batch_id: str) -> dict[str, object] | None:
    """请求取消进行中的导入；已完成批次保持原状态。"""
    batch = db.get_interest_import_batch(batch_id)
    if batch is None:
        return None
    if str(batch["status"]) == "running":
        with _IMPORT_CANCEL_LOCK:
            cancel_event = _IMPORT_CANCEL_EVENTS.get(batch_id)
        if cancel_event is not None:
            cancel_event.set()
    return get_browser_history_import(batch_id)


def rebuild_profile(window_days: int = PROFILE_WINDOW_DAYS) -> dict[str, object]:
    """按最近活动重建本地兴趣快照。"""
    current = _now()
    start = current - timedelta(days=window_days)
    start_text = _iso(start)
    end_text = _iso(current)
    events = db.list_interest_events(start_text, end_text)
    latest_feedback_by_item: dict[str, str] = {}
    for event in events:
        if str(event.get("event_type") or "") not in {"like", "not_interested"}:
            continue
        item_id = str(event.get("news_item_id") or "")
        if item_id:
            latest_feedback_by_item.setdefault(item_id, str(event["id"]))
    aggregates: dict[str, dict[str, Any]] = {}
    for event in events:
        event_type = str(event["event_type"])
        if event_type in {"like", "not_interested"}:
            item_id = str(event.get("news_item_id") or "")
            if not item_id or latest_feedback_by_item.get(item_id) != str(event["id"]):
                continue
        weight = _EVENT_WEIGHTS.get(event_type, 0.0)
        if weight == 0:
            continue
        occurred = _parse_datetime(str(event["occurred_at"]))
        age_days = max((current - occurred).total_seconds() / 86_400, 0.0)
        weighted_signal = weight * math.pow(0.5, age_days / 30.0)
        is_browser_history = (
            event.get("event_type") == "history_visit"
            and event.get("origin") in {"browser_history", "browser_extension"}
        )
        linked_item_title = str(event.get("linked_item_title") or "")
        linked_item_content = str(event.get("linked_item_content") or "")
        if is_browser_history:
            # 能关联到采集条目时，以条目标题为准；其余历史标题先排除站点和通用页面噪声。
            title = linked_item_title or _clean_history_title(
                str(event.get("title") or ""),
                str(event.get("canonical_url") or "") or None,
            )
            if not title:
                continue
        elif event_type in {"like", "not_interested"} and linked_item_title:
            title = linked_item_title
        else:
            title = str(event.get("display_title") or "")
        if event_type in {"like", "not_interested"} and linked_item_title:
            title_tokens = _tokens(title)
            body = re.sub(r"https?://\S+", " ", linked_item_content)
            body = re.sub(r"\s+", " ", body).strip()[:_FEEDBACK_BODY_CHAR_LIMIT]
            body_tokens = _tokens(body)
            # 标题表达更直接；正文补充用户实际认可或排斥的内容主题。
            weighted_tokens = {token: 1.0 for token in title_tokens}
            for token in body_tokens:
                weighted_tokens[token] = max(weighted_tokens.get(token, 0.0), 0.7)
            tokens = set(weighted_tokens)
        else:
            weighted_tokens = {token: 1.0 for token in _tokens(title)}
            tokens = set(weighted_tokens)
        if is_browser_history and not linked_item_title:
            tokens.difference_update(
                _history_site_tokens(str(event.get("canonical_url") or "") or None)
            )
        explicit_key = str(event.get("topic_key") or "").strip().lower()
        if explicit_key:
            tokens.update(_tokens(explicit_key))
        for token in tokens:
            aggregate = aggregates.setdefault(
                token,
                {"score": 0.0, "evidence_count": 0, "last_seen_at": None, "keywords": set()},
            )
            aggregate["score"] += (
                weighted_signal
                * weighted_tokens.get(token, 1.0)
                / max(len(tokens) ** 0.35, 1.0)
            )
            aggregate["evidence_count"] += 1
            aggregate["last_seen_at"] = max(
                str(aggregate["last_seen_at"] or ""), str(event["occurred_at"])
            )
            aggregate["keywords"].add(token)

    ranked = sorted(
        (
            (key, value)
            for key, value in aggregates.items()
            if abs(float(value["score"])) >= 0.08
        ),
        key=lambda pair: (abs(float(pair[1]["score"])), int(pair[1]["evidence_count"])),
        reverse=True,
    )[:40]
    profile_id = uuid.uuid4().hex
    topics = [
        {
            "id": uuid.uuid4().hex,
            "topic_key": key,
            "label": key,
            "score": round(float(value["score"]), 4),
            "evidence_count": int(value["evidence_count"]),
            "last_seen_at": value["last_seen_at"],
            "keywords_json": json.dumps(sorted(value["keywords"]), ensure_ascii=False),
        }
        for key, value in ranked
    ]
    db.save_interest_profile(
        profile_id,
        ALGORITHM_VERSION,
        start_text,
        end_text,
        end_text,
        len(events),
        topics,
    )
    return {
        "id": profile_id,
        "algorithmVersion": ALGORITHM_VERSION,
        "windowStart": start_text,
        "windowEnd": end_text,
        "generatedAt": end_text,
        "eventCount": len(events),
        "topics": [
            {
                "key": topic["topic_key"],
                "label": topic["label"],
                "score": topic["score"],
                "evidenceCount": topic["evidence_count"],
                "lastSeenAt": topic["last_seen_at"],
                "keywords": json.loads(str(topic["keywords_json"])),
            }
            for topic in topics
        ],
    }


def latest_profile() -> dict[str, object] | None:
    """返回最近画像；首次使用时返回 None。"""
    profile = db.get_latest_interest_profile()
    if profile is None:
        return None
    return {
        "id": profile["id"],
        "algorithmVersion": profile["algorithm_version"],
        "windowStart": profile["window_start"],
        "windowEnd": profile["window_end"],
        "generatedAt": profile["generated_at"],
        "eventCount": profile["event_count"],
        "topics": [
            {
                "key": topic["topic_key"],
                "label": topic["label"],
                "score": topic["score"],
                "evidenceCount": topic["evidence_count"],
                "lastSeenAt": topic["last_seen_at"],
                "keywords": json.loads(str(topic["keywords_json"])),
            }
            for topic in profile["topics"]
        ],
    }


def current_profile() -> dict[str, object]:
    """按需要更新画像，保证新产生的行为可以影响推荐。"""
    now = _now()
    profile_row = db.get_latest_interest_profile()
    if profile_row is not None:
        generated_at = _parse_datetime(str(profile_row["generated_at"]))
        profile_start = str(profile_row["window_start"])
        current_event_count = db.count_interest_events(profile_start, _iso(now))
        is_current = (
            str(profile_row["algorithm_version"]) == ALGORITHM_VERSION
            and current_event_count == int(profile_row["event_count"])
            and (now - generated_at) < timedelta(days=1)
        )
        if is_current:
            profile = latest_profile()
            if profile is not None:
                return profile
    return rebuild_profile()


def _topic_match_strength(
    topic: dict[str, object],
    title_tokens: set[str],
    content_tokens: set[str],
    idf_weights: dict[str, float],
) -> float:
    """用词项稀有度计算正文优先的主题匹配分。"""
    keywords = {str(value) for value in topic.get("keywords", [])}
    if not keywords:
        return 0.0
    informative_keywords = sorted(
        ((keyword, idf_weights.get(keyword, 0.0)) for keyword in keywords),
        key=lambda pair: pair[1],
        reverse=True,
    )[:4]
    denominator = max(1.0, sum(weight for _keyword, weight in informative_keywords))
    title_weight = sum(
        weight for keyword, weight in informative_keywords if keyword in title_tokens
    )
    content_weight = sum(
        weight for keyword, weight in informative_keywords if keyword in content_tokens
    )
    # 正文必须命中至少一个有效主题词，标题只能在此基础上补充分数。
    if content_weight <= 0:
        return 0.0
    weighted_coverage = min(1.0, (0.3 * title_weight + 0.7 * content_weight) / denominator)
    if weighted_coverage <= 0:
        return 0.0
    topic_strength = math.tanh(abs(float(topic["score"])) / 2.5)
    return topic_strength * weighted_coverage


def _source_affinity_scores(
    events: list[dict[str, object]],
    now: datetime,
) -> dict[str, float]:
    """根据来源行为和每篇文章最新赞踩计算有界的来源倾向分。"""
    ordered_events = sorted(
        events,
        key=lambda event: (
            str(event.get("occurred_at") or ""),
            str(event.get("created_at") or ""),
        ),
        reverse=True,
    )
    latest_feedback_by_item: dict[str, dict[str, object]] = {}
    for event in ordered_events:
        if str(event.get("event_type") or "") not in {"like", "not_interested"}:
            continue
        item_id = str(event.get("news_item_id") or "")
        if item_id:
            latest_feedback_by_item.setdefault(item_id, event)

    totals: dict[str, float] = {}
    for event in ordered_events:
        source_id = str(event.get("source_id") or "")
        event_type = str(event.get("event_type") or "")
        if event_type in {"like", "not_interested"}:
            item_id = str(event.get("news_item_id") or "")
            if item_id and latest_feedback_by_item.get(item_id) is not event:
                continue
        event_weight = _SOURCE_EVENT_WEIGHTS.get(event_type, 0.0)
        if not source_id or event_weight == 0.0:
            continue
        occurred = _parse_datetime(str(event["occurred_at"]))
        age_days = max((now - occurred).total_seconds() / 86_400, 0.0)
        decayed_weight = event_weight * math.pow(0.5, age_days / 45.0)
        totals[source_id] = totals.get(source_id, 0.0) + decayed_weight
    return {
        source_id: math.tanh(weight / _SOURCE_SCORE_SCALE) * _SOURCE_SCORE_LIMIT
        for source_id, weight in totals.items()
    }


def _freshness_score(row: dict[str, object], now: datetime) -> float:
    """为较新的资讯提供有上限的排序加分。"""
    for value in (row.get("published_at"), row.get("fetched_at")):
        if not value:
            continue
        try:
            age_days = max((now - _parse_datetime(str(value))).total_seconds() / 86_400, 0.0)
        except (TypeError, ValueError):
            continue
        return _FRESHNESS_SCORE_LIMIT * math.exp(-age_days / _FRESHNESS_DECAY_DAYS)
    return 0.0


def _diversify_recommendations(
    ranked: list[dict[str, object]],
    source_id: str | None,
) -> list[dict[str, object]]:
    """轻量调整首页前段来源分布，不修改画像或基础分。"""
    sources = {str(item["source_id"]) for item in ranked}
    if source_id is not None or len(sources) < 2 or len(ranked) < 3:
        return ranked

    remaining = list(ranked)
    selected: list[dict[str, object]] = []
    source_counts: dict[str, int] = {}
    for _ in range(min(_DIVERSITY_TOP_ITEMS, len(remaining))):
        best_index = max(
            range(len(remaining)),
            key=lambda index: (
                float(remaining[index]["score"])
                - min(
                    source_counts.get(str(remaining[index]["source_id"]), 0)
                    * _DIVERSITY_REUSE_PENALTY,
                    _SOURCE_SCORE_LIMIT * 2,
                ),
                float(remaining[index]["score"]),
                -int(remaining[index]["base_rank"]),
            ),
        )
        item = remaining.pop(best_index)
        selected_source = str(item["source_id"])
        previous_count = source_counts.get(selected_source, 0)
        if int(item["base_rank"]) != len(selected):
            item["reason"] = f"{item['reason']}；来源分布调整"
        source_counts[selected_source] = previous_count + 1
        selected.append(item)

    return selected + remaining


def _rank_candidate_rows(
    all_candidates: list[dict[str, object]],
    profile_topics: list[dict[str, object]],
    profile_events: list[dict[str, object]],
    now: datetime,
    source_id: str | None = None,
    selected_ids: set[str] | None = None,
    semantic_scores: dict[str, dict[str, object]] | None = None,
    ranking_mode: str = "keyword",
    semantic_weight: float = 0.5,
    source_scores_override: dict[str, float] | None = None,
) -> list[dict[str, object]]:
    """共享关键词与语义排序逻辑，供正式推荐和本机评估使用。"""
    if ranking_mode not in {"keyword", "semantic", "hybrid"}:
        raise ValueError("不支持的资讯排序方式")
    tokenized_candidates, corpus_documents = _tokenize_recommendation_candidates(
        all_candidates, source_id
    )
    idf_weights = _idf_weights(corpus_documents)
    source_scores = (
        source_scores_override
        if source_scores_override is not None
        else _source_affinity_scores(profile_events, now)
    )
    positive_topics = [
        topic for topic in profile_topics
        if float(topic["score"]) > 0 and topic.get("keywords")
    ]
    negative_topics = [
        topic for topic in profile_topics
        if float(topic["score"]) < 0 and topic.get("keywords")
    ]
    semantic_weight = min(max(float(semantic_weight), 0.0), 1.0)
    ranked: list[dict[str, object]] = []
    for row, title_tokens, content_tokens in tokenized_candidates:
        item_id = str(row.get("id") or "")
        if selected_ids is not None and item_id not in selected_ids:
            continue
        if not title_tokens and not content_tokens:
            continue

        positive_matches: list[tuple[float, str, bool, bool]] = []
        negative_matches: list[tuple[float, str]] = []
        for topic in positive_topics:
            contribution = _topic_match_strength(topic, title_tokens, content_tokens, idf_weights)
            if contribution > 0:
                matched_title = any(
                    str(keyword) in title_tokens and idf_weights.get(str(keyword), 0.0) > 0
                    for keyword in topic.get("keywords", [])
                )
                matched_content = any(
                    str(keyword) in content_tokens and idf_weights.get(str(keyword), 0.0) > 0
                    for keyword in topic.get("keywords", [])
                )
                positive_matches.append(
                    (contribution, str(topic["label"]), matched_title, matched_content)
                )
        for topic in negative_topics:
            contribution = _topic_match_strength(topic, title_tokens, content_tokens, idf_weights)
            if contribution > 0:
                negative_matches.append((contribution, str(topic["label"])))

        positive_matches.sort(key=lambda match: match[0], reverse=True)
        negative_matches.sort(key=lambda match: match[0], reverse=True)
        positive_raw = sum(
            score
            for score, _label, _matched_title, _matched_content in positive_matches[:5]
        )
        negative_raw = sum(score for score, _label in negative_matches[:5])
        keyword_positive = 1.0 - math.exp(-positive_raw)
        keyword_negative = 0.72 * (1.0 - math.exp(-negative_raw))
        keyword_score = keyword_positive - keyword_negative

        semantic = (semantic_scores or {}).get(item_id)
        semantic_positive = float(semantic.get("positive_score", 0.0)) if semantic else 0.0
        semantic_negative = float(semantic.get("negative_penalty", 0.0)) if semantic else 0.0
        semantic_score = semantic_positive - semantic_negative
        if ranking_mode == "semantic":
            content_score = semantic_score
            has_positive_interest = semantic_positive > 0
        elif ranking_mode == "hybrid" and semantic is not None:
            content_score = (1.0 - semantic_weight) * keyword_score + semantic_weight * semantic_score
            has_positive_interest = keyword_positive > 0 or semantic_positive > 0
        else:
            content_score = keyword_score
            has_positive_interest = keyword_positive > 0
        if not has_positive_interest or content_score <= 0:
            continue

        source_key = str(row.get("source_id") or "")
        source_score = source_scores.get(source_key, 0.0)
        freshness_score = _freshness_score(row, now)
        final_score = content_score + source_score + freshness_score
        if final_score <= 0:
            continue

        title_labels = list(dict.fromkeys(
            label
            for _score, label, matched_title, _matched_content in positive_matches[:3]
            if matched_title
        ))
        content_labels = list(dict.fromkeys(
            label
            for _score, label, _matched_title, matched_content in positive_matches[:3]
            if matched_content
        ))
        reasons: list[str] = []
        if ranking_mode != "semantic":
            if title_labels:
                reasons.append("标题匹配兴趣：" + "、".join(title_labels))
            if content_labels:
                reasons.append("正文匹配兴趣：" + "、".join(content_labels))
            if keyword_negative >= 0.04:
                negative_labels = list(dict.fromkeys(label for _score, label in negative_matches[:2]))
                reasons.append("负向兴趣降低：" + "、".join(negative_labels))
        if ranking_mode in {"semantic", "hybrid"} and semantic is not None:
            semantic_labels = [
                str(label) for label in semantic.get("positive_labels", []) if str(label)
            ][:3]
            semantic_negative_labels = [
                str(label) for label in semantic.get("negative_labels", []) if str(label)
            ][:2]
            if semantic_labels:
                reasons.append("正文语义匹配兴趣：" + "、".join(semantic_labels))
            if semantic_negative >= 0.04 and semantic_negative_labels:
                reasons.append("语义负向兴趣降低：" + "、".join(semantic_negative_labels))
        if source_score >= 0.025:
            reasons.append("来源偏好")
        elif source_score <= -0.025:
            reasons.append("来源近期反馈较弱")
        if freshness_score >= _FRESHNESS_SCORE_LIMIT * 0.45:
            reasons.append("近期更新")

        timestamp = str(row.get("published_at") or row.get("fetched_at") or "")
        ranked.append(
            {
                "score": final_score,
                "timestamp": timestamp,
                "row": row,
                "reason": "；".join(reasons),
                "source_id": source_key,
                "base_rank": 0,
            }
        )

    ranked.sort(
        key=lambda item: (float(item["score"]), str(item["timestamp"])),
        reverse=True,
    )
    for index, item in enumerate(ranked):
        item["base_rank"] = index
    return _diversify_recommendations(ranked, source_id)


def _recommendation_page(
    ranked: list[dict[str, object]],
    limit: int,
    offset: int,
    recommendation_state: str,
) -> dict[str, object]:
    page = ranked[offset:offset + limit]
    return {
        "items": [
            {**item["row"], "recommendation_reason": item["reason"]}
            for item in page
        ],
        "total": len(ranked),
        "recommendation_state": (
            recommendation_state
            if ranked or recommendation_state == "keyword_fallback"
            else "no_matches"
        ),
    }


def _keyword_ranked_items(
    profile: dict[str, object],
    source_id: str | None,
    now: datetime,
    all_candidates: list[dict[str, object]],
    profile_events: list[dict[str, object]],
) -> list[dict[str, object]]:
    return _rank_candidate_rows(
        all_candidates,
        list(profile["topics"]),
        profile_events,
        now,
        source_id=source_id,
        ranking_mode="keyword",
    )


def keyword_recommended_items(
    source_id: str | None,
    limit: int,
    offset: int,
) -> dict[str, object]:
    """仅用关键词排序，供评估样本抽取和语义不可用时回退。"""
    profile = current_profile()
    profile_topics = profile["topics"]
    positive_topics = [
        topic for topic in profile_topics
        if float(topic["score"]) > 0 and topic.get("keywords")
    ]
    if not positive_topics:
        rows, total = db.list_items(source_id, limit, offset)
        return {
            "items": rows,
            "total": total,
            "recommendation_state": "warming_up",
        }

    all_candidates = db.list_recommendation_candidates()
    now = _now()
    profile_events = db.list_interest_events(
        str(profile["windowStart"]), str(profile["windowEnd"])
    )
    ranked = _keyword_ranked_items(profile, source_id, now, all_candidates, profile_events)
    return _recommendation_page(ranked, limit, offset, "ready")


def _reciprocal_rank_fusion(
    keyword_ranked: list[dict[str, object]],
    semantic_ranked: list[dict[str, object]],
    rank_constant: int = RRF_RANK_CONSTANT,
) -> list[dict[str, object]]:
    """按关键词和语义榜单名次做 RRF；未出现在某榜单的条目该榜贡献为零。"""
    fused: dict[str, dict[str, object]] = {}
    rank_lists = (
        ("keyword", "关键词", keyword_ranked),
        ("semantic", "语义", semantic_ranked),
    )
    for mode, _label, ranked in rank_lists:
        for rank, result in enumerate(ranked, start=1):
            row = result.get("row")
            if not isinstance(row, dict):
                continue
            item_id = str(row.get("id") or "")
            if not item_id:
                continue
            entry = fused.setdefault(
                item_id,
                {**result, "score": 0.0, "_rrf_ranks": {}},
            )
            entry["score"] = float(entry["score"]) + 1.0 / (rank_constant + rank)
            ranks = entry["_rrf_ranks"]
            if isinstance(ranks, dict):
                ranks[mode] = rank

    ranked_entries = list(fused.values())
    for entry in ranked_entries:
        ranks = entry.pop("_rrf_ranks", {})
        rank_details = []
        if isinstance(ranks, dict):
            for mode, label, _ranked in rank_lists:
                rank = ranks.get(mode)
                rank_details.append(
                    f"{label}第 {rank} 位"
                    if rank is not None
                    else f"未进入{label}榜单"
                )
        entry["reason"] = "RRF 融合：" + "；".join(rank_details)
    ranked_entries.sort(
        key=lambda item: (float(item["score"]), str(item.get("timestamp") or "")),
        reverse=True,
    )
    for index, item in enumerate(ranked_entries):
        item["base_rank"] = index
    return ranked_entries


async def recommended_items(
    source_id: str | None,
    limit: int,
    offset: int,
) -> dict[str, object]:
    """正式推荐：关键词榜与正文语义榜用 RRF 融合，语义不可用时回退关键词。"""
    profile = await asyncio.to_thread(current_profile)
    profile_topics = list(profile["topics"])
    positive_topics = [
        topic for topic in profile_topics
        if float(topic["score"]) > 0 and topic.get("keywords")
    ]
    if not positive_topics:
        return await asyncio.to_thread(keyword_recommended_items, source_id, limit, offset)

    all_candidates = await asyncio.to_thread(db.list_recommendation_candidates)
    now = _now()
    profile_events = await asyncio.to_thread(
        db.list_interest_events, str(profile["windowStart"]), str(profile["windowEnd"])
    )
    keyword_ranked = await asyncio.to_thread(
        _keyword_ranked_items, profile, source_id, now, all_candidates, profile_events
    )
    config = storage.get_knowledge_config().embedding
    if not embedding_config_ready(config):
        return _recommendation_page(keyword_ranked, limit, offset, "keyword_fallback")

    try:
        semantic_scores = await semantic.scores_for_candidates(config, profile_topics, all_candidates)
        if not semantic_scores:
            raise ValueError("no semantic vectors available")
        source_scores = await asyncio.to_thread(_source_affinity_scores, profile_events, now)
        semantic_ranked = await asyncio.to_thread(
            _rank_candidate_rows,
            all_candidates,
            profile_topics,
            profile_events,
            now,
            source_id,
            None,
            semantic_scores,
            "semantic",
            0.5,
            source_scores,
        )
        fused = _reciprocal_rank_fusion(keyword_ranked, semantic_ranked)
        return _recommendation_page(fused, limit, offset, "ready")
    except Exception as error:
        # Provider errors can contain request contents; log only the exception class.
        _LOGGER.warning(
            "Semantic recommendation unavailable (%s); using keyword ranking",
            type(error).__name__,
        )
        return _recommendation_page(keyword_ranked, limit, offset, "keyword_fallback")


def _local_topic_rank(
    profile_topics: list[dict[str, object]],
    candidates: list[dict[str, str]],
) -> list[dict[str, object]]:
    positive_topics = [topic for topic in profile_topics if float(topic["score"]) > 0]
    ranked: list[dict[str, object]] = []
    for candidate in candidates:
        candidate_tokens = _tokens(f"{candidate['name']} {candidate.get('group', '')}")
        score = 0.0
        matches: list[tuple[float, str]] = []
        for topic in positive_topics:
            topic_tokens = set(str(word) for word in topic.get("keywords", []))
            overlap = candidate_tokens & topic_tokens
            if overlap:
                contribution = float(topic["score"]) * len(overlap) / max(len(candidate_tokens), 1)
                score += contribution
                matches.append((contribution, str(topic["label"])))
        if score <= 0:
            continue
        matches.sort(reverse=True)
        keyword_text = "、".join(label for _weight, label in matches[:3])
        ranked.append(
            {
                "id": uuid.uuid4().hex,
                "platform_topic_id": candidate["id"],
                "title": candidate["name"],
                "topic_group": candidate.get("group", ""),
                "score": score,
                "reason": f"与你近期关注的「{keyword_text}」有词项关联。",
            }
        )
    ranked.sort(key=lambda item: float(item["score"]), reverse=True)
    return ranked[:15]


async def _model_topic_rank(
    model_config: ModelConfig,
    profile_topics: list[dict[str, object]],
    candidates: list[dict[str, str]],
) -> list[dict[str, object]]:
    # 只构造聚合关键词和公开话题目录，原始 URL、页面标题和正文不进入模型请求。
    summary = [
        {
            "keyword": str(topic["label"]),
            "weight": round(float(topic["score"]), 3),
            "evidenceCount": int(topic["evidenceCount"]),
        }
        for topic in profile_topics
        if float(topic["score"]) > 0
    ][:30]
    catalog = [{"id": item["id"], "name": item["name"], "group": item.get("group", "")} for item in candidates]
    messages = [
        {
            "role": "system",
            "content": (
                "你是兴趣话题排序器。根据汇总关键词为候选话题排序。"
                "只能从候选目录选择，不要推断用户身份。请只输出 JSON："
                '{"topics":[{"id":"候选ID","reason":"简短理由"}]}，最多 15 项。'
            ),
        },
        {
            "role": "user",
            "content": json.dumps(
                {"interestSummary": summary, "candidateTopics": catalog},
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        },
    ]
    response_text = await llm.chat_completion(model_config, messages)
    parsed_text = response_text.strip()
    if parsed_text.startswith("```"):
        parsed_text = re.sub(r"^```(?:json)?\s*|\s*```$", "", parsed_text, flags=re.IGNORECASE)
    parsed = json.loads(parsed_text)
    selected = parsed.get("topics", []) if isinstance(parsed, dict) else []
    by_id = {candidate["id"]: candidate for candidate in candidates}
    result: list[dict[str, object]] = []
    used: set[str] = set()
    for index, selection in enumerate(selected[:15]):
        if not isinstance(selection, dict):
            continue
        topic_id = str(selection.get("id", ""))
        candidate = by_id.get(topic_id)
        if candidate is None or topic_id in used:
            continue
        used.add(topic_id)
        reason = str(selection.get("reason", "模型根据本地兴趣摘要推荐。"))[:160]
        result.append(
            {
                "id": uuid.uuid4().hex,
                "platform_topic_id": topic_id,
                "title": candidate["name"],
                "topic_group": candidate.get("group", ""),
                "score": float(100 - index * 4),
                "reason": reason,
            }
        )
    if not result:
        raise ValueError("模型没有返回有效的话题候选，请关闭 AI 分析后重试")
    return result


async def generate_topic_suggestions(
    candidates: list[dict[str, str]],
    use_model: bool,
    model_config: ModelConfig | None,
) -> dict[str, object]:
    """重建画像并根据本地兴趣摘要生成小黑盒话题建议。"""
    profile = await asyncio.to_thread(rebuild_profile)
    profile_topics = profile["topics"]
    if use_model:
        if model_config is None:
            raise ValueError("请先在 TabKeep 设置中配置模型，再启用 AI 分析")
        suggestions = await _model_topic_rank(model_config, profile_topics, candidates)
        algorithm = f"{ALGORITHM_VERSION}+configured-model"
    else:
        suggestions = _local_topic_rank(profile_topics, candidates)
        algorithm = f"{ALGORITHM_VERSION}+lexical-match"
    suggestions = suggestions[:15]
    if not suggestions:
        raise ValueError("目前的本地行为还不足以匹配话题；导入历史或多浏览一些资讯后再试")
    timestamp = _iso(_now())
    db.save_topic_suggestions(str(profile["id"]), "xiaoheihe", suggestions, timestamp)
    stored = db.list_topic_suggestions(str(profile["id"]))
    return {
        "profile": profile,
        "algorithm": algorithm,
        "suggestions": [
            {
                "id": row["id"],
                "provider": row["provider"],
                "platformTopicId": row["platform_topic_id"],
                "title": row["title"],
                "group": row["topic_group"],
                "score": row["score"],
                "reason": row["reason"],
                "status": row["status"],
                "sourceId": row["source_id"],
            }
            for row in stored
        ],
    }


def record_suggestion_event(
    event_type: str,
    suggestion: dict[str, object],
    source_id: str | None = None,
) -> None:
    """把用户接受或忽略候选的反馈作为兴趣事件保存。"""
    timestamp = _iso(_now())
    db.insert_interest_event(
        {
            "id": uuid.uuid4().hex,
            "origin": "suggestion",
            "event_type": event_type,
            "occurred_at": timestamp,
            "source_id": source_id,
            "canonical_url": None,
            "title": str(suggestion["title"]),
            "topic_key": str(suggestion["title"]),
            "dedupe_key": f"suggestion:{suggestion['id']}:{event_type}",
            "created_at": timestamp,
        }
    )
