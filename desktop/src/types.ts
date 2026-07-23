// -----------------------------------------------------------------------------
// Core app configuration
// -----------------------------------------------------------------------------

export type CaptureMode = "link" | "full" | "summary"

export interface ModelConfig {
  model: string
  baseURL: string
  apiKey: string
}

// -----------------------------------------------------------------------------
// Tabs and grouping
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// Note integrations
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// Desktop/backend status
// -----------------------------------------------------------------------------

export interface DesktopStatus {
  ok: boolean
  app: string
  version: string
  backend_url: string
  desktop_url: string
  token_cached: boolean
  usage_date: string
  today_translation_count: number
  today_ocr_count: number
}

export interface BackendConfigResponse {
  modelConfig?: ModelConfig | null
  tabCategories?: TabCategory[]
}

// -----------------------------------------------------------------------------
// Local sticky notes
// -----------------------------------------------------------------------------

export interface StickyNote {
  id: string
  title: string
  content: string
  color: string
  pinned: boolean
  category: string
  preview: string
  wordCount: number
  viewMode: StickyNoteViewMode
  tilePinned: boolean
  createdAt: string
  updatedAt: string
  windowBounds?: StickyWindowBounds | null
  tileBounds?: StickyWindowBounds | null
}

export interface StickyNoteDraft {
  id?: string
  title: string
  content: string
  color?: string
  pinned?: boolean
  category?: string
  viewMode?: StickyNoteViewMode
  tilePinned?: boolean
  windowBounds?: StickyWindowBounds | null
  tileBounds?: StickyWindowBounds | null
}

export interface StickyWindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export type StickyNoteViewMode = "edit" | "preview"

export interface StickyShortcutConfig {
  newNoteHotkey: string
  toggleWindowHotkey: string
}

// -----------------------------------------------------------------------------
// Knowledge base configuration and stats
// -----------------------------------------------------------------------------

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
  paragraphs: number
  chunks: number
  sessions: number
  lastIndexedAt?: string | null
  vectorAvailable: boolean
  vectorMessage?: string | null
}

// -----------------------------------------------------------------------------
// Knowledge indexing, sync, and health
// -----------------------------------------------------------------------------

export interface KnowledgeDocumentIndexStatus {
  documentId: string
  sourceType: string
  title: string
  url?: string | null
  path?: string | null
  noteId?: string | null
  contentHash: string
  contentBytes: number
  paragraphCount: number
  chunkCount: number
  indexStatus: string
  embeddingStatus: string
  lastError: string
  updatedAt: string
  indexedAt: string
  lastSeenAt?: string | null
}

export interface KnowledgeDocumentIndexListResponse {
  ok: boolean
  total: number
  items: KnowledgeDocumentIndexStatus[]
}

export interface KnowledgeCitation {
  documentId: string
  paragraphId?: string | null
  chunkId: string
  title: string
  paragraphTitle?: string | null
  sourceType: string
  url?: string | null
  path?: string | null
  content: string
  matchedContent?: string | null
  score: number
  rerankScore?: number | null
}

