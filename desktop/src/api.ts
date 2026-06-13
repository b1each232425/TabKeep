import { invoke } from "@tauri-apps/api/core"
import type {
  BackendConfigResponse,
  DesktopStatus,
  ModelConfig,
  NoteAdapterConfig,
  TabCategory,
} from "./types"
import { generateToken } from "./utils"

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  model: "",
  baseURL: "",
  apiKey: "",
}

export const DEFAULT_NOTE_ADAPTER: NoteAdapterConfig = {
  provider: "local",
}

interface BackendResponse<T> {
  status: number
  ok: boolean
  data: T
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

function extractErrorMessage(data: unknown): string | null {
  if (!data || typeof data !== "object") return null
  const record = data as Record<string, unknown>
  const detail = record.detail ?? record.error
  if (typeof detail === "string") return detail
  return null
}
