"""资讯订阅和本地条目 API。"""

import asyncio
import uuid
from datetime import datetime, timezone
from typing import Literal
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import FileResponse

from schemas.news import (
    NewsItem,
    NewsItemListResponse,
    NewsReadingHistoryItem,
    NewsReadingHistoryResponse,
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
    BrowserHistoryImportRequest,
    BrowserHistoryImportResponse,
    BrowserHistoryProfilesResponse,
    BrowserHistoryVisitsRequest,
    InterestDataClearResponse,
    InterestEventsRequest,
    InterestEventsResponse,
    InterestProfile,
    InterestProfileRebuildResponse,
    InterestProfileResponse,
    InterestSuggestionDecisionRequest,
    InterestSuggestionDecisionResponse,
    InterestSuggestionGenerateRequest,
    InterestSuggestionGenerateResponse,
    XiaoheiheAccountResponse,
    XiaoheiheLoginResponse,
    XiaoheiheLogoutResponse,
    XiaoheiheTopic,
    XiaoheiheTopicListResponse,
    XiaoheiheTopicSubscribeRequest,
    XiaoheiheTopicSubscribeResponse,
    TopicSearchAuthResponse,
    TopicSearchPreferenceRequest,
    TopicSearchPreferenceResponse,
    TopicSearchPreferencesResponse,
    TopicSearchRequest,
    TopicSearchResponse,
    TopicSearchCommentTaskResponse,
)
from services import storage
from services.auth import require_api_token
from services.news import browser_history, collector, db, images, interest, topic_search, xiaoheihe, xiaoheihe_auth
from services.news.tieba import parse_forum_name
from services.news.web_auth import NEWS_SESSION_COOKIE, is_valid_session_exchange_origin, require_news_access
from services.news import web_sessions

router = APIRouter(prefix="/news", tags=["资讯"])


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _source_model(row: dict[str, object]) -> NewsSource:
    source_type = str(row.get("source_type") or "rss")
    xiaoheihe_section = None
    xiaoheihe_platform = None
    xiaoheihe_topic_id = None
    source_url = str(row["url"])
    if source_type == "xiaoheihe":
        source_url = xiaoheihe.HOMEPAGE_URL
        try:
            xiaoheihe_section, xiaoheihe_platform = xiaoheihe.source_config(str(row["url"]))
            if xiaoheihe_section == "topic":
                xiaoheihe_topic_id = xiaoheihe.topic_id_from_source_url(str(row["url"]))
        except ValueError:
            # 保留错误配置来源的可见性，采集刷新时会给出具体错误。
            xiaoheihe_section, xiaoheihe_platform = "news", "pc"
    return NewsSource(
        id=str(row["id"]),
        url=source_url,
        title=str(row["title"]),
        iconUrl=images.asset_url(str(row["icon_asset"])) if row.get("icon_asset") else None,
        sourceType=source_type,
        xiaoheiheSection=xiaoheihe_section,
        xiaoheihePlatform=xiaoheihe_platform,
        xiaoheiheTopicId=xiaoheihe_topic_id,
        isActive=bool(row["is_active"]),
        createdAt=str(row["created_at"]),
        lastCheckedAt=str(row["last_checked_at"]) if row.get("last_checked_at") else None,
        lastSuccessAt=str(row["last_success_at"]) if row.get("last_success_at") else None,
        lastError=str(row["last_error"]) if row.get("last_error") else None,
        itemCount=int(row.get("item_count") or 0),
    )


def _refresh_model(result: collector.RefreshResult) -> NewsSourceRefreshResult:
    return NewsSourceRefreshResult(**result)


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"


