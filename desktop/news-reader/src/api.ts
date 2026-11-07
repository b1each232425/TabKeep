import type {
  NewsItemListResponse,
  NewsReadingHistoryResponse,
  NewsRefreshAllResponse,
  NewsSourceListResponse,
  NewsSourceMutationResponse,
  NewsSourceDeleteResponse,
  NewsSource,
} from "../../src/types"

export class NewsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "NewsApiError"
  }
}

const pendingSessionExchanges = new Map<string, Promise<{ ok: boolean }>>()

export interface XiaoheiheLogin {
  loginId: string
  state: "waiting_scan" | "scanned_waiting_confirmation" | "success" | "expired" | "failed" | "cancelled"
  message: string
  expiresAt: string
  qrImage?: string | null
  uid?: string | null
  nickname?: string | null
}

export interface XiaoheiheAccount {
  connected: boolean
  uid?: string | null
  nickname?: string | null
  loggedInAt?: string | null
}

export interface XiaoheiheTopic {
  id: string
  name: string
  group: string
  subscribed: boolean
}

export interface XiaoheiheSubscribeResult {
  sources: NewsSource[]
  newItems: number
}

export interface InterestEventsResponse {
  accepted: number
}

export type VideoTopicSearchProviderId = "douyin" | "bilibili" | "kuaishou"
export type TopicSearchProviderId = "local" | "tieba" | "xiaoheihe" | "zhihu" | "weibo" | VideoTopicSearchProviderId
export type TopicSearchProviderState = {
  provider: TopicSearchProviderId
  title: string
  state: "success" | "empty" | "unsupported" | "login_required" | "auth_expired_fallback" | "timeout" | "error" | "not_selected"
  message: string
  connected: boolean
  useAuthenticated: boolean
}
export type TopicSearchItem = {
  key: string
  provider: TopicSearchProviderId
  providerTitle: string
  title: string
  author: string | null
  publishedAt: string | null
  content: string
  imageUrl: string | null
  url: string | null
}
export type TopicSearchResponse = {
  requestId?: string
  query: string
  items: TopicSearchItem[]
  states: TopicSearchProviderState[]
  nextCursor: string | null
  commentTaskId: string | null
}
export type TopicSearchCommentState = "queued" | "running" | "completed" | "partial" | "failed" | "login_required" | "limited"
export type TopicSearchCommentTaskState = "queued" | "running" | "completed" | "partial" | "failed" | "expired"
export type TopicSearchComment = {
  key: string
  author: string | null
  content: string
  publishedAt: string | null
  likeCount?: number | null
  url: string | null
}
export type TopicSearchVideoComments = {
  key: string
  provider: VideoTopicSearchProviderId
  providerTitle: string
  title: string
  url: string | null
  state: TopicSearchCommentState
  message: string
  comments: TopicSearchComment[]
}
export type TopicSearchCommentProviderState = {
  provider: VideoTopicSearchProviderId
  title: string
  state: TopicSearchCommentState
  message: string
  videoCount: number
  completedVideoCount: number
  commentCount: number
}
export type TopicSearchCommentTaskResponse = {
  taskId: string
  state: TopicSearchCommentTaskState
  createdAt: string
  expiresAt: string
  providers: TopicSearchCommentProviderState[]
  items: TopicSearchVideoComments[]
}
export type TopicSearchAuthProvider = "tieba" | "zhihu" | "weibo" | VideoTopicSearchProviderId
export type TopicSearchAuth = {
  provider: TopicSearchAuthProvider
  connected: boolean
  state: "disconnected" | "connecting" | "connected" | "login_required"
  useAuthenticated: boolean
  loginImage: string | null
  message: string
}
export type TopicSearchPreferences = {
  tieba: boolean
  zhihu: boolean
  weibo: boolean
  douyin: boolean
  bilibili: boolean
  kuaishou: boolean
}

async function request<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  options: { keepalive?: boolean } = {},
): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    keepalive: options.keepalive,
  })
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  if (!response.ok) {
    const detail =
      payload && typeof payload === "object" && "detail" in payload && typeof payload.detail === "string"
        ? payload.detail
        : `请求失败（HTTP ${response.status}）`
    throw new NewsApiError(detail, response.status)
  }
  return payload as T
}

export function exchangeNewsWebSession(ticket: string): Promise<{ ok: boolean }> {
  const pending = pendingSessionExchanges.get(ticket)
  if (pending) return pending

  const exchange = request<{ ok: boolean }>("POST", "/news/browser-session/exchange", { ticket }).finally(() => {
    if (pendingSessionExchanges.get(ticket) === exchange) {
      pendingSessionExchanges.delete(ticket)
    }
  })
  pendingSessionExchanges.set(ticket, exchange)
  return exchange
}

export function listNewsSources(): Promise<NewsSourceListResponse> {
  return request("GET", "/news/sources")
}

export function addNewsSource(
  url: string,
  xiaoheiheSection: "news" | "discount" = "news",
  xiaoheihePlatform: "pc" | "switch" | "psn" | "xbox" = "pc",
): Promise<NewsSourceMutationResponse> {
  return request("POST", "/news/sources", { url, xiaoheiheSection, xiaoheihePlatform })
}

