"""话题搜索平台的本地扫码授权适配器。"""

import asyncio
import base64
import json
import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from http.cookies import SimpleCookie
from typing import Any
from urllib.parse import parse_qs, quote, urljoin, urlparse

import httpx
from logger import logger
from services import storage

QR_TTL_SECONDS = 180
_QR_AUTH_LOG_MAX_BYTES = 256_000
_QR_AUTH_LOG_LOCK = threading.Lock()
_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)
_COOKIE_ALLOWLIST = {
    "tieba": {"BDUSS", "STOKEN", "PTOKEN"},
    "zhihu": {"z_c0", "_xsrf", "d_c0"},
    "weibo": {"SUB", "SUBP", "SSOLoginState", "ALF"},
}
_REQUIRED_COOKIE_NAMES = {
    "tieba": {"BDUSS"},
    "zhihu": {"z_c0"},
    "weibo": {"SUB", "SSOLoginState"},
}
_COOKIE_DOMAINS = {
    "tieba": ("baidu.com",),
    "zhihu": ("zhihu.com",),
    "weibo": ("weibo.com", "weibo.cn", "sina.com.cn"),
}
_PASSPORT_HOSTS = {
    "passport.baidu.com",
    "www.baidu.com",
    "passport.zhihu.com",
    "www.zhihu.com",
    "passport.weibo.com",
    "passport.weibo.cn",
    "weibo.com",
    "login.sina.com.cn",
}
# 百度扫码接口返回的二维码图片可能使用其他百度官方子域。
_PASSPORT_HOST_SUFFIXES = {"baidu.com"}


