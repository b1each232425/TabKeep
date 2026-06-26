import { invoke } from "@tauri-apps/api/core"
import type {
  BackendConfigResponse,
  DesktopStatus,
  KnowledgeAskResponse,
  KnowledgeConfig,
  KnowledgeEvalCase,
  KnowledgeEvalCaseRequest,
  KnowledgeEvalDeleteResponse,
  KnowledgeEvalRunRequest,
  KnowledgeEvalRunResponse,
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
  ModelConfig,
  NoteAdapterConfig,
  OcrConfig,
  OcrDebugResult,
  OcrFlowResult,
  OcrRequest,
  RegionBoxConfig,
  ScreenSelection,
  SelectionTranslateConfig,
  SelectionTranslateResult,
  TabCategory,
  TranslateProviderConfig,
  TranslateProviderTestResponse,
  TranslateRequest,
  TranslateResponse,
} from "./types"
import { generateToken } from "./utils"

const DESKTOP_URL = "http://127.0.0.1:38472"
const BROWSER_API_BASE_URL_KEY = "tabkeep.eval.apiBaseUrl"
const BROWSER_API_TOKEN_KEY = "tabkeep.eval.apiToken"
const importMetaEnv = (import.meta as ImportMeta & {
  env?: Record<string, string | boolean | undefined>
}).env
const DEFAULT_BROWSER_API_BASE_URL =
  typeof importMetaEnv?.VITE_TABKEEP_API_BASE_URL === "string"
    ? importMetaEnv.VITE_TABKEEP_API_BASE_URL
    : "http://127.0.0.1:38471"

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  model: "",
  baseURL: "",
  apiKey: "",
}

export const DEFAULT_NOTE_ADAPTER: NoteAdapterConfig = {
  provider: "local",
}

export const DEFAULT_OCR_CONFIG: OcrConfig = {
  provider: "paddleocr_json",
  paddleExePath: "",
  paddleModelsPath: "",
  paddleConfigPath: "",
  paddleMinScore: 0.45,
  preprocessEnabled: true,
  preprocessScale: 2,
  preprocessGrayscale: true,
  preprocessContrast: 18,
  preprocessSharpen: true,
  preprocessThreshold: false,
  textPostprocessEnabled: true,
  textMergeLines: false,
  textLayoutMode: "auto",
}

export const DEFAULT_REGION_BOX_CONFIG: RegionBoxConfig = {
  x: 160,
  y: 160,
  width: 640,
  height: 180,
  passThrough: false,
  sourceLang: "auto",
  targetLang: "简体中文",
  panelX: null,
  panelY: null,
  panelWidth: 420,
  panelHeight: 150,
}

export const DEFAULT_TRANSLATE_PROVIDER_CONFIG: TranslateProviderConfig = {
  provider: "openai_compatible",
  baiduAppId: "",
  baiduSecret: "",
  volcengineAccessKey: "",
  volcengineSecretKey: "",
  volcengineRegion: "cn-north-1",
}

export const DEFAULT_SELECTION_TRANSLATE_CONFIG: SelectionTranslateConfig = {
  enabled: true,
  hotkey: "Ctrl+Alt+T",
  sourceLang: "auto",
  targetLang: "简体中文",
  hotkeyError: null,
}

export const DEFAULT_EMBEDDING_BASE_URL = "https://api.siliconflow.cn/v1"
export const DEFAULT_EMBEDDING_MODEL = "BAAI/bge-m3"

export const DEFAULT_KNOWLEDGE_CONFIG: KnowledgeConfig = {
  enabled: true,
  markdownPaths: [],
  maxFileBytes: 1_000_000,
  embedding: {
    enabled: false,
    baseURL: DEFAULT_EMBEDDING_BASE_URL,
    apiKey: "",
    model: DEFAULT_EMBEDDING_MODEL,
  },
}

interface BackendResponse<T> {
  status: number
  ok: boolean
  data: T
}

interface DesktopHttpResponse<T> {
  ok: boolean
  error?: string
  config?: T
}

export class BackendRequestError extends Error {
  status?: number
  data?: unknown

  constructor(message: string, status?: number, data?: unknown) {
    super(message)
    this.name = "BackendRequestError"
    this.status = status
    this.data = data
  }
}

export async function getDesktopStatus(): Promise<DesktopStatus> {
  return invoke<DesktopStatus>("get_desktop_status")
}