export function deleteNewsSource(sourceId: string): Promise<NewsSourceDeleteResponse> {
  return request("DELETE", `/news/sources/${encodeURIComponent(sourceId)}`)
}

export function refreshNewsSource(sourceId: string): Promise<NewsSourceMutationResponse> {
  return request("POST", `/news/sources/${encodeURIComponent(sourceId)}/refresh`)
}

export function refreshAllNewsSources(): Promise<NewsRefreshAllResponse> {
  return request("POST", "/news/refresh")
}

export function listNewsItems(options: {
  sourceId?: string | null
  view?: "latest" | "recommended"
  limit?: number
  offset?: number
} = {}): Promise<NewsItemListResponse> {
  const params = new URLSearchParams({
    limit: String(options.limit ?? 50),
    offset: String(options.offset ?? 0),
    view: options.view ?? "latest",
  })
  if (options.sourceId) params.set("sourceId", options.sourceId)
  return request("GET", `/news/items?${params.toString()}`)
}

export function listNewsReadingHistory(options: { limit?: number; offset?: number } = {}): Promise<NewsReadingHistoryResponse> {
  const params = new URLSearchParams({
    limit: String(options.limit ?? 50),
    offset: String(options.offset ?? 0),
  })
  return request("GET", `/news/reading-history?${params.toString()}`)
}

export function recordOriginalOpened(itemId: string): Promise<InterestEventsResponse> {
  return request(
    "POST",
    "/news/interests/events",
    {
      events: [{
        eventKey: crypto.randomUUID(),
        eventType: "open_original",
        itemId,
      }],
    },
    { keepalive: true },
  )
}

export function recordArticleFeedback(
  itemId: string,
  feedback: "like" | "not_interested",
): Promise<InterestEventsResponse> {
  return request(
    "POST",
    "/news/interests/events",
    {
      events: [{
        eventKey: crypto.randomUUID(),
        eventType: feedback,
        itemId,
      }],
    },
    { keepalive: true },
  )
}

export function createXiaoheiheLoginQr(): Promise<XiaoheiheLogin> {
  return request("POST", "/news/xiaoheihe/login/qr", {})
}

export function getXiaoheiheLoginStatus(loginId: string): Promise<XiaoheiheLogin> {
  return request("GET", `/news/xiaoheihe/login/${encodeURIComponent(loginId)}`)
}

export function cancelXiaoheiheLogin(loginId: string): Promise<{ ok: boolean }> {
  return request("DELETE", `/news/xiaoheihe/login/${encodeURIComponent(loginId)}`)
}

export function getXiaoheiheAccount(): Promise<XiaoheiheAccount> {
  return request("GET", "/news/xiaoheihe/account")
}

export function logoutXiaoheihe(): Promise<{ ok: boolean }> {
  return request("DELETE", "/news/xiaoheihe/account")
}

export function listXiaoheiheTopics(): Promise<{ items: XiaoheiheTopic[] }> {
  return request("GET", "/news/xiaoheihe/topics")
}

export function subscribeXiaoheiheTopics(topicIds: string[]): Promise<XiaoheiheSubscribeResult> {
  return request("POST", "/news/xiaoheihe/subscriptions", { topicIds })
}

export function searchNewsTopics(options: {
  query: string
  providers: TopicSearchProviderId[]
  timeRange: "all" | "24h" | "7d" | "30d"
  cursor?: string | null
}): Promise<TopicSearchResponse> {
  return request("POST", "/news/topic-search", options)
}

export function getTopicSearchComments(taskId: string): Promise<TopicSearchCommentTaskResponse> {
  return request("GET", `/news/topic-search/comments/${encodeURIComponent(taskId)}`)
}

export function getTopicSearchPreferences(): Promise<TopicSearchPreferences> {
  return request("GET", "/news/topic-search/preferences")
}

export function saveTopicSearchPreference(
  provider: TopicSearchAuthProvider,
  useAuthenticated: boolean,
): Promise<{ preferences: TopicSearchPreferences }> {
  return request("POST", "/news/topic-search/preferences", { provider, useAuthenticated })
}

export function getTopicSearchAuth(provider: TopicSearchAuthProvider): Promise<TopicSearchAuth> {
  return request("GET", `/news/topic-search/auth/${provider}`)
}

export function startTopicSearchAuth(provider: TopicSearchAuthProvider): Promise<TopicSearchAuth> {
  return request("POST", `/news/topic-search/auth/${provider}/start`, {})
}

export function completeTopicSearchAuth(provider: TopicSearchAuthProvider): Promise<TopicSearchAuth> {
  return request("POST", `/news/topic-search/auth/${provider}/complete`, {})
}

export function cancelTopicSearchAuth(provider: TopicSearchAuthProvider): Promise<TopicSearchAuth> {
  return request("POST", `/news/topic-search/auth/${provider}/cancel`, {})
}

export function disconnectTopicSearchAuth(provider: TopicSearchAuthProvider): Promise<TopicSearchAuth> {
  return request("DELETE", `/news/topic-search/auth/${provider}`)
}