@dataclass
class _PendingLogin:
    provider: str
    client: httpx.AsyncClient
    created_at: float
    payload: dict[str, str]
    login_image: str
    poll_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class TopicSearchQrAuth:
    """只管理扫码过程；成功后把 Cookie 交给调用方导入本机浏览器配置。"""

    def __init__(self) -> None:
        self._pending: dict[str, _PendingLogin] = {}

    async def start(self, provider: str) -> dict[str, Any]:
        if provider not in _COOKIE_ALLOWLIST:
            raise ValueError("该平台不支持扫码授权")
        _log_qr_diagnostic("INFO", "event=start provider={}", provider)
        await self.cancel(provider)
        client = httpx.AsyncClient(
            headers={
                "User-Agent": _USER_AGENT,
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            },
            follow_redirects=False,
            timeout=httpx.Timeout(connect=8, read=12, write=8, pool=8),
        )
        try:
            if provider == "tieba":
                login = await self._start_tieba(client)
            elif provider == "zhihu":
                login = await self._start_zhihu(client)
            else:
                login = await self._start_weibo(client)
        except httpx.HTTPStatusError as exc:
            await client.aclose()
            _log_qr_diagnostic(
                "WARNING",
                "topic_search_qr event=start_failed provider={} reason=http_status http_status={}",
                provider,
                exc.response.status_code,
            )
            raise RuntimeError(_platform_http_error(provider, exc.response.status_code)) from None
        except httpx.HTTPError as exc:
            await client.aclose()
            _log_qr_diagnostic(
                "WARNING",
                "topic_search_qr event=start_failed provider={} reason=network_error error_type={}",
                provider,
                type(exc).__name__,
            )
            raise RuntimeError(f"{_provider_title(provider)}二维码接口暂时无法连接，请稍后重试。") from None
        except RuntimeError as exc:
            await client.aclose()
            _log_qr_diagnostic(
                "WARNING",
                "topic_search_qr event=start_failed provider={} reason=runtime_error error_type={}",
                provider,
                type(exc).__name__,
            )
            raise
        except BaseException:
            await client.aclose()
            raise
        login.client = client
        self._pending[provider] = login
        _log_qr_diagnostic(
            "INFO",
            "topic_search_qr event=start_succeeded provider={} ttl_seconds={}",
            provider,
            QR_TTL_SECONDS,
        )
        return {
            "provider": provider,
            "connected": False,
            "state": "connecting",
            "loginImage": login.login_image,
            "message": "请使用对应平台 App 扫描二维码，并在手机上确认登录。",
        }

    async def poll(self, provider: str) -> dict[str, Any]:
        login = self._pending.get(provider)
        if login is None:
            return {"state": "missing", "message": "没有待确认的二维码，请重新生成。", "cookies": []}
        async with login.poll_lock:
            if self._pending.get(provider) is not login:
                return {"state": "missing", "message": "扫码登录已取消，请重新生成。", "cookies": []}
            if time.monotonic() - login.created_at >= QR_TTL_SECONDS:
                await self._finish(provider, login)
                return {"state": "expired", "message": "二维码已过期，请重新生成。", "cookies": []}
            try:
                if provider == "tieba":
                    state, message = await self._poll_tieba(login)
                elif provider == "zhihu":
                    state, message = await self._poll_zhihu(login)
                else:
                    state, message = await self._poll_weibo(login)
            except httpx.HTTPStatusError as exc:
                status = exc.response.status_code
                await self._finish(provider, login)
                _log_qr_diagnostic(
                    "WARNING",
                    "topic_search_qr event=poll_failed provider={} reason=http_status http_status={}",
                    provider,
                    status,
                )
                raise RuntimeError(_platform_http_error(provider, status)) from None
            except httpx.HTTPError as exc:
                _log_qr_diagnostic(
                    "WARNING",
                    "topic_search_qr event=poll_retry provider={} reason=network_error error_type={}",
                    provider,
                    type(exc).__name__,
                )
                return {
                    "state": "connecting",
                    "message": "查询扫码状态时网络暂时不可用，TabKeep 会继续重试。",
                    "cookies": [],
                    "retryable": True,
                }
            except RuntimeError as exc:
                _log_qr_diagnostic(
                    "WARNING",
                    "topic_search_qr event=poll_failed provider={} reason=runtime_error error_type={}",
                    provider,
                    type(exc).__name__,
                )
                raise
            if state == "pending":
                return {"state": "connecting", "message": message, "cookies": []}
            if state == "expired":
                await self._finish(provider, login)
                return {"state": "expired", "message": message, "cookies": []}
            cookies = _export_cookies(provider, login.client)
            required = _REQUIRED_COOKIE_NAMES[provider]
            if not any(cookie["name"] in required for cookie in cookies):
                await self._finish(provider, login)
                raise RuntimeError(f"{_provider_title(provider)}确认了扫码，但没有返回可用的登录凭据；请重试。")
            await self._finish(provider, login)
            return {"state": "connected", "message": "扫码确认成功。", "cookies": cookies}

    async def cancel(self, provider: str) -> None:
        login = self._pending.get(provider)
        if login is None:
            return
        async with login.poll_lock:
            if self._pending.get(provider) is login:
                self._pending.pop(provider, None)
                await login.client.aclose()

    async def close(self) -> None:
        for provider in list(self._pending):
            await self.cancel(provider)

    async def _finish(self, provider: str, login: _PendingLogin) -> None:
        if self._pending.get(provider) is login:
            self._pending.pop(provider, None)
        await login.client.aclose()

    async def _start_tieba(self, client: httpx.AsyncClient) -> _PendingLogin:
        now = int(time.time() * 1000)
        gid = str(uuid.uuid4()).upper()
        callback = f"tangram_guid_{now + 1}"
        await _get_platform(
            client,
            "https://www.baidu.com/",
            timeout=8,
            provider="tieba",
            stage="tieba_bootstrap",
        )
        response = await _get_platform(
            client,
            "https://passport.baidu.com/v2/api/getqrcode",
            params={
                "lp": "pc",
                "qrloginfrom": "pc",
                "gid": gid,
                "callback": f"tangram_guid_{now}",
                "apiver": "v3",
                "tt": now,
                "tpl": "mn",
                "_": now,
            },
            provider="tieba",
            stage="tieba_qr_create",
        )
        response.raise_for_status()
        data = _read_json_or_jsonp(response.text)
        sign = str(data.get("sign") or "").strip()
        image_url = str(data.get("imgurl") or "").replace("\\", "").strip()
        if not sign or not image_url:
            raise RuntimeError("贴吧没有返回有效的登录二维码；平台登录接口可能已变化。")
        image_url = _normalize_tieba_qr_image_url(image_url)
        image = await _download_image_data_url(client, image_url, provider="tieba")
        now = int(time.time() * 1000)
        return _PendingLogin(
            provider="tieba",
            client=client,
            created_at=time.monotonic(),
            payload={
                "sign": sign,
                "gid": gid,
                "callback": callback,
                "loginTime": str(now),
            },
            login_image=image,
        )

    async def _poll_tieba(self, login: _PendingLogin) -> tuple[str, str]:
        now = int(time.time() * 1000)
        response = await _get_platform(
            login.client,
            "https://passport.baidu.com/channel/unicast",
            params={
                "channel_id": login.payload["sign"],
                "tpl": "mn",
                "gid": login.payload["gid"],
                "callback": login.payload["callback"],
                "apiver": "v3",
                "tt": now,
                "_": now + 2,
            },
            headers={"Referer": "https://www.baidu.com/"},
            timeout=httpx.Timeout(connect=8, read=32, write=8, pool=8),
            provider="tieba",
            stage="tieba_qr_poll",
        )
        response.raise_for_status()
        data = _read_json_or_jsonp(response.text)
        errno = str(data.get("errno", "-1"))
        if errno == "1":
            return "pending", "等待使用百度 App 扫码。"
        if errno != "0":
            return "expired", "贴吧二维码已失效，请重新生成。"
        channel = _read_tieba_channel(data.get("channel_v"))
        if channel is None:
            return "expired", "贴吧二维码状态响应无法识别，请重新生成。"
        status = str(channel.get("status", "-1"))
        if status == "1":
            return "pending", "已扫码，请在手机上确认登录。"
        if status != "0":
            return "expired", "贴吧二维码已失效，请重新生成。"
        temporary_bduss = str(channel.get("v") or "")
        if not temporary_bduss:
            raise RuntimeError("贴吧扫码确认响应缺少临时凭据；平台登录接口可能已变化。")
        await self._exchange_tieba_cookie(login, temporary_bduss)
        return "connected", "贴吧扫码确认成功。"

    async def _exchange_tieba_cookie(self, login: _PendingLogin, temporary_bduss: str) -> None:
        now = int(time.time() * 1000)
        params = {
            "v": str(now),
            "u": "https://tieba.baidu.com/index.html",
            "loginVersion": "v4",
            "qrcode": "1",
            "tpl": "mn",
            "apiver": "v3",
            "bduss": temporary_bduss,
            "time": str(int(time.time())),
            "alg": "v3",
            "tt": str(now),
            "elapsed": "18",
            "shaOne": "0011f17de7b0a1b99aa70a6f1ea881c14d404379",
            "sig": "SXFidmJBL3NzS0lNaERoL1pzckVxaFdSS0lrSDQ5SUNPWFdjUDRhVE5rZkVOMEpzN2FpZExBTDRFejEwOFBvdw==",
            "callback": "bd__cbs__tabkeep",
        }
        response = await _get_platform(
            login.client,
            "https://passport.baidu.com/v3/login/main/qrbdusslogin",
            params=params,
            headers={"Referer": "https://tieba.baidu.com/"},
            provider="tieba",
            stage="tieba_cookie_exchange",
        )
        response.raise_for_status()

    async def _start_zhihu(self, client: httpx.AsyncClient) -> _PendingLogin:
        landing = await _get_platform(
            client,
            "https://www.zhihu.com/signin",
            provider="zhihu",
            stage="zhihu_landing",
        )
        xsrf = client.cookies.get("_xsrf", "")
        try:
            prewarm = await client.post(
                "https://www.zhihu.com/udid",
                json={},
                headers={
                    "Referer": "https://www.zhihu.com/signin",
                    "Content-Type": "application/json;charset=UTF-8",
                    "x-requested-with": "fetch",
                    **({"x-xsrftoken": xsrf} if xsrf else {}),
                },
            )
        except httpx.HTTPError as exc:
            _log_qr_network_error("zhihu", "zhihu_udid_prewarm", exc)
            raise
        _log_qr_http_error("zhihu", "zhihu_udid_prewarm", prewarm)
        prewarm.raise_for_status()
        xsrf = client.cookies.get("_xsrf", xsrf)
        try:
            response = await client.post(
                "https://www.zhihu.com/api/v3/account/api/login/qrcode",
                json={},
                headers={
                    "Referer": "https://www.zhihu.com/signin",
                    "Content-Type": "application/json;charset=UTF-8",
                    "x-requested-with": "fetch",
                    **({"x-xsrftoken": xsrf} if xsrf else {}),
                },
            )
        except httpx.HTTPError as exc:
            _log_qr_network_error("zhihu", "zhihu_qr_create", exc)
            raise
        _log_qr_http_error("zhihu", "zhihu_qr_create", response)
        if response.status_code == 403:
            raise RuntimeError("知乎当前拒绝二维码登录请求（HTTP 403）。平台接口暂不可用，TabKeep 不会绕过限制。")
        response.raise_for_status()
        try:
            data = response.json()
        except ValueError as exc:
            raise RuntimeError("知乎二维码登录接口返回格式无法识别。") from exc
        token = str(data.get("token") or "").strip()
        link = str(data.get("link") or "").strip()
        if not token or not link:
            raise RuntimeError("知乎没有返回有效的登录二维码；平台登录接口可能已变化。")
        link = _safe_platform_url(link, provider="zhihu", stage="zhihu_qr_link")
        return _PendingLogin(
            provider="zhihu",
            client=client,
            created_at=time.monotonic(),
            payload={"token": token},
            login_image=_qr_data_url(link),
        )

    async def _poll_zhihu(self, login: _PendingLogin) -> tuple[str, str]:
        response = await _get_platform(
            login.client,
            f"https://www.zhihu.com/api/v3/account/api/login/qrcode/{quote(login.payload['token'], safe='')}/scan_info",
            headers={
                "Referer": "https://www.zhihu.com/signin",
                "x-requested-with": "fetch",
                "x-zse-93": "101_3_3.0",
            },
            provider="zhihu",
            stage="zhihu_qr_poll",
        )
        if response.status_code == 403:
            raise RuntimeError("知乎当前拒绝二维码状态查询（HTTP 403）。请稍后重试；TabKeep 不会绕过限制。")
        response.raise_for_status()
        try:
            data = response.json()
        except ValueError as exc:
            raise RuntimeError("知乎二维码状态响应格式无法识别。") from exc
        status = str(data.get("login_status") or "").upper()
        if status in {"EXPIRED", "CANCELED", "CANCELLED"}:
            return "expired", "知乎二维码已过期，请重新生成。"
        if status in {"CONFIRMED", "SUCCESS", "LOGGED_IN"}:
            raw_cookie = str(data.get("cookie") or "")
            cookie = SimpleCookie()
            try:
                cookie.load(raw_cookie)
            except Exception:
                cookie = SimpleCookie()
            z_cookie = cookie.get("z_c0")
            if z_cookie is None:
                candidate = raw_cookie.split(";", 1)[0]
                if candidate.startswith("z_c0="):
                    value = candidate.partition("=")[2]
                else:
                    value = ""
            else:
                value = z_cookie.value
            if not value:
                raise RuntimeError("知乎确认了扫码，但没有返回 z_c0 登录凭据。")
            login.client.cookies.set("z_c0", value, domain=".zhihu.com", path="/")
            return "connected", "知乎扫码确认成功。"
        if status in {"SCANED", "SCANNED", "WAITING_CONFIRM"}:
            return "pending", "已扫码，请在手机上确认登录。"
        if status in {"WAITING", "PENDING", ""}:
            return "pending", "等待使用知乎 App 扫码。"
        return "pending", "知乎正在处理扫码请求。"

    async def _start_weibo(self, client: httpx.AsyncClient) -> _PendingLogin:
        response = await _get_platform(
            client,
            "https://passport.weibo.com/sso/signin",
            params={"entry": "miniblog", "source": "miniblog", "url": "https://weibo.com/"},
            headers={"Referer": "https://weibo.com/"},
            provider="weibo",
            stage="weibo_landing",
        )
        response.raise_for_status()
        csrf = client.cookies.get("X-CSRF-TOKEN", "")
        if not csrf:
            raise RuntimeError("微博登录页未提供扫码所需会话信息；请稍后重试。")
        client.headers["x-csrf-token"] = csrf
        response = await _get_platform(
            client,
            "https://passport.weibo.com/sso/v2/qrcode/image",
            params={"entry": "miniblog", "size": "180"},
            headers={"Referer": str(response.url)},
            provider="weibo",
            stage="weibo_qr_create",
        )
        response.raise_for_status()
        data = _read_json(response)
        if str(data.get("retcode")) != "20000000":
            raise RuntimeError("微博没有生成有效的登录二维码；平台登录接口可能已变化。")
        body = data.get("data") if isinstance(data.get("data"), dict) else {}
        qrid = str(body.get("qrid") or "").strip()
        image_url = str(body.get("image") or "").strip()
        if not qrid or not image_url:
            raise RuntimeError("微博登录接口没有返回二维码信息。")
        parsed = urlparse(image_url)
        scan_url = parse_qs(parsed.query).get("data", [""])[0]
        if not scan_url:
            scan_url = f"https://passport.weibo.cn/signin/qrcode/scan?qr={quote(qrid, safe='')}"
        scan_url = _safe_platform_url(scan_url, provider="weibo", stage="weibo_qr_scan_url")
        return _PendingLogin(
            provider="weibo",
            client=client,
            created_at=time.monotonic(),
            payload={"qrid": qrid},
            login_image=_qr_data_url(scan_url),
        )

    async def _poll_weibo(self, login: _PendingLogin) -> tuple[str, str]:
        now = int(time.time() * 1000)
        response = await _get_platform(
            login.client,
            "https://passport.weibo.com/sso/v2/qrcode/check",
            params={
                "entry": "miniblog",
                "source": "miniblog",
                "url": "https://weibo.com/",
                "qrid": login.payload["qrid"],
                "rid": "",
                "ver": "20250520",
                "_": now,
            },
            headers={"Referer": "https://passport.weibo.com/sso/signin"},
            provider="weibo",
            stage="weibo_qr_poll",
        )
        response.raise_for_status()
        data = _read_json(response)
        retcode = str(data.get("retcode") or "")
        if retcode == "50114001":
            return "pending", "等待使用微博 App 扫码。"
        if retcode == "50114002":
            return "pending", "已扫码，请在手机上确认登录。"
        if retcode == "50114004":
            return "expired", "微博二维码已过期，请重新生成。"
        if retcode != "20000000":
            raise RuntimeError("微博二维码状态查询失败；平台登录接口可能已变化。")
        body = data.get("data") if isinstance(data.get("data"), dict) else {}
        await self._follow_weibo_login(login, body)
        return "connected", "微博扫码确认成功。"

    async def _follow_weibo_login(self, login: _PendingLogin, data: dict[str, Any]) -> None:
        cross_url = str(data.get("url") or "").strip()
        alt = str(data.get("alt") or "").strip()
        if cross_url:
            await _get_platform(
                login.client,
                cross_url,
                headers={"Referer": "https://passport.weibo.com/"},
                provider="weibo",
                stage="weibo_cross_domain_login",
            )
        if alt and not _has_required_cookie("weibo", login.client):
            response = await _get_platform(
                login.client,
                "https://login.sina.com.cn/sso/login.php",
                params={"entry": "miniblog", "alt": alt, "returntype": "TEXT"},
                headers={"Referer": "https://passport.weibo.com/"},
                provider="weibo",
                stage="weibo_sina_cookie_exchange",
            )
            response.raise_for_status()


