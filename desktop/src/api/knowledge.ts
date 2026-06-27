import type {
  KnowledgeAskResponse,
  KnowledgeConfig,
  KnowledgeDocumentIndexListResponse,
  KnowledgeGraphLayer,
  KnowledgeGraphRebuildResponse,
  KnowledgeGraphResponse,
  KnowledgeHitTestResponse,
  KnowledgeIndexHealthResponse,
  KnowledgeIndexRepairResponse,
  KnowledgeReindexResponse,
  KnowledgeSearchMode,
  KnowledgeSearchResponse,
  KnowledgeSiyuanPrecheckResponse,
  KnowledgeSiyuanSyncResponse,
  KnowledgeStats,
  KnowledgeSyncAllResponse,
  KnowledgeSyncLogResponse,
  KnowledgeTopicDetailResponse,
  KnowledgeTopicEnrichResponse,
  KnowledgeTopicExportResponse,
  KnowledgeTopicListResponse,
  KnowledgeTopicRebuildResponse,
  KnowledgeVectorInspectResponse,
} from "../types"
import { backendRequest } from "./client"
import {
  DEFAULT_EMBEDDING_BASE_URL,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_KNOWLEDGE_CONFIG,
} from "./defaults"

export async function getKnowledgeConfig(): Promise<KnowledgeConfig> {
  const config = await backendRequest<KnowledgeConfig>("GET", "/knowledge/config")
  return normalizeKnowledgeConfig({
    ...DEFAULT_KNOWLEDGE_CONFIG,
    ...config,
    embedding: { ...DEFAULT_KNOWLEDGE_CONFIG.embedding, ...(config.embedding ?? {}) },
  })
}

export async function setKnowledgeConfig(config: KnowledgeConfig): Promise<KnowledgeConfig> {
  const saved = await backendRequest<KnowledgeConfig>("POST", "/knowledge/config", normalizeKnowledgeConfig(config))
  return normalizeKnowledgeConfig({
    ...DEFAULT_KNOWLEDGE_CONFIG,
    ...saved,
    embedding: { ...DEFAULT_KNOWLEDGE_CONFIG.embedding, ...(saved.embedding ?? {}) },
  })
}

export async function getKnowledgeStats(): Promise<KnowledgeStats> {
  return backendRequest<KnowledgeStats>("GET", "/knowledge/stats")
}

export async function listKnowledgeDocuments(
  sourceType?: string,
  limit = 200,
): Promise<KnowledgeDocumentIndexListResponse> {
  const params = new URLSearchParams()
  if (sourceType) params.set("sourceType", sourceType)
  params.set("limit", String(limit))
  return backendRequest<KnowledgeDocumentIndexListResponse>("GET", `/knowledge/documents?${params.toString()}`)
}

export async function getKnowledgeIndexHealth(): Promise<KnowledgeIndexHealthResponse> {
  return backendRequest<KnowledgeIndexHealthResponse>("GET", "/knowledge/index/health")
}

export async function repairKnowledgeIndex(): Promise<KnowledgeIndexRepairResponse> {
  return backendRequest<KnowledgeIndexRepairResponse>("POST", "/knowledge/index/repair")
}

export async function reindexKnowledge(): Promise<KnowledgeReindexResponse> {
  return backendRequest<KnowledgeReindexResponse>("POST", "/knowledge/reindex")
}

export async function syncAllKnowledge(): Promise<KnowledgeSyncAllResponse> {
  return backendRequest<KnowledgeSyncAllResponse>("POST", "/knowledge/sync/all")
}

export async function getKnowledgeSyncLogs(): Promise<KnowledgeSyncLogResponse> {
  return backendRequest<KnowledgeSyncLogResponse>("GET", "/knowledge/sync/logs")
}

export async function precheckSiyuanKnowledge(): Promise<KnowledgeSiyuanPrecheckResponse> {
  return backendRequest<KnowledgeSiyuanPrecheckResponse>("GET", "/knowledge/sync/siyuan/precheck")
}

export async function syncSiyuanKnowledge(
  notebookId?: string | null,
  limit?: number | null,
): Promise<KnowledgeSiyuanSyncResponse> {
  return backendRequest<KnowledgeSiyuanSyncResponse>("POST", "/knowledge/sync/siyuan", {
    notebookId: notebookId || null,
    limit: limit && limit > 0 ? limit : null,
  })
}

