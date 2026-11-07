"""小黑盒扫码登录、凭据存储和只读话题采集。"""

import asyncio
import base64
import ctypes
import hashlib
import json
import secrets
import time
from collections.abc import Mapping
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timezone
from typing import Any, Protocol
from urllib.parse import parse_qsl, urlencode, urlsplit

import httpx

from services.news import xiaoheihe, xiaoheihe_auth_signing

QR_CREATE_PATH = "/account/get_qrcode_url/"
QR_STATE_PATH = "/account/qr_state/"
CURRENT_USER_PATH = "/bbs/app/api/user/permission"
TOPICS_PATH = "/bbs/app/api/topic/index/"
TOPIC_FEEDS_PATH = "/bbs/app/topic/feeds"
QR_TTL_SECONDS = 180
MAX_TOPICS = 20
MAX_TOPIC_ITEMS = 20
_CREDENTIAL_TARGET = "TabKeep/Xiaoheihe/manifest"
_CREDENTIAL_CHUNK_PREFIX = "TabKeep/Xiaoheihe/"
_CREDENTIAL_CHUNK_BYTES = 1800
_MAX_CREDENTIAL_BYTES = 512_000
_WEB_CLIENT_PARAMS = {
    "os_type": "web",
    "app": "web",
    "client_type": "web",
    "version": "999.0.4",
    "web_version": "2.5",
    "x_client_type": "web",
    "x_app": "heybox_website",
    "x_os_type": "Windows",
    "device_info": "Chrome",
    "_notip": "true",
}


class XiaoheiheAuthError(RuntimeError):
    """登录凭据失效或小黑盒响应不符合当前契约。"""


class XiaoheiheCredentialsExpiredError(XiaoheiheAuthError):
    """小黑盒拒绝了当前账号凭据。"""


class XiaoheiheNotLoggedInError(XiaoheiheAuthError):
    """本机尚未保存小黑盒登录凭据。"""


class CredentialVault(Protocol):
    def save(self, credentials: "XiaoheiheCredentials") -> None: ...

    def load(self) -> "XiaoheiheCredentials | None": ...

    def delete(self) -> None: ...


@dataclass(frozen=True)
class XiaoheiheCredentials:
    uid: str
    nickname: str
    cookies: dict[str, str]
    access_token: str
    refresh_token: str
    device_id: str
    signing_key: str
    logged_in_at: str

    def to_dict(self) -> dict[str, object]:
        return asdict(self)

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "XiaoheiheCredentials":
        cookies = value.get("cookies")
        uid = str(value.get("uid") or "").strip()
        normalized_cookies = (
            {str(key): str(cookie) for key, cookie in cookies.items()}
            if isinstance(cookies, Mapping)
            else {}
        )
        access_token = str(value.get("access_token") or "")
        refresh_token = str(value.get("refresh_token") or "")
        if not uid or not (access_token or refresh_token or _has_auth_cookie(normalized_cookies)):
            raise ValueError("小黑盒登录凭据不完整")
        return cls(
            uid=uid,
            nickname=str(value.get("nickname") or ""),
            cookies=normalized_cookies,
            access_token=access_token,
            refresh_token=refresh_token,
            device_id=str(value.get("device_id") or ""),
            signing_key=str(value.get("signing_key") or ""),
            logged_in_at=str(value.get("logged_in_at") or ""),
        )