def _read_json(response: httpx.Response) -> dict[str, Any]:
    try:
        value = response.json()
    except ValueError as exc:
        raise RuntimeError("平台扫码接口返回了无法识别的数据。") from exc
    if not isinstance(value, dict):
        raise RuntimeError("平台扫码接口返回格式无法识别。")
    return value


def _read_json_or_jsonp(value: str) -> dict[str, Any]:
    text = value.strip()
    try:
        parsed = json.loads(text)
    except ValueError:
        match = re.search(r"\(\s*(\{.*\})\s*\)\s*;?\s*$", text, re.DOTALL)
        if match is None:
            raise RuntimeError("贴吧扫码接口返回格式无法识别。") from None
        try:
            parsed = json.loads(match.group(1))
        except ValueError as exc:
            raise RuntimeError("贴吧扫码状态响应格式无法识别。") from exc
    if not isinstance(parsed, dict):
        raise RuntimeError("贴吧扫码接口返回格式无法识别。")
    return parsed


def _read_tieba_channel(value: Any) -> dict[str, Any] | None:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return None
    return value if isinstance(value, dict) else None


def _normalize_tieba_qr_image_url(value: str) -> str:
    image_url = value.strip()
    parsed = urlparse(image_url)
    if parsed.scheme.casefold() in {"http", "https"}:
        candidate = parsed._replace(scheme=parsed.scheme.casefold()).geturl()
    elif image_url.startswith("//"):
        candidate = f"https:{image_url}"
    elif image_url.startswith("/"):
        candidate = urljoin("https://passport.baidu.com/", image_url)
    else:
        # 百度接口常返回 passport.baidu.com/... 这种没有协议的主机名。
        candidate = f"https://{image_url}"
    return _safe_platform_url(
        candidate,
        provider="tieba",
        stage="tieba_qr_image_url",
    )


