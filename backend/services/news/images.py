"""资讯图片的 URL 校验、本地缓存和安全读取。"""

import asyncio
import hashlib
import ipaddress
import os
import re
import socket
import uuid
from pathlib import Path
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx

from services import storage

MAX_IMAGE_BYTES = 4 * 1024 * 1024
IMAGE_TIMEOUT_SECONDS = 5
MAX_IMAGE_REDIRECTS = 3
_ASSET_NAME = re.compile(r"^[a-f0-9]{64}\.(?:png|jpg|gif|webp|avif|ico)$")
_REDIRECT_STATUSES = {301, 302, 303, 307, 308}
_IMAGE_SIGNATURES = (
    ("png", lambda value: value.startswith(b"\x89PNG\r\n\x1a\n")),
    ("jpg", lambda value: value.startswith(b"\xff\xd8\xff")),
    ("gif", lambda value: value.startswith((b"GIF87a", b"GIF89a"))),
    ("webp", lambda value: len(value) >= 12 and value[:4] == b"RIFF" and value[8:12] == b"WEBP"),
    ("avif", lambda value: len(value) >= 12 and value[4:8] == b"ftyp" and value[8:12] in {b"avif", b"avis"}),
    ("ico", lambda value: value.startswith(b"\x00\x00\x01\x00")),
)


def normalize_image_url(value: str | None, base_url: str | None = None) -> str | None:
    """解析图片地址，只保留不带凭据的 HTTP(S) URL。"""
    candidate = (value or "").strip()
    if not candidate:
        return None
    try:
        if base_url:
            candidate = urljoin(base_url, candidate)
        parsed = urlsplit(candidate)
        parsed.port
    except ValueError:
        return None
    if (
        parsed.scheme.lower() not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
    ):
        return None
    return urlunsplit((parsed.scheme.lower(), parsed.netloc, parsed.path or "/", parsed.query, ""))


def _resolve_public_addresses(host: str, port: int) -> bool:
    """拒绝解析到环回、私网、链路本地或保留地址的图片主机。"""
    normalized_host = host.rstrip(".").lower()
    if normalized_host in {"localhost", "localhost.localdomain"} or normalized_host.endswith(
        (".localhost", ".local", ".internal", ".lan", ".home")
    ):
        return False
    try:
        literal = ipaddress.ip_address(normalized_host)
        return literal.is_global
    except ValueError:
        pass
    try:
        results = socket.getaddrinfo(normalized_host, port, type=socket.SOCK_STREAM)
    except OSError:
        return False
    addresses = {result[4][0] for result in results}
    if not addresses:
        return False
    try:
        return all(ipaddress.ip_address(address.split("%", 1)[0]).is_global for address in addresses)
    except ValueError:
        return False


async def _is_public_url(value: str) -> bool:
    normalized = normalize_image_url(value)
    if not normalized:
        return False
    parsed = urlsplit(normalized)
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    return await asyncio.to_thread(_resolve_public_addresses, parsed.hostname or "", port)


def _detect_image_extension(content: bytes) -> str | None:
    for extension, matches in _IMAGE_SIGNATURES:
        if matches(content):
            return extension
    return None


def _asset_directory() -> Path:
    return storage.DATA_DIR / "news_assets"


def _write_asset(directory: Path, file_name: str, content: bytes) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / file_name
    temporary = directory / f".{uuid.uuid4().hex}.tmp"
    try:
        temporary.write_bytes(content)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def asset_file(file_name: str) -> Path | None:
    """按缓存名读取资讯图片；拒绝路径穿越和指向目录外的链接。"""
    if not _ASSET_NAME.fullmatch(file_name):
        return None
    directory = _asset_directory().resolve()
    candidate = directory / file_name
    try:
        resolved = candidate.resolve(strict=True)
    except OSError:
        return None
    if resolved.parent != directory or not resolved.is_file():
        return None
    return resolved


def asset_url(file_name: str | None) -> str | None:
    if not file_name or not _ASSET_NAME.fullmatch(file_name):
        return None
    return f"/news/assets/{file_name}"


async def cache_image(client: httpx.AsyncClient, value: str | None) -> str | None:
    """下载并缓存一张受限大小的图片，返回本地缓存文件名。"""
    normalized = normalize_image_url(value)
    if not normalized:
        return None
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    directory = _asset_directory()
    for extension, _matches in _IMAGE_SIGNATURES:
        cached_name = f"{digest}.{extension}"
        if asset_file(cached_name):
            return cached_name

    current_url = normalized
    try:
        for redirect_count in range(MAX_IMAGE_REDIRECTS + 1):
            if not await _is_public_url(current_url):
                return None
            async with client.stream(
                "GET",
                current_url,
                follow_redirects=False,
                timeout=IMAGE_TIMEOUT_SECONDS,
                headers={"Accept": "image/avif,image/webp,image/png,image/jpeg,image/gif,image/x-icon,*/*;q=0.2"},
            ) as response:
                if response.status_code in _REDIRECT_STATUSES:
                    location = response.headers.get("location")
                    if not location or redirect_count >= MAX_IMAGE_REDIRECTS:
                        return None
                    current_url = normalize_image_url(urljoin(current_url, location)) or ""
                    if not current_url:
                        return None
                    continue
                if response.status_code != 200:
                    return None
                content_length = response.headers.get("content-length")
                if content_length and int(content_length) > MAX_IMAGE_BYTES:
                    return None
                chunks: list[bytes] = []
                received = 0
                async for chunk in response.aiter_bytes():
                    received += len(chunk)
                    if received > MAX_IMAGE_BYTES:
                        return None
                    chunks.append(chunk)
                content = b"".join(chunks)
            extension = _detect_image_extension(content)
            if not extension:
                return None
            file_name = f"{digest}.{extension}"
            await asyncio.to_thread(_write_asset, directory, file_name, content)
            return file_name
    except (httpx.HTTPError, OSError, TimeoutError, ValueError):
        return None
    return None


async def cache_first(client: httpx.AsyncClient, urls: list[str | None]) -> tuple[str, str] | None:
    """按优先级缓存来源图片候选，并返回缓存名与原始地址。"""
    seen: set[str] = set()
    for value in urls:
        normalized = normalize_image_url(value)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        file_name = await cache_image(client, normalized)
        if file_name:
            return file_name, normalized
    return None