def _auth_http_error(error: Exception) -> HTTPException:
    if isinstance(error, xiaoheihe_auth.XiaoheiheCredentialsExpiredError):
        return HTTPException(status_code=401, detail="小黑盒登录已失效，请重新扫码")
    if isinstance(error, xiaoheihe_auth.XiaoheiheNotLoggedInError):
        return HTTPException(status_code=401, detail="请先扫码登录小黑盒")
    if isinstance(error, xiaoheihe_auth.XiaoheiheAuthError):
        return HTTPException(status_code=502, detail=str(error))
    if isinstance(error, httpx.HTTPStatusError):
        return HTTPException(status_code=502, detail=f"小黑盒接口返回 HTTP {error.response.status_code}")
    if isinstance(error, httpx.HTTPError):
        return HTTPException(status_code=502, detail="暂时无法连接小黑盒，请稍后重试")
    if isinstance(error, RuntimeError):
        return HTTPException(status_code=503, detail=str(error))
    return HTTPException(status_code=502, detail="小黑盒接口暂时不可用，请稍后重试")


@router.post(
    "/xiaoheihe/login/qr",
    response_model=XiaoheiheLoginResponse,
    dependencies=[Depends(require_news_access)],
    summary="申请小黑盒扫码登录二维码",
)
async def create_xiaoheihe_login_qr(response: Response) -> XiaoheiheLoginResponse:
    _no_store(response)
    try:
        return XiaoheiheLoginResponse(**await xiaoheihe_auth.auth_service.create_qr())
    except Exception as error:
        raise _auth_http_error(error) from error


@router.get(
    "/xiaoheihe/login/{login_id}",
    response_model=XiaoheiheLoginResponse,
    dependencies=[Depends(require_news_access)],
    summary="查询小黑盒扫码状态",
)
async def get_xiaoheihe_login_status(login_id: str, response: Response) -> XiaoheiheLoginResponse:
    _no_store(response)
    return XiaoheiheLoginResponse(**await xiaoheihe_auth.auth_service.check_qr(login_id))


@router.delete(
    "/xiaoheihe/login/{login_id}",
    response_model=XiaoheiheLogoutResponse,
    dependencies=[Depends(require_news_access)],
    summary="取消小黑盒扫码登录",
)
async def cancel_xiaoheihe_login(login_id: str, response: Response) -> XiaoheiheLogoutResponse:
    _no_store(response)
    await xiaoheihe_auth.auth_service.cancel_qr(login_id)
    return XiaoheiheLogoutResponse(ok=True)


@router.get(
    "/xiaoheihe/account",
    response_model=XiaoheiheAccountResponse,
    dependencies=[Depends(require_news_access)],
    summary="查询本地小黑盒账号授权状态",
)
def get_xiaoheihe_account(response: Response) -> XiaoheiheAccountResponse:
    _no_store(response)
    try:
        return XiaoheiheAccountResponse(**xiaoheihe_auth.auth_service.account_status())
    except Exception as error:
        raise _auth_http_error(error) from error


@router.delete(
    "/xiaoheihe/account",
    response_model=XiaoheiheLogoutResponse,
    dependencies=[Depends(require_news_access)],
    summary="清除本地小黑盒登录凭据",
)
def logout_xiaoheihe(response: Response) -> XiaoheiheLogoutResponse:
    _no_store(response)
    try:
        xiaoheihe_auth.auth_service.logout()
    except Exception as error:
        raise _auth_http_error(error) from error
    return XiaoheiheLogoutResponse(ok=True)


@router.get(
    "/xiaoheihe/topics",
    response_model=XiaoheiheTopicListResponse,
    dependencies=[Depends(require_news_access)],
    summary="读取小黑盒话题目录",
)
async def list_xiaoheihe_topics(response: Response) -> XiaoheiheTopicListResponse:
    _no_store(response)
    try:
        topics = await xiaoheihe_auth.auth_service.list_topics()
    except Exception as error:
        raise _auth_http_error(error) from error
    subscribed_ids: set[str] = set()
    for source in await asyncio.to_thread(db.list_sources):
        if str(source.get("source_type")) != "xiaoheihe":
            continue
        try:
            section, _ = xiaoheihe.source_config(str(source["url"]))
            if section == "topic":
                subscribed_ids.add(xiaoheihe.topic_id_from_source_url(str(source["url"])))
        except ValueError:
            continue
    return XiaoheiheTopicListResponse(
        items=[XiaoheiheTopic(**topic, subscribed=topic["id"] in subscribed_ids) for topic in topics]
    )