def _log_qr_diagnostic(level: str, message: str, *values: object) -> None:
    timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    line = f"topic_search_qr timestamp_utc={timestamp} {message.format(*values)}"
    logger.log(level, line)
    try:
        log_dir = storage.DATA_DIR / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        log_path = log_dir / "topic-search-auth.log"
        with _QR_AUTH_LOG_LOCK:
            if log_path.exists() and log_path.stat().st_size >= _QR_AUTH_LOG_MAX_BYTES:
                backup = log_dir / "topic-search-auth.log.1"
                backup.unlink(missing_ok=True)
                log_path.replace(backup)
            with log_path.open("a", encoding="utf-8", newline="\n") as handle:
                handle.write(line + "\n")
    except OSError as exc:
        logger.warning(
            "topic_search_qr event=diagnostic_file_write_failed error_type={}",
            type(exc).__name__,
        )


def _log_qr_http_error(provider: str, stage: str, response: httpx.Response) -> None:
    if response.status_code >= 400:
        _log_qr_diagnostic(
            "WARNING",
            "topic_search_qr event=request_failed provider={} stage={} reason=http_status http_status={}",
            provider,
            stage,
            response.status_code,
        )


def _log_qr_network_error(provider: str, stage: str, error: httpx.HTTPError) -> None:
    _log_qr_diagnostic(
        "WARNING",
        "topic_search_qr event=request_failed provider={} stage={} reason=network_error error_type={}",
        provider,
        stage,
        type(error).__name__,
    )


