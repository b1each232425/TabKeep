"""小黑盒公开游戏新闻接口采集。"""

import hashlib
import re
import secrets
import time
import uuid
from collections.abc import Mapping
from datetime import datetime, timezone
from html.parser import HTMLParser
from typing import Any, TypedDict
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit

import httpx

from services.news.images import normalize_image_url

API_BASE_URL = "https://api.xiaoheihe.cn"
HOMEPAGE_URL = "https://www.xiaoheihe.cn/"
NEWS_LIST_PATH = "/bbs/app/feeds/news"
MAX_NEWS_ITEMS = 20
MAX_CONTENT_CHARS = 20_000
_HKEY_DICT = "JKMNPQRTX1234OABCDFG56789H"


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


class NewsCandidate(TypedDict):
    link_id: str
    entry: NormalizedEntry


class _PlainTextParser(HTMLParser):
    """移除接口摘要中的 HTML 标签。"""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip_depth = 0

    def handle_data(self, data: str) -> None:
        if self.skip_depth == 0:
            self.parts.append(data)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() in {"script", "style"}:
            self.skip_depth += 1
        elif tag.lower() in {"br", "div", "li", "p", "section"} and self.skip_depth == 0:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() in {"script", "style"}:
            self.skip_depth = max(0, self.skip_depth - 1)
        elif tag.lower() in {"div", "li", "p", "section"} and self.skip_depth == 0:
            self.parts.append("\n")


def is_xiaoheihe_url(url: str) -> bool:
    """判断地址是否属于小黑盒官网。"""
    try:
        parsed = urlsplit(url)
        parsed.port
    except ValueError:
        return False
    return (
        parsed.scheme.lower() in {"http", "https"}
        and (parsed.hostname or "").lower() in {"xiaoheihe.cn", "www.xiaoheihe.cn"}
        and parsed.path.rstrip("/") == ""
        and parsed.username is None
        and parsed.password is None
    )


def _convert_byte(value: int) -> int:
    value &= 0xFF
    if value & 0x80:
        return ((value << 1) ^ 0x1B) & 0xFF
    return (value << 1) & 0xFF


def _c3(value: int) -> int:
    return _convert_byte(value) ^ value


def _c2(value: int) -> int:
    return _c3(_convert_byte(value))


def _c1(value: int) -> int:
    return _c2(_c3(_convert_byte(value)))


def _c0(value: int) -> int:
    return _c1(value) ^ _c2(value) ^ _c3(value)


def _checksum(values: list[int]) -> int:
    first, second, third, fourth = values
    return sum(
        (
            _c0(first) ^ _c1(second) ^ _c2(third) ^ _c3(fourth),
            _c3(first) ^ _c0(second) ^ _c1(third) ^ _c2(fourth),
            _c2(first) ^ _c3(second) ^ _c0(third) ^ _c1(fourth),
            _c1(first) ^ _c2(second) ^ _c3(third) ^ _c0(fourth),
        )
    ) % 100


def build_signed_url(url: str, timestamp: int, nonce: str) -> str:
    """为小黑盒 Web 新闻接口生成请求参数，算法来源见同目录第三方声明。"""
    parsed = urlsplit(url)
    path = "/" + "/".join(segment for segment in parsed.path.split("/") if segment) + "/"
    nonce_digits = re.sub(r"\D", "", nonce + _HKEY_DICT)
    nonce_hash = hashlib.md5(nonce_digits.encode("utf-8")).hexdigest()
    seed = hashlib.md5(f"{timestamp + 1}{path}{nonce_hash}".encode("utf-8")).hexdigest()
    digits = "".join(character for character in seed if character.isdigit())[:9].ljust(9, "0")
    remainder = int(digits)
    key = ""
    for _ in range(5):
        key += _HKEY_DICT[remainder % len(_HKEY_DICT)]
        remainder //= len(_HKEY_DICT)
    suffix = f"{_checksum([ord(character) for character in key[-4:]]):02d}"
    query = parse_qsl(parsed.query, keep_blank_values=True)
    query.extend((("hkey", key + suffix), ("_time", str(timestamp)), ("nonce", nonce)))
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(query), ""))


def _signed_url(url: str) -> str:
    return build_signed_url(url, int(time.time()), secrets.token_hex(16).upper())


def _headers() -> dict[str, str]:
    return {
        "Accept": "application/json",
        "Origin": "https://www.xiaoheihe.cn",
        "Referer": HOMEPAGE_URL,
        "User-Agent": "TabKeep/1.0 (+local news reader)",
    }


async def _request_json(client: httpx.AsyncClient, url: str) -> dict[str, Any]:
    response = await client.get(_signed_url(url), headers=_headers())
    response.raise_for_status()
    try:
        payload = response.json()
    except ValueError as error:
        raise ValueError("小黑盒新闻接口返回了无法识别的数据") from error
    if not isinstance(payload, dict):
        raise ValueError("小黑盒新闻接口返回的数据格式有变化")
    return payload