@router.post(
    "/xiaoheihe/subscriptions",
    response_model=XiaoheiheTopicSubscribeResponse,
    dependencies=[Depends(require_news_access)],
    summary="订阅小黑盒话题",
)
async def subscribe_xiaoheihe_topics(
    payload: XiaoheiheTopicSubscribeRequest,
    response: Response,
) -> XiaoheiheTopicSubscribeResponse:
    _no_store(response)
    try:
        topics = await xiaoheihe_auth.auth_service.list_topics()
    except Exception as error:
        raise _auth_http_error(error) from error
    topic_map = {topic["id"]: topic for topic in topics}
    unknown_ids = [topic_id for topic_id in payload.topicIds if topic_id not in topic_map]
    if unknown_ids:
        raise HTTPException(status_code=422, detail="话题目录已更新，请刷新后重新选择")

    sources: list[NewsSource] = []
    new_items = 0
    for topic_id in payload.topicIds:
        topic = topic_map[topic_id]
        source_url = xiaoheihe.build_topic_source_url(topic_id)
        existing = await asyncio.to_thread(db.get_source_by_url, source_url)
        needs_refresh = True
        added_subscription = False
        if existing and bool(existing["is_active"]) and not bool(existing.get("is_deleted")):
            source_id = str(existing["id"])
            needs_refresh = False
        elif existing:
            source_id = str(existing["id"])
            added_subscription = True
            await asyncio.to_thread(db.restore_source_subscription, source_id)
        else:
            source_id = uuid.uuid4().hex
            added_subscription = True
            title = " · ".join(part for part in (topic.get("group", ""), topic["name"]) if part)
            await asyncio.to_thread(
                db.create_source,
                source_id,
                source_url,
                f"小黑盒 · {title}",
                _timestamp(),
                "xiaoheihe",
            )
        if added_subscription:
            await asyncio.to_thread(interest.record_subscription_added, source_id)
        if needs_refresh:
            result = await collector.refresh_source(source_id)
            new_items += int(result["newItems"])
        row = await asyncio.to_thread(db.get_source, source_id)
        if row is not None:
            sources.append(_source_model(row))
    return XiaoheiheTopicSubscribeResponse(sources=sources, newItems=new_items)


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


@router.post(
    "/interests/events",
    response_model=InterestEventsResponse,
    dependencies=[Depends(require_news_access)],
    summary="记录资讯阅读和反馈行为",
)
def record_interest_events(payload: InterestEventsRequest) -> InterestEventsResponse:
    accepted = interest.record_reader_events(
        [
            {
                "event_key": event.eventKey,
                "event_type": event.eventType,
                "item_id": event.itemId,
            }
            for event in payload.events
        ]
    )
    return InterestEventsResponse(accepted=accepted)


@router.post(
    "/interests/history-visits",
    response_model=InterestEventsResponse,
    dependencies=[Depends(require_news_access)],
    summary="记录扩展同步的浏览器访问事件",
)
def record_browser_history_visits(
    payload: BrowserHistoryVisitsRequest,
    response: Response,
) -> InterestEventsResponse:
    _no_store(response)
    accepted = interest.record_extension_history_visits(
        [
            {
                "client_id": visit.clientId,
                "visit_id": visit.visitId,
                "url": visit.url,
                "title": visit.title,
                "visited_at": visit.visitedAt.isoformat(),
                "transition": visit.transition,
            }
            for visit in payload.visits
        ]
    )
    return InterestEventsResponse(accepted=accepted)


