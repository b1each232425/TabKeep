"""资讯 API 的 Token 与阅读网页会话鉴权。"""

from fastapi import Cookie, Header, HTTPException, Request, status

from services import storage
from services.auth import is_auth_disabled
from services.news import web_sessions

NEWS_SESSION_COOKIE = "tabkeep_news_session"
NEWS_READER_DEV_ORIGIN = "http://127.0.0.1:5176"


def require_news_access(
    x_tabkeep_token: str | None = Header(default=None),
    tabkeep_news_session: str | None = Cookie(default=None),
) -> None:
    """允许现有本机 Token 或只限资讯 API 使用的网页会话。"""
    if is_auth_disabled():
        return

    expected = storage.get_api_token()
    if expected and x_tabkeep_token and x_tabkeep_token == expected:
        return
    if web_sessions.is_session_valid(tabkeep_news_session):
        return

    detail = (
        "网页会话已失效，请从桌面端重新打开资讯入口。"
        if expected
        else "TabKeep API Token 未初始化，请先打开桌面端并完成扩展同步。"
    )
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=detail)


def is_valid_session_exchange_origin(request: Request) -> bool:
    """仅接受后端自身来源和本机开发阅读页的票据兑换请求。"""
    origin = request.headers.get("origin")
    host = request.headers.get("host")
    if not origin or not host or origin == "null":
        return False
    expected_origin = f"{request.url.scheme}://{host}"
    if origin == expected_origin:
        return True
    return is_auth_disabled() and origin == NEWS_READER_DEV_ORIGIN
