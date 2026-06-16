import { invoke } from "@tauri-apps/api/core"
import type {
  BackendConfigResponse,
  DesktopStatus,
  KnowledgeAskResponse,
  KnowledgeConfig,
  KnowledgeReindexResponse,
  KnowledgeSearchResponse,
  KnowledgeSiyuanSyncResponse,
  KnowledgeStats,
  ModelConfig,
  NoteAdapterConfig,
  OcrConfig,
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

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  model: "",
  baseURL: "",
  apiKey: "",
}

export const DEFAULT_NOTE_ADAPTER: NoteAdapterConfig = {
  provider: "local",
}

export const DEFAULT_OCR_CONFIG: OcrConfig = {
  provider: "windows_ocr",
  paddleExePath: "",
  paddleModelsPath: "",
  paddleConfigPath: "",
}

export const DEFAULT_REGION_BOX_CONFIG: RegionBoxConfig = {
  x: 160,
  y: 160,
  width: 640,
  height: 180,
  passThrough: false,
  sourceLang: "auto",
  targetLang: "简体中文",
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

export const DEFAULT_KNOWLEDGE_CONFIG: KnowledgeConfig = {
  enabled: true,
  markdownPaths: [],
  maxFileBytes: 1_000_000,
  embedding: {
    enabled: false,
    baseURL: "",
    apiKey: "",
    model: "",
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
  return {
    ...DEFAULT_KNOWLEDGE_CONFIG,
    ...config,
    embedding: { ...DEFAULT_KNOWLEDGE_CONFIG.embedding, ...(config.embedding ?? {}) },
  }
}

export async function setKnowledgeConfig(config: KnowledgeConfig): Promise<KnowledgeConfig> {
  const saved = await backendRequest<KnowledgeConfig>("POST", "/knowledge/config", config)
  return {
    ...DEFAULT_KNOWLEDGE_CONFIG,
    ...saved,
    embedding: { ...DEFAULT_KNOWLEDGE_CONFIG.embedding, ...(saved.embedding ?? {}) },
  }
}

export async function getKnowledgeStats(): Promise<KnowledgeStats> {
  return backendRequest<KnowledgeStats>("GET", "/knowledge/stats")
}

export async function reindexKnowledge(): Promise<KnowledgeReindexResponse> {
  return backendRequest<KnowledgeReindexResponse>("POST", "/knowledge/reindex")
}

export async function syncSiyuanKnowledge(
  notebookId?: string | null,
): Promise<KnowledgeSiyuanSyncResponse> {
  return backendRequest<KnowledgeSiyuanSyncResponse>("POST", "/knowledge/sync/siyuan", {
    notebookId: notebookId || null,
  })
}

export async function searchKnowledge(
  query: string,
  limit = 8,
): Promise<KnowledgeSearchResponse> {
  return backendRequest<KnowledgeSearchResponse>("POST", "/knowledge/search", { query, limit })
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