export interface KnowledgeReindexResponse {
  ok: boolean
  documentsIndexed: number
  documentsSkipped: number
  documentsDeleted: number
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
  documentsDeleted: number
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

export interface KnowledgeSyncSourceResult {
  source: string
  label: string
  ok: boolean
  status: "success" | "warning" | "error" | "skipped" | string
  skipped: boolean
  reason?: string | null
  startedAt?: string | null
  endedAt?: string | null
  durationMs: number
  documentsFound: number
  documentsIndexed: number
  documentsSkipped: number
  documentsDeleted: number
  chunksIndexed: number
  notebooksScanned: number
  errors: string[]
}

export interface KnowledgeSyncAllResponse {
  ok: boolean
  runId: string
  status: "success" | "partial" | "failed" | "skipped" | string
  startedAt?: string | null
  endedAt?: string | null
  durationMs: number
  sources: KnowledgeSyncSourceResult[]
  documentsFound: number
  documentsIndexed: number
  documentsSkipped: number
  documentsDeleted: number
  chunksIndexed: number
  errors: string[]
  stats: KnowledgeStats
}

export interface KnowledgeSyncLogResponse {
  items: KnowledgeSyncAllResponse[]
}

export interface KnowledgeIndexHealthIssue {
  key: string
  label: string
  severity: "warning" | "error" | string
  count: number
  message: string
  repairable: boolean
}

export interface KnowledgeIndexHealthResponse {
  ok: boolean
  status: string
  checkedAt: string
  documents: number
  paragraphs: number
  chunks: number
  ftsRows: number
  vectorRows: number
  orphanChunks: number
  orphanParagraphs: number
  orphanFtsRows: number
  missingFtsRows: number
  vectorMissingSqlRows: number
  vectorMissingParagraphRows: number
  staleMarkdownDocuments: number
  embeddingStatusCounts: Record<string, number>
  vectorAvailable: boolean
  vectorMessage?: string | null
  vectorSchemaReady: boolean
  missingVectorColumns: string[]
  issues: KnowledgeIndexHealthIssue[]
  repairableIssues: string[]
  stats: KnowledgeStats
  error?: string | null
}

export interface KnowledgeIndexRepairResponse {
  ok: boolean
  repaired: boolean
  orphanFtsRowsDeleted: number
  missingFtsRowsInserted: number
  health: KnowledgeIndexHealthResponse
  errors: string[]
}

// -----------------------------------------------------------------------------
// Knowledge retrieval and hit testing
// -----------------------------------------------------------------------------

export interface KnowledgeSearchResponse {
  ok: boolean
  query: string
  sourceMode: string
  items: KnowledgeCitation[]
  rerankUsed: boolean
  rerankMessage?: string | null
  error?: string | null
}

export type KnowledgeSearchMode = "fts" | "vector" | "hybrid"

export interface KnowledgeHitTestItem extends KnowledgeCitation {
  rank: number
  matchedBy: string[]
  ftsRank?: number | null
  ftsScore?: number | null
  ftsRawRank?: number | null
  vectorRank?: number | null
  vectorScore?: number | null
  vectorDistance?: number | null
  rrfScore: number
  rrfRank?: number | null
}

export interface KnowledgeHitTestResponse {
  ok: boolean
  query: string
  searchMode: KnowledgeSearchMode
  sourceMode: string
  items: KnowledgeHitTestItem[]
  vectorAvailable: boolean
  vectorMessage?: string | null
  rerankUsed: boolean
  rerankMessage?: string | null
  error?: string | null
}

// -----------------------------------------------------------------------------
// RAG evaluation
// -----------------------------------------------------------------------------

export interface KnowledgeEvalCaseRequest {
  question: string
  caseType: "keyword" | "natural" | "challenge" | "negative" | string
  expectedText: string
  expectedPath: string
  expectedTitle: string
  expectedDocumentId: string
  expectedParagraphId: string
  expectedAnswer: string
  answerKeywords: string
  shouldRefuse: boolean
  note: string
}

export interface KnowledgeEvalCase extends KnowledgeEvalCaseRequest {
  id: string
  createdAt: string
  updatedAt: string
}

export interface KnowledgeEvalDeleteResponse {
  ok: boolean
  deleted: boolean
  error?: string | null
}

export interface KnowledgeEvalRunRequest {
  caseIds?: string[]
  limit?: number
  searchMode?: KnowledgeSearchMode
  minScore?: number
  evaluateAnswer?: boolean
  answerLimit?: number
  answerTimeoutSeconds?: number
}

export interface KnowledgeEvalHit extends KnowledgeHitTestItem {
  relevant: boolean
  matchedExpectations: string[]
}

export interface KnowledgeEvalCaseResult {
  case: KnowledgeEvalCase
  ok: boolean
  rank?: number | null
  reciprocalRank: number
  hits: KnowledgeEvalHit[]
  issueType: "ok" | "late_hit" | "missed" | "no_results" | "error" | string
  issueMessage: string
  answerEvaluated: boolean
  answerOk?: boolean | null
  answer: string
  answerScore: number
  answerKeywordCoverage: number
  answerFaithfulness: number
  answerRelevance: number
  refusalOk?: boolean | null
  answerIssueType: string
  answerIssueMessage: string
  matchedAnswerKeywords: string[]
  missingAnswerKeywords: string[]
  error?: string | null
}

export interface KnowledgeEvalRankBucket {
  rank: number
  count: number
}

export interface KnowledgeEvalTypeSummary {
  caseType: string
  total: number
  hitCount: number
  recallAtK: number
  mrr: number
  top1Accuracy: number
  rankDistribution: KnowledgeEvalRankBucket[]
}

export interface KnowledgeEvalRunResponse {
  ok: boolean
  total: number
  evaluated: number
  retrievalEvaluated: number
  hitCount: number
  recallAtK: number
  mrr: number
  top1Accuracy: number
  answerEligible: number
  answerLimit: number
  answerEvaluated: number
  answerPassCount: number
  answerAccuracy: number
  refusalEvaluated: number
  refusalPassCount: number
  refusalAccuracy: number
  averageAnswerScore: number
  averageFaithfulness: number
  averageAnswerRelevance: number
  rankDistribution: KnowledgeEvalRankBucket[]
  typeSummaries: KnowledgeEvalTypeSummary[]
  limit: number
  searchMode: KnowledgeSearchMode
  sourceModes: Record<string, number>
  results: KnowledgeEvalCaseResult[]
  error?: string | null
}

// -----------------------------------------------------------------------------
// Vector inspection
// -----------------------------------------------------------------------------

export interface KnowledgeVectorColumn {
  name: string
  type: string
}

export interface KnowledgeVectorRecord {
  chunkId: string
  documentId: string
  paragraphId?: string | null
  title: string
  sourceType: string
  path?: string | null
  url?: string | null
  content: string
  contentPreview: string
  vectorDims: number
  vectorPreview: number[]
  documentTitle?: string | null
  paragraphTitle?: string | null
  paragraphContentPreview?: string | null
  paragraphCharLen?: number | null
}

export interface KnowledgeVectorInspectResponse {
  ok: boolean
  vectorAvailable: boolean
  vectorMessage?: string | null
  tableExists: boolean
  tableName: string
  path: string
  rowCount: number
  columns: KnowledgeVectorColumn[]
  requiredColumns: string[]
  missingColumns: string[]
  schemaReady: boolean
  query: string
  limit: number
  records: KnowledgeVectorRecord[]
  error?: string | null
}

// -----------------------------------------------------------------------------
// RAG answers and knowledge graph
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// Topic map and topic export
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// Classification and note test responses
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// Translation
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// OCR, region box, and selection translation
// -----------------------------------------------------------------------------

export type OcrProvider = "windows_ocr" | "paddleocr_json"
export type OcrTextLayoutMode = "auto" | "preserve" | "conservative" | "paragraph" | "manga"

export interface OcrTextBox {
  text: string
  score?: number | null
  x: number
  y: number
  width: number
  height: number
}

export interface OcrBounds {
  x: number
  y: number
  width: number
  height: number
}

export type ComicTextDirection = "horizontal" | "vertical"

export interface ComicTextRegion {
  id: string
  textBounds: OcrBounds
  bubbleBounds?: OcrBounds | null
  sourceText: string
  translatedText?: string | null
  direction: ComicTextDirection
  readingOrder: number
  confidence?: number | null
  lineBoxes: OcrTextBox[]
}

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
  textLayoutMode: OcrTextLayoutMode
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
  textBoxes?: OcrTextBox[]
  translatedRegions?: ComicTextRegion[]
  imageWidth?: number | null
  imageHeight?: number | null
}