class WindowsCredentialVault:
    """通过 Windows Credential Manager 保存受当前 Windows 用户保护的凭据。"""

    def save(self, credentials: XiaoheiheCredentials) -> None:
        _require_windows()
        payload = json.dumps(credentials.to_dict(), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(payload) > _MAX_CREDENTIAL_BYTES:
            raise ValueError("小黑盒登录凭据超过本地安全存储上限")
        version = secrets.token_hex(16)
        chunks = [
            payload[index : index + _CREDENTIAL_CHUNK_BYTES]
            for index in range(0, len(payload), _CREDENTIAL_CHUNK_BYTES)
        ]
        targets = [f"{_CREDENTIAL_CHUNK_PREFIX}{version}/{index}" for index in range(len(chunks))]
        old_manifest = self._read_blob(_CREDENTIAL_TARGET)
        old_version = self._manifest_version(old_manifest)
        written: list[str] = []
        try:
            for target, chunk in zip(targets, chunks, strict=True):
                self._write_blob(target, chunk)
                written.append(target)
            manifest = json.dumps(
                {
                    "version": version,
                    "chunks": len(chunks),
                    "sha256": hashlib.sha256(payload).hexdigest(),
                },
                separators=(",", ":"),
            ).encode("ascii")
            self._write_blob(_CREDENTIAL_TARGET, manifest)
        except Exception:
            for target in written:
                self._delete_blob(target)
            raise
        if old_version and old_version != version:
            self._delete_version(old_version)

    def load(self) -> XiaoheiheCredentials | None:
        _require_windows()
        manifest_bytes = self._read_blob(_CREDENTIAL_TARGET)
        if manifest_bytes is None:
            return None
        version, chunk_count, expected_hash = self._parse_manifest(manifest_bytes)
        if not version or chunk_count < 1 or chunk_count > 300:
            raise ValueError("小黑盒安全凭据索引无效")
        chunks: list[bytes] = []
        for index in range(chunk_count):
            chunk = self._read_blob(f"{_CREDENTIAL_CHUNK_PREFIX}{version}/{index}")
            if chunk is None:
                raise ValueError("小黑盒安全凭据不完整")
            chunks.append(chunk)
        payload = b"".join(chunks)
        if len(payload) > _MAX_CREDENTIAL_BYTES or hashlib.sha256(payload).hexdigest() != expected_hash:
            raise ValueError("小黑盒安全凭据校验失败")
        value = json.loads(payload.decode("utf-8"))
        if not isinstance(value, Mapping):
            raise ValueError("小黑盒安全凭据格式无效")
        return XiaoheiheCredentials.from_dict(value)

    def delete(self) -> None:
        _require_windows()
        manifest = self._read_blob(_CREDENTIAL_TARGET)
        version = self._manifest_version(manifest)
        self._delete_blob(_CREDENTIAL_TARGET)
        if version:
            self._delete_version(version)

    def _delete_version(self, version: str) -> None:
        for index in range(300):
            target = f"{_CREDENTIAL_CHUNK_PREFIX}{version}/{index}"
            if not self._delete_blob(target):
                break

    @staticmethod
    def _manifest_version(value: bytes | None) -> str | None:
        if value is None:
            return None
        try:
            parsed = json.loads(value.decode("utf-8"))
            version = parsed.get("version") if isinstance(parsed, dict) else None
            return str(version) if version else None
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None

    @staticmethod
    def _parse_manifest(value: bytes) -> tuple[str, int, str]:
        try:
            parsed = json.loads(value.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("小黑盒安全凭据索引损坏") from error
        if not isinstance(parsed, dict):
            raise ValueError("小黑盒安全凭据索引无效")
        try:
            return str(parsed["version"]), int(parsed["chunks"]), str(parsed["sha256"])
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError("小黑盒安全凭据索引无效") from error

    @staticmethod
    def _credential_api() -> tuple[Any, Any, Any, Any]:
        _require_windows()
        advapi32 = ctypes.WinDLL("Advapi32.dll", use_last_error=True)
        advapi32.CredWriteW.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        advapi32.CredWriteW.restype = ctypes.c_int
        advapi32.CredReadW.argtypes = [ctypes.c_wchar_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.POINTER(ctypes.c_void_p)]
        advapi32.CredReadW.restype = ctypes.c_int
        advapi32.CredDeleteW.argtypes = [ctypes.c_wchar_p, ctypes.c_ulong, ctypes.c_ulong]
        advapi32.CredDeleteW.restype = ctypes.c_int
        advapi32.CredFree.argtypes = [ctypes.c_void_p]
        advapi32.CredFree.restype = None
        return advapi32.CredWriteW, advapi32.CredReadW, advapi32.CredDeleteW, advapi32.CredFree

    def _write_blob(self, target: str, payload: bytes) -> None:
        write_credential, _, _, _ = self._credential_api()
        credential = _WindowsCredential()
        blob = ctypes.create_string_buffer(payload)
        credential.Type = 1  # CRED_TYPE_GENERIC
        credential.TargetName = target
        credential.CredentialBlobSize = len(payload)
        credential.CredentialBlob = ctypes.cast(blob, ctypes.POINTER(ctypes.c_ubyte))
        credential.Persist = 2  # CRED_PERSIST_LOCAL_MACHINE
        if not write_credential(ctypes.byref(credential), 0):
            raise ctypes.WinError(ctypes.get_last_error())

    def _read_blob(self, target: str) -> bytes | None:
        _, read_credential, _, free_credential = self._credential_api()
        credential_ptr = ctypes.c_void_p()
        if not read_credential(target, 1, 0, ctypes.byref(credential_ptr)):
            error_code = ctypes.get_last_error()
            if error_code == 1168:  # ERROR_NOT_FOUND
                return None
            raise ctypes.WinError(error_code)
        try:
            credential = ctypes.cast(credential_ptr, ctypes.POINTER(_WindowsCredential)).contents
            return ctypes.string_at(credential.CredentialBlob, credential.CredentialBlobSize)
        finally:
            free_credential(credential_ptr)

    def _delete_blob(self, target: str) -> bool:
        _, _, delete_credential, _ = self._credential_api()
        if delete_credential(target, 1, 0):
            return True
        error_code = ctypes.get_last_error()
        if error_code == 1168:  # ERROR_NOT_FOUND
            return False
        raise ctypes.WinError(error_code)


class _WindowsFileTime(ctypes.Structure):
    _fields_ = [("dwLowDateTime", ctypes.c_ulong), ("dwHighDateTime", ctypes.c_ulong)]


class _WindowsCredential(ctypes.Structure):
    _fields_ = [
        ("Flags", ctypes.c_ulong),
        ("Type", ctypes.c_ulong),
        ("TargetName", ctypes.c_wchar_p),
        ("Comment", ctypes.c_wchar_p),
        ("LastWritten", _WindowsFileTime),
        ("CredentialBlobSize", ctypes.c_ulong),
        ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)),
        ("Persist", ctypes.c_ulong),
        ("AttributeCount", ctypes.c_ulong),
        ("Attributes", ctypes.c_void_p),
        ("TargetAlias", ctypes.c_wchar_p),
        ("UserName", ctypes.c_wchar_p),
    ]


