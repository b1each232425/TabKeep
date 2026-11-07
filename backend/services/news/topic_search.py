"""本机话题搜索编排、公开页面适配器与可选浏览器会话。"""

import asyncio
import base64
import binascii
import hashlib
import json
import os
import re
import secrets
import shutil
import time
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urljoin, urlsplit

from playwright.async_api import Browser, BrowserContext, Page, Playwright, TimeoutError as PlaywrightTimeoutError
from playwright.async_api import async_playwright

from logger import logger
from services import storage
from services.news import db
from services.news.topic_search_auth import QR_TTL_SECONDS, qr_auth
from services.news.url_utils import canonicalize_url
from services.news import video_topic_search
from services.news.video_comment_jobs import VideoCommentCollectionError, video_comment_jobs

VIDEO_PROVIDERS = {"douyin", "bilibili", "kuaishou"}
CURRENT_BROWSER_PROVIDERS = {"zhihu", *VIDEO_PROVIDERS}
AUTH_PROVIDERS = {"tieba", "zhihu", "weibo", *VIDEO_PROVIDERS}
PROVIDER_TITLES = {
    "local": "本地资讯",
    "tieba": "百度贴吧",
    "xiaoheihe": "小黑盒",
    "zhihu": "知乎",
    "weibo": "微博",
    "douyin": "抖音",
    "bilibili": "哔哩哔哩",
    "kuaishou": "快手",
}
SEARCH_LIMIT = 20
SEARCH_TIMEOUT_SECONDS = 18
ZHIHU_CDP_DEFAULT_ENDPOINT = "http://127.0.0.1:9222"
ZHIHU_CDP_CONNECT_TIMEOUT_MS = 20_000
AUTHENTICATED_BODY_READ_TIMEOUT_MS = 20_000
AUTHENTICATED_JSON_FETCH_TIMEOUT_MS = 20_000
PROVIDER_SEARCH_TIMEOUT_SECONDS = 70
MAX_CURSOR_PAGE = 1000
TOPIC_SEARCH_LOG_MAX_BYTES = 1_000_000
_topic_search_log_lock = threading.Lock()

_SEARCH_URLS = {
    "tieba": lambda query, page: "https://tieba.baidu.com/f/search/res?" + urlencode(
        {"ie": "utf-8", "kw": "", "qw": query, "rn": SEARCH_LIMIT, "pn": page}
    ),
    "zhihu": lambda query, page: "https://www.zhihu.com/search?" + urlencode(
        {"type": "content", "q": query, "page": page}
    ),
    "weibo": lambda query, page: "https://s.weibo.com/weibo?" + urlencode(
        {"q": query, "page": page}
    ),
}
_RESULT_PATTERNS = {
    "tieba": re.compile(r"/p/(\d+)(?:[/?#]|$)"),
    "zhihu": re.compile(r"/(?:question/\d+(?:/answer/\d+)?|p/\d+)(?:[/?#]|$)"),
    "weibo": re.compile(r"/(?:\d+/[A-Za-z0-9]+|\w+/status/\d+)(?:[/?#]|$)"),
}
_LOGIN_COOKIE_NAMES = {
    # Presence-only checks: cookie values remain inside the dedicated Edge profile.
    "tieba": {"BDUSS"},
    "zhihu": {"z_c0"},
    "weibo": {"SUB", "SSOLoginState"},
    "douyin": {"sessionid", "sessionid_ss"},
    "bilibili": {"SESSDATA", "DedeUserID"},
    "kuaishou": {"kuaishou.server.web_st", "userId"},
}
_LOGIN_COOKIE_DOMAINS = {
    "tieba": ("baidu.com",),
    "zhihu": ("zhihu.com",),
    "weibo": ("weibo.com",),
    "douyin": ("douyin.com",),
    "bilibili": ("bilibili.com",),
    "kuaishou": ("kuaishou.com",),
}
_MANUAL_LOGIN_URLS = {
    "douyin": "https://www.douyin.com/",
    "bilibili": "https://passport.bilibili.com/login",
    "kuaishou": "https://www.kuaishou.com/",
}
_LOGIN_WALL_TEXT = (
    "登录后继续",
    "登录后查看",
    "登录查看更多",
    "请先登录",
    "请登录后",
    "登录后可查看",
    "登录知乎",
    "登录微博",
    "扫码登录",
    "验证后继续",
)
_CHALLENGE_TEXT = ("安全验证", "访问过于频繁", "操作频繁", "验证码")
_TIEBA_ORIGIN = "https://tieba.baidu.com"
_TIEBA_PC_SIGN_SECRET = "36770b1f34c9bbf2e7d1a99d2b82fa9e"


@dataclass
class ProviderResult:
    """单个平台的搜索结果与可恢复状态。"""

    items: list[dict[str, Any]]
    state: str
    message: str = ""
    has_more: bool = False
    connected: bool = False
    use_authenticated: bool = False
    diagnostic_stage: str = "search"
    http_status: int | None = None
    error_type: str | None = None
    error_code: str | None = None
    request_mode: str = "anonymous"
    authenticated_http_status: int | None = None


@dataclass
class _SearchCursor:
    query_hash: str
    pages: dict[str, int]
    local_offset: int
    seen_keys: list[str]


class _ProviderRequestFailure(Exception):
    def __init__(self, stage: str, error: Exception) -> None:
        super().__init__(stage)
        self.stage = stage
        self.error_type = type(error).__name__
        self.error_code = str(getattr(error, "error_code", "") or _safe_error_code(error))[:80]
        self.state = str(getattr(error, "state", "error"))
        self.message = str(getattr(error, "message", "") or "")[:240]
        self.http_status = getattr(error, "http_status", None)


class _TiebaApiResponseError(Exception):
    def __init__(self, stage: str, error_code: str) -> None:
        super().__init__(stage)
        self.stage = stage
        self.error_code = error_code


