"""资讯订阅 API 的请求与响应模型。"""

from typing import Literal
from urllib.parse import urlsplit, urlunsplit

from pydantic import BaseModel, Field, field_validator


class NewsSourceCreateRequest(BaseModel):
    url: str = Field(min_length=8, max_length=2048)

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


class NewsItemListResponse(BaseModel):
    items: list[NewsItem]
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


class NewsBrowserSessionTicketResponse(BaseModel):
    ticket: str


class NewsBrowserSessionExchangeRequest(BaseModel):
    ticket: str = Field(min_length=20, max_length=256)


class NewsBrowserSessionExchangeResponse(BaseModel):
    ok: bool
