"""百度贴吧 URL 识别与帖子采集。"""

import asyncio
import importlib
import uuid
from datetime import datetime, timezone
from typing import Any, TypedDict
from urllib.parse import parse_qs, urlsplit

from services.news.images import normalize_image_url


class NormalizedEntry(TypedDict):
    id: str
    dedupe_key: str
    title: str
    url: str | None
    content: str
    image_url: str | None
    image_asset: str | None
    author: str | None
    published_at: str | None

MAX_THREADS_PER_REFRESH = 10
MAX_POSTS_PER_THREAD = 10
MAX_CONTENT_CHARS = 20_000


def parse_forum_name(url: str) -> str | None:
    """识别贴吧吧主页并返回吧名；非贴吧地址返回 None。"""
    parsed = urlsplit(url)
    if (parsed.hostname or "").lower() not in {"tieba.baidu.com", "www.tieba.baidu.com"}:
        return None
    if parsed.path.rstrip("/") != "/f":
        raise ValueError("贴吧订阅请使用贴吧主页地址，例如 https://tieba.baidu.com/f?kw=吧名")
    forum_names = parse_qs(parsed.query).get("kw", [])
    forum_name = forum_names[0].strip() if forum_names else ""
    if not forum_name:
        raise ValueError("贴吧主页地址缺少 kw 参数，请复制具体贴吧的主页地址")
    return forum_name


def _read_text(value: object) -> str:
    """从 aiotieba 内容对象读取纯文本。"""
    if isinstance(value, str):
        return value.strip()
    contents = getattr(value, "contents", None)
    text = getattr(contents, "text", None) if contents is not None else None
    if isinstance(text, str) and text.strip():
        return text.strip()
    fallback = getattr(value, "text", None)
    return fallback.strip() if isinstance(fallback, str) else ""


def _to_iso_timestamp(value: object) -> str | None:
    """将贴吧的秒级时间戳转换为 UTC ISO 时间。"""
    try:
        timestamp = int(value)
        if timestamp <= 0:
            return None
        return datetime.fromtimestamp(timestamp, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def _display_name(user: object) -> str | None:
    """读取公开用户昵称，不保存用户 ID 等额外信息。"""
    for attribute in ("show_name", "nick_name", "user_name"):
        value = getattr(user, attribute, None) if user is not None else None
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _first_image_url(value: object) -> str | None:
    """读取 aiotieba 内容碎片里的首张图片。"""
    if value is None:
        return None
    contents = getattr(value, "contents", None)
    candidates = getattr(contents, "imgs", None) if contents is not None else None
    if not candidates:
        candidates = getattr(value, "imgs", None)
    for image in candidates or []:
        for attribute in ("big_src", "src", "origin_src"):
            candidate = getattr(image, attribute, None)
            normalized = normalize_image_url(candidate if isinstance(candidate, str) else None)
            if normalized:
                return normalized
    return None


def _normalize_threads(
    threads: list[Any],
    content_by_thread: dict[int, str],
    image_by_thread: dict[int, str] | None = None,
) -> list[NormalizedEntry]:
    """将贴吧主题帖和首屏回复归一化为资讯条目。"""
    entries: list[NormalizedEntry] = []
    for thread in threads[:MAX_THREADS_PER_REFRESH]:
        try:
            thread_id = int(getattr(thread, "tid", 0))
        except (TypeError, ValueError):
            continue
        if thread_id <= 0:
            continue

        title = str(getattr(thread, "title", "") or "").strip() or "贴吧主题帖"
        content = content_by_thread.get(thread_id) or _read_text(thread)
        image_url = (image_by_thread or {}).get(thread_id) or _first_image_url(thread)
        author = _display_name(getattr(thread, "user", None))
        published_at = _to_iso_timestamp(getattr(thread, "create_time", None))
        entries.append(
            {
                "id": uuid.uuid4().hex,
                "dedupe_key": f"tieba:tid:{thread_id}",
                "title": title[:500],
                "url": f"https://tieba.baidu.com/p/{thread_id}",
                "content": content[:MAX_CONTENT_CHARS],
                "image_url": image_url,
                "image_asset": None,
                "author": author,
                "published_at": published_at,
            }
        )
    return entries


async def fetch_forum(forum_name: str) -> list[NormalizedEntry]:
    """匿名抓取贴吧热门主题帖及每帖首屏回复。"""
    aiotieba = importlib.import_module("aiotieba")
    async with aiotieba.Client() as client:
        thread_result = await client.get_threads(
            forum_name,
            pn=1,
            rn=MAX_THREADS_PER_REFRESH,
            sort=aiotieba.ThreadSortType.HOT,
        )
        if getattr(thread_result, "err", None) is not None:
            raise RuntimeError("贴吧接口暂时无法读取帖子列表")

        threads = list(getattr(thread_result, "objs", []) or [])[:MAX_THREADS_PER_REFRESH]
        content_by_thread: dict[int, str] = {}
        image_by_thread: dict[int, str] = {}
        for thread in threads:
            try:
                thread_id = int(getattr(thread, "tid", 0))
                if thread_id <= 0:
                    continue
                thread_image = _first_image_url(thread)
                if thread_image:
                    image_by_thread[thread_id] = thread_image
                post_result = await client.get_posts(
                    thread_id,
                    pn=1,
                    rn=MAX_POSTS_PER_THREAD,
                    with_comments=False,
                )
                if getattr(post_result, "err", None) is not None:
                    continue
                post_texts = [
                    text
                    for post in (getattr(post_result, "objs", []) or [])
                    if (text := _read_text(post))
                ]
                if post_texts:
                    content_by_thread[thread_id] = "\n\n".join(post_texts)[:MAX_CONTENT_CHARS]
                if thread_id not in image_by_thread:
                    for post in (getattr(post_result, "objs", []) or []):
                        if image_url := _first_image_url(post):
                            image_by_thread[thread_id] = image_url
                            break
            except (AttributeError, TypeError, ValueError, RuntimeError):
                # 单帖详情不可读时仍保存列表接口提供的主题帖摘要。
                continue
        return _normalize_threads(threads, content_by_thread, image_by_thread)


async def fetch_forum_with_timeout(forum_name: str, timeout_seconds: float = 120) -> list[NormalizedEntry]:
    """限制一次贴吧采集的总等待时间。"""
    return await asyncio.wait_for(fetch_forum(forum_name), timeout=timeout_seconds)