class TopicSearchBrowser:
    """管理匿名搜索会话和供资讯弹窗显示的站点登录页。"""

    def __init__(self) -> None:
        self._playwright: Playwright | None = None
        self._browser: Browser | None = None
        self._authenticated_contexts: dict[str, BrowserContext] = {}
        self._authenticated_pages: dict[str, Page] = {}
        self._login_pages: dict[str, Page] = {}
        self._cdp_browsers: dict[str, Browser] = {}
        self._login_images: dict[str, str] = {}
        self._login_started_at: dict[str, float] = {}
        self._login_messages: dict[str, str] = {}
        self._lock = asyncio.Lock()

    async def _ensure_browser(self) -> Browser:
        async with self._lock:
            if self._browser is not None and self._browser.is_connected():
                return self._browser
            if self._playwright is None:
                self._playwright = await async_playwright().start()
            self._browser = await self._playwright.chromium.launch(channel="msedge", headless=True)
            return self._browser

    def _profile_dir(self, provider: str) -> Path:
        if provider not in AUTH_PROVIDERS:
            raise ValueError("该平台不支持独立登录配置")
        root = (storage.DATA_DIR / "topic-search-profiles").resolve()
        profile = (root / provider).resolve()
        if profile.parent != root:
            raise ValueError("登录配置目录无效")
        return profile

    def _zhihu_cdp_endpoints(self) -> list[str]:
        endpoints: list[str] = []
        active_ws_endpoints: list[str] = []
        active_http_endpoints: list[str] = []
        configured_endpoint = os.environ.get("TABKEEP_ZHIHU_CDP_ENDPOINT", "").strip()
        if configured_endpoint:
            endpoint_parts = urlsplit(configured_endpoint)
            if endpoint_parts.scheme not in {"http", "https", "ws", "wss"} or endpoint_parts.hostname not in {
                "127.0.0.1", "localhost", "::1",
            }:
                raise RuntimeError("平台授权只允许连接本机浏览器的 CDP 地址。")
            endpoints.append(configured_endpoint)

        local_app_data = os.environ.get("LOCALAPPDATA")
        if local_app_data:
            user_data_dirs = (
                Path(local_app_data) / "Microsoft" / "Edge" / "User Data",
                Path(local_app_data) / "Google" / "Chrome" / "User Data",
            )
            for user_data_dir in user_data_dirs:
                active_port_file = user_data_dir / "DevToolsActivePort"
                try:
                    active_port_lines = active_port_file.read_text(encoding="utf-8").splitlines()
                    port = int(active_port_lines[0].strip())
                    if 1 <= port <= 65_535:
                        ws_path = active_port_lines[1].strip() if len(active_port_lines) > 1 else ""
                        if ws_path.startswith("/devtools/browser/"):
                            # Chrome/Edge's edge://inspect toggle exposes WebSocket CDP only;
                            # its HTTP /json/version discovery endpoint returns 404.
                            active_ws_endpoints.append(f"ws://127.0.0.1:{port}{ws_path}")
                        else:
                            active_http_endpoints.append(f"http://127.0.0.1:{port}")
                except (OSError, ValueError, IndexError):
                    pass

        if active_ws_endpoints:
            # Prefer the exact endpoint published by the active browser. Re-trying the
            # same port through HTTP or a second WebSocket path can waste another timeout.
            endpoints.extend(active_ws_endpoints)
        else:
            endpoints.extend(active_http_endpoints)
            # Fallback for browser-instance debugging when DevToolsActivePort is unavailable.
            endpoints.append("ws://127.0.0.1:9222/devtools/browser")
            endpoints.append(ZHIHU_CDP_DEFAULT_ENDPOINT)
        return list(dict.fromkeys(endpoints))

    async def _ensure_zhihu_context(self) -> BrowserContext:
        async with self._lock:
            browser = self._cdp_browsers.get("zhihu")
            context = self._authenticated_contexts.get("zhihu")
            if browser is not None and browser.is_connected() and context is not None:
                return context

            self._cdp_browsers.pop("zhihu", None)
            self._authenticated_contexts.pop("zhihu", None)
            self._authenticated_pages.pop("zhihu", None)
            self._login_pages.pop("zhihu", None)
            if self._playwright is None:
                self._playwright = await async_playwright().start()

            last_connect_error = "未收到浏览器连接响应"
            for endpoint in self._zhihu_cdp_endpoints():
                try:
                    browser = await self._playwright.chromium.connect_over_cdp(
                        endpoint,
                        timeout=ZHIHU_CDP_CONNECT_TIMEOUT_MS,
                    )
                except Exception as exc:
                    last_connect_error = type(exc).__name__
                    continue
                if not browser.contexts:
                    await browser.close()
                    last_connect_error = "浏览器未提供可用上下文"
                    continue
                context = browser.contexts[0]
                self._cdp_browsers["zhihu"] = browser
                self._authenticated_contexts["zhihu"] = context
                return context

        raise RuntimeError(
            f"已检测到本机浏览器调试端口，但 CDP 连接失败（{last_connect_error}）。"
            "请留意 Edge 是否弹出远程调试授权提示并允许；如果连接超时，先唤醒休眠标签页后重试。"
        )

    async def _ensure_video_cdp_context(self, provider: str) -> BrowserContext:
        """连接用户当前本机浏览器；不启动持久化的自动化账号配置。"""
        if provider not in VIDEO_PROVIDERS:
            raise ValueError("该平台不支持当前浏览器登录")
        async with self._lock:
            browser = self._cdp_browsers.get(provider)
            context = self._authenticated_contexts.get(provider)
            if browser is not None and browser.is_connected() and context is not None:
                return context

            self._cdp_browsers.pop(provider, None)
            self._authenticated_contexts.pop(provider, None)
            self._authenticated_pages.pop(provider, None)
            self._login_pages.pop(provider, None)
            if self._playwright is None:
                self._playwright = await async_playwright().start()

            last_connect_error = "未收到浏览器连接响应"
            for endpoint in self._zhihu_cdp_endpoints():
                try:
                    browser = await self._playwright.chromium.connect_over_cdp(
                        endpoint,
                        timeout=ZHIHU_CDP_CONNECT_TIMEOUT_MS,
                    )
                except Exception as exc:
                    last_connect_error = type(exc).__name__
                    continue
                if not browser.contexts:
                    await browser.close()
                    last_connect_error = "浏览器未提供可用上下文"
                    continue
                context = browser.contexts[0]
                self._cdp_browsers[provider] = browser
                self._authenticated_contexts[provider] = context
                return context

        raise RuntimeError(
            f"无法连接本机 Edge/Chrome 的远程调试会话（{last_connect_error}）。"
            "请在 edge://inspect 或 chrome://inspect 允许当前浏览器实例的远程调试，然后重试。"
        )

    async def _manual_login_page(self, provider: str) -> tuple[BrowserContext, Page]:
        context = await self._ensure_video_cdp_context(provider)
        async with self._lock:
            page = self._login_pages.get(provider)
            if page is None or page.is_closed():
                page = await context.new_page()
                self._login_pages[provider] = page
            return context, page

    async def _start_manual_browser_login(self, provider: str) -> dict[str, Any]:
        """在用户现有浏览器的新标签打开登录页，由用户自行完成登录或验证。"""
        _context, page = await self._manual_login_page(provider)
        try:
            await page.goto(
                _MANUAL_LOGIN_URLS[provider],
                wait_until="domcontentloaded",
                timeout=SEARCH_TIMEOUT_SECONDS * 1000,
            )
        except PlaywrightTimeoutError:
            # 登录页可能继续加载；用户仍可在新标签中手动完成后续操作。
            pass
        except Exception as exc:
            raise RuntimeError(f"无法打开{PROVIDER_TITLES[provider]}登录页，请在当前浏览器检查网络后重试。") from exc
        self._login_started_at[provider] = time.monotonic()
        self._login_images.pop(provider, None)
        self._login_messages[provider] = f"已在当前浏览器新标签打开{PROVIDER_TITLES[provider]}。请手动登录或完成平台验证，完成后返回此处。"
        return {
            "provider": provider,
            "connected": False,
            "state": "connecting",
            "loginImage": None,
            "message": self._login_messages[provider],
        }

    async def _zhihu_login_page(self) -> tuple[BrowserContext, Page]:
        context = await self._ensure_zhihu_context()
        async with self._lock:
            page = self._login_pages.get("zhihu")
            if page is None or page.is_closed():
                page = await context.new_page()
                self._login_pages["zhihu"] = page
            return context, page

    def _marker_path(self, provider: str) -> Path:
        return self._profile_dir(provider) / "tabkeep-session.json"

    def _is_connected(self, provider: str) -> bool:
        marker = self._marker_path(provider)
        if not marker.is_file():
            return False
        try:
            data = json.loads(marker.read_text(encoding="utf-8"))
            return data.get("provider") == provider and bool(data.get("connectedAt"))
        except (OSError, json.JSONDecodeError):
            return False

    def status(self, provider: str) -> dict[str, Any]:
        connected = self._is_connected(provider)
        preferences = storage.get_news_search_preferences()
        return {
            "provider": provider,
            "connected": connected,
            "state": "connected" if connected else "disconnected",
            "useAuthenticated": bool(preferences.get(provider, False)),
            "message": "账号已连接；搜索是否使用账号由下方偏好单独控制。" if connected else "未连接账号，匿名搜索照常可用。",
        }

    async def start_login(self, provider: str) -> dict[str, Any]:
        if provider not in AUTH_PROVIDERS:
            raise ValueError("该平台不支持独立登录配置")
        try:
            if provider in VIDEO_PROVIDERS:
                result = await self._start_manual_browser_login(provider)
            elif provider == "zhihu":
                result = await self._start_zhihu_browser_login()
            else:
                result = await qr_auth.start(provider)
        except RuntimeError:
            raise
        except Exception as exc:
            raise RuntimeError(f"无法获取{PROVIDER_TITLES[provider]}登录二维码，请稍后重试。") from exc
        self._login_images[provider] = str(result.get("loginImage") or "")
        return {**result, "useAuthenticated": storage.get_news_search_preferences().get(provider, False)}

    async def _start_zhihu_browser_login(self) -> dict[str, Any]:
        """在知乎网页会话中读取二维码，扫码状态由该浏览器上下文的 Cookie 确认。"""
        await qr_auth.cancel("zhihu")
        self._login_images.pop("zhihu", None)
        self._login_started_at.pop("zhihu", None)
        self._login_messages.pop("zhihu", None)
        _context, page = await self._zhihu_login_page()

        qr_canvas = page.locator("canvas.Qrcode-qrcode")
        page_urls = (
            "https://www.zhihu.com/",
            "https://www.zhihu.com/signin?next=%2F",
        )
        last_http_status: int | None = None
        last_navigation_error: str | None = None
        qr_found = False
        for page_url in page_urls:
            try:
                response = await page.goto(
                    page_url,
                    wait_until="domcontentloaded",
                    timeout=SEARCH_TIMEOUT_SECONDS * 1000,
                )
            except Exception as exc:
                last_navigation_error = type(exc).__name__
                continue
            last_navigation_error = None
            if response:
                last_http_status = response.status
            try:
                await qr_canvas.wait_for(state="visible", timeout=12_000)
                qr_found = True
                break
            except PlaywrightTimeoutError:
                if await self._zhihu_page_requires_verification(page):
                    last_navigation_error = "verification_required"

        self._login_started_at["zhihu"] = time.monotonic()
        if qr_found:
            screenshot = await qr_canvas.screenshot(timeout=5_000)
            self._login_images["zhihu"] = f"data:image/png;base64,{base64.b64encode(screenshot).decode('ascii')}"
            self._login_messages["zhihu"] = "请使用知乎 App 扫码，并在手机上确认登录。"
        else:
            self._login_messages["zhihu"] = self._zhihu_login_wait_message(
                last_http_status,
                last_navigation_error,
            )
            self._login_images.pop("zhihu", None)
            page_path = urlsplit(str(page.url)).path or "/"
            logger.warning(
                "topic_search_zhihu_login event=qr_not_visible "
                f"http_status={last_http_status or '-'} page_path={page_path} "
                f"navigation_error={last_navigation_error or '-'}"
            )
        return {
            "provider": "zhihu",
            "connected": False,
            "state": "connecting",
            "loginImage": self._login_images.get("zhihu"),
            "message": self._login_messages["zhihu"],
        }

    def _zhihu_login_wait_message(self, http_status: int | None, navigation_error: str | None) -> str:
        if navigation_error == "verification_required":
            return "知乎要求安全验证，请在已连接浏览器的知乎标签页按页面提示操作；TabKeep 不会自动绕过验证。"
        if http_status in {403, 429}:
            return f"知乎页面返回 HTTP {http_status}，请在已连接浏览器的知乎标签页按页面提示操作。"
        if navigation_error:
            return "知乎登录页暂未加载完成，请在已连接浏览器的知乎标签页检查页面；二维码出现后会自动显示在这里。"
        return "知乎页面暂未显示二维码。请在已连接浏览器的知乎标签页切换到扫码登录或完成页面提示；二维码出现后会自动显示在这里。"

    async def _zhihu_page_requires_verification(self, page: Any) -> bool:
        page_url = str(page.url).casefold()
        if "/account/risk_control" in page_url or "/account/unhuman" in page_url:
            return True
        try:
            body = await page.locator("body").inner_text(timeout=1_000)
        except Exception:
            return False
        return any(
            text in body
            for text in ("安全验证", "访问异常", "网络环境存在异常", "访问频繁", "异常请求", "开始验证")
        )

    async def _complete_zhihu_browser_login(self) -> dict[str, Any]:
        provider = "zhihu"
        preferences = storage.get_news_search_preferences()
        login_image = self._login_images.get(provider)
        started_at = self._login_started_at.get(provider)
        context = self._authenticated_contexts.get(provider)
        if started_at is None or context is None:
            return {
                "provider": provider,
                "connected": self._is_connected(provider),
                "state": "login_required",
                "useAuthenticated": bool(preferences.get(provider, False)),
                "loginImage": None,
                "message": "没有待确认的知乎二维码，请重新生成。",
            }

        try:
            cookies = await context.cookies(["https://www.zhihu.com"])
        except Exception:
            return {
                "provider": provider,
                "connected": False,
                "state": "login_required",
                "useAuthenticated": bool(preferences.get(provider, False)),
                "loginImage": None,
                "message": "知乎登录页已关闭，请重新生成二维码。",
            }

        cookie_names = {
            str(cookie.get("name", ""))
            for cookie in cookies
            if str(cookie.get("domain", "")).lstrip(".").casefold().endswith("zhihu.com")
        }
        if "z_c0" in cookie_names:
            marker = self._marker_path(provider)
            marker.parent.mkdir(parents=True, exist_ok=True)
            marker.write_text(
                json.dumps({"provider": provider, "connectedAt": _now_iso()}, ensure_ascii=False),
                encoding="utf-8",
            )
            self._login_images.pop(provider, None)
            self._login_started_at.pop(provider, None)
            self._login_messages.pop(provider, None)
            return {
                "provider": provider,
                "connected": True,
                "state": "connected",
                "useAuthenticated": bool(preferences.get(provider, False)),
                "loginImage": None,
                "message": "知乎账号已通过浏览器会话确认并保存在本机。授权搜索仍默认关闭。",
            }

        if time.monotonic() - started_at >= QR_TTL_SECONDS:
            self._login_images.pop(provider, None)
            self._login_started_at.pop(provider, None)
            self._login_messages.pop(provider, None)
            return {
                "provider": provider,
                "connected": False,
                "state": "login_required",
                "useAuthenticated": bool(preferences.get(provider, False)),
                "loginImage": None,
                "message": "知乎二维码已过期，请重新生成。",
            }

        page = self._login_pages.get(provider)
        if page is None or page.is_closed():
            return {
                "provider": provider,
                "connected": False,
                "state": "login_required",
                "useAuthenticated": bool(preferences.get(provider, False)),
                "loginImage": None,
                "message": "知乎登录浏览器页面已关闭，请重新生成二维码。",
            }

        qr_canvas = page.locator("canvas.Qrcode-qrcode")
        qr_visible = False
        if login_image:
            try:
                qr_visible = await qr_canvas.is_visible()
            except Exception:
                qr_visible = False
        else:
            try:
                await qr_canvas.wait_for(state="visible", timeout=100)
                qr_visible = True
                screenshot = await qr_canvas.screenshot(timeout=2_000)
                login_image = f"data:image/png;base64,{base64.b64encode(screenshot).decode('ascii')}"
                self._login_images[provider] = login_image
                self._login_messages[provider] = "请使用知乎 App 扫码，并在手机上确认登录。"
            except PlaywrightTimeoutError:
                pass

        if not qr_visible and await self._zhihu_page_requires_verification(page):
            self._login_images.pop(provider, None)
            message = self._zhihu_login_wait_message(None, "verification_required")
            self._login_messages[provider] = message
            login_image = None
            return {
                "provider": provider,
                "connected": False,
                "state": "connecting",
                "useAuthenticated": bool(preferences.get(provider, False)),
                "loginImage": None,
                "message": message,
            }

        return {
            "provider": provider,
            "connected": False,
            "state": "connecting",
            "useAuthenticated": bool(preferences.get(provider, False)),
            "loginImage": login_image,
            "message": self._login_messages.get(provider, "等待知乎 App 扫码并确认登录。"),
        }

    async def complete_login(self, provider: str) -> dict[str, Any]:
        if provider not in AUTH_PROVIDERS:
            raise ValueError("该平台不支持独立登录配置")
        if provider in VIDEO_PROVIDERS:
            return await self._complete_manual_browser_login(provider)
        if provider == "zhihu":
            return await self._complete_zhihu_browser_login()
        try:
            result = await qr_auth.poll(provider)
        except RuntimeError as exc:
            await qr_auth.cancel(provider)
            self._login_images.pop(provider, None)
            return {
                "provider": provider,
                "connected": False,
                "state": "login_required",
                "useAuthenticated": storage.get_news_search_preferences().get(provider, False),
                "loginImage": None,
                "message": str(exc),
            }
        state = str(result.get("state") or "missing")
        if state == "connecting":
            return {
                "provider": provider,
                "connected": False,
                "state": "connecting",
                "useAuthenticated": storage.get_news_search_preferences().get(provider, False),
                "loginImage": self._login_images.get(provider),
                "message": str(result.get("message") or "等待扫码确认中。"),
            }
        if state == "connected":
            cookies = result.get("cookies")
            if not isinstance(cookies, list) or not cookies:
                self._login_images.pop(provider, None)
                return {
                    "provider": provider,
                    "connected": False,
                    "state": "login_required",
                    "useAuthenticated": storage.get_news_search_preferences().get(provider, False),
                    "loginImage": None,
                    "message": "平台确认了扫码，但没有返回可用的登录凭据；请重新扫码。",
                }
            try:
                context, _page = await self.authenticated_page(provider)
                await context.add_cookies(cookies)
                cookie_names = {
                    str(cookie.get("name", ""))
                    for cookie in await context.cookies()
                    if any(
                        str(cookie.get("domain", "")).lstrip(".").casefold() == domain
                        or str(cookie.get("domain", "")).lstrip(".").casefold().endswith("." + domain)
                        for domain in _LOGIN_COOKIE_DOMAINS[provider]
                    )
                }
                if not (_LOGIN_COOKIE_NAMES[provider] & cookie_names):
                    raise RuntimeError("登录凭据未通过本机校验")
                marker = self._marker_path(provider)
                marker.parent.mkdir(parents=True, exist_ok=True)
                marker.write_text(
                    json.dumps({"provider": provider, "connectedAt": _now_iso()}, ensure_ascii=False),
                    encoding="utf-8",
                )
            except Exception:
                await self._close_provider_contexts(provider)
                self._login_images.pop(provider, None)
                return {
                    "provider": provider,
                    "connected": False,
                    "state": "login_required",
                    "useAuthenticated": storage.get_news_search_preferences().get(provider, False),
                    "loginImage": None,
                    "message": f"{PROVIDER_TITLES[provider]}已确认扫码，但登录凭据未能保存到本机；请重新扫码。",
                }
            self._login_images.pop(provider, None)
            return {
                "provider": provider,
                "connected": True,
                "state": "connected",
                "useAuthenticated": storage.get_news_search_preferences().get(provider, False),
                "loginImage": None,
                "message": "账号登录配置已保存。授权搜索仍默认关闭，可在搜索设置中主动开启。",
            }
        self._login_images.pop(provider, None)
        return {
            "provider": provider,
            "connected": self._is_connected(provider),
            "state": "login_required",
            "useAuthenticated": storage.get_news_search_preferences().get(provider, False),
            "loginImage": None,
            "message": str(result.get("message") or "没有待确认的二维码，请重新生成。"),
        }

    async def _complete_manual_browser_login(self, provider: str) -> dict[str, Any]:
        """只检查登录 Cookie 名称；不读取、传回或记录 Cookie 值。"""
        preferences = storage.get_news_search_preferences()
        context = self._authenticated_contexts.get(provider)
        page = self._login_pages.get(provider)
        if context is None or page is None or page.is_closed():
            return {
                "provider": provider,
                "connected": self._is_connected(provider),
                "state": "login_required",
                "useAuthenticated": bool(preferences.get(provider, False)),
                "loginImage": None,
                "message": f"没有待确认的{PROVIDER_TITLES[provider]}登录页，请重新连接账号。",
            }

        try:
            origin = _MANUAL_LOGIN_URLS[provider]
            cookies = await context.cookies([origin])
        except Exception:
            return {
                "provider": provider,
                "connected": False,
                "state": "login_required",
                "useAuthenticated": bool(preferences.get(provider, False)),
                "loginImage": None,
                "message": f"{PROVIDER_TITLES[provider]}浏览器会话已关闭，请重新连接账号。",
            }
        allowed_domains = _LOGIN_COOKIE_DOMAINS[provider]
        cookie_names = {
            str(cookie.get("name", ""))
            for cookie in cookies
            if any(
                str(cookie.get("domain", "")).lstrip(".").casefold() == domain
                or str(cookie.get("domain", "")).lstrip(".").casefold().endswith("." + domain)
                for domain in allowed_domains
            )
        }
        if _LOGIN_COOKIE_NAMES[provider] & cookie_names:
            marker = self._marker_path(provider)
            marker.parent.mkdir(parents=True, exist_ok=True)
            marker.write_text(
                json.dumps({"provider": provider, "connectedAt": _now_iso()}, ensure_ascii=False),
                encoding="utf-8",
            )
            self._login_started_at.pop(provider, None)
            self._login_messages.pop(provider, None)
            return {
                "provider": provider,
                "connected": True,
                "state": "connected",
                "useAuthenticated": bool(preferences.get(provider, False)),
                "loginImage": None,
                "message": f"{PROVIDER_TITLES[provider]}登录状态已通过本机浏览器会话确认。授权搜索仍默认关闭。",
            }

        started_at = self._login_started_at.get(provider)
        if started_at is None or time.monotonic() - started_at >= 15 * 60:
            self._login_started_at.pop(provider, None)
            return {
                "provider": provider,
                "connected": False,
                "state": "login_required",
                "useAuthenticated": bool(preferences.get(provider, False)),
                "loginImage": None,
                "message": f"尚未检测到{PROVIDER_TITLES[provider]}登录状态；请在新标签完成登录后重试。",
            }
        return {
            "provider": provider,
            "connected": False,
            "state": "connecting",
            "useAuthenticated": bool(preferences.get(provider, False)),
            "loginImage": None,
            "message": f"等待在浏览器中完成{PROVIDER_TITLES[provider]}登录。",
        }

    async def cancel_login(self, provider: str) -> dict[str, Any]:
        if provider not in AUTH_PROVIDERS:
            raise ValueError("该平台不支持独立登录配置")
        async with self._lock:
            if provider not in VIDEO_PROVIDERS:
                await qr_auth.cancel(provider)
            self._login_images.pop(provider, None)
            self._login_started_at.pop(provider, None)
            self._login_messages.pop(provider, None)
            if provider in CURRENT_BROWSER_PROVIDERS:
                page = self._login_pages.pop(provider, None)
                if page is not None and not page.is_closed():
                    try:
                        await page.close()
                    except Exception:
                        pass
        return self.status(provider)

    async def disconnect(self, provider: str) -> dict[str, Any]:
        if provider not in AUTH_PROVIDERS:
            raise ValueError("该平台不支持独立登录配置")
        async with self._lock:
            if provider not in VIDEO_PROVIDERS:
                await qr_auth.cancel(provider)
            self._login_images.pop(provider, None)
            self._login_started_at.pop(provider, None)
            self._login_messages.pop(provider, None)
            await self._close_provider_contexts(provider)
            profile_dir = self._profile_dir(provider)
            root = (storage.DATA_DIR / "topic-search-profiles").resolve()
            if profile_dir.exists() and profile_dir.parent == root:
                shutil.rmtree(profile_dir)
            storage.set_news_search_preference(provider, False)
        return self.status(provider)

    async def authenticated_page(self, provider: str) -> tuple[BrowserContext, Page]:
        if provider not in AUTH_PROVIDERS:
            raise ValueError("该平台不支持独立登录配置")
        if provider == "zhihu":
            context = await self._ensure_zhihu_context()
            async with self._lock:
                page = self._authenticated_pages.get(provider)
                if page is None or page.is_closed():
                    page = await context.new_page()
                    self._authenticated_pages[provider] = page
                return context, page
        if provider in VIDEO_PROVIDERS:
            context = await self._ensure_video_cdp_context(provider)
            async with self._lock:
                page = self._authenticated_pages.get(provider)
                if page is None or page.is_closed():
                    page = await context.new_page()
                    self._authenticated_pages[provider] = page
                return context, page
        async with self._lock:
            context = self._authenticated_contexts.get(provider)
            if context is None:
                if self._playwright is None:
                    self._playwright = await async_playwright().start()
                profile_dir = self._profile_dir(provider)
                profile_dir.mkdir(parents=True, exist_ok=True)
                context = await self._playwright.chromium.launch_persistent_context(
                    str(profile_dir), channel="msedge", headless=True,
                )
                self._authenticated_contexts[provider] = context
        page = context.pages[0] if context.pages else await context.new_page()
        return context, page

    async def authenticated_context(self, provider: str) -> BrowserContext:
        """返回视频平台的当前浏览器上下文，不额外创建空白标签。"""
        if provider not in VIDEO_PROVIDERS:
            raise ValueError("当前浏览器上下文仅用于视频平台")
        return await self._ensure_video_cdp_context(provider)

    async def invisible_video_context(self, provider: str) -> BrowserContext:
        """复制当前视频平台登录态到无界面的临时上下文，不操作用户浏览器标签。"""
        source_context = await self.authenticated_context(provider)
        storage_state = await source_context.storage_state()
        browser = await self._ensure_browser()
        return await browser.new_context(storage_state=storage_state)

    async def expire(self, provider: str) -> None:
        marker = self._marker_path(provider)
        try:
            marker.unlink(missing_ok=True)
        except OSError:
            pass
        await self._close_provider_contexts(provider)

    async def _close_provider_contexts(self, provider: str) -> None:
        if provider in CURRENT_BROWSER_PROVIDERS:
            pages = [
                self._authenticated_pages.pop(provider, None),
                self._login_pages.pop(provider, None),
            ]
            for page in pages:
                if page is not None and not page.is_closed():
                    try:
                        await page.close()
                    except Exception:
                        pass
            self._authenticated_contexts.pop(provider, None)
            browser = self._cdp_browsers.pop(provider, None)
            if browser is not None:
                try:
                    await browser.close()
                except Exception:
                    pass
            return
        context = self._authenticated_contexts.pop(provider, None)
        if context is not None:
            try:
                await context.close()
            except Exception:
                pass

    async def close(self) -> None:
        await qr_auth.close()
        self._login_images.clear()
        self._login_started_at.clear()
        self._login_messages.clear()
        for provider in AUTH_PROVIDERS:
            await self._close_provider_contexts(provider)
        if self._browser is not None:
            await self._browser.close()
            self._browser = None
        if self._playwright is not None:
            await self._playwright.stop()
            self._playwright = None