export async function getCachedApiToken(): Promise<string | null> {
  return invoke<string | null>("get_cached_api_token")
}

export async function setCachedApiToken(token: string): Promise<void> {
  await invoke("set_cached_api_token", { token })
}

export async function clearCachedApiToken(): Promise<void> {
  await invoke("clear_cached_api_token")
}

export async function ensureDesktopApiToken(): Promise<string> {
  const cached = await getCachedApiToken()
  if (cached) return cached
  const token = generateToken()
  await setCachedApiToken(token)
  return token
}

export async function backendRequest<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  if (!isTauriRuntime()) {
    return browserBackendRequest<T>(method, path, body)
  }
  const res = await invoke<BackendResponse<T>>("backend_request", {
    method,
    path,
    body: body ?? null,
  })
  if (!res.ok) {
    const detail = extractErrorMessage(res.data) ?? `HTTP ${res.status}`
    throw new BackendRequestError(detail, res.status, res.data)
  }
  return res.data
}

export function getBrowserApiBaseUrl(): string {
  if (typeof localStorage === "undefined") return DEFAULT_BROWSER_API_BASE_URL
  return localStorage.getItem(BROWSER_API_BASE_URL_KEY)?.trim() || DEFAULT_BROWSER_API_BASE_URL
}

export function setBrowserApiBaseUrl(value: string): void {
  if (typeof localStorage === "undefined") return
  const clean = value.trim().replace(/\/+$/, "")
  if (clean) {
    localStorage.setItem(BROWSER_API_BASE_URL_KEY, clean)
  } else {
    localStorage.removeItem(BROWSER_API_BASE_URL_KEY)
  }
}

export function getBrowserApiToken(): string {
  if (typeof localStorage === "undefined") return ""
  return localStorage.getItem(BROWSER_API_TOKEN_KEY) ?? ""
}

export function setBrowserApiToken(value: string): void {
  if (typeof localStorage === "undefined") return
  const clean = value.trim()
  if (clean) {
    localStorage.setItem(BROWSER_API_TOKEN_KEY, clean)
  } else {
    localStorage.removeItem(BROWSER_API_TOKEN_KEY)
  }
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

async function browserBackendRequest<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  if (!path.startsWith("/") || path.includes("://")) {
    throw new BackendRequestError("非法后端路径")
  }
  const headers: Record<string, string> = {}
  if (body !== undefined && body !== null) headers["Content-Type"] = "application/json"
  const token = getBrowserApiToken()
  if (token && path !== "/") headers["X-TabKeep-Token"] = token
  const res = await fetch(`${getBrowserApiBaseUrl()}${path}`, {
    method,
    headers,
    body: body === undefined || body === null ? undefined : JSON.stringify(body),
  })
  const data = await readJsonResponse<T>(res)
  if (!res.ok) {
    const detail = extractErrorMessage(data) ?? `HTTP ${res.status}`
    throw new BackendRequestError(detail, res.status, data)
  }
  return data
}

async function readJsonResponse<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T
  } catch (err) {
    return { detail: `后端返回非 JSON: ${err instanceof Error ? err.message : String(err)}` } as T
  }
}

export async function checkBackendHealth(): Promise<boolean> {
  try {
    await backendRequest("GET", "/")
    return true
  } catch {
    return false
  }
}

export async function loadBackendConfig(): Promise<{
  modelConfig: ModelConfig
  tabCategories: TabCategory[]
  noteAdapter: NoteAdapterConfig
}> {
  const config = await backendRequest<BackendConfigResponse>("GET", "/config")
  const noteAdapter = await backendRequest<NoteAdapterConfig | null>("GET", "/notes/config")
  return {
    modelConfig: { ...DEFAULT_MODEL_CONFIG, ...(config.modelConfig ?? {}) },
    tabCategories: Array.isArray(config.tabCategories) ? config.tabCategories : [],
    noteAdapter: { ...DEFAULT_NOTE_ADAPTER, ...(noteAdapter ?? {}) },
  }
}

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

