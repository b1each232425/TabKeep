"""资讯订阅和本地条目 API。"""

import asyncio
import uuid
from datetime import datetime, timezone
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import FileResponse

from schemas.news import (
    NewsItem,
    NewsItemListResponse,
    NewsBrowserSessionExchangeRequest,
    NewsBrowserSessionExchangeResponse,
    NewsBrowserSessionTicketResponse,
    NewsRefreshAllResponse,
    NewsSource,
    NewsSourceCreateRequest,
    NewsSourceListResponse,
    NewsSourceMutationResponse,
    NewsSourceRefreshResult,
    NewsSourceDeleteResponse,
)
from services.auth import require_api_token
from services.news import collector, db, images, xiaoheihe
from services.news.tieba import parse_forum_name
from services.news.web_auth import NEWS_SESSION_COOKIE, is_valid_session_exchange_origin, require_news_access
from services.news import web_sessions

router = APIRouter(prefix="/news", tags=["资讯"])


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _source_model(row: dict[str, object]) -> NewsSource:
    return NewsSource(
        id=str(row["id"]),
        url=str(row["url"]),
        title=str(row["title"]),
        iconUrl=images.asset_url(str(row["icon_asset"])) if row.get("icon_asset") else None,
        sourceType=str(row.get("source_type") or "rss"),
        isActive=bool(row["is_active"]),
        createdAt=str(row["created_at"]),
        lastCheckedAt=str(row["last_checked_at"]) if row.get("last_checked_at") else None,
        lastSuccessAt=str(row["last_success_at"]) if row.get("last_success_at") else None,
        lastError=str(row["last_error"]) if row.get("last_error") else None,
        itemCount=int(row.get("item_count") or 0),
    )


def _refresh_model(result: collector.RefreshResult) -> NewsSourceRefreshResult:
    return NewsSourceRefreshResult(**result)


@router.post(
    "/browser-session",
    response_model=NewsBrowserSessionTicketResponse,
    dependencies=[Depends(require_api_token)],
    summary="创建资讯网页的一次性授权票据",
)
def create_browser_session_ticket(response: Response) -> NewsBrowserSessionTicketResponse:
    """签发给桌面端使用的一次性短时授权票据。"""
    ticket = web_sessions.create_ticket()
    response.headers["Cache-Control"] = "no-store"
    return NewsBrowserSessionTicketResponse(ticket=ticket)


@router.post(
    "/browser-session/exchange",
    response_model=NewsBrowserSessionExchangeResponse,
    summary="兑换资讯网页会话",
)
def exchange_browser_session_ticket(
    request: Request,
    response: Response,
    payload: NewsBrowserSessionExchangeRequest,
) -> NewsBrowserSessionExchangeResponse:
    """验证本机来源并把一次性票据兑换为资讯网页 Cookie。"""
    if not is_valid_session_exchange_origin(request):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="资讯网页会话只能从本机页面兑换",
        )
    session = web_sessions.exchange_ticket(payload.ticket)
    if not session:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="授权票据已失效，请从桌面端重新打开资讯入口",
        )
    response.set_cookie(
        key=NEWS_SESSION_COOKIE,
        value=session,
        max_age=web_sessions.SESSION_TTL_SECONDS,
        httponly=True,
        samesite="strict",
        path="/news",
    )
    response.headers["Cache-Control"] = "no-store"
    return NewsBrowserSessionExchangeResponse(ok=True)


@router.get(
    "/sources",
    response_model=NewsSourceListResponse,
    dependencies=[Depends(require_news_access)],
    summary="列出资讯订阅源",
)
def list_sources() -> NewsSourceListResponse:
    return NewsSourceListResponse(
        items=[_source_model(row) for row in db.list_sources()],
        totalItemCount=db.count_items(),
    )