def _log_qr_rejected_url(
    provider: str,
    stage: str,
    reason: str,
    scheme: str,
    host: str,
    port: str,
) -> None:
    safe_host = host if len(host) <= 253 and re.fullmatch(r"[a-z0-9.-]+", host) else "invalid"
    if not host:
        safe_host = "missing"
    _log_qr_diagnostic(
        "WARNING",
        "topic_search_qr event=url_rejected provider={} stage={} reason={} scheme={} host={} port={}",
        provider,
        stage,
        reason,
        scheme or "missing",
        safe_host,
        port,
    )


def _safe_platform_url(value: str, *, provider: str, stage: str) -> str:
    candidate = value if value.startswith(("https://", "http://")) else "https:" + value
    parsed = urlparse(candidate)
    host = (parsed.hostname or "").casefold()
    host_is_allowed = host in _PASSPORT_HOSTS or any(
        host == suffix or host.endswith(f".{suffix}")
        for suffix in _PASSPORT_HOST_SUFFIXES
    )
    try:
        port = parsed.port
    except ValueError as exc:
        _log_qr_rejected_url(provider, stage, "invalid_port", parsed.scheme, host, "invalid")
        raise RuntimeError(
            f"平台返回了不受支持的登录地址（主机：{host or '未知'}，端口格式无效），已停止请求。"
        ) from exc
    rejection_reason = ""
    if parsed.scheme not in {"https", "http"}:
        rejection_reason = "unsupported_scheme"
    elif not host:
        rejection_reason = "missing_host"
    elif not host_is_allowed:
        rejection_reason = "host_not_allowed"
    elif parsed.username is not None or parsed.password is not None:
        rejection_reason = "userinfo_not_allowed"
    elif port not in {None, 443}:
        rejection_reason = "port_not_allowed"
    if rejection_reason:
        port_label = str(port) if port is not None else "默认"
        _log_qr_rejected_url(provider, stage, rejection_reason, parsed.scheme, host, port_label)
        raise RuntimeError(
            f"平台返回了不受支持的登录地址（主机：{host or '未知'}，端口：{port_label}），已停止请求。"
        )
    # Some legacy QR endpoints still return http URLs. Upgrade only an allowlisted
    # platform hostname to HTTPS; never send a login token over cleartext HTTP.
    if parsed.scheme == "http":
        candidate = parsed._replace(scheme="https").geturl()
    return candidate