@dataclass
class _PendingLogin:
    login_id: str
    qr_content: str
    qr_image: str
    expires_at: float
    poll_params: dict[str, str]
    device_id: str
    client: httpx.AsyncClient
    state: str = "waiting_scan"
    message: str = "请使用小黑盒客户端扫码并确认"
    uid: str = ""
    nickname: str = ""
    lock: asyncio.Lock | None = None
    closed: bool = False


class XiaoheiheAuthService:
    def __init__(self, vault: CredentialVault | None = None) -> None:
        self._vault = vault or WindowsCredentialVault()
        self._pending: dict[str, _PendingLogin] = {}
        self._lock = asyncio.Lock()
        self._request_lock = asyncio.Lock()
        self._last_authenticated_request = 0.0

    async def create_qr(self) -> dict[str, object]:
        await self._expire_sessions()
        client = httpx.AsyncClient(timeout=20, follow_redirects=False)
        device_id = secrets.token_hex(16)
        try:
            qr_url = f"{xiaoheihe.API_BASE_URL}{QR_CREATE_PATH}?{urlencode(_WEB_CLIENT_PARAMS)}"
            payload = await _auth_request_json(client, qr_url, device_id)
            body = _response_body(payload)
            qr_content = _first_text(body, "qrcode", "qr_url", "url", "qr_content")
            if not qr_content or len(qr_content) > 4096:
                raise XiaoheiheAuthError("小黑盒未返回有效的登录二维码")
            poll_params = dict(parse_qsl(urlsplit(qr_content).query, keep_blank_values=True))
            request_id = _first_text(body, "request_id", "qr_id", "token", "nonce")
            if request_id and not poll_params:
                poll_params["request_id"] = request_id
            if not poll_params:
                request_id = request_id or hashlib.sha256(qr_content.encode("utf-8")).hexdigest()[:32]
                poll_params["request_id"] = request_id
            expires_at = _expiry_time(body)
            login_id = secrets.token_urlsafe(24)
            session = _PendingLogin(
                login_id=login_id,
                qr_content=qr_content,
                qr_image=_qr_data_url(qr_content),
                expires_at=expires_at,
                poll_params=poll_params,
                device_id=device_id,
                client=client,
                lock=asyncio.Lock(),
            )
            async with self._lock:
                for old in self._pending.values():
                    if old.state in {"waiting_scan", "scanned_waiting_confirmation"}:
                        old.state = "cancelled"
                        old.message = "已生成新的登录二维码"
                        await self._close_pending(old)
                self._pending[login_id] = session
            return self._public_pending(session)
        except Exception:
            await client.aclose()
            raise

    async def check_qr(self, login_id: str) -> dict[str, object]:
        session = self._pending.get(login_id)
        if session is None:
            return {
                "loginId": login_id,
                "state": "expired",
                "message": "二维码已失效，请重新生成",
                "expiresAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
                "qrImage": None,
                "uid": None,
                "nickname": None,
            }
        if session.lock is None:
            session.lock = asyncio.Lock()
        async with session.lock:
            if session.state not in {"waiting_scan", "scanned_waiting_confirmation"}:
                return self._public_pending(session)
            if time.time() >= session.expires_at:
                session.state = "expired"
                session.message = "二维码已过期，请重新生成"
                await self._close_pending(session)
                return self._public_pending(session)
            try:
                poll_params = {**_WEB_CLIENT_PARAMS, **session.poll_params}
                poll_url = f"{xiaoheihe.API_BASE_URL}{QR_STATE_PATH}?{urlencode(poll_params)}"
                payload = await _auth_request_json(session.client, poll_url, session.device_id)
                state, message = _parse_login_state(payload)
                session.state = state
                session.message = message or _state_message(state)
                if state == "success":
                    credentials = _parse_credentials(
                        payload, session.client, fallback_device_id=session.device_id
                    )
                    await _verify_credentials(credentials)
                    self._vault.save(credentials)
                    session.uid = credentials.uid
                    session.nickname = credentials.nickname
                    await self._close_pending(session)
                elif state in {"expired", "failed", "cancelled"}:
                    await self._close_pending(session)
            except httpx.HTTPStatusError as error:
                if error.response.status_code in {401, 403}:
                    session.state = "failed"
                    session.message = "小黑盒未接受这次登录，请重新生成二维码"
                    await self._close_pending(session)
                elif session.state == "success":
                    session.state = "failed"
                    session.message = "无法验证小黑盒登录信息，请重新扫码"
                    await self._close_pending(session)
                else:
                    session.message = "暂时无法检查扫码状态，请稍后重试"
            except (httpx.HTTPError, XiaoheiheAuthError, ValueError, OSError):
                if session.state == "success":
                    session.state = "failed"
                    session.message = "无法验证或安全保存小黑盒登录信息，请重新扫码"
                    await self._close_pending(session)
                    return self._public_pending(session)
                session.message = "暂时无法检查扫码状态，请稍后重试"
            except Exception:
                if session.state == "success":
                    session.state = "failed"
                    session.message = "无法验证或安全保存小黑盒登录信息，请重新扫码"
                    await self._close_pending(session)
                else:
                    session.message = "暂时无法检查扫码状态，请稍后重试"
            return self._public_pending(session)

    def account_status(self) -> dict[str, object]:
        credentials = self._vault.load()
        if credentials is None:
            return {"connected": False, "uid": None, "nickname": None, "loggedInAt": None}
        return {
            "connected": True,
            "uid": credentials.uid,
            "nickname": credentials.nickname or None,
            "loggedInAt": credentials.logged_in_at or None,
        }

    async def list_topics(self) -> list[dict[str, str]]:
        credentials = self._vault.load()
        if credentials is None:
            raise XiaoheiheNotLoggedInError("请先扫码登录小黑盒")
        credentials = self._ensure_credentials_device_id(credentials)
        async with _authenticated_client(credentials) as client:
            params = {**_WEB_CLIENT_PARAMS, "heybox_id": credentials.uid, "type": "list"}
            payload = await self._authenticated_request(
                client, f"{xiaoheihe.API_BASE_URL}{TOPICS_PATH}?{urlencode(params)}",
                credentials.device_id,
            )
        return _parse_topics(payload)

    async def fetch_topic(self, topic_id: str) -> list[xiaoheihe.NewsCandidate]:
        credentials = self._vault.load()
        if credentials is None:
            raise XiaoheiheNotLoggedInError("请先扫码登录小黑盒")
        credentials = self._ensure_credentials_device_id(credentials)
        if not topic_id.isdigit() or len(topic_id) > 32:
            raise ValueError("小黑盒话题 ID 无效")
        params = {
            **_WEB_CLIENT_PARAMS,
            "heybox_id": credentials.uid,
            "topic_id": topic_id,
            "offset": "0",
            "limit": str(MAX_TOPIC_ITEMS),
            "lastval": "",
            "dw": "720",
        }
        async with _authenticated_client(credentials) as client:
            payload = await self._authenticated_request(
                client,
                f"{xiaoheihe.API_BASE_URL}{TOPIC_FEEDS_PATH}?{urlencode(params)}",
                credentials.device_id,
            )
        links = _extract_topic_links(payload)
        candidates: list[xiaoheihe.NewsCandidate] = []
        seen_ids: set[str] = set()
        for item in links:
            candidate = xiaoheihe._normalize_candidate(item)
            if candidate and candidate["link_id"] not in seen_ids:
                seen_ids.add(candidate["link_id"])
                candidates.append(candidate)
        return candidates[:MAX_TOPIC_ITEMS]

    def logout(self) -> None:
        self._vault.delete()

    async def _authenticated_request(
        self, client: httpx.AsyncClient, url: str, device_id: str
    ) -> Any:
        """限制账号请求频率，避免多话题刷新时集中访问上游。"""
        async with self._request_lock:
            delay = 1.0 - (time.monotonic() - self._last_authenticated_request)
            if delay > 0:
                await asyncio.sleep(delay)
            try:
                try:
                    payload = await _auth_request_json(client, url, device_id)
                except httpx.HTTPStatusError as error:
                    if error.response.status_code == 401:
                        self._vault.delete()
                        raise XiaoheiheCredentialsExpiredError(
                            "小黑盒登录已失效，请重新扫码"
                        ) from error
                    raise
                try:
                    _ensure_authenticated_payload(payload)
                except XiaoheiheCredentialsExpiredError:
                    self._vault.delete()
                    raise
                return payload
            finally:
                self._last_authenticated_request = time.monotonic()

    def _ensure_credentials_device_id(
        self, credentials: XiaoheiheCredentials
    ) -> XiaoheiheCredentials:
        if credentials.device_id:
            return credentials
        updated = replace(credentials, device_id=secrets.token_hex(16))
        self._vault.save(updated)
        return updated

    async def cancel_qr(self, login_id: str) -> None:
        session = self._pending.pop(login_id, None)
        if session is not None:
            session.state = "cancelled"
            session.message = "已取消扫码登录"
            await self._close_pending(session)

    async def close(self) -> None:
        sessions = list(self._pending.values())
        self._pending.clear()
        for session in sessions:
            await self._close_pending(session)

    async def _expire_sessions(self) -> None:
        now = time.time()
        for login_id, session in list(self._pending.items()):
            if session.expires_at <= now:
                session.state = "expired"
                session.message = "二维码已过期，请重新生成"
                await self._close_pending(session)
                self._pending.pop(login_id, None)

    @staticmethod
    async def _close_pending(session: _PendingLogin) -> None:
        if not session.closed:
            session.closed = True
            await session.client.aclose()

    @staticmethod
    def _public_pending(session: _PendingLogin) -> dict[str, object]:
        return {
            "loginId": session.login_id,
            "state": session.state,
            "message": session.message,
            "expiresAt": datetime.fromtimestamp(session.expires_at, timezone.utc).isoformat().replace("+00:00", "Z"),
            "qrImage": session.qr_image if session.state in {"waiting_scan", "scanned_waiting_confirmation"} else None,
            "uid": session.uid or None,
            "nickname": session.nickname or None,
        }


