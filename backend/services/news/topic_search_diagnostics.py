"""话题搜索诊断日志；只允许写入不含用户内容的白名单字段。"""

import re
import threading
from pathlib import Path

from logger import logger
from services import storage

_LOG_LOCK = threading.Lock()
_LOG_MAX_BYTES = 1_000_000
_EVENTS = {"video_search_dom", "video_platform_api", "video_comment_task"}
_PROVIDERS = {"douyin", "bilibili", "kuaishou"}
_STATES = {
    "queued", "running", "completed", "partial", "failed", "empty",
    "login_required", "limited", "error", "http_error", "cancelled",
}
_ID_FIELDS = {
    "request_id": re.compile(r"^[0-9a-f]{8}$"),
    "task_id": re.compile(r"^[0-9a-f]{32}$"),
    "video_hash": re.compile(r"^[0-9a-f]{20}$"),
}
_ENUM_FIELDS = {
    "provider": _PROVIDERS,
    "state": _STATES,
    "failure_state": _STATES,
    "host_class": {"platform", "unexpected", "unknown"},
    "request_host_class": {"platform", "unexpected", "unknown"},
}
_TOKEN_FIELDS = {"stage": re.compile(r"^[a-z][a-z0-9_]{0,47}$")}
_ERROR_CODE = re.compile(r"^[A-Z][A-Z0-9_]{0,79}$")
_ERROR_TYPE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,59}$")
_INTEGER_FIELDS = {
    "http_status", "duration_ms", "result_count", "anchor_count",
    "video_href_count", "platform_href_count", "video_id_count", "title_count",
    "body_chars", "video_count", "comment_count", "comment_section_count",
    "comment_node_count", "request_count", "target_request_count", "matched_response_count",
    "scanned_comment_count", "partial_comment_count",
}
_BOOLEAN_FIELDS = {"challenge_detected", "login_wall_detected"}


def log_topic_search_diagnostic(event: str, **fields: str | int | bool | None) -> None:
    """记录白名单诊断字段，不接收关键词、URL、正文、评论或凭据。"""
    if event not in _EVENTS:
        return
    parts = [f"topic_search_{event}"]
    for key, value in fields.items():
        if value is None:
            continue
        safe_value = _safe_value(key, value)
        if safe_value is not None:
            parts.append(f"{key}={safe_value}")
    _write_line(" ".join(parts))


def _safe_value(key: str, value: str | int | bool) -> str | None:
    """按字段类别验证值，防止调用方误传正文或 URL。"""
    if key in _ID_FIELDS:
        if isinstance(value, str) and _ID_FIELDS[key].fullmatch(value):
            return value
        return None
    if key in _ENUM_FIELDS:
        if isinstance(value, str) and value in _ENUM_FIELDS[key]:
            return value
        return None
    if key == "stage":
        return value if isinstance(value, str) and _TOKEN_FIELDS[key].fullmatch(value) else None
    if key == "error_code":
        return value if isinstance(value, str) and _ERROR_CODE.fullmatch(value) else None
    if key == "error_type":
        return value if isinstance(value, str) and _ERROR_TYPE.fullmatch(value) else None
    if key in _INTEGER_FIELDS:
        if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 10_000_000:
            return str(value)
        return None
    if key in _BOOLEAN_FIELDS:
        return "1" if value is True else "0" if value is False else None
    return None


def _write_line(line: str) -> None:
    logger.info(line)
    try:
        log_dir = Path(storage.DATA_DIR) / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        log_path = log_dir / "topic-search.log"
        with _LOG_LOCK:
            if log_path.exists() and log_path.stat().st_size >= _LOG_MAX_BYTES:
                backup = log_dir / "topic-search.log.1"
                backup.unlink(missing_ok=True)
                log_path.replace(backup)
            with log_path.open("a", encoding="utf-8", newline="\n") as handle:
                handle.write(line + "\n")
    except OSError as exc:
        logger.warning("topic_search diagnostic_file_write_failed error_type={}", type(exc).__name__)