@router.get(
    "/interests/browser-profiles",
    response_model=BrowserHistoryProfilesResponse,
    dependencies=[Depends(require_news_access)],
    summary="列出可导入的本机浏览器配置文件",
)
def list_browser_history_profiles(response: Response) -> BrowserHistoryProfilesResponse:
    _no_store(response)
    return BrowserHistoryProfilesResponse(items=browser_history.list_profiles())


@router.post(
    "/interests/browser-import",
    response_model=BrowserHistoryImportResponse,
    dependencies=[Depends(require_news_access)],
    summary="导入用户选择的浏览器历史范围",
)
def import_browser_history(
    payload: BrowserHistoryImportRequest,
    response: Response,
    background_tasks: BackgroundTasks,
) -> BrowserHistoryImportResponse:
    _no_store(response)
    try:
        result = interest.start_browser_history_import(
            payload.profileId,
            payload.rangeStart,
            payload.rangeEnd,
        )
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    background_tasks.add_task(
        interest.run_browser_history_import,
        str(result["batchId"]),
        payload.profileId,
        payload.rangeStart,
        payload.rangeEnd,
    )
    return BrowserHistoryImportResponse(**result)


@router.get(
    "/interests/browser-import/{batch_id}",
    response_model=BrowserHistoryImportResponse,
    dependencies=[Depends(require_news_access)],
    summary="读取浏览器历史导入进度",
)
def get_browser_history_import_status(batch_id: str, response: Response) -> BrowserHistoryImportResponse:
    _no_store(response)
    result = interest.get_browser_history_import(batch_id)
    if result is None:
        raise HTTPException(status_code=404, detail="浏览器历史导入批次不存在")
    return BrowserHistoryImportResponse(**result)


@router.delete(
    "/interests/browser-import/{batch_id}",
    response_model=BrowserHistoryImportResponse,
    dependencies=[Depends(require_news_access)],
    summary="取消浏览器历史导入",
)
def cancel_browser_history_import(batch_id: str, response: Response) -> BrowserHistoryImportResponse:
    _no_store(response)
    result = interest.cancel_browser_history_import(batch_id)
    if result is None:
        raise HTTPException(status_code=404, detail="浏览器历史导入批次不存在")
    return BrowserHistoryImportResponse(**result)


@router.get(
    "/interests/profile",
    response_model=InterestProfileResponse,
    dependencies=[Depends(require_news_access)],
    summary="读取本地兴趣画像",
)
def get_interest_profile(response: Response) -> InterestProfileResponse:
    _no_store(response)
    profile = interest.latest_profile()
    return InterestProfileResponse(
        profile=InterestProfile(**profile) if profile else None,
        eventCount=db.count_interest_events(),
    )


@router.post(
    "/interests/profile/rebuild",
    response_model=InterestProfileRebuildResponse,
    dependencies=[Depends(require_news_access)],
    summary="重新计算本地兴趣画像",
)
async def rebuild_interest_profile(response: Response) -> InterestProfileRebuildResponse:
    _no_store(response)
    profile = await asyncio.to_thread(interest.rebuild_profile)
    return InterestProfileRebuildResponse(profile=InterestProfile(**profile))


@router.post(
    "/interests/suggestions",
    response_model=InterestSuggestionGenerateResponse,
    dependencies=[Depends(require_news_access)],
    summary="根据本地兴趣生成小黑盒话题建议",
)
async def generate_interest_suggestions(
    payload: InterestSuggestionGenerateRequest,
    response: Response,
) -> InterestSuggestionGenerateResponse:
    _no_store(response)
    model_config = storage.get_model_config() if payload.useModel else None
    if payload.useModel and model_config is None:
        raise HTTPException(status_code=409, detail="请先在 TabKeep 设置中配置模型")
    try:
        topic_rows = await xiaoheihe_auth.auth_service.list_topics()
    except Exception as error:
        raise _auth_http_error(error) from error
    subscribed_topic_ids: set[str] = set()
    for source in await asyncio.to_thread(db.list_sources):
        if str(source.get("source_type")) != "xiaoheihe" or not bool(source.get("is_active")):
            continue
        try:
            section, _platform = xiaoheihe.source_config(str(source["url"]))
            if section == "topic":
                subscribed_topic_ids.add(xiaoheihe.topic_id_from_source_url(str(source["url"])))
        except ValueError:
            continue
    candidates = [
        {"id": str(topic["id"]), "name": str(topic["name"]), "group": str(topic.get("group", ""))}
        for topic in topic_rows
        if str(topic["id"]) not in subscribed_topic_ids
    ]
    try:
        result = await interest.generate_topic_suggestions(candidates, payload.useModel, model_config)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=502, detail="生成话题建议失败，请稍后重试") from error
    return InterestSuggestionGenerateResponse(
        profile=InterestProfile(**result["profile"]),
        algorithm=str(result["algorithm"]),
        suggestions=result["suggestions"],
    )


