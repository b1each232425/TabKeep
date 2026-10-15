"""通过 HTTP 获取并归一化 RSS、Atom 订阅内容。"""

import asyncio
import hashlib
import re
import threading
import uuid
import weakref
from datetime import datetime, timezone
from html.parser import HTMLParser
from typing import TypedDict
from urllib.parse import urljoin, urlsplit, urlunsplit

import feedparser
import httpx

from services.news import db
from services.news import images
from services.news import tieba, xiaoheihe
from logger import logger

POLL_INTERVAL_SECONDS = 60 * 60
REQUEST_TIMEOUT_SECONDS = 15
MAX_RESPONSE_BYTES = 10 * 1024 * 1024
MAX_REDIRECTS = 5
MAX_CONCURRENT_FETCHES = 4


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


class RefreshResult(TypedDict):
    sourceId: str
    sourceTitle: str
    newItems: int
    notModified: bool
    error: str | None


class _DownloadedResponse(TypedDict):
    url: str
    content: bytes
    etag: str | None
    last_modified: str | None
    encoding: str | None
    not_modified: bool


class _PlainTextParser(HTMLParser):
    """将 feed 内的 HTML 片段转换为安全展示的纯文本。"""

    _BLOCK_TAGS = {
        "address", "article", "blockquote", "br", "dd", "div", "dl", "dt",
        "h1", "h2", "h3", "h4", "h5", "h6", "li", "ol", "p", "pre",
        "section", "tr", "ul",
    }

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip_depth = 0

    def handle_data(self, data: str) -> None:
        if self._skip_depth == 0:
            self.parts.append(data)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() in {"script", "style"}:
            self._skip_depth += 1
            return
        if tag.lower() in self._BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() in {"script", "style"}:
            self._skip_depth = max(0, self._skip_depth - 1)
            return
        if tag.lower() in self._BLOCK_TAGS:
            self.parts.append("\n")


class _AlternateFeedParser(HTMLParser):
    """读取同源网页声明的 RSS/Atom alternate 链接。"""

    _FEED_TYPES = {"application/rss+xml", "application/atom+xml"}

    def __init__(self, base_url: str) -> None:
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.feed_urls: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "link":
            return
        attributes = {name.lower(): value for name, value in attrs}
        relationships = set((attributes.get("rel") or "").lower().split())
        media_type = (attributes.get("type") or "").split(";", 1)[0].strip().lower()
        href = (attributes.get("href") or "").strip()
        if "alternate" not in relationships or media_type not in self._FEED_TYPES or not href:
            return
        try:
            candidate = urlsplit(urljoin(self.base_url, href))
            base = urlsplit(self.base_url)
            candidate_port = candidate.port or (443 if candidate.scheme.lower() == "https" else 80)
            base_port = base.port or (443 if base.scheme.lower() == "https" else 80)
        except ValueError:
            return
        if (
            candidate.scheme.lower() not in {"http", "https"}
            or not candidate.hostname
            or candidate.username is not None
            or candidate.password is not None
            or candidate.scheme.lower() != base.scheme.lower()
            or candidate.hostname.lower() != (base.hostname or "").lower()
            or candidate_port != base_port
        ):
            return
        feed_url = urlunsplit(
            (candidate.scheme.lower(), candidate.netloc, candidate.path, candidate.query, "")
        )
        if feed_url not in self.feed_urls:
            self.feed_urls.append(feed_url)


class _EntryImageParser(HTMLParser):
    """从 feed 摘要 HTML 读取第一张可用图片。"""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.image_url: str | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "img" or self.image_url:
            return
        attributes = {name.lower(): value for name, value in attrs}
        for name in ("data-original", "data-src", "srcset", "src"):
            value = (attributes.get(name) or "").strip()
            if name == "srcset":
                value = value.split(",", 1)[0].strip().split(" ", 1)[0]
            if value and not value.lower().startswith(("data:", "blob:", "javascript:")):
                self.image_url = value
                return


_source_locks: weakref.WeakKeyDictionary[
    asyncio.AbstractEventLoop, dict[str, asyncio.Lock]
] = weakref.WeakKeyDictionary()
_fetch_semaphores: weakref.WeakKeyDictionary[
    asyncio.AbstractEventLoop, asyncio.Semaphore
] = weakref.WeakKeyDictionary()
_source_locks_guard = threading.Lock()