async def _get_platform(
    client: httpx.AsyncClient,
    url: str,
    params: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    timeout: float | httpx.Timeout | None = None,
    *,
    provider: str,
    stage: str,
) -> httpx.Response:
    current_url = _safe_platform_url(url, provider=provider, stage=stage)
    current_params = params
    for _ in range(6):
        try:
            response = await client.get(
                current_url,
                params=current_params,
                headers=headers,
                timeout=timeout,
                follow_redirects=False,
            )
        except httpx.HTTPError as exc:
            _log_qr_network_error(provider, stage, exc)
            raise
        _log_qr_http_error(provider, stage, response)
        if response.is_redirect:
            location = response.headers.get("location")
            await response.aclose()
            if not location:
                _log_qr_diagnostic(
                    "WARNING",
                    "topic_search_qr event=request_failed provider={} stage={} reason=redirect_without_location",
                    provider,
                    stage,
                )
                raise RuntimeError("平台登录接口返回了无效跳转。")
            current_url = _safe_platform_url(
                urljoin(current_url, location),
                provider=provider,
                stage=f"{stage}_redirect",
            )
            current_params = None
            continue
        response.raise_for_status()
        return response
    _log_qr_diagnostic(
        "WARNING",
        "topic_search_qr event=request_failed provider={} stage={} reason=redirect_limit",
        provider,
        stage,
    )
    raise RuntimeError("平台登录接口跳转次数过多，已停止请求。")