@router.post(
    "/interests/suggestions/{suggestion_id}/decision",
    response_model=InterestSuggestionDecisionResponse,
    dependencies=[Depends(require_news_access)],
    summary="接受或忽略话题建议",
)
async def decide_interest_suggestion(
    suggestion_id: str,
    payload: InterestSuggestionDecisionRequest,
    response: Response,
) -> InterestSuggestionDecisionResponse:
    _no_store(response)
    suggestion = db.get_topic_suggestion(suggestion_id)
    if suggestion is None:
        raise HTTPException(status_code=404, detail="话题建议不存在")
    if str(suggestion["status"]) != "pending":
        raise HTTPException(status_code=409, detail="这个话题建议已经处理")
    if payload.action == "dismiss":
        if not db.decide_topic_suggestion(suggestion_id, "dismissed", _timestamp()):
            raise HTTPException(status_code=409, detail="这个话题建议已经处理")
        interest.record_suggestion_event("suggestion_dismissed", suggestion)
        return InterestSuggestionDecisionResponse(ok=True)

    try:
        topics = await xiaoheihe_auth.auth_service.list_topics()
    except Exception as error:
        raise _auth_http_error(error) from error
    topic_id = str(suggestion["platform_topic_id"])
    topic = next((item for item in topics if str(item["id"]) == topic_id), None)
    if topic is None:
        raise HTTPException(status_code=409, detail="话题目录已更新，请重新生成建议")
    source_url = xiaoheihe.build_topic_source_url(topic_id)
    existing = await asyncio.to_thread(db.get_source_by_url, source_url)
    added_subscription = False
    if existing and bool(existing["is_active"]) and not bool(existing.get("is_deleted")):
        source_id = str(existing["id"])
        new_items = 0
    elif existing:
        source_id = str(existing["id"])
        added_subscription = True
        await asyncio.to_thread(db.restore_source_subscription, source_id)
        result = await collector.refresh_source(source_id)
        new_items = int(result["newItems"])
    else:
        source_id = uuid.uuid4().hex
        title = " · ".join(part for part in (str(topic.get("group", "")), str(topic["name"])) if part)
        added_subscription = True
        await asyncio.to_thread(
            db.create_source,
            source_id,
            source_url,
            f"小黑盒 · {title}",
            _timestamp(),
            "xiaoheihe",
        )
        result = await collector.refresh_source(source_id)
        new_items = int(result["newItems"])
    if added_subscription:
        interest.record_subscription_added(source_id)
    if not db.decide_topic_suggestion(suggestion_id, "accepted", _timestamp(), source_id):
        raise HTTPException(status_code=409, detail="这个话题建议已经处理")
    interest.record_suggestion_event("suggestion_accepted", suggestion, source_id)
    source_row = await asyncio.to_thread(db.get_source, source_id)
    return InterestSuggestionDecisionResponse(
        ok=True,
        source=_source_model(source_row) if source_row else None,
        newItems=new_items,
    )


