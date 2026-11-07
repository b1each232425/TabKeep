"""使用平台 JSON API 搜索抖音和 B 站；快手继续读取正常网页已加载的数据。"""

import asyncio
import hashlib
import html
import re
import secrets
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode, urlsplit, urlunsplit

from playwright.async_api import BrowserContext, Page, Route, TimeoutError as PlaywrightTimeoutError

from services.news.url_utils import canonicalize_url
from services.news.video_comment_jobs import VideoCommentCollectionError
from services.news.topic_search_diagnostics import log_topic_search_diagnostic

SEARCH_LIMIT = 20
SEARCH_TIMEOUT_MS = 20_000
PAGE_READ_TIMEOUT_MS = 5_000
PAGE_SETTLE_MS = 900
COMMENT_LIMIT = 10
COMMENT_PAGE_SIZE = 20
COMMENT_SCAN_LIMIT = 100
COMMENT_MAX_PAGES = COMMENT_SCAN_LIMIT // COMMENT_PAGE_SIZE
COMMENT_PAGE_INTERVAL_SECONDS = 0.5
API_RESPONSE_WAIT_MS = 5_000
BILIBILI_API_ORIGIN = "https://api.bilibili.com"
DOUYIN_SEARCH_API_PATH = "/aweme/v1/web/general/search/single/"
DOUYIN_COMMENT_API_PATH = "/aweme/v1/web/comment/list/"
DOUYIN_API_ORIGIN = "https://www.douyin.com"
DOUYIN_SIGNER_PATH = Path(__file__).with_name("vendor") / "douyin_sign.js"
DOUYIN_ARGUS_HEADER_VALUE = "1"
BILIBILI_WBI_MIXIN_KEY_ORDER = (
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
)
BILIBILI_WBI_CACHE_TTL_SECONDS = 1_800
_bilibili_wbi_cache: tuple[str, str, float] | None = None
_bilibili_wbi_cache_lock = asyncio.Lock()

PROVIDER_TITLES = {
    "douyin": "抖音",
    "bilibili": "哔哩哔哩",
    "kuaishou": "快手",
}
PROVIDER_DOMAINS = {
    "douyin": ("douyin.com",),
    "bilibili": ("bilibili.com", "b23.tv"),
    "kuaishou": ("kuaishou.com", "gifshow.com"),
}
PROVIDER_SEARCH_HOSTS = {
    "douyin": ("douyin.com",),
    "bilibili": ("bilibili.com",),
    "kuaishou": ("kuaishou.com",),
}
PROVIDER_VIDEO_ID_PATTERNS = {
    "douyin": re.compile(r"/video/(\d+)(?:[/?#]|$)", re.IGNORECASE),
    "bilibili": re.compile(r"/video/(BV[a-zA-Z0-9]+|av\d+)(?:[/?#]|$)", re.IGNORECASE),
    "kuaishou": re.compile(r"/(?:short-video|photo)/([A-Za-z0-9_-]+)(?:[/?#]|$)", re.IGNORECASE),
}
LOGIN_WALL_TEXT = (
    "请先登录",
    "登录后查看",
    "登录后继续",
    "登录后评论",
    "登录后可查看",
    "扫码登录",
    "请登录后",
    "sign in to continue",
)
CHALLENGE_TEXT = ("安全验证", "访问过于频繁", "操作频繁", "验证码", "人机验证")
NO_COMMENTS_TEXT = (
    "暂无评论",
    "还没有评论",
    "还没有人评论",
    "评论已关闭",
    "评论功能已关闭",
    "评论区已关闭",
    "no comments yet",
    "comments are turned off",
    "comments are disabled",
)


class VideoTopicSearchError(Exception):
    """不包含页面正文、Cookie 或原始 Playwright 异常的安全错误。"""

    def __init__(
        self,
        message: str,
        error_code: str,
        *,
        state: str = "error",
        http_status: int | None = None,
    ) -> None:
        super().__init__(message)
        self.message = " ".join(message.split())[:240]
        self.error_code = error_code[:80]
        self.state = state if state in {"error", "timeout", "login_required"} else "error"
        self.http_status = http_status


def _search_url(provider: str, query: str, page_number: int) -> str:
    encoded_query = quote(query, safe="")
    if provider == "douyin":
        params = urlencode({"type": "video", "search_id": ""})
        return f"https://www.douyin.com/search/{encoded_query}?{params}"
    if provider == "bilibili":
        return "https://search.bilibili.com/video?" + urlencode(
            {"keyword": query, "page": max(1, page_number)}
        )
    if provider == "kuaishou":
        return "https://www.kuaishou.com/search/video?" + urlencode({"searchKey": query})
    raise ValueError("不支持的视频平台")


def _safe_platform_url(provider: str, value: Any) -> str | None:
    if provider not in PROVIDER_DOMAINS or not isinstance(value, str) or len(value) > 2048:
        return None
    try:
        parsed = urlsplit(value.strip())
        host = (parsed.hostname or "").casefold().rstrip(".")
        if parsed.scheme.casefold() not in {"http", "https"} or not host:
            return None
        if parsed.username is not None or parsed.password is not None:
            return None
        if not any(host == domain or host.endswith(f".{domain}") for domain in PROVIDER_DOMAINS[provider]):
            return None
        if parsed.port not in {None, 80, 443}:
            return None
        return urlunsplit((parsed.scheme.casefold(), parsed.netloc.casefold(), parsed.path[:1800], "", ""))
    except ValueError:
        return None


def _safe_search_url(provider: str, value: str) -> str | None:
    safe_url = _safe_platform_url(provider, value)
    if safe_url is None:
        return None
    host = (urlsplit(safe_url).hostname or "").casefold()
    if not any(host == domain or host.endswith(f".{domain}") for domain in PROVIDER_SEARCH_HOSTS[provider]):
        return None
    return safe_url


async def _install_platform_navigation_guard(page: Page, provider: str) -> None:
    """只允许主框架在对应平台域名间导览，不拦截 CDN 子资源。"""
    async def guard(route: Route) -> None:
        request = route.request
        if request.is_navigation_request() and request.frame == page.main_frame:
            if _safe_platform_url(provider, request.url) is None:
                await route.abort()
                return
        await route.continue_()

    await page.route("**/*", guard)


def _access_error(provider: str, status: int | None, page_url: str, body: str) -> VideoCommentCollectionError | None:
    lowered_url = page_url.casefold()
    lowered_body = body.casefold()
    diagnostics = {
        "http_status": status,
        "body_chars": len(body),
        "host_class": "platform" if _safe_platform_url(provider, page_url) else "unexpected",
    }
    if status == 401 or any(path in lowered_url for path in ("/login", "/signin", "/passport")):
        code = f"HTTP_{status}" if status == 401 else "LOGIN_REDIRECT"
        return VideoCommentCollectionError(
            "login_required",
            f"{PROVIDER_TITLES[provider]}需要登录后才能读取评论。",
            True,
            error_code=code,
            diagnostics=diagnostics,
        )
    if any(text.casefold() in lowered_body for text in LOGIN_WALL_TEXT):
        return VideoCommentCollectionError(
            "login_required",
            f"{PROVIDER_TITLES[provider]}要求登录后继续。",
            True,
            error_code="LOGIN_WALL",
            diagnostics=diagnostics,
        )
    if status in {403, 412, 429}:
        return VideoCommentCollectionError(
            "limited",
            f"{PROVIDER_TITLES[provider]}限制了本次访问，已暂停该平台的评论采集。",
            True,
            error_code=f"HTTP_{status}",
            diagnostics=diagnostics,
        )
    if any(text.casefold() in lowered_body for text in CHALLENGE_TEXT):
        return VideoCommentCollectionError(
            "limited",
            f"{PROVIDER_TITLES[provider]}限制了本次访问，已暂停该平台的评论采集。",
            True,
            error_code="PLATFORM_CHALLENGE",
            diagnostics=diagnostics,
        )
    return None