def _require_windows() -> None:
    if __import__("os").name != "nt":
        raise RuntimeError("小黑盒登录凭据安全存储目前仅支持 Windows")


def _has_auth_cookie(cookies: Mapping[str, str]) -> bool:
    identity_names = {"heybox_id", "user_heybox_id", "heyboxid", "uid", "userid", "user_id"}
    return any(name.casefold() not in identity_names and value for name, value in cookies.items())


async def _auth_request_json(
    client: httpx.AsyncClient, url: str, device_id: str
) -> dict[str, Any]:
    parsed = urlsplit(url)
    request_url = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
    params = dict(parse_qsl(parsed.query, keep_blank_values=True))
    signed_params = xiaoheihe_auth_signing.build_signed_params(
        parsed.path, params, device_id=device_id
    )
    response = await client.get(
        request_url,
        params=signed_params,
        headers=xiaoheihe._headers(),
    )
    response.raise_for_status()
    try:
        payload = response.json()
    except ValueError as error:
        raise ValueError("小黑盒接口返回了无法识别的数据") from error
    if not isinstance(payload, dict):
        raise ValueError("小黑盒接口返回的数据格式有变化")
    return payload


def _response_body(payload: Mapping[str, Any]) -> Mapping[str, Any]:
    body = payload.get("result", payload.get("data", payload))
    if not isinstance(body, Mapping):
        raise XiaoheiheAuthError("小黑盒接口响应格式发生变化")
    return body


