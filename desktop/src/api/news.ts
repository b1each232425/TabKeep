import type {
  NewsItemListResponse,
  NewsRefreshAllResponse,
  NewsSourceListResponse,
  NewsSourceMutationResponse,
  NewsSourceDeleteResponse,
} from "../types"
import { backendRequest } from "./client"

export async function listNewsSources(): Promise<NewsSourceListResponse> {
  return backendRequest<NewsSourceListResponse>("GET", "/news/sources")
}

export async function createNewsBrowserSession(): Promise<{ ticket: string }> {
  return backendRequest<{ ticket: string }>("POST", "/news/browser-session")
}

export async function addNewsSource(url: string): Promise<NewsSourceMutationResponse> {
  return backendRequest<NewsSourceMutationResponse>("POST", "/news/sources", { url })
}

export async function deleteNewsSource(sourceId: string): Promise<NewsSourceDeleteResponse> {
  return backendRequest<NewsSourceDeleteResponse>("DELETE", `/news/sources/${encodeURIComponent(sourceId)}`)
}

export async function refreshNewsSource(sourceId: string): Promise<NewsSourceMutationResponse> {
  return backendRequest<NewsSourceMutationResponse>(
    "POST",
    `/news/sources/${encodeURIComponent(sourceId)}/refresh`,
  )
}

export async function refreshAllNewsSources(): Promise<NewsRefreshAllResponse> {
  return backendRequest<NewsRefreshAllResponse>("POST", "/news/refresh")
}

export async function listNewsItems(options: {
  sourceId?: string | null
  limit?: number
  offset?: number
} = {}): Promise<NewsItemListResponse> {
  const params = new URLSearchParams()
  params.set("limit", String(options.limit ?? 50))
  params.set("offset", String(options.offset ?? 0))
  if (options.sourceId) params.set("sourceId", options.sourceId)
  return backendRequest<NewsItemListResponse>("GET", `/news/items?${params.toString()}`)
}