def clear_source_locks() -> None:
    """应用关闭时清空事件循环绑定的锁。"""
    with _source_locks_guard:
        _source_locks.clear()
        _fetch_semaphores.clear()


def _get_source_lock(source_id: str) -> asyncio.Lock:
    loop = asyncio.get_running_loop()
    with _source_locks_guard:
        loop_locks = _source_locks.get(loop)
        if loop_locks is None:
            loop_locks = {}
            _source_locks[loop] = loop_locks
        lock = loop_locks.get(source_id)
        if lock is None:
            lock = asyncio.Lock()
            loop_locks[source_id] = lock
        return lock


def _get_fetch_semaphore() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    with _source_locks_guard:
        semaphore = _fetch_semaphores.get(loop)
        if semaphore is None:
            semaphore = asyncio.Semaphore(MAX_CONCURRENT_FETCHES)
            _fetch_semaphores[loop] = semaphore
        return semaphore


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _plain_text(value: str) -> str:
    parser = _PlainTextParser()
    parser.feed(value)
    parser.close()
    return re.sub(r"\n[\t ]*\n+", "\n\n", "".join(parser.parts)).strip()


def _entry_content(entry: feedparser.FeedParserDict) -> str:
    value = _entry_raw_content(entry)
    return _plain_text(value)


def _entry_raw_content(entry: feedparser.FeedParserDict) -> str:
    contents = entry.get("content")
    if isinstance(contents, list):
        for content in contents:
            if isinstance(content, dict) and content.get("value"):
                return str(content["value"])
    for key in ("summary", "description"):
        value = entry.get(key)
        if value:
            return str(value)
    return ""


def _media_image_url(entry: feedparser.FeedParserDict, base_url: str) -> str | None:
    """从 media、enclosure 和摘要 HTML 中提取首张缩略图。"""
    for key in ("media_thumbnail", "media_content", "enclosures", "links"):
        values = entry.get(key)
        if not isinstance(values, list):
            continue
        for media in values:
            if not isinstance(media, dict):
                continue
            media_type = str(media.get("type") or "").lower()
            medium = str(media.get("medium") or "").lower()
            relation = str(media.get("rel") or "").lower()
            candidate = media.get("url") or media.get("href")
            try:
                candidate_path = urlsplit(str(candidate or "")).path.lower()
            except ValueError:
                candidate_path = ""
            has_image_extension = candidate_path.endswith(
                (".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico")
            )
            if key == "media_thumbnail":
                is_image = True
            else:
                is_image = medium == "image" or media_type.startswith("image/") or has_image_extension
                if key == "links" and relation != "enclosure":
                    is_image = False
                if medium and medium != "image":
                    is_image = False
                if media_type and not media_type.startswith("image/"):
                    is_image = False
            if not is_image:
                continue
            image_url = images.normalize_image_url(str(candidate) if candidate else None, base_url)
            if image_url:
                return image_url

    parser = _EntryImageParser()
    try:
        parser.feed(_entry_raw_content(entry))
        parser.close()
    except Exception:
        return None
    return images.normalize_image_url(parser.image_url, base_url)


def _feed_icon_url(feed: feedparser.FeedParserDict, base_url: str) -> str | None:
    """读取 RSS image 或 Atom logo/icon 元数据。"""
    image = feed.get("image")
    candidates: list[object] = []
    if isinstance(image, dict):
        candidates.extend((image.get("href"), image.get("url")))
    candidates.extend((feed.get("logo"), feed.get("icon")))
    for candidate in candidates:
        icon_url = images.normalize_image_url(str(candidate) if candidate else None, base_url)
        if icon_url:
            return icon_url
    return None


def _favicon_url(page_url: str | None) -> str | None:
    normalized = images.normalize_image_url(page_url)
    if not normalized:
        return None
    parsed = urlsplit(normalized)
    return urlunsplit((parsed.scheme, parsed.netloc, "/favicon.ico", "", ""))