@router.delete(
    "/interests/data",
    response_model=InterestDataClearResponse,
    dependencies=[Depends(require_news_access)],
    summary="清除本地兴趣事件和画像",
)
def clear_interest_data(response: Response) -> InterestDataClearResponse:
    _no_store(response)
    counts = db.clear_interest_data()
    return InterestDataClearResponse(ok=True, **counts)


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
    if source_type == "xiaoheihe":
        try:
            source_url = xiaoheihe.build_source_url(
                request.xiaoheiheSection,
                request.xiaoheihePlatform,
            )
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
    else:
        source_url = request.url
    existing = await asyncio.to_thread(db.get_source_by_url, source_url)
    if existing and bool(existing["is_active"]) and not bool(existing.get("is_deleted")):
        raise HTTPException(status_code=409, detail="这个订阅地址已经添加")
    added_subscription = False
    if existing:
        source_id = str(existing["id"])
        added_subscription = True
        await asyncio.to_thread(db.restore_source_subscription, source_id)
    else:
        source_id = uuid.uuid4().hex
        added_subscription = True
        source_title = (
            forum_name
            or (
                xiaoheihe.source_title(request.xiaoheiheSection, request.xiaoheihePlatform)
                if source_type == "xiaoheihe"
                else None
            )
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
    if added_subscription:
        await asyncio.to_thread(interest.record_subscription_added, source_id)
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
async def list_items(
    source_id: str | None = Query(default=None, alias="sourceId"),
    view: str = Query(default="latest", pattern="^(latest|recommended)$"),
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> NewsItemListResponse:
    if view == "recommended":
        result = await interest.recommended_items(source_id, limit, offset)
        rows = result["items"]
        total = int(result["total"])
        recommendation_state = str(result["recommendation_state"])
    else:
        rows, total = db.list_items(source_id, limit, offset)
        recommendation_state = "not_applicable"
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
            recommendationReason=(
                str(row["recommendation_reason"])
                if row.get("recommendation_reason")
                else None
            ),
            userFeedback=(
                str(row["user_feedback"])
                if row.get("user_feedback") in {"like", "not_interested"}
                else None
            ),
        )
        for row in rows
    ]
    return NewsItemListResponse(
        items=items,
        total=total,
        limit=limit,
        offset=offset,
        view=view,
        recommendationState=recommendation_state,
    )