@router.get(
    "/assets/{file_name}",
    dependencies=[Depends(require_news_access)],
    summary="读取本地缓存的资讯图片",
)
def get_asset(file_name: str) -> FileResponse:
    """只提供资讯缓存目录中的受限图片资源。"""
    path = images.asset_file(file_name)
    if path is None:
        raise HTTPException(status_code=404, detail="资讯图片不存在")
    return FileResponse(
        path,
        headers={
            "Cache-Control": "private, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post(
    "/sources",
    response_model=NewsSourceMutationResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_news_access)],
    summary="添加资讯订阅源并立即采集",
)
async def create_source(request: NewsSourceCreateRequest) -> NewsSourceMutationResponse:
    try:
        forum_name = parse_forum_name(request.url)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    if forum_name:
        source_type = "tieba"
    elif xiaoheihe.is_xiaoheihe_url(request.url):
        source_type = "xiaoheihe"
    else:
        source_type = "rss"
    source_url = xiaoheihe.HOMEPAGE_URL if source_type == "xiaoheihe" else request.url
    existing = await asyncio.to_thread(db.get_source_by_url, source_url)
    if existing and bool(existing["is_active"]) and not bool(existing.get("is_deleted")):
        raise HTTPException(status_code=409, detail="这个订阅地址已经添加")
    if existing:
        source_id = str(existing["id"])
        await asyncio.to_thread(db.restore_source_subscription, source_id)
    else:
        source_id = uuid.uuid4().hex
        source_title = (
            forum_name
            or ("小黑盒游戏新闻" if source_type == "xiaoheihe" else None)
            or urlsplit(source_url).hostname
            or source_url
        )
        await asyncio.to_thread(
            db.create_source,
            source_id,
            source_url,
            source_title,
            _timestamp(),
            source_type,
        )
    result = await collector.refresh_source(source_id)
    source = await asyncio.to_thread(db.get_source, source_id)
    if source is None:
        raise HTTPException(status_code=500, detail="订阅源保存失败")
    return NewsSourceMutationResponse(
        source=_source_model(source),
        newItems=result["newItems"],
        notModified=result["notModified"],
    )


@router.delete(
    "/sources/{source_id}",
    response_model=NewsSourceDeleteResponse,
    dependencies=[Depends(require_news_access)],
    summary="取消资讯订阅",
)
def delete_source(source_id: str) -> NewsSourceDeleteResponse:
    source = db.get_source(source_id)
    if source is None:
        raise HTTPException(status_code=404, detail="订阅源不存在")
    db.delete_source_subscription(source_id)
    return NewsSourceDeleteResponse(ok=True)


@router.post(
    "/sources/{source_id}/refresh",
    response_model=NewsSourceMutationResponse,
    dependencies=[Depends(require_news_access)],
    summary="立即刷新一个订阅源",
)
async def refresh_source(source_id: str) -> NewsSourceMutationResponse:
    source = await asyncio.to_thread(db.get_source, source_id)
    if source is None or bool(source.get("is_deleted")):
        raise HTTPException(status_code=404, detail="订阅源不存在")
    if not bool(source["is_active"]):
        raise HTTPException(status_code=409, detail="该订阅源已停用")
    result = await collector.refresh_source(source_id)
    updated_source = await asyncio.to_thread(db.get_source, source_id)
    if updated_source is None:
        raise HTTPException(status_code=404, detail="订阅源不存在")
    return NewsSourceMutationResponse(
        source=_source_model(updated_source),
        newItems=result["newItems"],
        notModified=result["notModified"],
    )


@router.post(
    "/refresh",
    response_model=NewsRefreshAllResponse,
    dependencies=[Depends(require_news_access)],
    summary="立即刷新所有启用的订阅源",
)
async def refresh_all_sources() -> NewsRefreshAllResponse:
    sources = await asyncio.to_thread(db.list_sources)
    source_ids = [str(row["id"]) for row in sources if bool(row["is_active"])]
    results = await collector.refresh_sources(source_ids)
    return NewsRefreshAllResponse(
        items=[_refresh_model(result) for result in results],
        newItems=sum(result["newItems"] for result in results),
    )


@router.get(
    "/items",
    response_model=NewsItemListResponse,
    dependencies=[Depends(require_news_access)],
    summary="读取已采集的资讯条目",
)
def list_items(
    source_id: str | None = Query(default=None, alias="sourceId"),
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> NewsItemListResponse:
    rows, total = db.list_items(source_id, limit, offset)
    items = [
        NewsItem(
            id=str(row["id"]),
            sourceId=str(row["source_id"]),
            sourceTitle=str(row["source_title"]),
            title=str(row["title"]),
            url=str(row["url"]) if row.get("url") else None,
            content=str(row["content"]),
            imageUrl=images.asset_url(str(row["image_asset"])) if row.get("image_asset") else None,
            sourceIconUrl=(
                images.asset_url(str(row["source_icon_asset"]))
                if row.get("source_icon_asset")
                else None
            ),
            author=str(row["author"]) if row.get("author") else None,
            publishedAt=str(row["published_at"]) if row.get("published_at") else None,
            fetchedAt=str(row["fetched_at"]),
        )
        for row in rows
    ]
    return NewsItemListResponse(items=items, total=total, limit=limit, offset=offset)