def _published_at(entry: feedparser.FeedParserDict) -> str | None:
    for key in ("published_parsed", "updated_parsed"):
        value = entry.get(key)
        if value:
            try:
                parsed = datetime(*value[:6], tzinfo=timezone.utc)
                return parsed.isoformat(timespec="seconds").replace("+00:00", "Z")
            except (TypeError, ValueError, OverflowError):
                continue
    return None


def _normalize_entries(entries: list[feedparser.FeedParserDict], base_url: str) -> list[NormalizedEntry]:
    normalized: list[NormalizedEntry] = []
    for entry in entries:
        raw_link = str(entry.get("link") or "").strip()
        link = urljoin(base_url, raw_link) if raw_link else None
        if link:
            try:
                parsed_link = urlsplit(link)
                if parsed_link.scheme.lower() not in {"http", "https"} or not parsed_link.hostname:
                    link = None
            except ValueError:
                link = None
        title = _plain_text(str(entry.get("title") or "")).strip() or (link or "无标题条目")
        content = _entry_content(entry)
        image_url = _media_image_url(entry, base_url)
        author_value = entry.get("author")
        if not author_value:
            author_detail = entry.get("author_detail")
            if isinstance(author_detail, dict):
                author_value = author_detail.get("name")
        author = _plain_text(str(author_value)).strip() if author_value else None
        published_at = _published_at(entry)
        feed_id = str(entry.get("id") or "").strip()
        if feed_id:
            dedupe_key = f"guid:{feed_id}"
        elif link:
            dedupe_key = f"link:{link}"
        else:
            fingerprint = "\x1f".join((title, published_at or "", content))
            dedupe_key = f"hash:{hashlib.sha256(fingerprint.encode('utf-8')).hexdigest()}"
        normalized.append(
            {
                "id": uuid.uuid4().hex,
                "dedupe_key": dedupe_key,
                "title": title,
                "url": link,
                "content": content,
                "image_url": image_url,
                "image_asset": None,
                "author": author,
                "published_at": published_at,
            }
        )
    return normalized


def _parse_feed(
    content: bytes,
    base_url: str,
) -> tuple[str | None, str | None, str | None, list[NormalizedEntry]]:
    """解析 RSS/Atom 并将条目归一化，供工作线程执行。"""
    parsed = feedparser.parse(content)
    feed_version = str(parsed.version or "").lower()
    if not (feed_version.startswith("rss") or feed_version.startswith("atom")):
        raise ValueError("服务器响应不是可识别的 RSS 或 Atom feed")
    feed_title = _plain_text(str(parsed.get("feed", {}).get("title") or "")).strip()
    feed_metadata = parsed.get("feed", {})
    icon_url = _feed_icon_url(feed_metadata, base_url)
    homepage_url = images.normalize_image_url(str(feed_metadata.get("link") or ""))
    entries = _normalize_entries(list(parsed.entries), base_url)
    return feed_title or None, icon_url, homepage_url, entries


def _discover_feed_links(content: bytes, base_url: str, encoding: str | None) -> list[str]:
    """从 HTML 页面提取同源、明确声明的 RSS/Atom 地址。"""
    parser = _AlternateFeedParser(base_url)
    try:
        html = content.decode(encoding or "utf-8", errors="replace")
    except LookupError:
        html = content.decode("utf-8", errors="replace")
    parser.feed(html)
    parser.close()
    return parser.feed_urls


async def _read_response_content(response: httpx.Response) -> bytes:
    """读取有限大小的响应，避免订阅地址返回过大的内容。"""
    content_length = response.headers.get("content-length")
    if content_length and int(content_length) > MAX_RESPONSE_BYTES:
        raise ValueError("订阅内容超过 10 MiB 限制")
    chunks: list[bytes] = []
    received = 0
    async for chunk in response.aiter_bytes():
        received += len(chunk)
        if received > MAX_RESPONSE_BYTES:
            raise ValueError("订阅内容超过 10 MiB 限制")
        chunks.append(chunk)
    return b"".join(chunks)