export async function searchKnowledge(
  query: string,
  limit = 8,
): Promise<KnowledgeSearchResponse> {
  return backendRequest<KnowledgeSearchResponse>("POST", "/knowledge/search", { query, limit })
}

export async function hitTestKnowledge(options: {
  query: string
  limit?: number
  searchMode?: KnowledgeSearchMode
  minScore?: number
}): Promise<KnowledgeHitTestResponse> {
  return backendRequest<KnowledgeHitTestResponse>("POST", "/knowledge/hit-test", {
    query: options.query,
    limit: options.limit ?? 8,
    searchMode: options.searchMode ?? "hybrid",
    minScore: options.minScore ?? 0,
  })
}

export async function askKnowledge(
  question: string,
  sessionId?: string | null,
  limit = 8,
): Promise<KnowledgeAskResponse> {
  return backendRequest<KnowledgeAskResponse>("POST", "/knowledge/ask", {
    question,
    sessionId,
    limit,
  })
}

export async function inspectKnowledgeVector(options: {
  query?: string
  limit?: number
} = {}): Promise<KnowledgeVectorInspectResponse> {
  const params = new URLSearchParams()
  params.set("limit", String(options.limit ?? 100))
  if (options.query?.trim()) params.set("query", options.query.trim())
  return backendRequest<KnowledgeVectorInspectResponse>("GET", `/knowledge/vector/inspect?${params.toString()}`)
}

export async function migrateKnowledgeVectorSchema(): Promise<KnowledgeVectorInspectResponse> {
  return backendRequest<KnowledgeVectorInspectResponse>("POST", "/knowledge/vector/migrate")
}

export async function getKnowledgeGraph(options: {
  layer?: KnowledgeGraphLayer
  query?: string
  sourceType?: string
  limit?: number
} = {}): Promise<KnowledgeGraphResponse> {
  const params = new URLSearchParams()
  params.set("layer", options.layer ?? "all")
  params.set("limit", String(options.limit ?? 300))
  if (options.query?.trim()) params.set("query", options.query.trim())
  if (options.sourceType?.trim()) params.set("sourceType", options.sourceType.trim())
  return backendRequest<KnowledgeGraphResponse>("GET", `/knowledge/graph?${params.toString()}`)
}

export async function rebuildKnowledgeGraph(): Promise<KnowledgeGraphRebuildResponse> {
  return backendRequest<KnowledgeGraphRebuildResponse>("POST", "/knowledge/graph/rebuild")
}

export async function getKnowledgeTopics(options: {
  query?: string
  sourceType?: string
  limit?: number
} = {}): Promise<KnowledgeTopicListResponse> {
  const params = new URLSearchParams()
  params.set("limit", String(options.limit ?? 80))
  if (options.query?.trim()) params.set("query", options.query.trim())
  if (options.sourceType?.trim()) params.set("sourceType", options.sourceType.trim())
  return backendRequest<KnowledgeTopicListResponse>("GET", `/knowledge/topics?${params.toString()}`)
}

export async function getKnowledgeTopicDetail(topicId: string): Promise<KnowledgeTopicDetailResponse> {
  return backendRequest<KnowledgeTopicDetailResponse>("GET", `/knowledge/topics/${encodeURIComponent(topicId)}`)
}

export async function rebuildKnowledgeTopics(): Promise<KnowledgeTopicRebuildResponse> {
  return backendRequest<KnowledgeTopicRebuildResponse>("POST", "/knowledge/topics/rebuild")
}

export async function enrichKnowledgeTopics(topicId?: string | null): Promise<KnowledgeTopicEnrichResponse> {
  return backendRequest<KnowledgeTopicEnrichResponse>("POST", "/knowledge/topics/enrich", {
    topicId: topicId || null,
  })
}

export async function exportKnowledgeTopic(topicId: string): Promise<KnowledgeTopicExportResponse> {
  return backendRequest<KnowledgeTopicExportResponse>(
    "POST",
    `/knowledge/topics/${encodeURIComponent(topicId)}/export`,
  )
}

function normalizeKnowledgeConfig(config: KnowledgeConfig): KnowledgeConfig {
  return {
    ...DEFAULT_KNOWLEDGE_CONFIG,
    ...config,
    embedding: {
      ...DEFAULT_KNOWLEDGE_CONFIG.embedding,
      ...(config.embedding ?? {}),
      baseURL: config.embedding?.baseURL?.trim() || DEFAULT_EMBEDDING_BASE_URL,
      model: config.embedding?.model?.trim() || DEFAULT_EMBEDDING_MODEL,
    },
  }
}
