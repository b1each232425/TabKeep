export type CaptureMode = "link" | "full" | "summary"

export interface ModelConfig {
  model: string
  baseURL: string
  apiKey: string
}

export interface TabData {
  id: number
  title: string
  url: string
  favIconUrl?: string
  active: boolean
  pinned: boolean
  index?: number
}

export interface GroupedTab {
  domain: string
  count: number
  tabs: TabData[]
  favIconUrl?: string
  isOther?: boolean
}

export type TabGroupColor =
  | "grey"
  | "blue"
  | "red"
  | "yellow"
  | "green"
  | "pink"
  | "purple"
  | "cyan"
  | "orange"

export interface TabGroupStyleOptions {
  colorMode: "random" | "uniform"
  uniformColor: TabGroupColor
  useDomainAsTitle: boolean
  collapsedByDefault: boolean
}

export interface TabCategory {
  id: string
  name: string
  description?: string
}

export interface NoteAdapterConfig {
  provider: "local" | "siyuan" | "obsidian"
  endpoint?: string
  token?: string
  vault?: string
  defaultFolder?: string
  writeMode?: "new_file" | "append"
  defaultNotebook?: string
  defaultTargetDoc?: string
}

export interface NotebookInfo {
  id: string
  name: string
}

export interface DesktopStatus {
  ok: boolean
  app: string
  version: string
  backend_url: string
  desktop_url: string
  token_cached: boolean
}

export interface BackendConfigResponse {
  modelConfig?: ModelConfig | null
  tabCategories?: TabCategory[]
}

export interface ClassifyResponse {
  result?: Record<string, string>
  raw?: string
  error?: string
}

export interface NotesTestResponse {
  ok: boolean
  provider?: string | null
  error?: string | null
}