async def _download_image_data_url(client: httpx.AsyncClient, url: str, *, provider: str) -> str:
    response = await _get_platform(
        client,
        url,
        provider=provider,
        stage=f"{provider}_qr_image_download",
    )
    _safe_platform_url(
        str(response.url),
        provider=provider,
        stage=f"{provider}_qr_image_response_url",
    )
    content_type = response.headers.get("content-type", "").split(";", 1)[0].strip().casefold()
    if not content_type.startswith("image/") or len(response.content) > 2_000_000:
        raise RuntimeError("贴吧二维码图片响应无效。")
    encoded = base64.b64encode(response.content).decode("ascii")
    return f"data:{content_type};base64,{encoded}"


def _qr_data_url(value: str) -> str:
    try:
        import qrcode
    except ImportError as exc:
        raise RuntimeError("二维码组件未安装，请安装后端依赖后重试。") from exc
    from io import BytesIO

    image = qrcode.make(value)
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def _export_cookies(provider: str, client: httpx.AsyncClient) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for cookie in client.cookies.jar:
        domain = str(cookie.domain or "").casefold()
        if cookie.name not in _COOKIE_ALLOWLIST[provider]:
            continue
        if not any(domain.lstrip(".") == allowed or domain.lstrip(".").endswith("." + allowed) for allowed in _COOKIE_DOMAINS[provider]):
            continue
        if not cookie.value:
            continue
        item: dict[str, Any] = {
            "name": cookie.name,
            "value": cookie.value,
            "domain": domain if domain.startswith(".") else "." + domain,
            "path": cookie.path or "/",
            "secure": bool(cookie.secure),
            "httpOnly": bool(cookie.has_nonstandard_attr("HttpOnly")),
        }
        if cookie.expires is not None:
            item["expires"] = float(cookie.expires)
        result.append(item)
    return result


def _has_required_cookie(provider: str, client: httpx.AsyncClient) -> bool:
    names = {cookie.name for cookie in client.cookies.jar}
    return bool(names & _REQUIRED_COOKIE_NAMES[provider])


def _provider_title(provider: str) -> str:
    return {"tieba": "贴吧", "zhihu": "知乎", "weibo": "微博"}.get(provider, "平台")


def _platform_http_error(provider: str, status: int) -> str:
    if status == 403:
        return f"{_provider_title(provider)}当前拒绝二维码授权请求（HTTP 403）。请稍后重试；TabKeep 不会绕过平台限制。"
    if status == 429:
        return f"{_provider_title(provider)}扫码请求过于频繁（HTTP 429），请稍后重试。"
    return f"{_provider_title(provider)}扫码接口暂不可用（HTTP {status}）；平台登录接口可能已变化。"


qr_auth = TopicSearchQrAuth()