def _clean_text(value: object) -> str:
    if not isinstance(value, str):
        return ""
    parser = _PlainTextParser()
    parser.feed(value)
    parser.close()
    return re.sub(r"\n[\t ]*\n+", "\n\n", "".join(parser.parts)).strip()


def _first_text(value: object) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        for item in value:
            if isinstance(item, Mapping):
                text = item.get("text") or item.get("value")
                if isinstance(text, str) and text.strip():
                    return text
            elif isinstance(item, str) and item.strip():
                return item
    return ""


def _image_url(value: Mapping[str, Any]) -> str | None:
    image_keys = (
        "imgs", "thumbs", "cover_url", "cover", "thumb_url", "thumb",
        "image_url", "image", "pic_url",
    )
    for key in image_keys:
        candidate: object = value.get(key)
        if isinstance(candidate, Mapping):
            candidate = candidate.get("origin_url") or candidate.get("url") or candidate.get("src")
        elif isinstance(candidate, list):
            candidate = candidate[0] if candidate else None
            if isinstance(candidate, Mapping):
                candidate = candidate.get("origin_url") or candidate.get("url") or candidate.get("src")
        normalized = normalize_image_url(
            candidate if isinstance(candidate, str) else None,
            HOMEPAGE_URL,
        )
        if normalized:
            return normalized
    return None


def _author_name(value: object) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    if isinstance(value, Mapping):
        for key in ("show_name", "nickname", "nick_name", "name"):
            candidate = value.get(key)
            if isinstance(candidate, str) and candidate.strip():
                return candidate.strip()
    return None


def _published_at(value: object) -> str | None:
    if isinstance(value, (int, float)) or (isinstance(value, str) and value.isdigit()):
        try:
            timestamp = float(value)
            if timestamp > 10_000_000_000:
                timestamp /= 1000
            if timestamp <= 0:
                return None
            return (
                datetime.fromtimestamp(timestamp, timezone.utc)
                .isoformat(timespec="seconds")
                .replace("+00:00", "Z")
            )
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(value, str) and value.strip():
        try:
            parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return (
                parsed.astimezone(timezone.utc)
                .isoformat(timespec="seconds")
                .replace("+00:00", "Z")
            )
        except ValueError:
            return None
    return None


def _normalize_candidate(item: Mapping[str, Any]) -> NewsCandidate | None:
    link_id = item.get("linkid") or item.get("link_id")
    if not isinstance(link_id, (str, int)) or not str(link_id).strip():
        return None
    normalized_id = str(link_id).strip()
    share_id = next(
        (
            value
            for key, value in parse_qsl(urlsplit(str(item.get("share_url") or "")).query)
            if key == "link_id" and value
        ),
        normalized_id,
    )
    description = item.get("description") or item.get("content") or ""
    entry: NormalizedEntry = {
        "id": uuid.uuid4().hex,
        "dedupe_key": f"xiaoheihe:link:{normalized_id}",
        "title": (_clean_text(str(item.get("title") or "小黑盒游戏资讯")) or "小黑盒游戏资讯")[:500],
        "url": f"https://www.xiaoheihe.cn/app/bbs/link/{quote(share_id, safe='')}",
        "content": _clean_text(_first_text(description))[:MAX_CONTENT_CHARS],
        "image_url": _image_url(item),
        "image_asset": None,
        "author": _author_name(item.get("user") or item.get("author")),
        "published_at": _published_at(item.get("modify_at") or item.get("create_time") or item.get("created_at")),
    }
    return {"link_id": normalized_id, "entry": entry}


def _extract_news_links(payload: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    if payload.get("status") not in (None, "ok", "success", 0, 1):
        raise ValueError("小黑盒新闻接口暂时无法读取，请稍后重试")
    result = payload.get("result")
    links = result.get("links") if isinstance(result, Mapping) else None
    if not isinstance(links, list):
        raise ValueError("小黑盒新闻接口返回的数据格式有变化")
    return [
        item
        for item in links
        if isinstance(item, Mapping) and (item.get("linkid") or item.get("link_id"))
    ][:MAX_NEWS_ITEMS]


async def fetch_news_list(client: httpx.AsyncClient) -> list[NewsCandidate]:
    """读取小黑盒公开新闻列表。"""
    params = urlencode(
        (
            ("os_type", "web"),
            ("app", "heybox"),
            ("client_type", "mobile"),
            ("version", "999.0.3"),
            ("x_client_type", "web"),
            ("x_os_type", "Mac"),
            ("x_app", "heybox"),
            ("heybox_id", "-1"),
            ("appid", "900018355"),
            ("offset", "0"),
            ("limit", str(MAX_NEWS_ITEMS)),
        )
    )
    payload = await _request_json(client, f"{API_BASE_URL}{NEWS_LIST_PATH}?{params}")
    candidates: list[NewsCandidate] = []
    seen_ids: set[str] = set()
    for item in _extract_news_links(payload):
        candidate = _normalize_candidate(item)
        if candidate and candidate["link_id"] not in seen_ids:
            seen_ids.add(candidate["link_id"])
            candidates.append(candidate)
    return candidates