export async function getKnowledgeStats(): Promise<KnowledgeStats> {
  return backendRequest<KnowledgeStats>("GET", "/knowledge/stats")
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

export async function listKnowledgeEvalCases(): Promise<KnowledgeEvalCase[]> {
  return backendRequest<KnowledgeEvalCase[]>("GET", "/knowledge/eval/cases")
}

export async function saveKnowledgeEvalCase(
  data: KnowledgeEvalCaseRequest,
  caseId?: string | null,
): Promise<KnowledgeEvalCase> {
  const path = caseId ? `/knowledge/eval/cases/${encodeURIComponent(caseId)}` : "/knowledge/eval/cases"
  return backendRequest<KnowledgeEvalCase>("POST", path, data)
}

export async function deleteKnowledgeEvalCase(caseId: string): Promise<KnowledgeEvalDeleteResponse> {
  return backendRequest<KnowledgeEvalDeleteResponse>(
    "POST",
    `/knowledge/eval/cases/${encodeURIComponent(caseId)}/delete`,
  )
}

export async function runKnowledgeEval(options: KnowledgeEvalRunRequest): Promise<KnowledgeEvalRunResponse> {
  return backendRequest<KnowledgeEvalRunResponse>("POST", "/knowledge/eval/run", options)
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

export async function syncConfigToBackend(partial: {
  modelConfig?: ModelConfig
  tabCategories?: TabCategory[]
  noteAdapter?: NoteAdapterConfig
}): Promise<void> {
  const apiToken = await ensureDesktopApiToken()
  const body: Record<string, unknown> = { apiToken }
  if (partial.modelConfig !== undefined) body.modelConfig = partial.modelConfig
  if (partial.tabCategories !== undefined) body.tabCategories = partial.tabCategories
  if (partial.noteAdapter !== undefined) body.noteAdapter = partial.noteAdapter
  const res = await backendRequest<{ ok: boolean }>("POST", "/config/sync", body)
  if (!res.ok) {
    throw new BackendRequestError("配置同步失败", undefined, res)
  }
}

export async function translateText(
  payload: TranslateRequest,
  endpoint: "/translate" | "/input_translate" | "/selection_translate" = "/translate",
): Promise<TranslateResponse> {
  const token = await getCachedApiToken()
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  if (token) headers["X-TabKeep-Token"] = token

  const res = await fetch(`${DESKTOP_URL}${endpoint}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })
  const data = (await res.json()) as TranslateResponse
  if (!res.ok || !data.ok) {
    throw new BackendRequestError(extractErrorMessage(data) ?? `HTTP ${res.status}`, res.status, data)
  }
  return data
}

export async function getOcrConfig(): Promise<OcrConfig> {
  const config = await invoke<OcrConfig>("get_ocr_config")
  return { ...DEFAULT_OCR_CONFIG, ...config }
}

export async function setOcrConfig(config: OcrConfig): Promise<void> {
  await invoke("set_ocr_config", { config })
}

export async function getTranslateProviderConfig(): Promise<TranslateProviderConfig> {
  const config = await invoke<TranslateProviderConfig>("get_translate_provider_config")
  return { ...DEFAULT_TRANSLATE_PROVIDER_CONFIG, ...config }
}

export async function setTranslateProviderConfig(
  config: TranslateProviderConfig,
): Promise<TranslateProviderConfig> {
  const saved = await invoke<TranslateProviderConfig>("set_translate_provider_config", { config })
  return { ...DEFAULT_TRANSLATE_PROVIDER_CONFIG, ...saved }
}

export async function testTranslateProvider(
  config: TranslateProviderConfig,
): Promise<TranslateProviderTestResponse> {
  return invoke<TranslateProviderTestResponse>("test_translate_provider", { config })
}

export async function startOcrRecognize(payload: OcrRequest): Promise<OcrFlowResult> {
  return invoke<OcrFlowResult>("start_ocr_recognize", { payload })
}

export async function startOcrTranslate(payload: OcrRequest): Promise<OcrFlowResult> {
  return invoke<OcrFlowResult>("start_ocr_translate", { payload })
}

export async function finishScreenSelection(selection: ScreenSelection): Promise<void> {
  await invoke("finish_screen_selection", { selection })
}

export async function cancelScreenSelection(): Promise<void> {
  await invoke("cancel_screen_selection")
}

export async function getLatestOcrResult(): Promise<OcrFlowResult | null> {
  return invoke<OcrFlowResult | null>("get_latest_ocr_result")
}

export async function debugRegionOcr(): Promise<OcrDebugResult> {
  return invoke<OcrDebugResult>("debug_region_ocr")
}

export async function openRegionBox(): Promise<RegionBoxConfig> {
  try {
    const data = await desktopHttpRequest<RegionBoxConfig>("POST", "/region/open")
    return { ...DEFAULT_REGION_BOX_CONFIG, ...data }
  } catch (httpErr) {
    try {
      const config = await invoke<RegionBoxConfig>("open_region_box")
      return { ...DEFAULT_REGION_BOX_CONFIG, ...config }
    } catch (ipcErr) {
      throw mergeRegionError("打开固定翻译框失败", httpErr, ipcErr)
    }
  }
}

export async function closeRegionBox(): Promise<void> {
  try {
    await desktopHttpRequest<void>("POST", "/region/close")
  } catch (httpErr) {
    try {
      await invoke("close_region_box")
    } catch (ipcErr) {
      throw mergeRegionError("关闭固定翻译框失败", httpErr, ipcErr)
    }
  }
}

export async function getRegionBoxConfig(): Promise<RegionBoxConfig> {
  try {
    const config = await desktopHttpRequest<RegionBoxConfig>("GET", "/region/config")
    return { ...DEFAULT_REGION_BOX_CONFIG, ...config }
  } catch {
    const config = await invoke<RegionBoxConfig>("get_region_box_config")
    return { ...DEFAULT_REGION_BOX_CONFIG, ...config }
  }
}

export async function setRegionBoxConfig(config: RegionBoxConfig): Promise<RegionBoxConfig> {
  const saved = await invoke<RegionBoxConfig>("set_region_box_config", { config })
  return { ...DEFAULT_REGION_BOX_CONFIG, ...saved }
}

export async function setRegionBoxPassthrough(passThrough: boolean): Promise<RegionBoxConfig> {
  const config = await invoke<RegionBoxConfig>("set_region_box_passthrough", { passThrough })
  return { ...DEFAULT_REGION_BOX_CONFIG, ...config }
}

export async function runRegionOcr(): Promise<OcrFlowResult> {
  return invoke<OcrFlowResult>("run_region_ocr")
}

export async function runRegionTranslate(): Promise<OcrFlowResult> {
  return invoke<OcrFlowResult>("run_region_translate")
}

export async function getSelectionTranslateConfig(): Promise<SelectionTranslateConfig> {
  const config = await invoke<SelectionTranslateConfig>("get_selection_translate_config")
  return { ...DEFAULT_SELECTION_TRANSLATE_CONFIG, ...config }
}

export async function setSelectionTranslateConfig(
  config: SelectionTranslateConfig,
): Promise<SelectionTranslateConfig> {
  const saved = await invoke<SelectionTranslateConfig>("set_selection_translate_config", { config })
  return { ...DEFAULT_SELECTION_TRANSLATE_CONFIG, ...saved }
}

export async function triggerSelectionTranslate(): Promise<SelectionTranslateResult> {
  return invoke<SelectionTranslateResult>("trigger_selection_translate")
}

export async function getLatestSelectionTranslateResult(): Promise<SelectionTranslateResult | null> {
  return invoke<SelectionTranslateResult | null>("get_latest_selection_translate_result")
}

export async function openExternalTarget(target: string): Promise<void> {
  await invoke("open_external_target", { target })
}

function extractErrorMessage(data: unknown): string | null {
  if (!data || typeof data !== "object") return null
  const record = data as Record<string, unknown>
  const detail = record.detail ?? record.error
  if (typeof detail === "string") return detail
  return null
}

async function desktopHttpRequest<T>(
  method: "GET" | "POST",
  path: "/region/open" | "/region/close" | "/region/config",
): Promise<T> {
  const res = await fetch(`${DESKTOP_URL}${path}`, { method })
  const data = (await res.json()) as DesktopHttpResponse<T>
  if (!res.ok || !data.ok) {
    throw new BackendRequestError(data.error ?? `HTTP ${res.status}`, res.status, data)
  }
  return data.config as T
}

function mergeRegionError(prefix: string, httpErr: unknown, ipcErr: unknown): BackendRequestError {
  return new BackendRequestError(
    `${prefix}: HTTP ${formatUnknownError(httpErr)}; Tauri IPC ${formatUnknownError(ipcErr)}`,
  )
}

function formatUnknownError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
