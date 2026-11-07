"""资讯订阅 API 的请求与响应模型。"""

from datetime import datetime, timedelta, timezone
from typing import Literal
from urllib.parse import urlsplit, urlunsplit

from pydantic import BaseModel, Field, field_validator, model_validator


class NewsSourceCreateRequest(BaseModel):
    url: str = Field(min_length=8, max_length=2048)
    xiaoheiheSection: Literal["news", "discount"] = "news"
    xiaoheihePlatform: Literal["pc", "switch", "psn", "xbox"] = "pc"

    @field_validator("url")
    @classmethod
    def normalize_url(cls, value: str) -> str:
        clean = value.strip()
        if any(character.isspace() for character in clean):
            raise ValueError("订阅地址不能包含空格或换行")
        try:
            parsed = urlsplit(clean)
            hostname = parsed.hostname
            parsed.port  # 检查无效端口
        except ValueError as exc:
            raise ValueError("订阅地址格式无效") from exc
        if parsed.scheme.lower() not in {"http", "https"} or not hostname:
            raise ValueError("订阅地址必须是包含主机名的 HTTP 或 HTTPS 地址")
        if parsed.username is not None or parsed.password is not None:
            raise ValueError("订阅地址不能包含用户名或密码")
        return urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), parsed.path, parsed.query, ""))


class NewsSource(BaseModel):
    id: str
    url: str
    title: str
    iconUrl: str | None = None
    sourceType: Literal["rss", "tieba", "xiaoheihe"] = "rss"
    xiaoheiheSection: Literal["news", "discount", "topic"] | None = None
    xiaoheihePlatform: Literal["pc", "switch", "psn", "xbox"] | None = None
    xiaoheiheTopicId: str | None = None
    isActive: bool
    createdAt: str
    lastCheckedAt: str | None = None
    lastSuccessAt: str | None = None
    lastError: str | None = None
    itemCount: int = 0


class NewsSourceListResponse(BaseModel):
    items: list[NewsSource]
    totalItemCount: int = 0


class NewsItem(BaseModel):
    id: str
    sourceId: str
    sourceTitle: str
    title: str
    url: str | None = None
    content: str = ""
    imageUrl: str | None = None
    sourceIconUrl: str | None = None
    author: str | None = None
    publishedAt: str | None = None
    fetchedAt: str
    recommendationReason: str | None = None
    userFeedback: Literal["like", "not_interested"] | None = None


class NewsItemListResponse(BaseModel):
    items: list[NewsItem]
    total: int
    limit: int
    offset: int
    view: Literal["latest", "recommended"] = "latest"
    recommendationState: Literal["not_applicable", "ready", "warming_up", "no_matches", "keyword_fallback"] = "not_applicable"


VideoTopicSearchProvider = Literal["douyin", "bilibili", "kuaishou"]
TopicSearchProvider = Literal[
    "local", "tieba", "xiaoheihe", "zhihu", "weibo", "douyin", "bilibili", "kuaishou"
]


class TopicSearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=160)
    providers: list[TopicSearchProvider] = Field(
        default_factory=lambda: ["local", "tieba", "xiaoheihe", "zhihu", "weibo", "douyin", "bilibili", "kuaishou"],
        min_length=1,
        max_length=8,
    )
    timeRange: Literal["all", "24h", "7d", "30d"] = "all"
    cursor: str | None = Field(default=None, max_length=24000)

    @field_validator("query")
    @classmethod
    def normalize_query(cls, value: str) -> str:
        clean = " ".join(value.split())
        if not clean:
            raise ValueError("请输入话题关键词")
        return clean

    @field_validator("providers")
    @classmethod
    def unique_providers(cls, value: list[str]) -> list[str]:
        if len(set(value)) != len(value):
            raise ValueError("平台不能重复选择")
        return value


class TopicSearchItem(BaseModel):
    key: str
    provider: TopicSearchProvider
    providerTitle: str
    title: str
    author: str | None = None
    publishedAt: str | None = None
    content: str = ""
    imageUrl: str | None = None
    url: str | None = None


class TopicSearchProviderState(BaseModel):
    provider: TopicSearchProvider
    title: str
    state: Literal[
        "success",
        "empty",
        "unsupported",
        "login_required",
        "auth_expired_fallback",
        "timeout",
        "error",
        "not_selected",
    ]
    message: str = ""
    connected: bool = False
    useAuthenticated: bool = False


class TopicSearchResponse(BaseModel):
    requestId: str
    query: str
    items: list[TopicSearchItem]
    states: list[TopicSearchProviderState]
    nextCursor: str | None = None
    commentTaskId: str | None = None


