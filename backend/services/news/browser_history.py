"""从用户选择的 Chromium 浏览器配置文件只读读取访问记录。"""

import hashlib
import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from threading import Event
from typing import TypedDict


class BrowserProfile(TypedDict):
    id: str
    browser: str
    name: str


class BrowserVisit(TypedDict):
    visit_id: str
    url: str
    title: str
    visited_at: str


_CHROMIUM_EPOCH_OFFSET_SECONDS = 11_644_473_600


def _browser_roots() -> list[tuple[str, str, Path]]:
    local_app_data = os.getenv("LOCALAPPDATA", "").strip()
    if not local_app_data:
        return []
    base = Path(local_app_data)
    return [
        ("edge", "Microsoft Edge", base / "Microsoft" / "Edge" / "User Data"),
        ("chrome", "Google Chrome", base / "Google" / "Chrome" / "User Data"),
    ]


def _profile_key(browser: str, directory_name: str) -> str:
    digest = hashlib.sha256(f"{browser}:{directory_name}".encode("utf-8")).hexdigest()
    return digest[:32]


def _profile_entries(root: Path) -> dict[str, dict[str, object]]:
    local_state = root / "Local State"
    try:
        data = json.loads(local_state.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    profile = data.get("profile")
    cache = profile.get("info_cache") if isinstance(profile, dict) else None
    return cache if isinstance(cache, dict) else {}


def list_profiles() -> list[BrowserProfile]:
    """列出可读的 Edge/Chrome 用户配置文件，不返回本机绝对路径。"""
    profiles: list[BrowserProfile] = []
    for browser, browser_name, root in _browser_roots():
        if not root.is_dir():
            continue
        info_cache = _profile_entries(root)
        try:
            candidates = {path.name for path in root.iterdir() if path.is_dir()}
        except OSError:
            continue
        candidates.update(str(name) for name in info_cache)
        for directory_name in sorted(candidates):
            history_path = root / directory_name / "History"
            if not history_path.is_file():
                continue
            details = info_cache.get(directory_name, {})
            display_name = details.get("name") if isinstance(details, dict) else None
            profiles.append(
                {
                    "id": _profile_key(browser, directory_name),
                    "browser": browser,
                    "name": f"{browser_name} · {display_name or directory_name}",
                }
            )
    return profiles


def _resolve_profile(profile_id: str) -> tuple[str, Path]:
    for browser, _browser_name, root in _browser_roots():
        if not root.is_dir():
            continue
        try:
            directories = list(root.iterdir())
        except OSError:
            continue
        for directory in directories:
            if directory.is_dir() and _profile_key(browser, directory.name) == profile_id:
                history_path = directory / "History"
                if history_path.is_file():
                    return browser, history_path
    raise FileNotFoundError("选中的浏览器配置文件已不可用，请重新选择")


def _chromium_time(value: datetime) -> int:
    utc_value = value.astimezone(timezone.utc)
    return int((utc_value.timestamp() + _CHROMIUM_EPOCH_OFFSET_SECONDS) * 1_000_000)


def _iso_time(value: int) -> str:
    unix_seconds = value / 1_000_000 - _CHROMIUM_EPOCH_OFFSET_SECONDS
    return datetime.fromtimestamp(unix_seconds, tz=timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def read_visits(
    profile_id: str,
    range_start: datetime,
    range_end: datetime,
    limit: int = 50_000,
    cancel_event: Event | None = None,
) -> tuple[str, list[BrowserVisit]]:
    """以 SQLite 只读模式读取指定时间范围的 URL 访问记录。"""
    browser, history_path = _resolve_profile(profile_id)
    uri = f"{history_path.resolve().as_uri()}?mode=ro"
    try:
        connection = sqlite3.connect(uri, uri=True, timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only = ON")
        connection.execute("PRAGMA busy_timeout = 5000")
        cursor = connection.execute(
            """
            SELECT visits.id AS visit_id, urls.url AS url,
                   COALESCE(urls.title, '') AS title, visits.visit_time AS visit_time
            FROM visits
            JOIN urls ON urls.id = visits.url
            WHERE visits.visit_time >= ? AND visits.visit_time <= ?
              AND urls.url LIKE 'http%'
            ORDER BY visits.visit_time DESC
            LIMIT ?
            """,
            (_chromium_time(range_start), _chromium_time(range_end), limit),
        )
        rows: list[sqlite3.Row] = []
        while True:
            if cancel_event is not None and cancel_event.is_set():
                raise InterruptedError("浏览器历史导入已取消")
            chunk = cursor.fetchmany(500)
            if not chunk:
                break
            rows.extend(chunk)
    except sqlite3.Error as error:
        raise RuntimeError("浏览器历史数据库暂时无法读取，请关闭浏览器后重试") from error
    finally:
        if "connection" in locals():
            connection.close()

    visits = [
        {
            "visit_id": str(row["visit_id"]),
            "url": str(row["url"]),
            "title": str(row["title"]),
            "visited_at": _iso_time(int(row["visit_time"])),
        }
        for row in rows
    ]
    return browser, visits