async def _download_response(
    client: httpx.AsyncClient,
    url: str,
    headers: dict[str, str],
) -> _DownloadedResponse:
    """下载网页或 feed，并保留最终 URL 与缓存响应头。"""
    async with client.stream("GET", url, headers=headers) as response:
        if response.status_code == 304:
            return {
                "url": str(response.url),
                "content": b"",
                "etag": response.headers.get("etag"),
                "last_modified": response.headers.get("last-modified"),
                "encoding": response.encoding,
                "not_modified": True,
            }
        response.raise_for_status()
        content = await _read_response_content(response)
        return {
            "url": str(response.url),
            "content": content,
            "etag": response.headers.get("etag"),
            "last_modified": response.headers.get("last-modified"),
            "encoding": response.encoding,
            "not_modified": False,
        }


async def _cache_entry_images(
    client: httpx.AsyncClient,
    entries: list[NormalizedEntry],
) -> None:
    """并发缓存条目缩略图；图片失败不影响文字资讯采集。"""
    semaphore = asyncio.Semaphore(8)

    async def cache_entry(entry: NormalizedEntry) -> None:
        image_url = entry.get("image_url")
        if not image_url:
            return
        async with semaphore:
            entry["image_asset"] = await images.cache_image(client, image_url)

    await asyncio.gather(*(cache_entry(entry) for entry in entries))


async def _cache_source_icon(
    client: httpx.AsyncClient,
    source_id: str,
    source: dict[str, object],
    feed_icon_url: str | None = None,
    homepage_url: str | None = None,
) -> None:
    """优先缓存 feed 图标，其次尝试来源网页的 favicon。"""
    if source.get("icon_asset"):
        return
    icon_candidates = [
        feed_icon_url,
        _favicon_url(homepage_url),
        _favicon_url(str(source["url"])),
    ]
    cached_icon = await images.cache_first(client, icon_candidates)
    if cached_icon:
        icon_asset, icon_url = cached_icon
        await asyncio.to_thread(db.set_source_icon, source_id, icon_url, icon_asset)


def _error_message(error: Exception, source_type: str = "rss") -> str:
    if isinstance(error, ModuleNotFoundError) and error.name == "aiotieba":
        return "贴吧采集组件未安装，请重新安装 TabKeep 后端依赖"
    if isinstance(error, (asyncio.TimeoutError, TimeoutError)) and source_type == "tieba":
        return "贴吧采集超时，请稍后重试"
    if source_type == "tieba" and isinstance(error, RuntimeError):
        return str(error)
    if isinstance(error, httpx.HTTPStatusError):
        if source_type == "xiaoheihe":
            return f"小黑盒新闻接口返回 HTTP {error.response.status_code}"
        return f"订阅服务器返回 HTTP {error.response.status_code}"
    if isinstance(error, httpx.TimeoutException):
        if source_type == "xiaoheihe":
            return "连接小黑盒新闻接口超时，请稍后重试"
        return "连接订阅源超时，请检查地址或稍后重试"
    if isinstance(error, httpx.TooManyRedirects):
        return "订阅地址重定向次数过多"
    if isinstance(error, httpx.HTTPError):
        return f"订阅请求失败（{type(error).__name__}）"
    if isinstance(error, ValueError):
        return str(error)
    return f"采集失败（{type(error).__name__}）"


async def _refresh_tieba_source(
    source_id: str,
    source: dict[str, object],
    source_title: str,
) -> RefreshResult:
    """抓取贴吧主题帖并按 tid 保存。"""
    forum_name = tieba.parse_forum_name(str(source["url"]))
    if not forum_name:
        raise ValueError("贴吧订阅地址无效，请使用贴吧主页地址")
    entries = await tieba.fetch_forum_with_timeout(forum_name)
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS, follow_redirects=False) as client:
        await _cache_entry_images(client, entries)
        await _cache_source_icon(client, source_id, source)
    timestamp = _now_iso()
    new_items = await asyncio.to_thread(
        db.complete_fetch,
        source_id,
        forum_name,
        None,
        None,
        timestamp,
        entries,
    )
    return {
        "sourceId": source_id,
        "sourceTitle": forum_name or source_title,
        "newItems": new_items,
        "notModified": False,
        "error": None,
    }