def _first_text(value: Mapping[str, Any], *keys: str) -> str:
    for key in keys:
        candidate = value.get(key)
        if isinstance(candidate, (str, int)) and str(candidate).strip():
            return str(candidate).strip()
    return ""


def _expiry_time(body: Mapping[str, Any]) -> float:
    raw = body.get("expires_in", body.get("ttl", body.get("expire", QR_TTL_SECONDS)))
    try:
        value = float(raw)
    except (TypeError, ValueError):
        value = QR_TTL_SECONDS
    now = time.time()
    if value > 10_000_000_000:
        value /= 1000
    if value > 1_000_000_000:
        ttl = value - now
    else:
        ttl = value
    return now + max(10, min(ttl, 600))


def _parse_login_state(payload: Mapping[str, Any]) -> tuple[str, str]:
    body = _response_body(payload)
    state = _first_text(body, "state", "status", "qr_state").casefold()
    marker = _first_text(body, "error", "err").casefold()
    message = _first_text(body, "message", "msg", "error_msg", "err_msg")
    state_map = {
        "0": "waiting_scan", "waiting": "waiting_scan", "waiting_scan": "waiting_scan",
        "1": "scanned_waiting_confirmation", "scanned": "scanned_waiting_confirmation",
        "confirm": "scanned_waiting_confirmation", "2": "success", "success": "success",
        "confirmed": "success", "3": "expired", "expired": "expired",
        "-1": "failed", "failed": "failed",
    }
    if state in state_map:
        return state_map[state], message
    if marker in {"ok", "success", "confirmed"}:
        return "success", message
    if marker in {"ready", "scanned"}:
        return "scanned_waiting_confirmation", message
    hint = f"{marker} {message}".casefold()
    if any(token in hint for token in ("expired", "timeout", "过期", "失效", "超时")):
        return "expired", message
    if any(token in hint for token in ("scanned", "confirm", "已扫码", "已扫描", "待确认", "请确认", "确认")):
        return "scanned_waiting_confirmation", message
    return "waiting_scan", message


