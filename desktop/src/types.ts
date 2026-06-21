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

export interface EmbeddingConfig {
  enabled: boolean
  baseURL: string
  apiKey: string
  model: string
}

export interface KnowledgeConfig {
  enabled: boolean
  markdownPaths: string[]
  maxFileBytes: number
  embedding: EmbeddingConfig
}

export interface KnowledgeStats {
  documents: number
  chunks: number
  sessions: number
  lastIndexedAt?: string | null
  vectorAvailable: boolean
  vectorMessage?: string | null
}

export interface KnowledgeCitation {
  documentId: string
  chunkId: string
  title: string
  sourceType: string
  url?: string | null
  path?: string | null
  content: string
  score: number
}

export interface KnowledgeReindexResponse {
  ok: boolean
  documentsIndexed: number
  documentsSkipped: number
  chunksIndexed: number
  errors: string[]
  stats: KnowledgeStats
}

export interface KnowledgeSiyuanSyncResponse {
  ok: boolean
  notebooksScanned: number
  documentsFound: number
  documentsIndexed: number
  documentsSkipped: number
  chunksIndexed: number
  errors: string[]
  stats: KnowledgeStats
}

export interface KnowledgeSiyuanPrecheckResponse {
  ok: boolean
  provider?: string | null
  endpoint?: string | null
  notebooks: NotebookInfo[]
  error?: string | null
}

export interface KnowledgeSearchResponse {
  ok: boolean
  query: string
  sourceMode: string
  items: KnowledgeCitation[]
  error?: string | null
}

export interface KnowledgeAskResponse {
  ok: boolean
  answer: string
  citations: KnowledgeCitation[]
  sessionId?: string | null
  sourceMode: string
  error?: string | null
}

export type KnowledgeGraphLayer = "all" | "documents" | "concepts"

export interface KnowledgeGraphNode {
  id: string
  kind: "document" | "source" | "tag" | "heading" | "concept" | string
  label: string
  documentId?: string | null
  sourceType?: string | null
  url?: string | null
  path?: string | null
  noteId?: string | null
  degree: number
}

export interface KnowledgeGraphEdge {
  id: string
  source: string
  target: string
  kind: string
  weight: number
}

export interface KnowledgeGraphStats {
  nodes: number
  edges: number
  totalNodes: number
  totalEdges: number
}

export interface KnowledgeGraphResponse {
  ok: boolean
  layer: KnowledgeGraphLayer
  nodes: KnowledgeGraphNode[]
  edges: KnowledgeGraphEdge[]
  stats: KnowledgeGraphStats
  error?: string | null
}

export interface KnowledgeGraphRebuildResponse {
  ok: boolean
  nodes: number
  edges: number
  error?: string | null
}

export interface KnowledgeTopicStats {
  topics: number
  documents: number
  relations: number
  totalTopics: number
}

export interface KnowledgeTopic {
  id: string
  title: string
  summary: string
  keywords: string[]
  sourceTypes: string[]
  documentCount: number
  evidenceCount: number
  relationCount: number
  confidence: number
  aiEnhanced: boolean
  updatedAt?: string | null
}

export interface KnowledgeTopicDocument {
  documentId: string
  title: string
  sourceType: string
  url?: string | null
  path?: string | null
  noteId?: string | null
  anchor?: string | null
  score: number
  reason: string
  snippet: string
}

export interface KnowledgeTopicEvidence {
  id: string
  kind: string
  label: string
  documentId?: string | null
  weight: number
}

export interface KnowledgeTopicRelation {
  id: string
  sourceTopicId: string
  targetTopicId: string
  kind: string
  label: string
  weight: number
}

export interface KnowledgeTopicListResponse {
  ok: boolean
  topics: KnowledgeTopic[]
  stats: KnowledgeTopicStats
  error?: string | null
}

export interface KnowledgeTopicDetailResponse {
  ok: boolean
  topic?: KnowledgeTopic | null
  documents: KnowledgeTopicDocument[]
  evidence: KnowledgeTopicEvidence[]
  relations: KnowledgeTopicRelation[]
  error?: string | null
}

export interface KnowledgeTopicRebuildResponse {
  ok: boolean
  topics: number
  topicDocuments: number
  evidence: number
  relations: number
  error?: string | null
}

export interface KnowledgeTopicEnrichResponse {
  ok: boolean
  topics: number
  error?: string | null
}

export interface KnowledgeTopicExportResponse {
  ok: boolean
  topicId: string
  noteId?: string | null
  openTarget?: string | null
  provider?: string | null
  error?: string | null
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
  paddleMinScore: number
  preprocessEnabled: boolean
  preprocessScale: number
  preprocessGrayscale: boolean
  preprocessContrast: number
  preprocessSharpen: boolean
  preprocessThreshold: boolean
  textPostprocessEnabled: boolean
  textMergeLines: boolean
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

export interface SelectionTranslateConfig {
  enabled: boolean
  hotkey: string
  sourceLang: string
  targetLang: string
  hotkeyError?: string | null
}

export interface SelectionTranslateResult {
  ok: boolean
  text: string
  translatedText?: string | null
  sourceLang: string
  targetLang: string
  model?: string | null
  error?: string | null
  phase?: "copy" | "translate" | "done" | "error" | null
  message?: string | null
  x: number
  y: number
}