def _log_video_api(
    provider: str,
    stage: str,
    state: str,
    *,
    request_id: str | None = None,
    video_id: str | None = None,
    http_status: int | None = None,
    result_count: int | None = None,
    comment_count: int | None = None,
    request_count: int | None = None,
    target_request_count: int | None = None,
    matched_response_count: int | None = None,
    request_host_class: str | None = None,
    error_code: str | None = None,
    duration_ms: int | None = None,
) -> None:
    video_hash = hashlib.sha256(video_id.encode("utf-8")).hexdigest()[:20] if video_id else None
    log_topic_search_diagnostic(
        "video_platform_api",
        request_id=request_id,
        provider=provider,
        video_hash=video_hash,
        stage=stage,
        state=state,
        http_status=http_status,
        result_count=result_count,
        comment_count=comment_count,
        request_count=request_count,
        target_request_count=target_request_count,
        matched_response_count=matched_response_count,
        request_host_class=request_host_class,
        error_code=error_code,
        duration_ms=duration_ms,
    )


def _attach_api_response_capture(
    page: Page,
    provider: str,
    path_fragment: str,
) -> tuple[list[dict[str, Any]], asyncio.Event, set[asyncio.Task[None]]]:
    """只暂存平台页面自己发出的目标 JSON 响应，不保留 URL、请求头或 Cookie。"""
    captured: list[dict[str, Any]] = []
    received = asyncio.Event()
    pending: set[asyncio.Task[None]] = set()
    allowed_hosts = {
        "douyin": {"www.douyin.com", "douyin.com"},
        "bilibili": {"www.bilibili.com", "search.bilibili.com"},
        "kuaishou": {"www.kuaishou.com", "kuaishou.com"},
    }

    async def read_response(response: Any) -> None:
        try:
            payload = await response.json()
        except Exception:
            payload = None
        captured.append({"status": response.status, "payload": payload})
        received.set()

    def on_response(response: Any) -> None:
        try:
            parsed = urlsplit(response.url)
            host = (parsed.hostname or "").casefold()
            if host not in allowed_hosts[provider] or path_fragment not in parsed.path:
                return
        except (KeyError, ValueError):
            return
        task = asyncio.create_task(read_response(response))
        pending.add(task)
        task.add_done_callback(pending.discard)

    page.on("response", on_response)
    return captured, received, pending


async def _wait_for_api_response(
    captured: list[dict[str, Any]],
    received: asyncio.Event,
    pending: set[asyncio.Task[None]],
) -> None:
    if not captured:
        try:
            await asyncio.wait_for(received.wait(), timeout=API_RESPONSE_WAIT_MS / 1000)
        except asyncio.TimeoutError:
            return
    await asyncio.sleep(0.15)
    active = tuple(pending)
    if active:
        await asyncio.gather(*active, return_exceptions=True)


def _api_http_error(status: int | None, title: str) -> VideoTopicSearchError | None:
    if status == 401:
        return VideoTopicSearchError(
            f"{title}要求登录后才能搜索。", "API_LOGIN_REQUIRED", state="login_required", http_status=status
        )
    if status in {403, 412, 429}:
        return VideoTopicSearchError(
            f"{title}限制了本次访问；TabKeep 不会绕过平台验证。",
            "API_PLATFORM_LIMITED",
            http_status=status,
        )
    if status is not None and status >= 500:
        return VideoTopicSearchError(f"{title}接口暂时不可用。", "API_SERVER_ERROR", http_status=status)
    return None


def _normalize_api_text(value: Any, limit: int) -> str:
    text = html.unescape(str(value or ""))
    text = re.sub(r"<[^>]*>", " ", text)
    return " ".join(text.split())[:limit]


