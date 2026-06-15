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

export interface TranslateRequest {
  text: string
  sourceLang?: string
  targetLang?: string
  context?: string
}

export interface TranslateResponse {
  ok: boolean
  text: string
  translatedText: string
  sourceLang: string
  targetLang: string
  model: string
  error?: string
  detail?: string
}

export type TranslateProvider = "openai_compatible" | "baidu" | "volcengine"

export interface TranslateProviderConfig {
  provider: TranslateProvider
  baiduAppId: string
  baiduSecret: string
  volcengineAccessKey: string
  volcengineSecretKey: string
  volcengineRegion: string
}

export interface TranslateProviderTestResponse {
  ok: boolean
  provider: string
  translatedText?: string | null
  latencyMs: number
  error?: string | null
}

export type OcrProvider = "windows_ocr" | "paddleocr_json"

export interface OcrConfig {
  provider: OcrProvider
  paddleExePath: string
  paddleModelsPath: string
  paddleConfigPath: string
}

export interface OcrRequest {
  screenshot?: boolean
  provider?: OcrProvider
  sourceLang?: string
  targetLang?: string
}

export interface ScreenSelection {
  x: number
  y: number
  width: number
  height: number
  viewportWidth: number
  viewportHeight: number
}

export interface OcrFlowResult {
  ok: boolean
  text: string
  provider: OcrProvider
  imagePath: string
  imageDataUrl?: string | null
  translatedText?: string | null
  model?: string | null
  error?: string | null
  phase?: "ocr" | "translate" | "done" | "error" | null
  message?: string | null
}

export interface RegionBoxConfig {
  x: number
  y: number
  width: number
  height: number
  passThrough: boolean
  sourceLang: string
  targetLang: string
}
