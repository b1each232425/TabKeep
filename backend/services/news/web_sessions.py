"""管理资讯网页的一次性授权票据和短时会话。"""

import secrets
import threading
import time

TICKET_TTL_SECONDS = 60
SESSION_TTL_SECONDS = 12 * 60 * 60

_lock = threading.Lock()
_tickets: dict[str, float] = {}
_sessions: dict[str, float] = {}


def _remove_expired(now: float) -> None:
    """清理已过期的授权票据和网页会话。"""
    expired_tickets = [key for key, expires_at in _tickets.items() if expires_at <= now]
    expired_sessions = [key for key, expires_at in _sessions.items() if expires_at <= now]
    for key in expired_tickets:
        del _tickets[key]
    for key in expired_sessions:
        del _sessions[key]


def create_ticket() -> str:
    """创建一个只能兑换一次、有效期为 60 秒的随机票据。"""
    now = time.monotonic()
    ticket = secrets.token_urlsafe(32)
    with _lock:
        _remove_expired(now)
        _tickets[ticket] = now + TICKET_TTL_SECONDS
    return ticket


def exchange_ticket(ticket: str) -> str | None:
    """兑换一次性票据，并返回有效期为 12 小时的随机会话值。"""
    now = time.monotonic()
    with _lock:
        _remove_expired(now)
        expires_at = _tickets.pop(ticket, None)
        if expires_at is None or expires_at <= now:
            return None
        session = secrets.token_urlsafe(32)
        _sessions[session] = now + SESSION_TTL_SECONDS
    return session


def is_session_valid(session: str | None) -> bool:
    """检查网页会话是否仍然有效。"""
    if not session:
        return False
    now = time.monotonic()
    with _lock:
        _remove_expired(now)
        return session in _sessions


def clear_sessions() -> None:
    """清理进程内会话状态，供应用关闭和测试隔离使用。"""
    with _lock:
        _tickets.clear()
        _sessions.clear()