class TopicSearchComment(BaseModel):
    key: str
    author: str | None = Field(default=None, max_length=160)
    content: str = Field(default="", max_length=4000)
    publishedAt: str | None = Field(default=None, max_length=100)
    likeCount: int | None = Field(default=None, ge=0)
    url: str | None = Field(default=None, max_length=2048)


TopicSearchCommentState = Literal[
    "queued", "running", "completed", "partial", "failed", "login_required", "limited"
]
TopicSearchCommentTaskState = Literal[
    "queued", "running", "completed", "partial", "failed", "expired"
]


class TopicSearchVideoComments(BaseModel):
    key: str
    provider: VideoTopicSearchProvider
    providerTitle: str
    title: str
    url: str | None = None
    state: TopicSearchCommentState
    message: str = ""
    comments: list[TopicSearchComment] = Field(default_factory=list, max_length=10)


class TopicSearchCommentProviderState(BaseModel):
    provider: VideoTopicSearchProvider
    title: str
    state: TopicSearchCommentState
    message: str = ""
    videoCount: int = 0
    completedVideoCount: int = 0
    commentCount: int = 0


class TopicSearchCommentTaskResponse(BaseModel):
    taskId: str
    state: TopicSearchCommentTaskState
    createdAt: str
    expiresAt: str
    providers: list[TopicSearchCommentProviderState] = Field(default_factory=list)
    items: list[TopicSearchVideoComments] = Field(default_factory=list)


class TopicSearchAuthResponse(BaseModel):
    provider: Literal["tieba", "zhihu", "weibo", "douyin", "bilibili", "kuaishou"]
    connected: bool
    state: Literal["disconnected", "connecting", "connected", "login_required"]
    useAuthenticated: bool = False
    loginImage: str | None = None
    message: str = ""


class TopicSearchPreferenceRequest(BaseModel):
    provider: Literal["tieba", "zhihu", "weibo", "douyin", "bilibili", "kuaishou"]
    useAuthenticated: bool


class TopicSearchPreferencesResponse(BaseModel):
    tieba: bool = False
    zhihu: bool = False
    weibo: bool = False
    douyin: bool = False
    bilibili: bool = False
    kuaishou: bool = False


class TopicSearchPreferenceResponse(BaseModel):
    preferences: TopicSearchPreferencesResponse


class NewsReadingHistoryItem(NewsItem):
    lastOpenedAt: str
    openCount: int


class NewsReadingHistoryResponse(BaseModel):
    items: list[NewsReadingHistoryItem]
    total: int
    limit: int
    offset: int


class NewsSourceRefreshResult(BaseModel):
    sourceId: str
    sourceTitle: str
    newItems: int = 0
    notModified: bool = False
    error: str | None = None


class NewsSourceMutationResponse(BaseModel):
    source: NewsSource
    newItems: int = 0
    notModified: bool = False


class NewsRefreshAllResponse(BaseModel):
    items: list[NewsSourceRefreshResult]
    newItems: int = 0


class NewsSourceDeleteResponse(BaseModel):
    ok: bool


class XiaoheiheLoginResponse(BaseModel):
    loginId: str
    state: Literal[
        "waiting_scan",
        "scanned_waiting_confirmation",
        "success",
        "expired",
        "failed",
        "cancelled",
    ]
    message: str
    expiresAt: str
    qrImage: str | None = None
    uid: str | None = None
    nickname: str | None = None


class XiaoheiheAccountResponse(BaseModel):
    connected: bool
    uid: str | None = None
    nickname: str | None = None
    loggedInAt: str | None = None


class XiaoheiheTopic(BaseModel):
    id: str
    name: str
    group: str = ""
    subscribed: bool = False


class XiaoheiheTopicListResponse(BaseModel):
    items: list[XiaoheiheTopic]


class XiaoheiheTopicSubscribeRequest(BaseModel):
    topicIds: list[str] = Field(min_length=1, max_length=20)

    @field_validator("topicIds")
    @classmethod
    def validate_topic_ids(cls, values: list[str]) -> list[str]:
        normalized = [value.strip() for value in values]
        if any(not value.isdigit() or len(value) > 32 for value in normalized):
            raise ValueError("小黑盒话题 ID 必须是 1 到 32 位数字")
        if len(set(normalized)) != len(normalized):
            raise ValueError("话题列表中不能包含重复 ID")
        return normalized


class XiaoheiheTopicSubscribeResponse(BaseModel):
    sources: list[NewsSource]
    newItems: int = 0


class XiaoheiheLogoutResponse(BaseModel):
    ok: bool


