import type {
  BackendConfigResponse,
  ModelConfig,
  NoteAdapterConfig,
  TabCategory,
} from "../types"
import { BackendRequestError, backendRequest, ensureDesktopApiToken } from "./client"
import { DEFAULT_MODEL_CONFIG, DEFAULT_NOTE_ADAPTER } from "./defaults"

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