def _state_message(state: str) -> str:
    return {
        "waiting_scan": "请使用小黑盒客户端扫码并确认",
        "scanned_waiting_confirmation": "已扫码，请在小黑盒客户端确认登录",
        "success": "登录成功",
        "expired": "二维码已过期，请重新生成",
        "failed": "扫码登录失败，请重新生成二维码",
        "cancelled": "已取消扫码登录",
    }.get(state, "正在检查登录状态")


def _parse_credentials(
    payload: Mapping[str, Any],
    client: httpx.AsyncClient,
    *,
    fallback_device_id: str = "",
) -> XiaoheiheCredentials:
    body = _response_body(payload)
    containers: list[Mapping[str, Any]] = [body]
    for key in ("user", "user_info", "account", "account_info", "profile", "account_detail"):
        nested = body.get(key)
        if isinstance(nested, Mapping):
            containers.append(nested)
    cookies = {cookie.name: cookie.value for cookie in client.cookies.jar}
    embedded = body.get("cookies")
    if isinstance(embedded, Mapping):
        cookies.update({str(key): str(value) for key, value in embedded.items()})
    uid = ""
    nickname = ""
    for container in containers:
        uid = uid or _first_text(container, "uid", "heybox_id", "user_heybox_id", "heyboxid", "user_id", "userid", "id")
        nickname = nickname or _first_text(container, "nickname", "username", "name")
    uid = uid or _first_text(cookies, "heybox_id", "user_heybox_id", "heyboxid", "user_id", "userid", "uid")
    if uid:
        cookies.setdefault("heybox_id", uid)
    values: dict[str, object] = {
        "uid": uid,
        "nickname": nickname,
        "cookies": cookies,
        "access_token": _first_text_from(containers, "access_token", "token"),
        "refresh_token": _first_text_from(containers, "refresh_token"),
        "device_id": _first_text_from(containers, "device_id") or fallback_device_id,
        "signing_key": _first_text_from(containers, "signing_key", "sign_key"),
        "logged_in_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    }
    try:
        return XiaoheiheCredentials.from_dict(values)
    except ValueError as error:
        raise XiaoheiheAuthError("登录成功响应没有包含可用账号凭据") from error


def _first_text_from(containers: list[Mapping[str, Any]], *keys: str) -> str:
    for container in containers:
        value = _first_text(container, *keys)
        if value:
            return value
    return ""


async def _verify_credentials(credentials: XiaoheiheCredentials) -> None:
    async with _authenticated_client(credentials) as client:
        params = {**_WEB_CLIENT_PARAMS, "heybox_id": credentials.uid}
        try:
            payload = await _auth_request_json(
                client,
                f"{xiaoheihe.API_BASE_URL}{CURRENT_USER_PATH}?{urlencode(params)}",
                credentials.device_id,
            )
        except httpx.HTTPStatusError as error:
            if error.response.status_code == 401:
                raise XiaoheiheCredentialsExpiredError(
                    "小黑盒未接受这次登录凭据，请重新扫码"
                ) from error
            raise
    _response_body(payload)
    _ensure_authenticated_payload(payload)


def _ensure_authenticated_payload(payload: Mapping[str, Any]) -> None:
    marker = payload.get("status", payload.get("stat"))
    if marker in (None, "", "ok", "success", "0", "1", "200", 0, 1, 200):
        return
    message = _first_text(payload, "msg", "message", "error", "err")
    hint = f"{marker} {message}".casefold()
    if any(
        token in hint
        for token in (
            "relogin", "login required", "not login", "unauthorized",
            "重新登录", "请登录", "未登录", "登录失效",
        )
    ):
        raise XiaoheiheCredentialsExpiredError("小黑盒登录已失效，请重新扫码")
    raise XiaoheiheAuthError("小黑盒暂时拒绝了请求，请稍后重试")


def _authenticated_client(credentials: XiaoheiheCredentials) -> httpx.AsyncClient:
    headers = xiaoheihe._headers()
    if credentials.access_token:
        headers["Authorization"] = f"Bearer {credentials.access_token}"
    return httpx.AsyncClient(
        timeout=20,
        follow_redirects=False,
        cookies=credentials.cookies,
        headers=headers,
    )


def _parse_topics(payload: Mapping[str, Any]) -> list[dict[str, str]]:
    body = _response_body(payload)
    raw = body.get("topics_list")
    if not isinstance(raw, list):
        raise XiaoheiheAuthError("小黑盒话题目录响应格式发生变化")
    topics: list[dict[str, str]] = []

    def visit(node: object, parent_group: str = "") -> None:
        if isinstance(node, list):
            for child in node:
                visit(child, parent_group)
            return
        if not isinstance(node, Mapping):
            return
        topic_id = _first_text(node, "topic_id", "id", "id_str")
        name = _first_text(node, "name", "title", "topic_name")
        children = next(
            (node.get(key) for key in ("topics_list", "topics", "children", "list", "items", "sub_list") if isinstance(node.get(key), list)),
            None,
        )
        group = _first_text(node, "group_name", "group", "category_name") or parent_group
        if topic_id.isdigit() and name:
            topics.append({"id": topic_id, "name": name[:200], "group": group[:200]})
            child_group = group
        else:
            child_group = name or group
        if isinstance(children, list):
            visit(children, child_group)
        elif not topic_id:
            for child in node.values():
                if isinstance(child, list):
                    visit(child, child_group)

    visit(raw)
    unique = {topic["id"]: topic for topic in topics}
    if not unique:
        raise XiaoheiheAuthError("小黑盒话题目录为空或格式发生变化")
    return sorted(unique.values(), key=lambda topic: (topic["group"], topic["name"].casefold()))


def _extract_topic_links(payload: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    body = _response_body(payload)
    links = body.get("links", body.get("items", body.get("list")))
    if not isinstance(links, list):
        raise XiaoheiheAuthError("小黑盒话题帖子流响应格式发生变化")
    return [
        item for item in links
        if isinstance(item, Mapping) and (item.get("linkid") or item.get("link_id") or item.get("post_id"))
    ]


def _qr_data_url(content: str) -> str:
    try:
        import qrcode
    except ImportError as error:
        raise RuntimeError("扫码登录二维码组件未安装，请重新安装 TabKeep 后端依赖") from error
    from io import BytesIO

    image = qrcode.make(content)
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


auth_service = XiaoheiheAuthService()