@router.get(
    "/reading-history",
    response_model=NewsReadingHistoryResponse,
    dependencies=[Depends(require_news_access)],
    summary="读取点击过原文的资讯记录",
)
def list_reading_history(
    response: Response,
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> NewsReadingHistoryResponse:
    _no_store(response)
    rows, total = db.list_reading_history(limit, offset)
    items = [
        NewsReadingHistoryItem(
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
            userFeedback=(
                str(row["user_feedback"])
                if row.get("user_feedback") in {"like", "not_interested"}
                else None
            ),
            lastOpenedAt=str(row["last_opened_at"]),
            openCount=int(row["open_count"]),
        )
        for row in rows
    ]
    return NewsReadingHistoryResponse(items=items, total=total, limit=limit, offset=offset)


@router.post(
    "/topic-search",
    response_model=TopicSearchResponse,
    dependencies=[Depends(require_news_access)],
    summary="并行搜索本地资讯和公开平台",
)
async def search_topic(request: TopicSearchRequest, response: Response) -> TopicSearchResponse:
    _no_store(response)
    try:
        result = await topic_search.search_topics(
            query=request.query,
            providers=request.providers,
            time_range=request.timeRange,
            cursor_value=request.cursor,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return TopicSearchResponse(**result)


@router.get(
    "/topic-search/comments/{task_id}",
    response_model=TopicSearchCommentTaskResponse,
    dependencies=[Depends(require_news_access)],
    summary="读取本次话题搜索的视频评论任务",
)
async def get_topic_search_comments(task_id: str, response: Response) -> TopicSearchCommentTaskResponse:
    _no_store(response)
    snapshot = topic_search.video_comment_jobs.get(task_id)
    if snapshot is None:
        if topic_search.video_comment_jobs.is_expired(task_id):
            raise HTTPException(status_code=410, detail="评论采集任务已过期")
        raise HTTPException(status_code=404, detail="评论采集任务不存在")
    if snapshot.get("state") == "expired":
        raise HTTPException(status_code=410, detail="评论采集任务已过期")
    return TopicSearchCommentTaskResponse(**snapshot)


@router.get(
    "/topic-search/preferences",
    response_model=TopicSearchPreferencesResponse,
    dependencies=[Depends(require_news_access)],
    summary="读取话题搜索的授权搜索偏好",
)
def get_topic_search_preferences(response: Response) -> TopicSearchPreferencesResponse:
    _no_store(response)
    return TopicSearchPreferencesResponse(**storage.get_news_search_preferences())


@router.post(
    "/topic-search/preferences",
    response_model=TopicSearchPreferenceResponse,
    dependencies=[Depends(require_news_access)],
    summary="保存话题搜索的授权搜索偏好",
)
def save_topic_search_preference(
    request: TopicSearchPreferenceRequest,
    response: Response,
) -> TopicSearchPreferenceResponse:
    _no_store(response)
    preferences = storage.set_news_search_preference(request.provider, request.useAuthenticated)
    return TopicSearchPreferenceResponse(preferences=TopicSearchPreferencesResponse(**preferences))


@router.post(
    "/topic-search/auth/{provider}/start",
    response_model=TopicSearchAuthResponse,
    dependencies=[Depends(require_news_access)],
    summary="在资讯弹窗中载入平台登录二维码",
)
async def start_topic_search_login(
    provider: Literal["tieba", "zhihu", "weibo", "douyin", "bilibili", "kuaishou"],
    response: Response,
) -> TopicSearchAuthResponse:
    _no_store(response)
    try:
        return TopicSearchAuthResponse(**await topic_search.browser_sessions.start_login(provider))
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post(
    "/topic-search/auth/{provider}/complete",
    response_model=TopicSearchAuthResponse,
    dependencies=[Depends(require_news_access)],
    summary="检查弹窗内的平台登录状态",
)
async def complete_topic_search_login(
    provider: Literal["tieba", "zhihu", "weibo", "douyin", "bilibili", "kuaishou"],
    response: Response,
) -> TopicSearchAuthResponse:
    _no_store(response)
    try:
        return TopicSearchAuthResponse(**await topic_search.browser_sessions.complete_login(provider))
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post(
    "/topic-search/auth/{provider}/cancel",
    response_model=TopicSearchAuthResponse,
    dependencies=[Depends(require_news_access)],
    summary="取消平台二维码登录",
)
async def cancel_topic_search_login(
    provider: Literal["tieba", "zhihu", "weibo", "douyin", "bilibili", "kuaishou"],
    response: Response,
) -> TopicSearchAuthResponse:
    _no_store(response)
    try:
        return TopicSearchAuthResponse(**await topic_search.browser_sessions.cancel_login(provider))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get(
    "/topic-search/auth/{provider}",
    response_model=TopicSearchAuthResponse,
    dependencies=[Depends(require_news_access)],
    summary="读取平台独立登录连接状态",
)
def get_topic_search_login_status(
    provider: Literal["tieba", "zhihu", "weibo", "douyin", "bilibili", "kuaishou"],
    response: Response,
) -> TopicSearchAuthResponse:
    _no_store(response)
    return TopicSearchAuthResponse(**topic_search.browser_sessions.status(provider))


@router.delete(
    "/topic-search/auth/{provider}",
    response_model=TopicSearchAuthResponse,
    dependencies=[Depends(require_news_access)],
    summary="清除平台独立登录配置",
)
async def disconnect_topic_search_login(
    provider: Literal["tieba", "zhihu", "weibo", "douyin", "bilibili", "kuaishou"],
    response: Response,
) -> TopicSearchAuthResponse:
    _no_store(response)
    try:
        return TopicSearchAuthResponse(**await topic_search.browser_sessions.disconnect(provider))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