async def _refresh_xiaoheihe_source(
    source_id: str,
    source: dict[str, object],
    source_title: str,
) -> RefreshResult:
    """抓取小黑盒游戏新闻列表，并缓存本次返回的图片。"""
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS, follow_redirects=False) as client:
        candidates = await xiaoheihe.fetch_news_list(client)
        entries = [candidate["entry"] for candidate in candidates]
        await _cache_entry_images(client, entries)
        await _cache_source_icon(
            client,
            source_id,
            source,
            homepage_url=xiaoheihe.HOMEPAGE_URL,
        )

    timestamp = _now_iso()
    new_items = await asyncio.to_thread(
        db.complete_fetch,
        source_id,
        "小黑盒游戏新闻",
        None,
        None,
        timestamp,
        entries,
    )
    return {
        "sourceId": source_id,
        "sourceTitle": source_title,
        "newItems": new_items,
        "notModified": False,
        "error": None,
    }


async def refresh_source(source_id: str) -> RefreshResult:
    """刷新单个订阅源；请求失败时保留既有条目并记录可见错误。"""
    async with _get_source_lock(source_id):
        source = await asyncio.to_thread(db.get_source, source_id)
        if source is None:
            return {
                "sourceId": source_id,
                "sourceTitle": "未知订阅源",
                "newItems": 0,
                "notModified": False,
                "error": "订阅源不存在",
            }
        source_title = str(source["title"])
        if bool(source.get("is_deleted")):
            return {
                "sourceId": source_id,
                "sourceTitle": source_title,
                "newItems": 0,
                "notModified": False,
                "error": "订阅源已删除",
            }
        if not bool(source["is_active"]):
            return {
                "sourceId": source_id,
                "sourceTitle": source_title,
                "newItems": 0,
                "notModified": False,
                "error": "该订阅源已停用",
            }

        source_type = str(source.get("source_type") or "rss")
        if source_type == "tieba":
            try:
                async with _get_fetch_semaphore():
                    return await _refresh_tieba_source(source_id, source, source_title)
            except Exception as error:
                message = _error_message(error, source_type)
                await asyncio.to_thread(db.record_failure, source_id, _now_iso(), message)
                return {
                    "sourceId": source_id,
                    "sourceTitle": source_title,
                    "newItems": 0,
                    "notModified": False,
                    "error": message,
                }
        if source_type == "xiaoheihe":
            try:
                async with _get_fetch_semaphore():
                    return await _refresh_xiaoheihe_source(source_id, source, source_title)
            except Exception as error:
                message = _error_message(error, source_type)
                await asyncio.to_thread(db.record_failure, source_id, _now_iso(), message)
                return {
                    "sourceId": source_id,
                    "sourceTitle": source_title,
                    "newItems": 0,
                    "notModified": False,
                    "error": message,
                }

        headers: dict[str, str] = {
            "User-Agent": "TabKeep/1.0 (+local RSS reader)",
            "Accept": "application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
        }
        cached_feed_url = str(source["feed_url"]) if source.get("feed_url") else None
        request_headers = headers.copy()
        if source.get("etag"):
            request_headers["If-None-Match"] = str(source["etag"])
        if source.get("last_modified"):
            request_headers["If-Modified-Since"] = str(source["last_modified"])

        try:
            async with _get_fetch_semaphore():
                async with httpx.AsyncClient(
                    timeout=REQUEST_TIMEOUT_SECONDS,
                    follow_redirects=True,
                    max_redirects=MAX_REDIRECTS,
                ) as client:
                    request_url = cached_feed_url or str(source["url"])
                    downloaded = await _download_response(client, request_url, request_headers)
                    if downloaded["not_modified"]:
                        if "If-None-Match" not in request_headers and "If-Modified-Since" not in request_headers:
                            raise ValueError("服务器返回 304，但本机还没有可用的订阅缓存")
                        if not cached_feed_url:
                            await asyncio.to_thread(
                                db.set_source_feed_url,
                                source_id,
                                downloaded["url"],
                            )
                        await asyncio.to_thread(
                            db.complete_unchanged,
                            source_id,
                            downloaded["etag"],
                            downloaded["last_modified"],
                            _now_iso(),
                        )
                        await _cache_source_icon(client, source_id, source)
                        return {
                            "sourceId": source_id,
                            "sourceTitle": source_title,
                            "newItems": 0,
                            "notModified": True,
                            "error": None,
                        }

                    try:
                        feed_title, feed_icon_url, homepage_url, entries = await asyncio.to_thread(
                            _parse_feed,
                            downloaded["content"],
                            downloaded["url"],
                        )
                    except ValueError as initial_error:
                        if cached_feed_url:
                            raise
                        feed_links = await asyncio.to_thread(
                            _discover_feed_links,
                            downloaded["content"],
                            downloaded["url"],
                            downloaded["encoding"],
                        )
                        if not feed_links:
                            raise ValueError(
                                "服务器响应不是可识别的 RSS 或 Atom feed，且网页未声明 RSS/Atom 订阅源；可尝试 RSSHub 路由"
                            ) from initial_error

                        discovered: tuple[
                            _DownloadedResponse,
                            str | None,
                            str | None,
                            str | None,
                            list[NormalizedEntry],
                        ] | None = None
                        candidate_errors: list[Exception] = []
                        for feed_link in feed_links:
                            try:
                                candidate_response = await _download_response(client, feed_link, headers)
                                if candidate_response["not_modified"]:
                                    raise ValueError("服务器返回 304，但本机还没有可用的订阅缓存")
                                (
                                    candidate_title,
                                    candidate_icon_url,
                                    candidate_homepage_url,
                                    candidate_entries,
                                ) = await asyncio.to_thread(
                                    _parse_feed,
                                    candidate_response["content"],
                                    candidate_response["url"],
                                )
                                discovered = (
                                    candidate_response,
                                    candidate_title,
                                    candidate_icon_url,
                                    candidate_homepage_url,
                                    candidate_entries,
                                )
                                break
                            except (httpx.HTTPError, ValueError) as candidate_error:
                                candidate_errors.append(candidate_error)

                        if discovered is None:
                            details = "；".join(
                                dict.fromkeys(_error_message(error) for error in candidate_errors)
                            )
                            raise ValueError(
                                "网页声明的 RSS/Atom 订阅地址无法读取"
                                + (f"：{details}" if details else "")
                            ) from initial_error
                        downloaded, feed_title, feed_icon_url, homepage_url, entries = discovered

                    await asyncio.to_thread(
                        db.set_source_feed_url,
                        source_id,
                        downloaded["url"],
                    )
                    await _cache_entry_images(client, entries)
                    await _cache_source_icon(
                        client,
                        source_id,
                        source,
                        feed_icon_url,
                        homepage_url,
                    )
                    new_items = await asyncio.to_thread(
                        db.complete_fetch,
                        source_id,
                        feed_title,
                        downloaded["etag"],
                        downloaded["last_modified"],
                        _now_iso(),
                        entries,
                    )
                    return {
                        "sourceId": source_id,
                        "sourceTitle": feed_title or source_title,
                        "newItems": new_items,
                        "notModified": False,
                        "error": None,
                    }
        except Exception as error:
            message = _error_message(error)
            await asyncio.to_thread(db.record_failure, source_id, _now_iso(), message)
            return {
                "sourceId": source_id,
                "sourceTitle": source_title,
                "newItems": 0,
                "notModified": False,
                "error": message,
            }


async def refresh_sources(source_ids: list[str]) -> list[RefreshResult]:
    """并发刷新多个订阅源，并隔离单源错误。"""
    return list(await asyncio.gather(*(refresh_source(source_id) for source_id in source_ids)))


async def refresh_due_sources() -> list[RefreshResult]:
    """刷新超过固定轮询周期的启用源。"""
    cutoff = (datetime.now(timezone.utc).timestamp() - POLL_INTERVAL_SECONDS)
    cutoff_iso = datetime.fromtimestamp(cutoff, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    source_ids = await asyncio.to_thread(db.list_due_source_ids, cutoff_iso)
    return await refresh_sources(source_ids)


async def run_scheduler() -> None:
    """启动时补抓到期源，之后每 60 分钟轮询一次。"""
    while True:
        try:
            await refresh_due_sources()
        except Exception as error:
            logger.warning(f"资讯订阅轮询失败（{type(error).__name__}）")
        await asyncio.sleep(POLL_INTERVAL_SECONDS)