class NewsBrowserSessionTicketResponse(BaseModel):
    ticket: str


class NewsBrowserSessionExchangeRequest(BaseModel):
    ticket: str = Field(min_length=20, max_length=256)


class NewsBrowserSessionExchangeResponse(BaseModel):
    ok: bool


class InterestEventInput(BaseModel):
    eventKey: str = Field(min_length=8, max_length=128)
    eventType: Literal["reader_impression", "open_original", "like", "not_interested", "less_like_this"]
    itemId: str = Field(min_length=1, max_length=128)


class InterestEventsRequest(BaseModel):
    events: list[InterestEventInput] = Field(min_length=1, max_length=100)


class InterestEventsResponse(BaseModel):
    accepted: int


class BrowserHistoryVisitInput(BaseModel):
    clientId: str = Field(pattern=r"^[a-f0-9]{32}$")
    visitId: str = Field(min_length=1, max_length=128)
    url: str = Field(min_length=8, max_length=4096)
    title: str = Field(default="", max_length=500)
    visitedAt: datetime
    transition: str = Field(min_length=1, max_length=64)

    @field_validator("visitedAt")
    @classmethod
    def require_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            raise ValueError("访问时间必须包含时区")
        return value.astimezone(timezone.utc)

    @field_validator("url")
    @classmethod
    def validate_url(cls, value: str) -> str:
        clean = value.strip()
        try:
            parsed = urlsplit(clean)
            hostname = parsed.hostname
            parsed.port
        except ValueError as exc:
            raise ValueError("浏览记录地址格式无效") from exc
        if parsed.scheme.lower() not in {"http", "https"} or not hostname:
            raise ValueError("只允许导入 HTTP 或 HTTPS 浏览记录")
        if parsed.username is not None or parsed.password is not None:
            raise ValueError("浏览记录地址不能包含用户名或密码")
        return clean


class BrowserHistoryVisitsRequest(BaseModel):
    visits: list[BrowserHistoryVisitInput] = Field(min_length=1, max_length=100)


class BrowserHistoryProfile(BaseModel):
    id: str
    browser: Literal["edge", "chrome"]
    name: str


class BrowserHistoryProfilesResponse(BaseModel):
    items: list[BrowserHistoryProfile]


class BrowserHistoryImportRequest(BaseModel):
    profileId: str = Field(min_length=16, max_length=64)
    rangeStart: datetime
    rangeEnd: datetime

    @field_validator("rangeStart", "rangeEnd")
    @classmethod
    def require_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            raise ValueError("时间范围必须包含时区")
        return value.astimezone(timezone.utc)

    @model_validator(mode="after")
    def validate_range(self) -> "BrowserHistoryImportRequest":
        if self.rangeEnd <= self.rangeStart:
            raise ValueError("结束时间必须晚于开始时间")
        if self.rangeEnd - self.rangeStart > timedelta(days=366):
            raise ValueError("单次最多导入 366 天的浏览历史")
        return self


class BrowserHistoryImportResponse(BaseModel):
    batchId: str
    browser: Literal["edge", "chrome"]
    visitsRead: int
    eventsAdded: int
    status: Literal["running", "completed", "cancelled", "failed"]
    error: str | None = None


class InterestTopic(BaseModel):
    key: str
    label: str
    score: float
    evidenceCount: int
    lastSeenAt: str | None = None
    keywords: list[str] = Field(default_factory=list)


class InterestProfile(BaseModel):
    id: str
    algorithmVersion: str
    windowStart: str
    windowEnd: str
    generatedAt: str
    eventCount: int
    topics: list[InterestTopic]


class InterestProfileResponse(BaseModel):
    profile: InterestProfile | None = None
    eventCount: int = 0


class InterestProfileRebuildResponse(BaseModel):
    profile: InterestProfile


class InterestSuggestionGenerateRequest(BaseModel):
    useModel: bool = False


class InterestSuggestion(BaseModel):
    id: str
    provider: str
    platformTopicId: str
    title: str
    group: str = ""
    score: float
    reason: str = ""
    status: Literal["pending", "accepted", "dismissed"]
    sourceId: str | None = None


class InterestSuggestionGenerateResponse(BaseModel):
    profile: InterestProfile
    algorithm: str
    suggestions: list[InterestSuggestion]


class InterestSuggestionDecisionRequest(BaseModel):
    action: Literal["accept", "dismiss"]


class InterestSuggestionDecisionResponse(BaseModel):
    ok: bool
    source: NewsSource | None = None
    newItems: int = 0


class InterestDataClearResponse(BaseModel):
    ok: bool
    events: int
    batches: int
    profiles: int
    suggestions: int