browser_sessions = TopicSearchBrowser()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _query_hash(query: str, providers: list[str], time_range: str) -> str:
    raw = json.dumps([query.casefold(), sorted(providers), time_range], ensure_ascii=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def _encode_cursor(cursor: _SearchCursor) -> str:
    raw = json.dumps(
        {
            "q": cursor.query_hash,
            "p": cursor.pages,
            "o": cursor.local_offset,
            "s": cursor.seen_keys[-700:],
        },
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _decode_cursor(value: str | None, query_hash: str) -> _SearchCursor:
    if not value:
        return _SearchCursor(query_hash=query_hash, pages={}, local_offset=0, seen_keys=[])
    try:
        padded = value + "=" * (-len(value) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
        if payload.get("q") != query_hash:
            raise ValueError("分页游标和当前搜索条件不匹配，请重新搜索")
        if not isinstance(payload, dict):
            raise ValueError("分页游标无效，请重新搜索")
        raw_pages = payload.get("p", {})
        raw_seen = payload.get("s", [])
        if not isinstance(raw_pages, dict) or not isinstance(raw_seen, list):
            raise ValueError("分页游标无效，请重新搜索")
        pages = {
            str(key): min(MAX_CURSOR_PAGE, max(0, int(page)))
            for key, page in raw_pages.items()
            if key in {"local", "tieba", "zhihu", "weibo", *VIDEO_PROVIDERS}
        }
        return _SearchCursor(
            query_hash=query_hash,
            pages=pages,
            local_offset=min(20_000, max(0, int(payload.get("o", 0)))),
            seen_keys=[str(key) for key in raw_seen if isinstance(key, str)][-700:],
        )
    except ValueError:
        raise
    except (TypeError, KeyError, AttributeError, binascii.Error, json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ValueError("分页游标无效，请重新搜索") from exc


def _range_start(time_range: str) -> str | None:
    durations = {"24h": timedelta(hours=24), "7d": timedelta(days=7), "30d": timedelta(days=30)}
    duration = durations.get(time_range)
    if duration is None:
        return None
    return (datetime.now(timezone.utc) - duration).isoformat(timespec="seconds").replace("+00:00", "Z")


def _published_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        # Public Chinese search pages commonly expose local wall-clock time
        # without an explicit offset. Interpret those values as China time.
        parsed = parsed.replace(tzinfo=timezone(timedelta(hours=8)))
    return parsed.astimezone(timezone.utc)


def _normalize_page_time(value: str | None) -> str | None:
    """Normalize common absolute and relative time labels from public result cards."""
    if not value:
        return None
    parsed = _published_datetime(value)
    if parsed is not None:
        return parsed.isoformat(timespec="seconds").replace("+00:00", "Z")

    now_utc = datetime.now(timezone.utc)
    relative_match = re.search(r"(\d+)\s*(分钟|小时|天)前", value)
    if relative_match:
        amount = int(relative_match.group(1))
        unit = relative_match.group(2)
        duration = timedelta(minutes=amount) if unit == "分钟" else timedelta(hours=amount) if unit == "小时" else timedelta(days=amount)
        return (now_utc - duration).isoformat(timespec="seconds").replace("+00:00", "Z")
    if "刚刚" in value:
        return now_utc.isoformat(timespec="seconds").replace("+00:00", "Z")

    china_tz = timezone(timedelta(hours=8))
    china_now = now_utc.astimezone(china_tz)
    local_value = value.replace("今天", china_now.strftime("%Y-%m-%d"))
    local_value = local_value.replace("昨天", (china_now - timedelta(days=1)).strftime("%Y-%m-%d"))
    candidates = ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d", "%m-%d %H:%M")
    for pattern in candidates:
        try:
            local_time = datetime.strptime(local_value, pattern)
            if pattern.startswith("%m-"):
                local_time = local_time.replace(year=china_now.year)
            return local_time.replace(tzinfo=china_tz).astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        except ValueError:
            continue
    return None


def _within_range(value: str | None, published_after: str | None) -> bool:
    if published_after is None:
        return True
    item_time = _published_datetime(value)
    start_time = _published_datetime(published_after)
    return item_time is None or start_time is None or item_time >= start_time


def _sort_timestamp(value: str | None) -> int:
    """Return a platform-independent sortable timestamp in microseconds."""
    parsed = _published_datetime(value)
    if parsed is None:
        return 0
    return (
        parsed.toordinal() * 86_400_000_000
        + parsed.hour * 3_600_000_000
        + parsed.minute * 60_000_000
        + parsed.second * 1_000_000
        + parsed.microsecond
    )


def _result_key(provider: str, url: str | None, provider_id: str) -> str:
    canonical_url = canonicalize_url(url)
    if canonical_url:
        return "url:" + hashlib.sha256(canonical_url.encode("utf-8")).hexdigest()[:20]
    identity = f"{provider}:{provider_id}"
    return "id:" + hashlib.sha256(identity.encode("utf-8")).hexdigest()[:20]


def _login_wall(page_url: str, body: str) -> bool:
    lowered = body.casefold()
    return any(fragment.casefold() in lowered for fragment in _LOGIN_WALL_TEXT) or any(
        part in page_url.casefold() for part in ("/signin", "/login")
    )


def _is_challenge(body: str) -> bool:
    return any(fragment in body for fragment in _CHALLENGE_TEXT)


def _log_provider_outcome(
    request_id: str,
    provider: str,
    result: ProviderResult,
    duration_ms: int,
) -> None:
    """Log operational diagnostics without search terms, page data, or credentials."""
    line = (
        f"topic_search request_id={request_id} provider={provider} mode={result.request_mode} "
        f"stage={result.diagnostic_stage} state={result.state} "
        f"http_status={result.http_status if result.http_status is not None else '-'} "
        f"authenticated_http_status={result.authenticated_http_status if result.authenticated_http_status is not None else '-'} "
        f"result_count={len(result.items)} duration_ms={max(0, duration_ms)} "
        f"error_type={result.error_type or '-'} error_code={result.error_code or '-'}"
    )
    logger.info(line)
    try:
        log_dir = storage.DATA_DIR / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        log_path = log_dir / "topic-search.log"
        with _topic_search_log_lock:
            if log_path.exists() and log_path.stat().st_size >= TOPIC_SEARCH_LOG_MAX_BYTES:
                backup = log_dir / "topic-search.log.1"
                backup.unlink(missing_ok=True)
                log_path.replace(backup)
            with log_path.open("a", encoding="utf-8", newline="\n") as handle:
                handle.write(line + "\n")
    except OSError as exc:
        logger.warning("topic_search diagnostic_file_write_failed error_type={}", type(exc).__name__)


async def _extract_page_items(page: Any, provider: str) -> list[dict[str, Any]]:
    pattern = _RESULT_PATTERNS[provider]
    raw_items = await page.locator("a[href]").evaluate_all(
        """anchors => anchors.map(anchor => {
          const root = anchor.closest('article, li, .card-wrap, .s_post, .threadlist_li_right, .SearchResult-Card, .ContentItem, [class*=result]')
            || anchor.parentElement?.parentElement || anchor.parentElement;
          if (!root) return null;
          const heading = root.querySelector('h1, h2, h3, [class*=title]');
          const time = root.querySelector('time[datetime], time');
          const author = root.querySelector('[class*=author], [class*=name], [class*=user]');
          const image = Array.from(root.querySelectorAll('img')).find(img => (img.naturalWidth || img.width || 0) >= 80 && !/avatar|head/i.test(img.alt || ''));
          return {
            href: anchor.href,
            anchorText: (anchor.innerText || anchor.getAttribute('title') || '').trim(),
            heading: heading ? heading.innerText.trim() : '',
            text: (root.innerText || '').trim().slice(0, 5000),
            time: time ? (time.getAttribute('datetime') || time.innerText.trim()) : '',
            author: author ? author.innerText.trim().slice(0, 100) : '',
            image: image ? (image.currentSrc || image.src || image.getAttribute('data-src') || '') : ''
          };
        }).filter(Boolean)"""
    )
    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entry in raw_items:
        href = str(entry.get("href") or "")
        parsed = urlsplit(href)
        host = (parsed.hostname or "").lower()
        allowed = {
            "tieba": {"tieba.baidu.com", "www.tieba.baidu.com"},
            "zhihu": {"zhihu.com", "www.zhihu.com"},
            "weibo": {"weibo.com", "www.weibo.com", "s.weibo.com"},
        }[provider]
        match = pattern.search(parsed.path)
        if host not in allowed or match is None:
            continue
        provider_id = match.group(1) if match.lastindex else match.group(0).strip("/")
        canonical = canonicalize_url(href)
        if canonical is None or canonical in seen:
            continue
        seen.add(canonical)
        body = " ".join(str(entry.get("text") or "").split())
        title = " ".join(str(entry.get("heading") or entry.get("anchorText") or "").split())
        if not title:
            title = next((line.strip() for line in body.split(" ") if line.strip()), "")
        if not title or len(title) > 500:
            continue
        content = body.replace(title, "", 1).strip(" ·-—|\n")[:2500]
        image_url = urljoin(href, str(entry.get("image") or "")) if entry.get("image") else None
        if image_url and urlsplit(image_url).scheme not in {"http", "https"}:
            image_url = None
        published = _normalize_page_time(str(entry.get("time") or "").strip())
        normalized.append({
            "providerId": provider_id,
            "title": title[:500],
            "author": str(entry.get("author") or "").strip()[:100] or None,
            "publishedAt": published,
            "content": content,
            "imageUrl": image_url,
            "url": canonical,
        })
    normalized.sort(
        key=lambda item: _published_datetime(item.get("publishedAt")) or datetime.min.replace(tzinfo=timezone.utc),
        reverse=True,
    )
    return normalized[:SEARCH_LIMIT]


def _safe_error_code(error: Exception) -> str:
    """Extract a bounded diagnostic category; never persist raw exception text."""
    message = str(error)
    network_match = re.search(r"net::(ERR_[A-Z0-9_]+)", message)
    if network_match:
        return network_match.group(1)
    lowered = message.casefold()
    if "executable doesn't exist" in lowered or "executable does not exist" in lowered:
        return "PLAYWRIGHT_EXECUTABLE_MISSING"
    if "target page, context or browser has been closed" in lowered or "browser has been closed" in lowered:
        return "PLAYWRIGHT_BROWSER_CLOSED"
    return "PLAYWRIGHT_ERROR"


def _request_error_message(error_code: str) -> str:
    messages = {
        "ERR_NETWORK_ACCESS_DENIED": "系统或网络策略阻止自动化浏览器连接平台；TabKeep 未收到平台响应。",
        "ERR_NAME_NOT_RESOLVED": "平台域名无法解析；请检查 DNS 或网络连接。",
        "ERR_CONNECTION_TIMED_OUT": "连接平台超时；请检查网络后重试。",
        "ERR_CONNECTION_RESET": "与平台的网络连接被重置；请检查网络后重试。",
        "ERR_CONNECTION_REFUSED": "平台拒绝了网络连接；请稍后重试。",
        "ERR_INTERNET_DISCONNECTED": "当前网络不可用，无法连接平台。",
        "PLAYWRIGHT_EXECUTABLE_MISSING": "找不到 Microsoft Edge，无法启动公开搜索。",
        "PLAYWRIGHT_BROWSER_CLOSED": "自动化浏览器意外关闭；可以重试搜索。",
    }
    if error_code.startswith("ERR_CERT_"):
        return "平台 HTTPS 证书验证失败；请检查系统证书或网络代理。"
    return messages.get(error_code, "无法连接平台公开搜索页；可稍后重试。")


def _tieba_pc_sign(params: dict[str, str | int]) -> str:
    """按贴吧 PC 搜索接口要求生成参数签名。"""
    sign_source = "".join(
        f"{key}={params[key]}"
        for key in sorted(params)
        if key not in {"sign", "sig"} and params[key] is not None
    )
    return hashlib.md5(
        (sign_source + _TIEBA_PC_SIGN_SECRET).encode("utf-8"),
        usedforsecurity=False,
    ).hexdigest()


def _tieba_api_time(value: Any) -> str | None:
    try:
        timestamp = float(value)
        if timestamp > 100_000_000_000:
            timestamp /= 1000
        if timestamp <= 0:
            return None
        parsed = datetime.fromtimestamp(timestamp, timezone.utc)
    except (OverflowError, OSError, TypeError, ValueError):
        return None
    return parsed.isoformat(timespec="seconds").replace("+00:00", "Z")


def _extract_tieba_api_items(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        raise _TiebaApiResponseError("api_schema", "TIEBA_API_SCHEMA")
    error_code = payload.get("error_code", payload.get("no"))
    if error_code not in (None, 0, "0", "None"):
        raise _TiebaApiResponseError("api_platform_error", "TIEBA_API_ERROR")
    data = payload.get("data")
    cards = data.get("card_list") if isinstance(data, dict) else None
    if not isinstance(cards, list):
        raise _TiebaApiResponseError("api_schema", "TIEBA_API_SCHEMA")

    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    thread_card_count = 0
    for card in cards:
        if not isinstance(card, dict):
            continue
        if card.get("cardInfo") != "thread" and card.get("cardStyle") != "thread":
            continue
        thread_card_count += 1
        note = card.get("data")
        if not isinstance(note, dict):
            continue
        provider_id = str(note.get("tid") or "").strip()
        if not provider_id or provider_id in seen:
            continue
        seen.add(provider_id)

        title = " ".join(str(note.get("title") or "").split())[:500]
        content = " ".join(str(note.get("content") or "").split())[:2500]
        if not title:
            title = content[:120].strip()
        if not title:
            continue
        user = note.get("user")
        author = None
        if isinstance(user, dict):
            author = str(user.get("show_nickname") or user.get("user_name") or "").strip()[:100] or None
        url = canonicalize_url(f"{_TIEBA_ORIGIN}/p/{provider_id}")
        if not url:
            continue
        items.append({
            "providerId": provider_id,
            "title": title,
            "author": author,
            "publishedAt": _tieba_api_time(note.get("time") or note.get("create_time")),
            "content": content,
            "imageUrl": None,
            "url": url,
        })

    if cards and thread_card_count == 0:
        raise _TiebaApiResponseError("api_schema", "TIEBA_API_SCHEMA")
    items.sort(
        key=lambda item: _published_datetime(item.get("publishedAt")) or datetime.min.replace(tzinfo=timezone.utc),
        reverse=True,
    )
    return items[:SEARCH_LIMIT]


async def _fetch_tieba_search_response(page: Any, query: str, page_number: int) -> tuple[int, str]:
    page_host = (urlsplit(page.url).hostname or "").lower()
    if page_host != "tieba.baidu.com":
        response = await page.goto(
            _TIEBA_ORIGIN,
            wait_until="domcontentloaded",
            timeout=SEARCH_TIMEOUT_SECONDS * 1000,
        )
        status = response.status if response else None
        if status in {401, 403, 429}:
            return status, ""

    params: dict[str, str | int] = {
        "rn": max(SEARCH_LIMIT, 20),
        "st": "1",
        "word": query,
        "needbrand": 1,
        "sug_type": 2,
        "pn": page_number,
        "come_from": "search",
        "subapp_type": "pc",
        "_client_type": "20",
    }
    params["sign"] = _tieba_pc_sign(params)
    search_url = f"{_TIEBA_ORIGIN}/mo/q/search/multsearch?{urlencode(params)}"
    response = await asyncio.wait_for(
        page.evaluate(
            """async ({ url, timeoutMs }) => {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), timeoutMs);
                try {
                    const response = await fetch(url, {
                        method: "GET",
                        credentials: "include",
                        headers: { "Accept": "application/json, text/plain, */*" },
                        signal: controller.signal
                    });
                    return { status: response.status, text: await response.text() };
                } catch (error) {
                    return { status: null, text: "", error: error?.name === "AbortError" ? "timeout" : "network" };
                } finally {
                    clearTimeout(timer);
                }
            }""",
            {"url": search_url, "timeoutMs": AUTHENTICATED_JSON_FETCH_TIMEOUT_MS},
        ),
        timeout=AUTHENTICATED_JSON_FETCH_TIMEOUT_MS / 1000 + 2,
    )
    if not isinstance(response, dict):
        raise _TiebaApiResponseError("api_transport", "TIEBA_API_TRANSPORT")
    if response.get("error") == "timeout":
        raise _TiebaApiResponseError("api_timeout", "TIEBA_API_TIMEOUT")
    if response.get("error"):
        raise _TiebaApiResponseError("api_transport", "TIEBA_API_TRANSPORT")
    status = response.get("status")
    if not isinstance(status, int):
        raise _TiebaApiResponseError("api_transport", "TIEBA_API_TRANSPORT")
    return status, str(response.get("text") or "")


async def _search_page(
    provider: str,
    query: str,
    page_number: int,
    context: BrowserContext,
    request_id: str | None = None,
) -> tuple[list[dict[str, Any]], str, str, int | None]:
    if provider in VIDEO_PROVIDERS:
        try:
            items, body, final_url, response_status = await video_topic_search.search_video_page(
                provider,
                query,
                page_number,
                context,
                request_id,
            )
            for item in items:
                item["publishedAt"] = _normalize_page_time(str(item.get("publishedAt") or ""))
            return items, body, final_url, response_status
        except video_topic_search.VideoTopicSearchError as exc:
            if "timeout" in exc.error_code.casefold():
                raise PlaywrightTimeoutError(exc.message) from exc
            raise _ProviderRequestFailure("video_search_api", exc) from exc
    try:
        page = await context.new_page()
    except Exception as exc:
        raise _ProviderRequestFailure("page_create", exc) from exc
    response_status: int | None = None
    try:
        try:
            response = await page.goto(
                _SEARCH_URLS[provider](query, page_number),
                wait_until="domcontentloaded",
                timeout=SEARCH_TIMEOUT_SECONDS * 1000,
            )
        except Exception as exc:
            raise _ProviderRequestFailure("navigation", exc) from exc
        response_status = response.status if response else None
        try:
            await page.wait_for_timeout(1000)
            body = " ".join((await page.locator("body").inner_text(timeout=4000)).split())[:12000]
        except Exception as exc:
            raise _ProviderRequestFailure("response_read", exc) from exc
        if response_status in {401, 403, 429}:
            return [], body, page.url, response_status
        try:
            items = await _extract_page_items(page, provider)
        except Exception as exc:
            raise _ProviderRequestFailure("result_parse", exc) from exc
        return items, body, page.url, response_status
    finally:
        try:
            await page.close()
        except Exception:
            pass


async def _anonymous_search(
    provider: str,
    query: str,
    page_number: int,
    request_id: str | None = None,
) -> ProviderResult:
    stage = "browser_launch"
    try:
        browser = await browser_sessions._ensure_browser()
        stage = "context_create"
        context = await browser.new_context()
        try:
            items, body, final_url, response_status = await _search_page(
                provider, query, page_number, context, request_id
            )
        finally:
            await context.close()
    except _ProviderRequestFailure as exc:
        state = exc.state if exc.state in {"error", "login_required"} else "error"
        message = exc.message or ("平台页面响应超时。" if exc.error_type == "TimeoutError" else _request_error_message(exc.error_code))
        return ProviderResult(
            [], state, message,
            diagnostic_stage=exc.stage,
            error_type=exc.error_type,
            error_code=exc.error_code,
            http_status=exc.http_status if isinstance(exc.http_status, int) else None,
        )
    except PlaywrightTimeoutError as exc:
        return ProviderResult(
            [], "timeout", "平台页面响应超时。",
            diagnostic_stage=stage, error_type=type(exc).__name__, error_code=_safe_error_code(exc),
        )
    except Exception as exc:
        error_code = _safe_error_code(exc)
        return ProviderResult(
            [], "error", _request_error_message(error_code),
            diagnostic_stage=stage, error_type=type(exc).__name__, error_code=error_code,
        )
    if _is_challenge(body):
        return ProviderResult(
            [], "error", "平台要求安全验证；TabKeep 不会绕过验证。",
            diagnostic_stage="challenge_detection", http_status=response_status,
        )
    if response_status == 401:
        return ProviderResult(
            [], "login_required", "平台公开搜索要求登录。",
            diagnostic_stage="http_response", http_status=response_status,
        )
    if response_status in {403, 412, 429}:
        return ProviderResult(
            [], "error", f"平台公开搜索受限（HTTP {response_status}）；TabKeep 不会绕过访问限制。",
            diagnostic_stage="http_response", http_status=response_status,
        )
    if _login_wall(final_url, body):
        return ProviderResult(
            [], "login_required", "平台要求登录后才能查看搜索结果。",
            diagnostic_stage="login_wall", http_status=response_status,
        )
    return ProviderResult(
        items,
        "success" if items else "empty",
        "" if items else "公开搜索没有匹配结果。",
        len(items) >= SEARCH_LIMIT and provider not in {"douyin", "kuaishou"},
        diagnostic_stage="result_parse",
        http_status=response_status,
    )


def _is_retryable_video_session_failure(error_type: str, error_code: str, stage: str) -> bool:
    if stage == "context_start":
        return True
    if error_type in {"TargetClosedError", "BrowserClosedError", "BrowserContextClosedError"}:
        return True
    return error_code.upper() in {
        "API_TRANSPORT_ERROR",
        "API_TIMEOUT",
        "API_RESPONSE_MISSING",
        "TARGET_CLOSED",
        "BROWSER_DISCONNECTED",
    }


async def _search_provider(
    provider: str,
    query: str,
    page_number: int,
    use_authenticated: bool,
    request_id: str | None = None,
    context_reconnect_attempted: bool = False,
) -> ProviderResult:
    if provider == "xiaoheihe":
        return ProviderResult(
            [], "unsupported", "当前适配器只有新闻、折扣和话题流；未验证到可用的公开关键词搜索。",
            diagnostic_stage="capability_check",
        )
    connected = browser_sessions._is_connected(provider) if provider in AUTH_PROVIDERS else False
    if use_authenticated and provider in AUTH_PROVIDERS and connected:
        auth_stage = "context_start"
        response_status: int | None = None
        api_fallback_reason: str | None = None
        try:
            if provider in VIDEO_PROVIDERS:
                _context = await browser_sessions.invisible_video_context(provider)
                page = None
            else:
                _context, page = await browser_sessions.authenticated_page(provider)
            # 视频平台使用本次复制的临时会话；采集不会读取或返回 Cookie 值。
            if provider == "tieba":
                auth_stage = "api_request"
                try:
                    if page is None:
                        raise RuntimeError("贴吧登录页未建立")
                    response_status, response_text = await _fetch_tieba_search_response(page, query, page_number)
                    if response_status in {403, 429}:
                        return ProviderResult(
                            [], "error", f"平台搜索受限（HTTP {response_status}）；TabKeep 不会绕过访问限制。",
                            connected=True,
                            use_authenticated=True,
                            diagnostic_stage="authenticated_api_http_response",
                            http_status=response_status,
                            request_mode="authenticated",
                        )
                    if response_status == 401:
                        await browser_sessions.expire(provider)
                        fallback = await _anonymous_search(provider, query, page_number, request_id)
                        fallback.state = "auth_expired_fallback"
                        fallback.message = "授权登录已失效，已尝试匿名搜索；请重新连接账号以使用登录搜索。"
                        fallback.connected = False
                        fallback.use_authenticated = True
                        fallback.diagnostic_stage = "authenticated_expired_fallback"
                        fallback.http_status = response_status
                        fallback.request_mode = "anonymous_fallback"
                        return fallback
                    if response_status == 200:
                        try:
                            payload = json.loads(response_text)
                            items = _extract_tieba_api_items(payload)
                        except json.JSONDecodeError:
                            api_fallback_reason = "api_json_parse"
                        except _TiebaApiResponseError as exc:
                            if exc.stage == "api_platform_error":
                                return ProviderResult(
                                    [], "error", "贴吧搜索接口返回错误；请稍后重试。",
                                    connected=True,
                                    use_authenticated=True,
                                    diagnostic_stage="authenticated_api_platform_error",
                                    http_status=response_status,
                                    error_code=exc.error_code,
                                    request_mode="authenticated",
                                )
                            api_fallback_reason = exc.stage
                        else:
                            return ProviderResult(
                                items,
                                "success" if items else "empty",
                                "" if items else "登录搜索没有匹配结果。",
                                len(items) >= SEARCH_LIMIT,
                                connected=True,
                                use_authenticated=True,
                                diagnostic_stage="api_result_parse",
                                http_status=response_status,
                                request_mode="authenticated_api",
                            )
                    else:
                        api_fallback_reason = "api_http_fallback"
                except _TiebaApiResponseError as exc:
                    api_fallback_reason = exc.stage
                except (asyncio.TimeoutError, PlaywrightTimeoutError):
                    api_fallback_reason = "api_timeout"
                except Exception:
                    api_fallback_reason = "api_request_error"

            auth_stage = "navigation"
            if provider in VIDEO_PROVIDERS:
                try:
                    items, body, final_url, response_status = await _search_page(
                        provider,
                        query,
                        page_number,
                        _context,
                        request_id,
                    )
                finally:
                    await _context.close()
            else:
                page_url = _SEARCH_URLS[provider](query, page_number)
                response = await page.goto(
                    page_url,
                    wait_until="domcontentloaded",
                    timeout=SEARCH_TIMEOUT_SECONDS * 1000,
                )
                response_status = response.status if response else None
                auth_stage = "post_navigation_wait"
                await page.wait_for_timeout(800)
                auth_stage = "body_read"
                body = " ".join(
                    (await page.locator("body").inner_text(timeout=AUTHENTICATED_BODY_READ_TIMEOUT_MS)).split()
                )[:12000]
            if response_status in {403, 412, 429}:
                return ProviderResult(
                    [], "error", f"平台搜索受限（HTTP {response_status}）；TabKeep 不会绕过访问限制。",
                    connected=True,
                    use_authenticated=True,
                    diagnostic_stage="http_response",
                    http_status=response_status,
                    request_mode="authenticated",
                )
            if response_status == 401 or _login_wall(final_url if provider in VIDEO_PROVIDERS else page.url, body):
                await browser_sessions.expire(provider)
                fallback = await _anonymous_search(provider, query, page_number, request_id)
                fallback.state = "auth_expired_fallback"
                fallback.message = "授权登录已失效，已尝试匿名搜索；请重新连接账号以使用登录搜索。"
                fallback.connected = False
                fallback.use_authenticated = True
                fallback.diagnostic_stage = "authenticated_expired_fallback"
                fallback.http_status = response_status
                fallback.request_mode = "anonymous_fallback"
                return fallback
            if response_status in {403, 412, 429} or _is_challenge(body):
                return ProviderResult(
                    [], "error", "平台要求安全验证或限制了访问；TabKeep 不会绕过验证。",
                    connected=True,
                    use_authenticated=True,
                    diagnostic_stage="authenticated_challenge" if _is_challenge(body) else "http_response",
                    http_status=response_status,
                    request_mode="authenticated",
                )
            auth_stage = "result_parse"
            if provider not in VIDEO_PROVIDERS:
                items = await _extract_page_items(page, provider)
            return ProviderResult(
                items,
                "success" if items else "empty",
                "" if items else "登录搜索没有匹配结果。",
                len(items) >= SEARCH_LIMIT and provider not in {"douyin", "kuaishou"},
                connected=True,
                use_authenticated=True,
                diagnostic_stage=f"authenticated_{api_fallback_reason}_dom_fallback" if api_fallback_reason else "result_parse",
                http_status=response_status,
                request_mode="authenticated_dom_fallback" if api_fallback_reason else "authenticated",
            )
        except _ProviderRequestFailure as exc:
            if (
                provider in VIDEO_PROVIDERS
                and not context_reconnect_attempted
                and _is_retryable_video_session_failure(exc.error_type, exc.error_code, exc.stage)
            ):
                await browser_sessions._close_provider_contexts(provider)
                return await _search_provider(
                    provider, query, page_number, use_authenticated, request_id, True
                )
            return ProviderResult(
                [],
                exc.state if exc.state in {"error", "login_required"} else "error",
                exc.message or "授权搜索暂不可用。",
                connected=True,
                use_authenticated=True,
                diagnostic_stage=exc.stage,
                http_status=exc.http_status if isinstance(exc.http_status, int) else None,
                error_type=exc.error_type,
                error_code=exc.error_code,
                request_mode="authenticated_api",
            )
        except PlaywrightTimeoutError as exc:
            if (
                provider in VIDEO_PROVIDERS
                and not context_reconnect_attempted
                and auth_stage == "context_start"
            ):
                await browser_sessions._close_provider_contexts(provider)
                return await _search_provider(
                    provider, query, page_number, use_authenticated, request_id, True
                )
            fallback = await _anonymous_search(provider, query, page_number, request_id)
            fallback.state = "timeout"
            if fallback.http_status in {403, 412, 429}:
                fallback.message = f"授权搜索超时；匿名回退同时收到 HTTP {fallback.http_status}，平台限制了访问。"
            else:
                fallback.message = "授权搜索超时，当前未返回结果。可稍后重试。"
            fallback.connected = connected
            fallback.use_authenticated = True
            api_prefix = f"{api_fallback_reason}_dom_" if provider == "tieba" and api_fallback_reason else ""
            fallback.diagnostic_stage = f"authenticated_{api_prefix}{auth_stage}_timeout_fallback"
            fallback.authenticated_http_status = response_status
            fallback.error_type = type(exc).__name__
            fallback.error_code = _safe_error_code(exc)
            fallback.request_mode = "anonymous_fallback"
            return fallback
        except Exception as exc:
            if (
                provider in VIDEO_PROVIDERS
                and not context_reconnect_attempted
                and (
                    auth_stage == "context_start"
                    or _is_retryable_video_session_failure(
                        type(exc).__name__, _safe_error_code(exc), auth_stage
                    )
                )
            ):
                await browser_sessions._close_provider_contexts(provider)
                return await _search_provider(
                    provider, query, page_number, use_authenticated, request_id, True
                )
            fallback = await _anonymous_search(provider, query, page_number, request_id)
            fallback.state = "error"
            fallback.message = "授权搜索暂不可用，已尝试匿名搜索；账号连接状态未更改。"
            fallback.connected = connected
            fallback.use_authenticated = True
            api_prefix = f"{api_fallback_reason}_dom_" if provider == "tieba" and api_fallback_reason else ""
            fallback.diagnostic_stage = f"authenticated_{api_prefix}{auth_stage}_error_fallback"
            fallback.authenticated_http_status = response_status
            fallback.error_type = type(exc).__name__
            fallback.error_code = _safe_error_code(exc)
            fallback.request_mode = "anonymous_fallback"
            return fallback
    result = await _anonymous_search(provider, query, page_number, request_id)
    result.connected = connected
    result.use_authenticated = bool(use_authenticated)
    if use_authenticated and not connected:
        result.message = ("未连接账号，已按匿名方式搜索。" + (" " + result.message if result.message else "")).strip()
    return result


def _local_items(rows: list[dict[str, object]]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for row in rows:
        published = str(row.get("published_at") or row.get("fetched_at") or "") or None
        items.append({
            "providerId": str(row.get("id") or ""),
            "title": str(row.get("title") or ""),
            "author": str(row.get("author") or "") or None,
            "publishedAt": published,
            "content": str(row.get("content") or "")[:2500],
            "imageUrl": str(row.get("image_url") or "") or None,
            "url": str(row.get("url") or "") or None,
            "sourceTitle": str(row.get("source_title") or "本地资讯"),
        })
    return items


async def search_topics(
    query: str,
    providers: list[str],
    time_range: str,
    cursor_value: str | None,
) -> dict[str, Any]:
    """并行检索本地文章和已登记的公开站点适配器。"""
    request_id = secrets.token_hex(4)
    clean_query = " ".join(query.split())
    selected = list(dict.fromkeys(providers))
    query_hash = _query_hash(clean_query, selected, time_range)
    cursor = _decode_cursor(cursor_value, query_hash)
    published_after = _range_start(time_range)
    preferences = storage.get_news_search_preferences()
    states: list[dict[str, Any]] = []
    output_items: list[dict[str, Any]] = []
    next_pages = dict(cursor.pages)
    next_local_offset = cursor.local_offset
    has_more = False

    if "local" in selected and cursor.pages.get("local", 1) != 0:
        local_started = time.perf_counter()
        rows, total = await asyncio.to_thread(
            db.search_items,
            clean_query,
            published_after,
            SEARCH_LIMIT,
            cursor.local_offset,
        )
        local_items = _local_items(rows)
        _log_provider_outcome(
            request_id,
            "local",
            ProviderResult(
                local_items,
                "success" if local_items else "empty",
                diagnostic_stage="sqlite_search",
                request_mode="local",
            ),
            round((time.perf_counter() - local_started) * 1000),
        )
        for item in local_items:
            item_key = _result_key("local", item.get("url"), str(item.get("providerId") or ""))
            output_items.append({
                **item,
                "key": item_key,
                "provider": "local",
                "providerTitle": item.get("sourceTitle") or PROVIDER_TITLES["local"],
            })
        next_local_offset += len(local_items)
        local_more = next_local_offset < total and next_local_offset < 20_000
        next_pages["local"] = 1 if local_more else 0
        has_more = has_more or local_more
        states.append({
            "provider": "local",
            "title": PROVIDER_TITLES["local"],
            "state": "success" if local_items else "empty",
            "message": f"本地共找到 {total} 条匹配资讯。" if total else "本地资讯中没有匹配结果。",
            "connected": False,
            "useAuthenticated": False,
        })
    elif "local" in selected:
        states.append({
            "provider": "local",
            "title": PROVIDER_TITLES["local"],
            "state": "empty",
            "message": "本地匹配结果已全部加载。",
            "connected": False,
            "useAuthenticated": False,
        })

    remote_providers = [
        provider
        for provider in selected
        if provider in {"tieba", "xiaoheihe", "zhihu", "weibo", *VIDEO_PROVIDERS}
    ]
    async def run_provider(provider: str) -> tuple[str, ProviderResult]:
        started = time.perf_counter()
        try:
            if provider == "xiaoheihe":
                result = await _search_provider(
                    provider, clean_query, cursor.pages.get(provider, 1), False, request_id
                )
            elif cursor.pages.get(provider, 1) == 0:
                result = ProviderResult([], "empty", "该平台结果已全部加载。", diagnostic_stage="pagination_complete")
            else:
                preference = bool(preferences.get(provider, False))
                result = await asyncio.wait_for(
                    _search_provider(
                        provider,
                        clean_query,
                        cursor.pages.get(provider, 1),
                        preference,
                        request_id,
                    ),
                    timeout=PROVIDER_SEARCH_TIMEOUT_SECONDS,
                )
        except (asyncio.TimeoutError, PlaywrightTimeoutError) as exc:
            result = ProviderResult(
                [], "timeout", "平台搜索超过时限，其他来源结果仍可继续使用。",
                diagnostic_stage="provider_timeout",
                error_type=type(exc).__name__,
                error_code=_safe_error_code(exc),
            )
        except Exception as exc:
            result = ProviderResult(
                [], "error", "平台搜索暂时失败，其他来源结果仍可继续使用。",
                diagnostic_stage="provider_dispatch",
                error_type=type(exc).__name__,
                error_code=_safe_error_code(exc),
            )
        duration_ms = round((time.perf_counter() - started) * 1000)
        _log_provider_outcome(request_id, provider, result, duration_ms)
        return provider, result

    results = await asyncio.gather(*(run_provider(provider) for provider in remote_providers))
    for provider, provider_result in results:
        preferences_enabled = bool(preferences.get(provider, False)) if provider in AUTH_PROVIDERS else False
        states.append({
            "provider": provider,
            "title": PROVIDER_TITLES[provider],
            "state": provider_result.state,
            "message": provider_result.message,
            "connected": provider_result.connected or (provider in AUTH_PROVIDERS and browser_sessions._is_connected(provider)),
            "useAuthenticated": provider_result.use_authenticated or preferences_enabled,
        })
        current_page = cursor.pages.get(provider, 1)
        if provider_result.state in {"error", "timeout", "login_required", "auth_expired_fallback"}:
            next_pages[provider] = current_page
        elif provider_result.has_more and current_page < MAX_CURSOR_PAGE:
            next_pages[provider] = current_page + 1
        else:
            next_pages[provider] = 0
        provider_more = provider_result.has_more and current_page < MAX_CURSOR_PAGE
        has_more = has_more or provider_more
        for item in provider_result.items:
            if not _within_range(item.get("publishedAt"), published_after):
                continue
            item_key = _result_key(provider, item.get("url"), str(item.get("providerId") or ""))
            output_items.append({
                **item,
                "key": item_key,
                "provider": provider,
                "providerTitle": PROVIDER_TITLES[provider],
            })

    for provider in ("tieba", "xiaoheihe", "zhihu", "weibo", "douyin", "bilibili", "kuaishou"):
        if provider not in selected:
            states.append({
                "provider": provider,
                "title": PROVIDER_TITLES[provider],
                "state": "not_selected",
                "message": "未选择该平台。",
                "connected": provider in AUTH_PROVIDERS and browser_sessions._is_connected(provider),
                "useAuthenticated": bool(preferences.get(provider, False)) if provider in AUTH_PROVIDERS else False,
            })

    seen = set(cursor.seen_keys)
    deduplicated: list[dict[str, Any]] = []
    current_keys: list[str] = []
    for item in output_items:
        item_key = str(item["key"])
        if item_key in seen:
            continue
        seen.add(item_key)
        current_keys.append(item_key)
        deduplicated.append(item)
    # 同一平台内新内容排前；平台分组次序由前端按状态栏平台顺序呈现。
    deduplicated.sort(
        key=lambda item: (
            ["local", "tieba", "xiaoheihe", "zhihu", "weibo", "douyin", "bilibili", "kuaishou"].index(
                str(item.get("provider"))
            ),
            -_sort_timestamp(item.get("publishedAt")),
        )
    )
    next_cursor = None
    if has_more:
        next_cursor = _encode_cursor(_SearchCursor(
            query_hash=query_hash,
            pages=next_pages,
            local_offset=next_local_offset,
            seen_keys=[*cursor.seen_keys, *current_keys][-700:],
        ))

    async def collect_video_comments(provider: str, video_item: dict[str, Any]) -> list[dict[str, Any]]:
        use_authenticated = bool(preferences.get(provider, False)) and browser_sessions._is_connected(provider)
        if use_authenticated:
            context = await browser_sessions.invisible_video_context(provider)
            try:
                return await video_topic_search.collect_video_comments(provider, video_item, context)
            finally:
                await context.close()
        browser = await browser_sessions._ensure_browser()
        context = await browser.new_context()
        try:
            return await video_topic_search.collect_video_comments(provider, video_item, context)
        finally:
            await context.close()

    comment_task_id = await video_comment_jobs.create(
        deduplicated,
        collect_video_comments,
        request_id=request_id,
    )
    return {
        "requestId": request_id,
        "query": clean_query,
        "items": deduplicated,
        "states": states,
        "nextCursor": next_cursor,
        "commentTaskId": comment_task_id,
    }


async def close() -> None:
    """关闭浏览器资源；持久登录配置保留在本机，供下次显式启用时使用。"""
    await video_comment_jobs.close()
    await browser_sessions.close()