export interface OcrDebugResult {
  ok: boolean
  provider: OcrProvider
  sourceLang: string
  originalImagePath: string
  originalImageDataUrl?: string | null
  originalWidth: number
  originalHeight: number
  preprocessedImagePath?: string | null
  preprocessedImageDataUrl?: string | null
  preprocessedWidth?: number | null
  preprocessedHeight?: number | null
  rawText: string
  text: string
  textBoxes: OcrTextBox[]
  translatedRegions: ComicTextRegion[]
  elapsedMs: number
  config: OcrConfig
}

export interface OcrDebugRecord {
  id: string
  createdAt: string
  mode: "recognize" | "translate" | string
  sourceLang: string
  targetLang: string
  provider: OcrProvider
  imagePath: string
  preprocessedImagePath?: string | null
  rawText: string
  text: string
  textBoxes?: OcrTextBox[]
  translatedRegions?: ComicTextRegion[]
  translatedText?: string | null
  model?: string | null
  ok: boolean
  error?: string | null
  elapsedMs: number
}

export interface RegionBoxConfig {
  x: number
  y: number
  width: number
  height: number
  passThrough: boolean
  sourceLang: string
  targetLang: string
  translationDisplayMode: "panel" | "inline" | "both"
  panelX?: number | null
  panelY?: number | null
  panelWidth: number
  panelHeight: number
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