def _api_timestamp(value: Any) -> str | None:
    try:
        timestamp = float(value)
        if timestamp > 100_000_000_000:
            timestamp /= 1000
        if timestamp <= 0:
            return None
        return datetime.fromtimestamp(timestamp, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    except (OverflowError, OSError, TypeError, ValueError):
        return None


def _api_like_count(value: Any) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        count = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return max(0, count)


def _api_has_more(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value > 0
    return isinstance(value, str) and value.strip().casefold() in {"1", "true", "yes"}


def _top_liked_comments(comments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(
        comments,
        key=lambda comment: comment.get("likeCount") if isinstance(comment.get("likeCount"), int) else -1,
        reverse=True,
    )[:COMMENT_LIMIT]


def _douyin_payload_error(payload: Any, title: str) -> VideoTopicSearchError | None:
    if not isinstance(payload, dict):
        return VideoTopicSearchError(f"{title}接口响应格式无法识别。", "API_SCHEMA_ERROR")
    code = payload.get("status_code", 0)
    if code in (None, 0, "0", "None"):
        return None
    message = str(payload.get("status_msg") or "").casefold()
    if any(fragment in message for fragment in ("登录", "login")):
        return VideoTopicSearchError(f"{title}要求登录后才能继续。", "API_LOGIN_REQUIRED", state="login_required")
    if any(fragment in message for fragment in ("验证", "频繁", "risk", "blocked")) or str(code) in {"8", "9", "10001"}:
        return VideoTopicSearchError(
            f"{title}限制了本次访问；TabKeep 不会绕过平台验证。", "API_PLATFORM_LIMITED"
        )
    return VideoTopicSearchError(f"{title}接口暂时未能完成请求。", "API_PLATFORM_ERROR")


def _extract_douyin_api_items(payload: Any) -> list[dict[str, Any]]:
    api_error = _douyin_payload_error(payload, "抖音")
    if api_error is not None:
        raise api_error
    rows = payload.get("data")
    if not isinstance(rows, list):
        raise VideoTopicSearchError("抖音搜索接口响应格式无法识别。", "API_SCHEMA_ERROR")
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        aweme = row.get("aweme_info")
        if not isinstance(aweme, dict):
            mix = row.get("aweme_mix_info")
            mix_items = mix.get("mix_items") if isinstance(mix, dict) else None
            aweme = mix_items[0] if isinstance(mix_items, list) and mix_items else row
        if not isinstance(aweme, dict):
            continue
        provider_id = str(aweme.get("aweme_id") or "").strip()
        if not provider_id.isdigit() or provider_id in seen:
            continue
        title = _normalize_api_text(aweme.get("desc"), 500)
        if not title:
            continue
        canonical = canonicalize_url(f"https://www.douyin.com/video/{provider_id}")
        author_data = aweme.get("author")
        author = _normalize_api_text(author_data.get("nickname"), 160) if isinstance(author_data, dict) else ""
        seen.add(provider_id)
        items.append({
            "providerId": provider_id,
            "title": title,
            "author": author or None,
            "publishedAt": _api_timestamp(aweme.get("create_time")),
            "content": title,
            "imageUrl": None,
            "url": canonical,
        })
        if len(items) >= SEARCH_LIMIT:
            break
    return items


def _extract_bilibili_api_items(data: Any) -> list[dict[str, Any]]:
    if not isinstance(data, dict) or not isinstance(data.get("result"), list):
        raise VideoTopicSearchError("B 站搜索接口响应格式无法识别。", "API_SCHEMA_ERROR")
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in data["result"]:
        if not isinstance(row, dict):
            continue
        provider_id = str(row.get("bvid") or "").strip()
        if not re.fullmatch(r"BV[a-zA-Z0-9]+", provider_id):
            aid = str(row.get("aid") or "").strip()
            provider_id = f"av{aid}" if aid.isdigit() else ""
        if (not re.fullmatch(r"BV[a-zA-Z0-9]+", provider_id) and not re.fullmatch(r"av\d+", provider_id)) or provider_id in seen:
            continue
        title = _normalize_api_text(row.get("title"), 500)
        if not title:
            continue
        canonical = canonicalize_url(f"https://www.bilibili.com/video/{provider_id}")
        seen.add(provider_id)
        items.append({
            "providerId": provider_id,
            "apiVideoId": str(row.get("aid")) if str(row.get("aid") or "").isdigit() else None,
            "title": title,
            "author": _normalize_api_text(row.get("author"), 160) or None,
            "publishedAt": _api_timestamp(row.get("pubdate")),
            "content": _normalize_api_text(row.get("description"), 2500),
            "imageUrl": None,
            "url": canonical,
        })
        if len(items) >= SEARCH_LIMIT:
            break
    return items


def _bilibili_key_from_url(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    filename = urlsplit(value).path.rsplit("/", 1)[-1]
    key = filename.split(".", 1)[0]
    return key if re.fullmatch(r"[A-Za-z0-9]{32}", key) else ""


def _bilibili_wbi_sign(params: dict[str, Any], img_key: str, sub_key: str) -> dict[str, Any]:
    source = img_key + sub_key
    if len(source) < max(BILIBILI_WBI_MIXIN_KEY_ORDER) + 1:
        raise VideoTopicSearchError("无法生成 B 站搜索接口签名。", "API_SIGNING_KEY_INVALID")
    mixin_key = "".join(source[index] for index in BILIBILI_WBI_MIXIN_KEY_ORDER)[:32]
    signed = {**params, "wts": int(time.time())}
    filtered = {
        key: "".join(character for character in str(value) if character not in "!'()*")
        for key, value in sorted(signed.items())
    }
    query = urlencode(filtered)
    filtered["w_rid"] = hashlib.md5((query + mixin_key).encode("utf-8")).hexdigest()
    return filtered


async def _bilibili_api_json(
    context: BrowserContext,
    path: str,
    params: dict[str, Any],
    headers: dict[str, str],
    *,
    wbi_keys: tuple[str, str] | None = None,
) -> tuple[int, dict[str, Any]]:
    request_params = _bilibili_wbi_sign(params, *wbi_keys) if wbi_keys else params
    query = urlencode(request_params)
    request_url = f"{BILIBILI_API_ORIGIN}{path}" + (f"?{query}" if query else "")
    referer = next((value for key, value in headers.items() if key.casefold() == "referer"), None)
    page: Page | None = None
    try:
        # B 站接口在 Edge 页面中可访问；独立 API 请求在部分机器上会被网络层拒绝。
        # 让现有浏览器上下文发起主框架导航，复用浏览器自己的 Cookie 和网络栈。
        page = await context.new_page()
        browser_headers = {
            key: value for key, value in headers.items()
            if key.casefold() in {"accept", "accept-language"}
        }
        if browser_headers:
            await page.set_extra_http_headers(browser_headers)
        response = await page.goto(
            request_url,
            referer=referer,
            wait_until="domcontentloaded",
            timeout=SEARCH_TIMEOUT_MS,
        )
    except PlaywrightTimeoutError as exc:
        if page is not None:
            try:
                await page.close()
            except Exception:
                pass
        raise VideoTopicSearchError("B 站接口响应超时。", "API_TIMEOUT", state="timeout") from exc
    except Exception as exc:
        if page is not None:
            try:
                await page.close()
            except Exception:
                pass
        raise VideoTopicSearchError("无法连接 B 站接口。", "API_TRANSPORT_ERROR") from exc
    try:
        if response is None:
            raise VideoTopicSearchError("B 站接口没有返回响应。", "API_RESPONSE_MISSING")
        status = response.status
        http_error = _api_http_error(status, "B 站")
        if http_error is not None:
            raise http_error
        payload = await response.json()
    except VideoTopicSearchError:
        raise
    except Exception as exc:
        status = response.status if response is not None else None
        raise VideoTopicSearchError(
            "B 站接口响应格式无法识别。", "API_JSON_ERROR", http_status=status
        ) from exc
    finally:
        if page is not None:
            try:
                await page.close()
            except Exception:
                pass
    if not isinstance(payload, dict):
        raise VideoTopicSearchError("B 站接口响应格式无法识别。", "API_SCHEMA_ERROR", http_status=status)
    code = payload.get("code", 0)
    if code not in (None, 0, "0"):
        if str(code) == "-101":
            raise VideoTopicSearchError(
                "B 站要求登录后才能继续。", "API_LOGIN_REQUIRED", state="login_required", http_status=status
            )
        if str(code) in {"-412", "-352"}:
            raise VideoTopicSearchError(
                "B 站限制了本次访问；TabKeep 不会绕过平台验证。",
                "API_PLATFORM_LIMITED",
                http_status=status,
            )
        raise VideoTopicSearchError("B 站接口暂时未能完成请求。", "API_PLATFORM_ERROR", http_status=status)
    return status, payload


async def _bilibili_wbi_keys(
    context: BrowserContext,
    headers: dict[str, str],
) -> tuple[int, str, str]:
    global _bilibili_wbi_cache
    now = time.monotonic()
    if _bilibili_wbi_cache is not None and _bilibili_wbi_cache[2] > now:
        return 200, _bilibili_wbi_cache[0], _bilibili_wbi_cache[1]
    async with _bilibili_wbi_cache_lock:
        now = time.monotonic()
        if _bilibili_wbi_cache is not None and _bilibili_wbi_cache[2] > now:
            return 200, _bilibili_wbi_cache[0], _bilibili_wbi_cache[1]
        status, payload = await _bilibili_api_json(
            context,
            "/x/web-interface/nav",
            {},
            headers,
        )
        wbi = payload.get("data", {}).get("wbi_img") if isinstance(payload.get("data"), dict) else None
        if not isinstance(wbi, dict):
            raise VideoTopicSearchError("B 站没有返回 WBI 密钥。", "API_WBI_KEYS_MISSING", http_status=status)
        img_key = _bilibili_key_from_url(wbi.get("img_url"))
        sub_key = _bilibili_key_from_url(wbi.get("sub_url"))
        if not img_key or not sub_key:
            raise VideoTopicSearchError("B 站返回的 WBI 密钥格式无法识别。", "API_WBI_KEYS_INVALID", http_status=status)
        _bilibili_wbi_cache = (img_key, sub_key, time.monotonic() + BILIBILI_WBI_CACHE_TTL_SECONDS)
        return status, img_key, sub_key


def _comment_api_error(
    provider: str,
    error: VideoTopicSearchError,
    *,
    body_chars: int = 0,
    host_class: str = "platform",
) -> VideoCommentCollectionError:
    if error.state == "login_required":
        state = "login_required"
        stop_provider = True
    elif error.error_code == "API_PLATFORM_LIMITED" or error.http_status in {403, 412, 429}:
        state = "limited"
        stop_provider = True
    else:
        state = "failed"
        stop_provider = False
    diagnostics: dict[str, str | int | bool | None] = {
        "host_class": host_class,
        "http_status": error.http_status,
        "body_chars": body_chars,
    }
    return VideoCommentCollectionError(
        state,
        error.message or f"{PROVIDER_TITLES.get(provider, '平台')}评论接口暂时未能完成请求。",
        stop_provider=stop_provider,
        error_code=error.error_code,
        diagnostics=diagnostics,
    )


def _with_partial_liked_comments(
    error: VideoCommentCollectionError,
    comments: list[dict[str, Any]],
) -> VideoCommentCollectionError:
    partial_comments = _top_liked_comments(comments)
    if partial_comments:
        error.partial_comments = partial_comments
        error.diagnostics["partial_comment_count"] = len(partial_comments)
    return error


async def _page_body(page: Page) -> str:
    try:
        return " ".join((await page.locator("body").inner_text(timeout=PAGE_READ_TIMEOUT_MS)).split())[:12000]
    except Exception:
        return ""


async def _extract_video_items(page: Page, provider: str) -> tuple[list[dict[str, Any]], dict[str, int]]:
    raw_result = await page.locator("a[href]").evaluate_all(
        r"""(anchors, provider) => {
          const selectors = {
            douyin: 'article, [class*=video-card], [class*=VideoCard], [class*=search-result], [class*=SearchResult]',
            bilibili: '.bili-video-card__wrap, .video-item, .bili-video-card, [class*=video-card], [class*=video-item]',
            kuaishou: '[class*=video-card], [class*=photo-card], [class*=search-result], [class*=SearchResult], article'
          };
          const videoAnchors = anchors.filter(anchor => {
            const match = anchor.getAttribute('href') || '';
            return /(\/video\/|\/short-video\/|\/photo\/)/i.test(match);
          });
          const entries = videoAnchors.map(anchor => {
            const root = anchor.closest(selectors[provider]) || anchor.parentElement?.parentElement || anchor.parentElement;
            if (!root) return null;
            const heading = root.querySelector('h1, h2, h3, [class*=title], [class*=Title]');
            const time = root.querySelector('time[datetime], time');
            const author = root.querySelector('[class*=author], [class*=Author], [class*=user-name], [class*=UserName], [class*=nickname]');
            return {
              href: anchor.href,
              anchorText: (anchor.innerText || anchor.getAttribute('title') || '').trim(),
              heading: heading ? (heading.innerText || '').trim() : '',
              text: (root.innerText || '').trim().slice(0, 3000),
              time: time ? (time.getAttribute('datetime') || time.innerText || '').trim() : '',
              author: author ? (author.innerText || '').trim().slice(0, 160) : ''
            };
          }).filter(Boolean);
          return { anchorCount: anchors.length, videoHrefCount: videoAnchors.length, entries };
        }""",
        provider,
    )
    raw_items = raw_result.get("entries", []) if isinstance(raw_result, dict) else []
    diagnostics = {
        "anchor_count": int(raw_result.get("anchorCount", 0)) if isinstance(raw_result, dict) else 0,
        "video_href_count": int(raw_result.get("videoHrefCount", 0)) if isinstance(raw_result, dict) else 0,
        "platform_href_count": 0,
        "video_id_count": 0,
        "title_count": 0,
    }
    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()
    pattern = PROVIDER_VIDEO_ID_PATTERNS[provider]
    for entry in raw_items:
        href = _safe_search_url(provider, str(entry.get("href") or ""))
        if href is None:
            continue
        diagnostics["platform_href_count"] += 1
        parsed = urlsplit(href)
        match = pattern.search(parsed.path)
        if match is None:
            continue
        diagnostics["video_id_count"] += 1
        canonical = canonicalize_url(href)
        if canonical is None or canonical in seen:
            continue
        title = " ".join(str(entry.get("heading") or entry.get("anchorText") or "").split())
        body = " ".join(str(entry.get("text") or "").split())
        if not title:
            title = body[:250].strip()
        if not title:
            continue
        diagnostics["title_count"] += 1
        seen.add(canonical)
        published = " ".join(str(entry.get("time") or "").split())[:100] or None
        normalized.append(
            {
                "providerId": match.group(1),
                "title": title[:500],
                "author": " ".join(str(entry.get("author") or "").split())[:160] or None,
                "publishedAt": published,
                "content": body.replace(title, "", 1).strip(" ·-—|\n")[:2500],
                "imageUrl": None,
                "url": canonical,
            }
        )
        if len(normalized) >= SEARCH_LIMIT:
            break
    return normalized, diagnostics


async def _search_douyin_api(
    query: str,
    page_number: int,
    context: BrowserContext,
    request_id: str | None,
) -> tuple[list[dict[str, Any]], str, str, int | None]:
    target_url = _safe_search_url("douyin", _search_url("douyin", query, page_number))
    if target_url is None:
        raise VideoTopicSearchError("抖音搜索地址校验失败。", "SEARCH_URL_INVALID")
    started = time.perf_counter()
    try:
        page = await context.new_page()
    except Exception as exc:
        raise VideoTopicSearchError("无法打开抖音搜索页面。", "PAGE_CREATE_FAILED") from exc
    captured, received, pending = _attach_api_response_capture(page, "douyin", DOUYIN_SEARCH_API_PATH)
    navigation_status: int | None = None
    try:
        await _install_platform_navigation_guard(page, "douyin")
        try:
            response = await page.goto(target_url, wait_until="domcontentloaded", timeout=SEARCH_TIMEOUT_MS)
            navigation_status = response.status if response else None
        except PlaywrightTimeoutError as exc:
            raise VideoTopicSearchError("抖音搜索页面加载超时。", "PAGE_NAVIGATION_TIMEOUT", state="timeout") from exc
        except Exception as exc:
            raise VideoTopicSearchError("无法连接抖音搜索页面。", "PAGE_NAVIGATION_FAILED") from exc
        body = await _page_body(page)
        access_error = _access_error("douyin", navigation_status, page.url, body)
        if access_error is not None:
            return [], body, page.url, navigation_status
        await page.wait_for_timeout(PAGE_SETTLE_MS)
        await _wait_for_api_response(captured, received, pending)
        if not captured:
            lowered = body.casefold()
            error_code = "API_CHALLENGE" if any(text.casefold() in lowered for text in CHALLENGE_TEXT) else "API_RESPONSE_MISSING"
            log_topic_search_diagnostic(
                "video_platform_api",
                request_id=request_id,
                provider="douyin",
                stage="search_response",
                state="error",
                http_status=navigation_status,
                body_chars=len(body),
                error_code=error_code,
                duration_ms=round((time.perf_counter() - started) * 1000),
            )
            if error_code == "API_CHALLENGE":
                raise VideoTopicSearchError("抖音要求安全验证；TabKeep 不会绕过平台验证。", error_code)
            raise VideoTopicSearchError("抖音搜索页面没有返回搜索 JSON。", error_code)
        api_response = captured[-1]
        status = api_response.get("status")
        http_error = _api_http_error(status if isinstance(status, int) else None, "抖音")
        if http_error is not None:
            raise http_error
        payload = api_response.get("payload")
        api_error = _douyin_payload_error(payload, "抖音")
        if api_error is not None:
            raise api_error
        try:
            items = _extract_douyin_api_items(payload)
        except VideoTopicSearchError as exc:
            if exc.http_status is None and isinstance(status, int):
                exc.http_status = status
            raise
        log_topic_search_diagnostic(
            "video_platform_api",
            request_id=request_id,
            provider="douyin",
            stage="search_response",
            state="success" if items else "empty",
            http_status=status if isinstance(status, int) else None,
            result_count=len(items),
            duration_ms=round((time.perf_counter() - started) * 1000),
        )
        final_url = page.url if _safe_platform_url("douyin", page.url) else target_url
        return items, body, final_url, status if isinstance(status, int) else navigation_status
    except VideoTopicSearchError as exc:
        log_topic_search_diagnostic(
            "video_platform_api",
            request_id=request_id,
            provider="douyin",
            stage="search_response",
            state=exc.state if exc.state in {"timeout", "login_required"} else "limited" if exc.error_code == "API_PLATFORM_LIMITED" else "error",
            http_status=exc.http_status,
            error_code=exc.error_code.upper(),
            duration_ms=round((time.perf_counter() - started) * 1000),
        )
        raise
    finally:
        if pending:
            await asyncio.gather(*tuple(pending), return_exceptions=True)
        try:
            await page.close()
        except Exception:
            pass


async def _search_bilibili_api(
    query: str,
    page_number: int,
    context: BrowserContext,
    request_id: str | None,
) -> tuple[list[dict[str, Any]], str, str, int | None]:
    target_url = _safe_search_url("bilibili", _search_url("bilibili", query, page_number))
    if target_url is None:
        raise VideoTopicSearchError("B 站搜索地址校验失败。", "SEARCH_URL_INVALID")
    started = time.perf_counter()
    try:
        page = await context.new_page()
    except Exception as exc:
        raise VideoTopicSearchError("无法打开 B 站搜索页面。", "PAGE_CREATE_FAILED") from exc
    try:
        await _install_platform_navigation_guard(page, "bilibili")
        try:
            response = await page.goto(target_url, wait_until="domcontentloaded", timeout=SEARCH_TIMEOUT_MS)
        except PlaywrightTimeoutError as exc:
            raise VideoTopicSearchError("B 站搜索页面加载超时。", "PAGE_NAVIGATION_TIMEOUT", state="timeout") from exc
        except Exception as exc:
            raise VideoTopicSearchError("无法连接 B 站搜索页面。", "PAGE_NAVIGATION_FAILED") from exc
        navigation_status = response.status if response else None
        body = await _page_body(page)
        access_error = _access_error("bilibili", navigation_status, page.url, body)
        if access_error is not None:
            return [], body, page.url, navigation_status
        user_agent = str(await page.evaluate("() => navigator.userAgent"))
        headers = {
            "Accept": "application/json, text/plain, */*",
            "Referer": target_url,
            "User-Agent": user_agent,
        }
        _nav_status, img_key, sub_key = await _bilibili_wbi_keys(context, headers)
        status, payload = await _bilibili_api_json(
            context,
            "/x/web-interface/wbi/search/type",
            {
                "search_type": "video",
                "keyword": query,
                "page": max(1, page_number),
                "page_size": SEARCH_LIMIT,
                "order": "totalrank",
                "pubtime_begin_s": 0,
                "pubtime_end_s": 0,
            },
            headers,
            wbi_keys=(img_key, sub_key),
        )
        data = payload.get("data")
        try:
            items = _extract_bilibili_api_items(data)
        except VideoTopicSearchError as exc:
            if exc.http_status is None:
                exc.http_status = status
            raise
        log_topic_search_diagnostic(
            "video_platform_api",
            request_id=request_id,
            provider="bilibili",
            stage="search_response",
            state="success" if items else "empty",
            http_status=status,
            result_count=len(items),
            duration_ms=round((time.perf_counter() - started) * 1000),
        )
        final_url = page.url if _safe_platform_url("bilibili", page.url) else target_url
        return items, body, final_url, status
    except VideoTopicSearchError as exc:
        log_topic_search_diagnostic(
            "video_platform_api",
            request_id=request_id,
            provider="bilibili",
            stage="search_response",
            state=exc.state if exc.state in {"timeout", "login_required"} else "limited" if exc.error_code == "API_PLATFORM_LIMITED" else "error",
            http_status=exc.http_status,
            error_code=exc.error_code.upper(),
            duration_ms=round((time.perf_counter() - started) * 1000),
        )
        raise
    finally:
        try:
            await page.close()
        except Exception:
            pass


async def search_video_page(
    provider: str,
    query: str,
    page_number: int,
    context: BrowserContext,
    request_id: str | None = None,
) -> tuple[list[dict[str, Any]], str, str, int | None]:
    """通过抖音网页 API 响应、B 站 WBI API 或快手页面获取视频搜索结果。"""
    if provider not in PROVIDER_TITLES:
        raise ValueError("不支持的视频平台")
    if provider == "douyin":
        return await _search_douyin_api(query, page_number, context, request_id)
    if provider == "bilibili":
        return await _search_bilibili_api(query, page_number, context, request_id)
    target_url = _safe_search_url(provider, _search_url(provider, query, page_number))
    if target_url is None:
        raise ValueError("视频搜索地址校验失败")
    started = time.perf_counter()
    try:
        page = await context.new_page()
    except Exception as exc:
        log_topic_search_diagnostic(
            "video_search_dom",
            request_id=request_id,
            provider=provider,
            stage="page_create",
            state="error",
            error_code="PAGE_CREATE_FAILED",
            error_type=type(exc).__name__,
            duration_ms=round((time.perf_counter() - started) * 1000),
        )
        raise VideoTopicSearchError("无法打开平台搜索页面。", "page_create") from exc
    response_status: int | None = None
    try:
        await _install_platform_navigation_guard(page, provider)
        try:
            response = await page.goto(target_url, wait_until="domcontentloaded", timeout=SEARCH_TIMEOUT_MS)
            response_status = response.status if response else None
        except PlaywrightTimeoutError as exc:
            raise VideoTopicSearchError("平台搜索页面加载超时。", "navigation_timeout") from exc
        except Exception as exc:
            raise VideoTopicSearchError("无法连接平台搜索页面。", "navigation_failed") from exc
        await page.wait_for_timeout(PAGE_SETTLE_MS)
        body = await _page_body(page)
        host_class = "platform" if _safe_platform_url(provider, page.url) else "unexpected"
        final_url = page.url[:2048] if host_class == "platform" else target_url
        lowered_body = body.casefold()
        common_diagnostics = {
            "request_id": request_id,
            "provider": provider,
            "http_status": response_status,
            "host_class": host_class,
            "body_chars": len(body),
            "challenge_detected": any(text.casefold() in lowered_body for text in CHALLENGE_TEXT),
            "login_wall_detected": any(text.casefold() in lowered_body for text in LOGIN_WALL_TEXT),
            "duration_ms": round((time.perf_counter() - started) * 1000),
        }
        if response_status in {401, 403, 412, 429}:
            log_topic_search_diagnostic(
                "video_search_dom",
                **common_diagnostics,
                stage="http_response",
                state="http_error",
                error_code=f"HTTP_{response_status}",
            )
            return [], body, final_url, response_status
        items, parse_diagnostics = await _extract_video_items(page, provider)
        log_topic_search_diagnostic(
            "video_search_dom",
            **common_diagnostics,
            **parse_diagnostics,
            stage="result_parse",
            state="success" if items else "empty",
            result_count=len(items),
        )
        return items, body, final_url, response_status
    except VideoTopicSearchError as exc:
        log_topic_search_diagnostic(
            "video_search_dom",
            request_id=request_id,
            provider=provider,
            stage=exc.error_code,
            state="error",
            error_code=exc.error_code.upper(),
            duration_ms=round((time.perf_counter() - started) * 1000),
        )
        raise
    except Exception as exc:
        log_topic_search_diagnostic(
            "video_search_dom",
            request_id=request_id,
            provider=provider,
            stage="result_read_failed",
            state="error",
            error_code="RESULT_READ_FAILED",
            error_type=type(exc).__name__,
            duration_ms=round((time.perf_counter() - started) * 1000),
        )
        raise VideoTopicSearchError("读取平台搜索结果失败。", "result_read_failed") from exc
    finally:
        try:
            await page.close()
        except Exception:
            pass


async def _extract_first_level_comments(page: Page, provider: str) -> tuple[list[dict[str, Any]], int]:
    selectors = {
        "douyin": '[data-e2e="comment-item"], [class*=CommentItem], [class*=comment-item]',
        "bilibili": "#comment .reply-item, #comment .root-reply-container, .reply-list > .reply-item",
        "kuaishou": '[data-testid*=comment], [class*=CommentItem], [class*=comment-item]',
    }
    raw_comments = await page.locator(selectors[provider]).evaluate_all(
        """(nodes) => {
          const subSelector = '[class*=sub-reply], [class*=subReply], [class*=reply-sub], [class*=sub-comment], [class*=subComment]';
          const seen = new Set();
          const output = [];
          for (const root of nodes) {
            if (root.closest(subSelector)) continue;
            const clone = root.cloneNode(true);
            clone.querySelectorAll(subSelector).forEach(node => node.remove());
            const contentNode = clone.querySelector('[class*=reply-content], [class*=comment-content], [class*=content], [class*=Content]');
            const content = ((contentNode && contentNode.innerText) || clone.innerText || '').trim().slice(0, 4000);
            if (!content || seen.has(content)) continue;
            seen.add(content);
            const authorNode = root.querySelector('[class*=user-name], [class*=username], [class*=author], [class*=Author], [class*=nickname]');
            const timeNode = root.querySelector('time[datetime], time, [class*=time], [class*=Time]');
            output.push({
              content,
              author: authorNode ? (authorNode.innerText || '').trim().slice(0, 160) : '',
              publishedAt: timeNode ? (timeNode.getAttribute('datetime') || timeNode.innerText || '').trim().slice(0, 100) : ''
            });
            if (output.length >= 10) break;
          }
          return output;
        }""",
    )
    comment_node_count = len(raw_comments)
    comments: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, entry in enumerate(raw_comments):
        content = " ".join(str(entry.get("content") or "").split())[:4000]
        if not content or content in seen:
            continue
        seen.add(content)
        comments.append(
            {
                "key": f"{provider}:{index}",
                "author": " ".join(str(entry.get("author") or "").split())[:160] or None,
                "content": content,
                "publishedAt": " ".join(str(entry.get("publishedAt") or "").split())[:100] or None,
                "url": None,
            }
        )
        if len(comments) >= COMMENT_LIMIT:
            break
    return comments, comment_node_count


def _extract_douyin_api_comments(payload: Any) -> list[dict[str, Any]]:
    api_error = _douyin_payload_error(payload, "抖音")
    if api_error is not None:
        raise api_error
    rows = payload.get("comments")
    if rows is None:
        return []
    if not isinstance(rows, list):
        raise VideoTopicSearchError("抖音评论接口响应格式无法识别。", "API_SCHEMA_ERROR")
    comments: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            continue
        content = _normalize_api_text(row.get("text"), 4000)
        if not content or content in seen:
            continue
        user = row.get("user") or row.get("user_info")
        author = _normalize_api_text(user.get("nickname"), 160) if isinstance(user, dict) else ""
        comment_id = str(row.get("cid") or index)
        raw_like_count = row.get("digg_count")
        if raw_like_count is None:
            raw_like_count = row.get("like_count")
        seen.add(content)
        comments.append({
            "key": f"douyin:{comment_id}",
            "author": author or None,
            "content": content,
            "publishedAt": _api_timestamp(row.get("create_time")),
            "likeCount": _api_like_count(raw_like_count),
            "url": None,
        })
    return comments


def _douyin_comment_params(video_id: str, ms_token: str, cursor: int = 0) -> dict[str, str]:
    """按 MediaCrawler 当前 Web 评论接口顺序构造签名参数。"""
    return {
        "aweme_id": video_id,
        "cursor": str(cursor),
        "count": str(COMMENT_PAGE_SIZE),
        "item_type": "0",
        "device_platform": "webapp",
        "aid": "6383",
        "channel": "channel_pc_web",
        "version_code": "190600",
        "version_name": "19.6.0",
        "update_version_code": "170400",
        "pc_client_type": "1",
        "cookie_enabled": "true",
        "browser_language": "zh-CN",
        "browser_platform": "MacIntel",
        "browser_name": "Chrome",
        "browser_version": "125.0.0.0",
        "browser_online": "true",
        "engine_name": "Blink",
        "os_name": "Mac OS",
        "os_version": "10.15.7",
        "cpu_core_num": "8",
        "device_memory": "8",
        "engine_version": "109.0",
        "platform": "PC",
        "screen_width": "2560",
        "screen_height": "1440",
        "effective_type": "4g",
        "round_trip_time": "50",
        "webid": str(10**18 + secrets.randbelow(9 * 10**18)),
        "msToken": ms_token,
    }


async def _douyin_uifid(context: BrowserContext) -> str | None:
    """只在请求构造时读取 UIFID，不写入日志或持久化存储。"""
    try:
        cookies = await context.cookies([DOUYIN_API_ORIGIN, "https://douyin.com"])
    except Exception:
        return None
    for cookie in cookies:
        if str(cookie.get("name") or "") in {"UIFID", "UIFID_TEMP"}:
            value = str(cookie.get("value") or "").strip()
            if value:
                return value
    return None


def _extract_bilibili_api_comments(data: Any) -> list[dict[str, Any]]:
    if not isinstance(data, dict):
        raise VideoTopicSearchError("B 站评论接口响应格式无法识别。", "API_SCHEMA_ERROR")
    rows: list[Any] = []
    top_replies = data.get("top_replies")
    if isinstance(top_replies, list):
        rows.extend(top_replies)
    top = data.get("top")
    if isinstance(top, dict):
        upper = top.get("upper")
        if isinstance(upper, dict):
            rows.append(upper)
    replies = data.get("replies")
    if isinstance(replies, list):
        rows.extend(replies)
    comments: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    seen_content: set[str] = set()
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            continue
        content_data = row.get("content")
        content = _normalize_api_text(content_data.get("message"), 4000) if isinstance(content_data, dict) else ""
        if not content or content in seen_content:
            continue
        member = row.get("member")
        author = _normalize_api_text(member.get("uname"), 160) if isinstance(member, dict) else ""
        comment_id = str(row.get("rpid") or index)
        raw_like_count = row.get("like")
        if raw_like_count is None:
            raw_like_count = row.get("like_count")
        if comment_id in seen_ids:
            continue
        seen_ids.add(comment_id)
        seen_content.add(content)
        comments.append({
            "key": f"bilibili:{comment_id}",
            "author": author or None,
            "content": content,
            "publishedAt": _api_timestamp(row.get("ctime")),
            "likeCount": _api_like_count(raw_like_count),
            "url": None,
        })
    return comments


async def _collect_douyin_api_comments(
    video_id: str,
    target_url: str,
    context: BrowserContext,
) -> list[dict[str, Any]]:
    started = time.perf_counter()
    try:
        page = await context.new_page()
    except Exception as exc:
        raise VideoCommentCollectionError("failed", "无法打开抖音视频页面。", error_code="PAGE_CREATE_FAILED") from exc
    body = ""
    navigation_status: int | None = None
    api_status: int | None = None
    api_requested = 0
    response_received = 0
    comments: list[dict[str, Any]] = []
    seen_comment_keys: set[str] = set()
    seen_content: set[str] = set()

    def diagnostics() -> dict[str, str | int | bool | None]:
        return {
            "host_class": "platform",
            "http_status": api_status if api_status is not None else navigation_status,
            "body_chars": len(body),
            "request_count": api_requested,
            "target_request_count": api_requested,
            "matched_response_count": response_received,
            "request_host_class": "platform" if api_requested else "unknown",
        }

    try:
        await _install_platform_navigation_guard(page, "douyin")
        try:
            response = await page.goto(target_url, wait_until="domcontentloaded", timeout=SEARCH_TIMEOUT_MS)
            navigation_status = response.status if response else None
        except PlaywrightTimeoutError as exc:
            raise VideoCommentCollectionError("failed", "抖音视频页面加载超时。", error_code="PAGE_NAVIGATION_TIMEOUT") from exc
        except Exception as exc:
            raise VideoCommentCollectionError("failed", "无法连接抖音视频页面。", error_code="PAGE_NAVIGATION_FAILED") from exc
        body = await _page_body(page)
        access_error = _access_error("douyin", navigation_status, page.url, body)
        if access_error is not None:
            raise access_error
        if (urlsplit(page.url).hostname or "").casefold() != "www.douyin.com":
            try:
                response = await page.goto(
                    f"{DOUYIN_API_ORIGIN}/video/{video_id}",
                    wait_until="domcontentloaded",
                    timeout=SEARCH_TIMEOUT_MS,
                )
                navigation_status = response.status if response else navigation_status
                body = await _page_body(page)
            except PlaywrightTimeoutError as exc:
                raise VideoCommentCollectionError(
                    "failed", "抖音视频页面加载超时。", error_code="PAGE_NAVIGATION_TIMEOUT", diagnostics=diagnostics()
                ) from exc
            except Exception as exc:
                raise VideoCommentCollectionError(
                    "failed", "无法连接抖音视频页面。", error_code="PAGE_NAVIGATION_FAILED", diagnostics=diagnostics()
                ) from exc
            access_error = _access_error("douyin", navigation_status, page.url, body)
            if access_error is not None:
                raise access_error

        try:
            browser_state = await page.evaluate(
                """() => ({ userAgent: navigator.userAgent, msToken: localStorage.getItem('xmst') || '' })"""
            )
            user_agent = str(browser_state.get("userAgent") or "") if isinstance(browser_state, dict) else ""
            ms_token = str(browser_state.get("msToken") or "") if isinstance(browser_state, dict) else ""
            if not user_agent:
                raise RuntimeError("browser user agent unavailable")
            await page.add_script_tag(path=str(DOUYIN_SIGNER_PATH))
        except Exception as exc:
            raise VideoCommentCollectionError(
                "failed",
                "抖音评论请求签名未能生成。",
                error_code="DOUYIN_SIGNER_FAILED",
                diagnostics=diagnostics(),
            ) from exc

        request_headers = {"Accept": "application/json, text/plain, */*", "x-tt-argus": DOUYIN_ARGUS_HEADER_VALUE}
        uifid = await _douyin_uifid(context)
        if uifid:
            request_headers["uifid"] = uifid

        cursor = 0
        seen_cursors = {cursor}
        for page_index in range(COMMENT_MAX_PAGES):
            try:
                query_string = urlencode(_douyin_comment_params(video_id, ms_token, cursor))
                signature = await page.evaluate(
                    "([params, userAgent]) => window.sign_datail(params, userAgent)",
                    [query_string, user_agent],
                )
                if not isinstance(signature, str) or not signature:
                    raise RuntimeError("signature unavailable")
            except Exception as exc:
                error = VideoCommentCollectionError(
                    "failed",
                    "抖音评论请求签名未能生成。",
                    error_code="DOUYIN_SIGNER_FAILED",
                    diagnostics=diagnostics(),
                )
                raise _with_partial_liked_comments(error, comments) from exc

            api_url = (
                f"{DOUYIN_API_ORIGIN}{DOUYIN_COMMENT_API_PATH}?{query_string}"
                f"&a_bogus={quote(signature, safe='')}"
            )
            api_requested += 1
            try:
                api_response = await asyncio.wait_for(
                    page.evaluate(
                        """async ({ url, headers }) => {
                          const response = await fetch(url, {
                            method: 'GET',
                            credentials: 'include',
                            cache: 'no-store',
                            headers
                          });
                          let payload = null;
                          try { payload = await response.json(); } catch (_) {}
                          return { status: response.status, payload };
                        }""",
                        {"url": api_url, "headers": request_headers},
                    ),
                    timeout=SEARCH_TIMEOUT_MS / 1000,
                )
            except asyncio.TimeoutError as exc:
                error = VideoCommentCollectionError(
                    "failed", "抖音评论接口请求超时。", error_code="COMMENT_API_TIMEOUT", diagnostics=diagnostics()
                )
                raise _with_partial_liked_comments(error, comments) from exc
            except Exception as exc:
                error = VideoCommentCollectionError(
                    "failed", "抖音评论接口请求未完成。", error_code="COMMENT_API_REQUEST_FAILED", diagnostics=diagnostics()
                )
                raise _with_partial_liked_comments(error, comments) from exc
            if not isinstance(api_response, dict):
                error = VideoCommentCollectionError(
                    "failed", "抖音评论接口响应格式无法识别。", error_code="API_SCHEMA_ERROR", diagnostics=diagnostics()
                )
                raise _with_partial_liked_comments(error, comments)

            response_received += 1
            status = api_response.get("status")
            api_status = status if isinstance(status, int) else None
            http_error = _api_http_error(api_status, "抖音")
            if http_error is not None:
                converted = _comment_api_error("douyin", http_error, body_chars=len(body))
                converted.diagnostics.update(diagnostics())
                raise _with_partial_liked_comments(converted, comments)
            try:
                page_comments = _extract_douyin_api_comments(api_response.get("payload"))
            except VideoTopicSearchError as exc:
                if exc.http_status is None:
                    exc.http_status = api_status
                converted = _comment_api_error("douyin", exc, body_chars=len(body))
                converted.diagnostics.update(diagnostics())
                raise _with_partial_liked_comments(converted, comments) from exc

            for comment in page_comments:
                comment_key = str(comment.get("key") or "")
                content = str(comment.get("content") or "")
                if not content or comment_key in seen_comment_keys or content in seen_content:
                    continue
                seen_comment_keys.add(comment_key)
                seen_content.add(content)
                comments.append(comment)
                if len(comments) >= COMMENT_SCAN_LIMIT:
                    break

            payload = api_response.get("payload")
            if not isinstance(payload, dict) or len(comments) >= COMMENT_SCAN_LIMIT or not _api_has_more(payload.get("has_more")):
                break
            next_cursor = _api_like_count(payload.get("cursor"))
            if next_cursor is None or next_cursor == cursor or next_cursor in seen_cursors or not page_comments:
                break
            cursor = next_cursor
            seen_cursors.add(cursor)
            if page_index + 1 < COMMENT_MAX_PAGES:
                await asyncio.sleep(COMMENT_PAGE_INTERVAL_SECONDS)

        ranked_comments = _top_liked_comments(comments)
        _log_video_api(
            "douyin",
            "comment_response",
            "completed" if ranked_comments else "empty",
            video_id=video_id,
            http_status=api_status,
            comment_count=len(ranked_comments),
            scanned_comment_count=len(comments),
            request_count=api_requested,
            target_request_count=api_requested,
            matched_response_count=response_received,
            request_host_class="platform",
            duration_ms=round((time.perf_counter() - started) * 1000),
        )
        return ranked_comments
    except VideoCommentCollectionError as exc:
        _log_video_api(
            "douyin",
            "comment_response",
            exc.state,
            video_id=video_id,
            http_status=exc.diagnostics.get("http_status") if isinstance(exc.diagnostics.get("http_status"), int) else None,
            error_code=exc.error_code,
            duration_ms=round((time.perf_counter() - started) * 1000),
            request_count=exc.diagnostics.get("request_count") if isinstance(exc.diagnostics.get("request_count"), int) else None,
            target_request_count=exc.diagnostics.get("target_request_count") if isinstance(exc.diagnostics.get("target_request_count"), int) else None,
            matched_response_count=exc.diagnostics.get("matched_response_count") if isinstance(exc.diagnostics.get("matched_response_count"), int) else None,
            request_host_class=exc.diagnostics.get("request_host_class") if isinstance(exc.diagnostics.get("request_host_class"), str) else None,
        )
        raise
    finally:
        try:
            await page.close()
        except Exception:
            pass


async def _collect_bilibili_api_comments(
    video_id: str,
    target_url: str,
    context: BrowserContext,
    api_video_id: str | None,
) -> list[dict[str, Any]]:
    started = time.perf_counter()
    comments: list[dict[str, Any]] = []
    seen_comment_keys: set[str] = set()
    seen_content: set[str] = set()
    request_count = 0
    response_count = 0
    comment_status: int | None = None
    try:
        page = await context.new_page()
    except Exception as exc:
        raise VideoCommentCollectionError("failed", "无法打开 B 站视频页面。", error_code="PAGE_CREATE_FAILED") from exc
    try:
        await _install_platform_navigation_guard(page, "bilibili")
        try:
            response = await page.goto(target_url, wait_until="domcontentloaded", timeout=SEARCH_TIMEOUT_MS)
        except PlaywrightTimeoutError as exc:
            raise VideoCommentCollectionError("failed", "B 站视频页面加载超时。", error_code="PAGE_NAVIGATION_TIMEOUT") from exc
        except Exception as exc:
            raise VideoCommentCollectionError("failed", "无法连接 B 站视频页面。", error_code="PAGE_NAVIGATION_FAILED") from exc
        status = response.status if response else None
        body = await _page_body(page)
        access_error = _access_error("bilibili", status, page.url, body)
        if access_error is not None:
            raise access_error
        user_agent = str(await page.evaluate("() => navigator.userAgent"))
        headers = {
            "Accept": "application/json, text/plain, */*",
            "Referer": target_url,
            "User-Agent": user_agent,
        }
        try:
            _nav_status, img_key, sub_key = await _bilibili_wbi_keys(context, headers)
            if api_video_id is not None and api_video_id.isdigit():
                aid = int(api_video_id)
            elif video_id.casefold().startswith("av") and video_id[2:].isdigit():
                aid = int(video_id[2:])
            elif video_id.isdigit():
                aid = int(video_id)
            else:
                _view_status, view_payload = await _bilibili_api_json(
                    context,
                    "/x/web-interface/view",
                    {"bvid": video_id},
                    headers,
                )
                view_data = view_payload.get("data")
                aid = int(view_data.get("aid")) if isinstance(view_data, dict) and str(view_data.get("aid", "")).isdigit() else 0
                if not aid:
                    raise VideoTopicSearchError("B 站没有返回视频编号。", "API_VIDEO_ID_MISSING")
            cursor = 0
            seen_cursors = {cursor}
            for page_index in range(COMMENT_MAX_PAGES):
                request_count += 1
                comment_status, comment_payload = await _bilibili_api_json(
                    context,
                    "/x/v2/reply/wbi/main",
                    {"oid": aid, "mode": 3, "type": 1, "ps": COMMENT_PAGE_SIZE, "next": cursor},
                    headers,
                    wbi_keys=(img_key, sub_key),
                )
                response_count += 1
                comment_data = comment_payload.get("data")
                try:
                    page_comments = _extract_bilibili_api_comments(comment_data)
                except VideoTopicSearchError as exc:
                    if exc.http_status is None:
                        exc.http_status = comment_status
                    raise
                for comment in page_comments:
                    comment_key = str(comment.get("key") or "")
                    content = str(comment.get("content") or "")
                    if not content or comment_key in seen_comment_keys or content in seen_content:
                        continue
                    seen_comment_keys.add(comment_key)
                    seen_content.add(content)
                    comments.append(comment)
                    if len(comments) >= COMMENT_SCAN_LIMIT:
                        break

                cursor_info = comment_data.get("cursor") if isinstance(comment_data, dict) else None
                if (
                    len(comments) >= COMMENT_SCAN_LIMIT
                    or not page_comments
                    or not isinstance(cursor_info, dict)
                    or _api_has_more(cursor_info.get("is_end"))
                ):
                    break
                next_cursor = _api_like_count(cursor_info.get("next"))
                if next_cursor is None or next_cursor == cursor or next_cursor in seen_cursors:
                    break
                cursor = next_cursor
                seen_cursors.add(cursor)
                if page_index + 1 < COMMENT_MAX_PAGES:
                    await asyncio.sleep(COMMENT_PAGE_INTERVAL_SECONDS)
        except VideoTopicSearchError as exc:
            converted = _comment_api_error("bilibili", exc, body_chars=len(body))
            converted.diagnostics.update({
                "request_count": request_count,
                "target_request_count": request_count,
                "matched_response_count": response_count,
                "request_host_class": "platform" if request_count else "unknown",
            })
            raise _with_partial_liked_comments(converted, comments) from exc
        ranked_comments = _top_liked_comments(comments)
        _log_video_api(
            "bilibili",
            "comment_response",
            "completed" if ranked_comments else "empty",
            video_id=video_id,
            http_status=comment_status,
            comment_count=len(ranked_comments),
            scanned_comment_count=len(comments),
            request_count=request_count,
            target_request_count=request_count,
            matched_response_count=response_count,
            request_host_class="platform" if request_count else "unknown",
            duration_ms=round((time.perf_counter() - started) * 1000),
        )
        return ranked_comments
    except VideoCommentCollectionError as exc:
        _log_video_api(
            "bilibili",
            "comment_response",
            exc.state,
            video_id=video_id,
            http_status=exc.diagnostics.get("http_status") if isinstance(exc.diagnostics.get("http_status"), int) else None,
            error_code=exc.error_code,
            duration_ms=round((time.perf_counter() - started) * 1000),
            request_count=exc.diagnostics.get("request_count") if isinstance(exc.diagnostics.get("request_count"), int) else None,
            target_request_count=exc.diagnostics.get("target_request_count") if isinstance(exc.diagnostics.get("target_request_count"), int) else None,
            matched_response_count=exc.diagnostics.get("matched_response_count") if isinstance(exc.diagnostics.get("matched_response_count"), int) else None,
            request_host_class=exc.diagnostics.get("request_host_class") if isinstance(exc.diagnostics.get("request_host_class"), str) else None,
        )
        raise
    finally:
        try:
            await page.close()
        except Exception:
            pass


async def collect_video_comments(
    provider: str,
    video_item: dict[str, Any],
    context: BrowserContext,
) -> list[dict[str, Any]]:
    """在平台页面会话中通过 JSON API 或页面已加载内容读取一级评论。"""
    if provider not in PROVIDER_TITLES:
        raise VideoCommentCollectionError("failed", "不支持的视频平台。")
    target_url = _safe_platform_url(provider, video_item.get("url"))
    if target_url is None or _safe_search_url(provider, target_url) is None:
        raise VideoCommentCollectionError("failed", "视频链接不属于受支持的平台页面。")
    video_id_match = PROVIDER_VIDEO_ID_PATTERNS[provider].search(urlsplit(target_url).path)
    if video_id_match is None:
        raise VideoCommentCollectionError("failed", "视频链接格式无法识别。")
    if provider == "douyin":
        return await _collect_douyin_api_comments(video_id_match.group(1), target_url, context)
    if provider == "bilibili":
        api_video_id = str(video_item.get("apiVideoId") or "").strip() or None
        return await _collect_bilibili_api_comments(video_id_match.group(1), target_url, context, api_video_id)

    try:
        page = await context.new_page()
    except Exception as exc:
        raise VideoCommentCollectionError(
            "failed", "无法打开视频页面。", error_code="PAGE_CREATE_FAILED"
        ) from exc
    diagnostics: dict[str, str | int | bool | None] = {"host_class": "unknown"}
    try:
        await _install_platform_navigation_guard(page, provider)
        try:
            response = await page.goto(target_url, wait_until="domcontentloaded", timeout=SEARCH_TIMEOUT_MS)
        except PlaywrightTimeoutError as exc:
            raise VideoCommentCollectionError(
                "failed", "视频页面加载超时。", error_code="PAGE_NAVIGATION_TIMEOUT", diagnostics=diagnostics
            ) from exc
        except Exception as exc:
            raise VideoCommentCollectionError(
                "failed", "无法连接视频页面。", error_code="PAGE_NAVIGATION_FAILED", diagnostics=diagnostics
            ) from exc
        status = response.status if response else None
        body = await _page_body(page)
        diagnostics.update({
            "http_status": status,
            "body_chars": len(body),
            "host_class": "platform" if _safe_platform_url(provider, page.url) else "unexpected",
        })
        access_error = _access_error(provider, status, page.url, body)
        if access_error is not None:
            raise access_error
        if status is not None and status >= 500:
            raise VideoCommentCollectionError(
                "failed", "平台视频页面暂时不可用。", error_code=f"HTTP_{status}", diagnostics=diagnostics
            )

        comment_section = {
            "douyin": '[data-e2e="comment-list"], [class*=comment-list], [class*=CommentList]',
            "bilibili": "#comment, .reply-list",
            "kuaishou": '[class*=comment-list], [class*=CommentList], [data-testid*=comment]',
        }[provider]
        try:
            diagnostics["comment_section_count"] = await page.locator(comment_section).count()
        except Exception:
            diagnostics["comment_section_count"] = 0
        try:
            await page.locator(comment_section).first.scroll_into_view_if_needed(timeout=2500)
        except Exception:
            await page.evaluate("window.scrollTo(0, Math.floor(document.body.scrollHeight * 0.65))")
        await page.wait_for_timeout(PAGE_SETTLE_MS)
        comments, comment_node_count = await _extract_first_level_comments(page, provider)
        diagnostics["comment_node_count"] = comment_node_count
        if not comments or not comment_node_count:
            body = await _page_body(page)
            diagnostics["body_chars"] = len(body)
            access_error = _access_error(provider, None, page.url, body)
            if access_error is not None:
                raise access_error
            if any(message.casefold() in body.casefold() for message in NO_COMMENTS_TEXT):
                return []
            error_code = "COMMENT_NODES_NO_CONTENT" if comment_node_count else "COMMENT_SELECTOR_NO_NODES"
            raise VideoCommentCollectionError(
                "failed",
                "平台评论区未能加载，请稍后重试。",
                error_code=error_code,
                diagnostics=diagnostics,
            )
        return comments[:COMMENT_LIMIT]
    except VideoCommentCollectionError:
        raise
    except PlaywrightTimeoutError as exc:
        raise VideoCommentCollectionError(
            "failed", "读取平台评论超时。", error_code="COMMENT_READ_TIMEOUT", diagnostics=diagnostics
        ) from exc
    except Exception as exc:
        raise VideoCommentCollectionError(
            "failed", "读取平台评论失败。", error_code="COMMENT_READ_FAILED", diagnostics=diagnostics
        ) from exc
    finally:
        try:
            await page.close()
        except Exception:
            pass
