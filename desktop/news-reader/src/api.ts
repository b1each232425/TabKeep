import type {
  NewsItemListResponse,
  NewsRefreshAllResponse,
  NewsSourceListResponse,
  NewsSourceMutationResponse,
  NewsSourceDeleteResponse,
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

async function request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
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

export function addNewsSource(url: string): Promise<NewsSourceMutationResponse> {
  return request("POST", "/news/sources", { url })
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
  limit?: number
  offset?: number
} = {}): Promise<NewsItemListResponse> {
  const params = new URLSearchParams({
    limit: String(options.limit ?? 50),
    offset: String(options.offset ?? 0),
  })
  if (options.sourceId) params.set("sourceId", options.sourceId)
  return request("GET", `/news/items?${params.toString()}`)
}
