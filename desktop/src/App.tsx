import { useEffect, useMemo, useRef, useState } from "react"
import type { ButtonHTMLAttributes, MouseEvent } from "react"
import { listen } from "@tauri-apps/api/event"
import { getCurrentWindow } from "@tauri-apps/api/window"
import type { LucideIcon } from "lucide-react"
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import {
  BookOpen,
  Brain,
  Camera,
  ChartNetwork,
  CheckCircle2,
  Clipboard,
  Copy,
  Database,
  Folder,
  Keyboard,
  Languages,
  LayoutDashboard,
  MousePointer2,
  Move,
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from "lucide-react"
import {
  BackendRequestError,
  DEFAULT_KNOWLEDGE_CONFIG,
  DEFAULT_SELECTION_TRANSLATE_CONFIG,
  DEFAULT_OCR_CONFIG,
  DEFAULT_REGION_BOX_CONFIG,
  DEFAULT_MODEL_CONFIG,
  DEFAULT_NOTE_ADAPTER,
  DEFAULT_TRANSLATE_PROVIDER_CONFIG,
  askKnowledge,
  backendRequest,
  cancelScreenSelection,
  checkBackendHealth,
  clearCachedApiToken,
  debugRegionOcr,
  closeRegionBox,
  exportKnowledgeTopic,
  finishScreenSelection,
  enrichKnowledgeTopics,
  getCachedApiToken,
  getDesktopStatus,
  getKnowledgeConfig,
  getKnowledgeGraph,
  getKnowledgeStats,
  getKnowledgeTopicDetail,
  getKnowledgeTopics,
  getLatestOcrResult,
  getOcrConfig,
  getRegionBoxConfig,
  getLatestSelectionTranslateResult,
  getTranslateProviderConfig,
  getSelectionTranslateConfig,
  loadBackendConfig,
  openRegionBox,
  openExternalTarget,
  precheckSiyuanKnowledge,
  rebuildKnowledgeGraph,
  rebuildKnowledgeTopics,
  reindexKnowledge,
  runRegionTranslate,
  searchKnowledge,
  setCachedApiToken,
  setKnowledgeConfig,
  setOcrConfig,
  setRegionBoxConfig,
  setRegionBoxPassthrough,
  setSelectionTranslateConfig,
  setTranslateProviderConfig,
  startOcrRecognize,
  startOcrTranslate,
  syncSiyuanKnowledge,
  syncConfigToBackend,
  testTranslateProvider,
  translateText,
  triggerSelectionTranslate,
} from "./api"
import type {
  ClassifyResponse,
  DesktopStatus,
  KnowledgeAskResponse,
  KnowledgeCitation,
  KnowledgeConfig,
  KnowledgeGraphEdge,
  KnowledgeGraphLayer,
  KnowledgeGraphNode,
  KnowledgeGraphResponse,
  KnowledgeSearchResponse,
  KnowledgeStats,
  KnowledgeSiyuanPrecheckResponse,
  KnowledgeSiyuanSyncResponse,
  KnowledgeTopic,
  KnowledgeTopicDetailResponse,
  KnowledgeTopicDocument,
  KnowledgeTopicListResponse,
  KnowledgeTopicRelation,
  ModelConfig,
  NoteAdapterConfig,
  NotebookInfo,
  NotesTestResponse,
  OcrConfig,
  OcrDebugResult,
  OcrFlowResult,
  OcrProvider,
  RegionBoxConfig,
  SelectionTranslateConfig,
  SelectionTranslateResult,
  TabCategory,
  TabData,
  TabGroupColor,
  TabGroupStyleOptions,
  TranslateProvider,
  TranslateProviderConfig,
  TranslateProviderTestResponse,
} from "./types"
import { groupTabsByDomain } from "./utils"

type Section =
  | "overview"
  | "translate"
  | "knowledge"
  | "graph"
  | "categories"
  | "modelApi"
  | "notes"
  | "ocrDebug"
type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West"

type GraphCanvasNode = KnowledgeGraphNode
type GraphRelation = {
  childMap: Map<string, string[]>
  parentMap: Map<string, string[]>
  edgeKindMap: Map<string, string>
  roots: string[]
}

type GraphNodeRelation = {
  node: KnowledgeGraphNode
  kind: string
}

type GraphSelectedRelation = {
  source: KnowledgeGraphNode
  target: KnowledgeGraphNode
  kind: string
}

type GraphFlowNodeData = Record<string, unknown> & {
  graphNode: GraphCanvasNode
  childCount: number
  expanded: boolean
  selected: boolean
  relatedToSelected: boolean
  isLeaf: boolean
  onSelect: (node: GraphCanvasNode) => void
  onToggle: (node: GraphCanvasNode) => void
}
type GraphFlowNode = Node<GraphFlowNodeData, "knowledgeMap">
type GraphFlowEdge = Edge<{ kind: string }, "smoothstep">

const GRAPH_COLUMN_WIDTH = 360
const GRAPH_ROW_HEIGHT = 184
const GRAPH_NODE_X = 48
const GRAPH_NODE_Y = 52
const GRAPH_EDGE_LABEL_LIMIT = 80

const TAB_GROUP_STYLE_KEY = "tabkeep.desktop.tabGroupStyle"
const importMetaEnv = (import.meta as ImportMeta & {
  env?: Record<string, string | boolean | undefined>
}).env
const SHOW_OCR_DEBUG =
  importMetaEnv?.DEV === true || importMetaEnv?.VITE_TABKEEP_SHOW_OCR_DEBUG === "true"

const COLORS: TabGroupColor[] = [
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
]

const COLOR_LABEL: Record<TabGroupColor, string> = {
  grey: "灰色",
  blue: "蓝色",
  red: "红色",
  yellow: "黄色",
  green: "绿色",
  pink: "粉色",
  purple: "紫色",
  cyan: "青色",
  orange: "橙色",
}

const DEFAULT_STYLE: TabGroupStyleOptions = {
  colorMode: "random",
  uniformColor: "blue",
  useDomainAsTitle: true,
  collapsedByDefault: false,
}

function App() {
  const view = new URLSearchParams(window.location.search).get("view")
  if (view === "capture") return <CaptureOverlay />
  if (view === "ocr-result") return <OcrResultWindow />
  if (view === "region-box") return <RegionBoxWindow />
  if (view === "region-panel") return <RegionPanelWindow />
  if (view === "selection-panel") return <SelectionPanelWindow />
  return <DesktopApp />
}

function DesktopApp() {
  const [section, setSection] = useState<Section>("overview")
  const [desktopStatus, setDesktopStatus] = useState<DesktopStatus | null>(null)
  const [backendReady, setBackendReady] = useState<boolean | null>(null)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [tabs, setTabs] = useState<TabData[]>([])
  const [modelConfig, setModelConfig] = useState<ModelConfig>(DEFAULT_MODEL_CONFIG)
  const [tabCategories, setTabCategories] = useState<TabCategory[]>([])
  const [noteAdapter, setNoteAdapter] = useState<NoteAdapterConfig>(DEFAULT_NOTE_ADAPTER)
  const [tokenInput, setTokenInput] = useState("")

  const refreshAll = async () => {
    setRefreshing(true)
    setConnectionError(null)
    try {
      const status = await getDesktopStatus()
      setDesktopStatus(status)
      const token = await getCachedApiToken()
      setTokenInput(token ?? "")

      const backendOk = await checkBackendHealth()
      setBackendReady(backendOk)
      if (!backendOk) {
        setConnectionError("FastAPI 后端未连接")
        return
      }

      try {
        const config = await loadBackendConfig()
        setModelConfig(config.modelConfig)
        setTabCategories(config.tabCategories)
        setNoteAdapter(config.noteAdapter)
      } catch (err) {
        setConnectionError(errorMessage(err))
      }

      try {
        const data = await backendRequest<TabData[]>("GET", "/tabs")
        setTabs(Array.isArray(data) ? data : [])
      } catch {
        setTabs([])
      }
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    refreshAll()
  }, [])

  const navItems: { id: Section; label: string; icon: LucideIcon }[] = [
    { id: "overview", label: "概览", icon: LayoutDashboard },
    { id: "translate", label: "翻译", icon: Languages },
    { id: "knowledge", label: "知识库", icon: Database },
    { id: "graph", label: "知识工作台", icon: ChartNetwork },
    { id: "categories", label: "分组", icon: Folder },
    { id: "modelApi", label: "模型 API", icon: Brain },
    { id: "notes", label: "笔记集成", icon: BookOpen },
  ]
  const debugNavItems: { id: Section; label: string; icon: LucideIcon }[] = SHOW_OCR_DEBUG
    ? [{ id: "ocrDebug", label: "OCR 调试", icon: Settings2 }]
    : []

  const saveToken = async () => {
    const token = tokenInput.trim()
    if (!token) return
    await setCachedApiToken(token)
    await refreshAll()
  }

  const clearToken = async () => {
    await clearCachedApiToken()
    setTokenInput("")
    await refreshAll()
  }

  return (
    <div className="tk-app-frame">
      <DesktopTitlebar />
      <div className="tk-desktop-shell">
        <aside className="tk-sidebar">
        <div>
          <div className="tk-wordmark">
            Tab<span className="tk-wordmark-accent">Keep</span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Desktop Status</p>
        </div>

        <nav className="tk-sidebar-nav">
          {navItems.map((item) => {
            const Icon = item.icon
            const active = section === item.id
            return (
              <button
                key={item.id}
                className={`tk-nav-item ${active ? "tk-nav-item-active" : ""}`}
                onClick={() => setSection(item.id)}>
                <Icon className="h-4 w-4" />
                <span>{item.label}</span>
              </button>
            )
          })}
        </nav>

        {debugNavItems.length > 0 && (
          <div className="tk-sidebar-debug">
            <p className="tk-sidebar-debug-label">开发调试</p>
            {debugNavItems.map((item) => {
              const Icon = item.icon
              const active = section === item.id
              return (
                <button
                  key={item.id}
                  className={`tk-nav-item ${active ? "tk-nav-item-active" : ""}`}
                  onClick={() => setSection(item.id)}>
                  <Icon className="h-4 w-4" />
                  <span>{item.label}</span>
                </button>
              )
            })}
          </div>
        )}

        <div className="space-y-3 border-t border-border pt-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <PlugZap className="h-3.5 w-3.5" />
            <span>{desktopStatus?.desktop_url ?? "http://127.0.0.1:38472"}</span>
          </div>
          <Button variant="secondary" className="w-full" onClick={refreshAll} disabled={refreshing}>
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            刷新状态
          </Button>
        </div>
        </aside>

        <main className="tk-main">
        {section === "overview" && (
          <OverviewSection
            tabs={tabs}
            backendReady={backendReady}
            desktopStatus={desktopStatus}
            connectionError={connectionError}
            tokenInput={tokenInput}
            setTokenInput={setTokenInput}
            onSaveToken={saveToken}
            onClearToken={clearToken}
            onRefresh={refreshAll}
            refreshing={refreshing}
          />
        )}
        {section === "translate" && <TranslateSection />}
        {section === "knowledge" && <KnowledgeSection />}
        {section === "graph" && <KnowledgeGraphSection noteAdapter={noteAdapter} />}
        {section === "categories" && (
          <CategoriesSection
            tabs={tabs}
            categories={tabCategories}
            setCategories={setTabCategories}
          />
        )}
        {section === "modelApi" && (
          <ModelApiSection config={modelConfig} setConfig={setModelConfig} />
        )}
        {section === "notes" && (
          <NotesSection config={noteAdapter} setConfig={setNoteAdapter} />
        )}
        {section === "ocrDebug" && SHOW_OCR_DEBUG && <OcrDebugSection />}
        </main>
      </div>
    </div>
  )
}

function DesktopTitlebar() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    let mounted = true
    getCurrentWindow()
      .isMaximized()
      .then((value) => {
        if (mounted) setMaximized(value)
      })
      .catch(() => {})
    return () => {
      mounted = false
    }
  }, [])

  const startDrag = async (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.detail > 1) return
    try {
      await getCurrentWindow().startDragging()
    } catch {
      // Native dragging may be rejected if the pointer is already released.
    }
  }

  const minimize = async () => {
    await getCurrentWindow().minimize()
  }

  const toggleMaximize = async () => {
    const currentWindow = getCurrentWindow()
    await currentWindow.toggleMaximize()
    setMaximized(await currentWindow.isMaximized())
  }

  const close = async () => {
    await getCurrentWindow().close()
  }

  return (
    <div className="tk-window-titlebar">
      <div className="tk-window-drag-region" onMouseDown={startDrag} onDoubleClick={toggleMaximize}>
        <div className="tk-window-mark" aria-hidden="true" />
        <div className="tk-window-title">
          <span>TabKeep</span>
          <span>Desktop</span>
        </div>
      </div>
      <div className="tk-window-controls">
        <button className="tk-window-control" type="button" onClick={minimize} aria-label="最小化">
          <span className="tk-window-control-min" />
        </button>
        <button className="tk-window-control" type="button" onClick={toggleMaximize} aria-label={maximized ? "还原" : "最大化"}>
          <span className={maximized ? "tk-window-control-restore" : "tk-window-control-max"} />
        </button>
        <button className="tk-window-control tk-window-control-close" type="button" onClick={close} aria-label="关闭">
          <span className="tk-window-control-x" />
        </button>
      </div>
    </div>
  )
}

function OverviewSection({
  tabs,
  backendReady,
  desktopStatus,
  connectionError,
  tokenInput,
  setTokenInput,
  onSaveToken,
  onClearToken,
  onRefresh,
  refreshing,
}: {
  tabs: TabData[]
  backendReady: boolean | null
  desktopStatus: DesktopStatus | null
  connectionError: string | null
  tokenInput: string
  setTokenInput: (value: string) => void
  onSaveToken: () => Promise<void>
  onClearToken: () => Promise<void>
  onRefresh: () => Promise<void>
  refreshing: boolean
}) {
  const groupedTabs = useMemo(() => groupTabsByDomain(tabs), [tabs])
  const groupableCount = groupedTabs.reduce(
    (sum, group) => sum + (group.tabs.length >= 2 ? group.tabs.length : 0),
    0,
  )
  const [style, setStyle] = useState<TabGroupStyleOptions>(() => loadTabGroupStyle())
  const [saved, setSaved] = useState(false)
  const [groupNotice, setGroupNotice] = useState<string | null>(null)

  const saveStyle = () => {
    localStorage.setItem(TAB_GROUP_STYLE_KEY, JSON.stringify(style))
    setSaved(true)
    window.setTimeout(() => setSaved(false), 1500)
  }

  return (
    <div className="space-y-5">
      <header className="tk-topbar">
        <div>
          <h1 className="tk-page-title">概览</h1>
          <p className="tk-page-subtitle">标签状态、连接状态和 Tab Group 默认样式</p>
        </div>
        <Button variant="secondary" onClick={onRefresh} disabled={refreshing}>
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          刷新
        </Button>
      </header>

      <section className="tk-status-grid">
        <StatusCard
          title="桌面状态"
          value={desktopStatus?.ok ? "运行中" : "未就绪"}
          tone={desktopStatus?.ok ? "success" : "warning"}
        />
        <StatusCard
          title="FastAPI 后端"
          value={backendReady === null ? "检查中" : backendReady ? "已连接" : "未连接"}
          tone={backendReady ? "success" : backendReady === false ? "error" : "warning"}
        />
        <StatusCard
          title="API Token"
          value={desktopStatus?.token_cached ? "已缓存" : "未缓存"}
          tone={desktopStatus?.token_cached ? "success" : "warning"}
        />
        <StatusCard title="标签页" value={`${tabs.length} 个`} tone="neutral" />
      </section>

      {connectionError && <Notice tone="warning">{connectionError}</Notice>}

      <section className="tk-grid-two">
        <div className="space-y-4">
          <section className="tk-panel">
            <div className="tk-panel-header">
              <div>
                <h2 className="tk-panel-title">Tab Group 默认样式</h2>
                <p className="text-xs text-muted-foreground">配置会保存在桌面端本地</p>
              </div>
              <span className="tk-badge">{saved ? "已保存" : "本地"}</span>
            </div>
            <div className="tk-panel-body space-y-4">
              <div className="tk-form-grid">
                <label className="tk-field">
                  <span className="tk-label">颜色模式</span>
                  <select
                    className="tk-select"
                    value={style.colorMode}
                    onChange={(event) =>
                      setStyle({
                        ...style,
                        colorMode: event.target.value as TabGroupStyleOptions["colorMode"],
                      })
                    }>
                    <option value="random">按域名随机</option>
                    <option value="uniform">统一颜色</option>
                  </select>
                </label>

                {style.colorMode === "uniform" && (
                  <label className="tk-field">
                    <span className="tk-label">统一颜色</span>
                    <select
                      className="tk-select"
                      value={style.uniformColor}
                      onChange={(event) =>
                        setStyle({ ...style, uniformColor: event.target.value as TabGroupColor })
                      }>
                      {COLORS.map((color) => (
                        <option key={color} value={color}>
                          {COLOR_LABEL[color]}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>

              <div className="grid gap-2">
                <Checkbox
                  label="使用域名作为分组标题"
                  checked={style.useDomainAsTitle}
                  onChange={(checked) => setStyle({ ...style, useDomainAsTitle: checked })}
                />
                <Checkbox
                  label="默认折叠分组"
                  checked={style.collapsedByDefault}
                  onChange={(checked) => setStyle({ ...style, collapsedByDefault: checked })}
                />
              </div>
            </div>
            <div className="tk-command-bar">
              <Button onClick={saveStyle}>{saved ? "已保存" : "保存设置"}</Button>
              <Button
                variant="secondary"
                onClick={() => setGroupNotice("桌面端已保留该配置；实际整理当前 Chrome 窗口仍由扩展执行。")}>
                立即对当前窗口分组
              </Button>
              <Button variant="ghost" onClick={() => setStyle(DEFAULT_STYLE)}>
                <RotateCcw className="h-4 w-4" />
                重置
              </Button>
            </div>
          </section>

          {groupNotice && <Notice>{groupNotice}</Notice>}
        </div>

        <section className="tk-panel">
          <div className="tk-panel-header">
            <h2 className="tk-panel-title">连接凭据</h2>
            <span className="tk-badge tk-badge-warning">本机</span>
          </div>
          <div className="tk-panel-body space-y-3">
            <label className="tk-field">
              <span className="tk-label">TabKeep API Token</span>
              <input
                className="tk-input"
                type="password"
                value={tokenInput}
                onChange={(event) => setTokenInput(event.target.value)}
                placeholder="由扩展同步，或手动粘贴"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button onClick={onSaveToken} disabled={!tokenInput.trim()}>
                保存 Token
              </Button>
              <Button variant="secondary" onClick={onClearToken}>
                清除
              </Button>
            </div>
            <div className="tk-muted-box">
              打开扩展 popup 或设置页后，桌面状态会自动缓存扩展传来的 token。
            </div>
          </div>
        </section>
      </section>

      <section className="tk-panel">
        <div className="tk-panel-header">
          <h2 className="tk-panel-title">域名分布</h2>
          <span className="tk-badge">{groupedTabs.length} 组</span>
        </div>
        <div className="tk-panel-body">
          {groupedTabs.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无标签页数据</p>
          ) : (
            <div className="grid gap-2">
              {groupedTabs.map((group) => (
                <div
                  key={group.domain}
                  className="flex items-center gap-3 rounded-md border border-border px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">{group.domain}</span>
                  <span className="text-xs text-muted-foreground">
                    {group.count} 个{group.tabs.length >= 2 ? " · 可分组" : ""}
                  </span>
                </div>
              ))}
            </div>
          )}
          {groupableCount > 0 && (
            <p className="mt-3 text-xs text-muted-foreground">当前可分组标签：{groupableCount} 个</p>
          )}
        </div>
      </section>
    </div>
  )
}

function TranslateSection() {
  const [sourceText, setSourceText] = useState("")
  const [translatedText, setTranslatedText] = useState("")
  const [sourceLang, setSourceLang] = useState("auto")
  const [targetLang, setTargetLang] = useState("简体中文")
  const [status, setStatus] = useState<string | null>(null)
  const [translating, setTranslating] = useState(false)
  const [ocrConfig, setOcrConfigState] = useState<OcrConfig>(DEFAULT_OCR_CONFIG)
  const [ocrSaving, setOcrSaving] = useState(false)
  const [ocrBusy, setOcrBusy] = useState<"recognize" | "translate" | null>(null)
  const [translateProviderConfig, setTranslateProviderConfigState] =
    useState<TranslateProviderConfig>(DEFAULT_TRANSLATE_PROVIDER_CONFIG)
  const [translateProviderSaving, setTranslateProviderSaving] = useState(false)
  const [translateProviderTesting, setTranslateProviderTesting] = useState(false)
  const [translateProviderTest, setTranslateProviderTest] =
    useState<TranslateProviderTestResponse | null>(null)
  const [selectionConfig, setSelectionConfigState] =
    useState<SelectionTranslateConfig>(DEFAULT_SELECTION_TRANSLATE_CONFIG)
  const [selectionSaving, setSelectionSaving] = useState(false)
  const [selectionTriggering, setSelectionTriggering] = useState(false)

  const targetOptions = ["简体中文", "English", "日本語", "한국어", "Français", "Deutsch"]
  const canTranslate = sourceText.trim().length > 0 && !translating

  useEffect(() => {
    let cancelled = false
    Promise.allSettled([
      getOcrConfig(),
      getTranslateProviderConfig(),
      getSelectionTranslateConfig(),
    ]).then((results) => {
      if (cancelled) return
      const [ocrResult, translateProviderResult, selectionResult] = results
      if (ocrResult.status === "fulfilled") {
        setOcrConfigState(ocrResult.value)
      } else {
        setStatus(`读取 OCR 设置失败: ${errorMessage(ocrResult.reason)}`)
      }
      if (translateProviderResult.status === "fulfilled") {
        setTranslateProviderConfigState(translateProviderResult.value)
      } else {
        setStatus(`读取翻译 Provider 设置失败: ${errorMessage(translateProviderResult.reason)}`)
      }
      if (selectionResult.status === "fulfilled") {
        setSelectionConfigState(selectionResult.value)
      } else {
        setStatus(`读取划词翻译设置失败: ${errorMessage(selectionResult.reason)}`)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  const runTranslate = async () => {
    const text = sourceText.trim()
    if (!text) return
    setTranslating(true)
    setStatus(null)
    setTranslatedText("")
    try {
      const result = await translateText({
        text,
        sourceLang,
        targetLang,
      }, "/input_translate")
      setTranslatedText(result.translatedText)
      setStatus(`已完成 · ${result.model}`)
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setTranslating(false)
    }
  }

  const pasteText = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (text) setSourceText(text)
    } catch (err) {
      setStatus(`读取剪贴板失败: ${errorMessage(err)}`)
    }
  }

  const copyResult = async () => {
    if (!translatedText) return
    try {
      await navigator.clipboard.writeText(translatedText)
      setStatus("译文已复制")
    } catch (err) {
      setStatus(`复制失败: ${errorMessage(err)}`)
    }
  }

  const swapText = () => {
    if (!translatedText) return
    setSourceText(translatedText)
    setTranslatedText(sourceText)
    setSourceLang(targetLang)
    setTargetLang(sourceLang === "auto" ? "English" : sourceLang)
  }

  const saveOcrSettings = async () => {
    setOcrSaving(true)
    setStatus(null)
    try {
      await setOcrConfig(ocrConfig)
      setStatus("OCR 设置已保存")
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setOcrSaving(false)
    }
  }

  const updateOcrNumber = (
    key: "paddleMinScore" | "preprocessScale" | "preprocessContrast",
    value: string,
    fallback: number,
  ) => {
    const numeric = Number(value)
    setOcrConfigState({
      ...ocrConfig,
      [key]: Number.isFinite(numeric) ? numeric : fallback,
    })
  }

  const saveTranslateProviderSettings = async () => {
    setTranslateProviderSaving(true)
    setStatus(null)
    try {
      const saved = await setTranslateProviderConfig(translateProviderConfig)
      setTranslateProviderConfigState(saved)
      setStatus("翻译 Provider 设置已保存")
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setTranslateProviderSaving(false)
    }
  }

  const testCurrentTranslateProvider = async () => {
    setTranslateProviderTesting(true)
    setTranslateProviderTest(null)
    setStatus(null)
    try {
      const result = await testTranslateProvider(translateProviderConfig)
      setTranslateProviderTest(result)
      setStatus(
        result.ok
          ? `测试成功 · ${result.provider} · ${result.latencyMs}ms`
          : result.error ?? "Provider 测试失败",
      )
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setTranslateProviderTesting(false)
    }
  }

  const saveSelectionTranslateSettings = async () => {
    setSelectionSaving(true)
    setStatus(null)
    try {
      const saved = await setSelectionTranslateConfig(selectionConfig)
      setSelectionConfigState(saved)
      setStatus(saved.hotkeyError ?? "划词翻译设置已保存")
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setSelectionSaving(false)
    }
  }

  const runSelectionTranslateTest = async () => {
    setSelectionTriggering(true)
    setStatus("正在最小化桌面端，1 秒后读取当前应用选中文本")
    try {
      try {
        await getCurrentWindow().minimize()
      } catch {
        // Ignore minimize failures; the global hotkey flow still works.
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1000))
      const result = await triggerSelectionTranslate()
      setStatus(result.ok ? "划词翻译已完成" : result.error ?? "划词翻译未完成")
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setSelectionTriggering(false)
    }
  }

  const runScreenshotOcr = async (mode: "recognize" | "translate") => {
    setOcrBusy(mode)
    setStatus("请在屏幕上框选要识别的区域")
    try {
      const payload = {
        screenshot: true,
        provider: ocrConfig.provider,
        sourceLang,
        targetLang,
      }
      const result =
        mode === "recognize"
          ? await startOcrRecognize(payload)
          : await startOcrTranslate(payload)
      setStatus(result.ok ? "OCR 结果已在悬浮窗显示" : result.error ?? "OCR 未完成")
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setOcrBusy(null)
    }
  }

  const openFixedRegion = async () => {
    setStatus(null)
    try {
      const config = await openRegionBox()
      setStatus(
        `固定翻译框已打开 · ${config.width}x${config.height} @ ${config.x},${config.y}`,
      )
    } catch (err) {
      setStatus(errorMessage(err))
    }
  }

  const closeFixedRegion = async () => {
    setStatus(null)
    try {
      await closeRegionBox()
      setStatus("固定翻译框已关闭")
    } catch (err) {
      setStatus(errorMessage(err))
    }
  }

  return (
    <div className="space-y-5">
      <header className="tk-topbar">
        <div>
          <h1 className="tk-page-title">翻译</h1>
          <p className="tk-page-subtitle">文本翻译、截图 OCR 翻译和固定区域翻译</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={pasteText}>
            <Clipboard className="h-4 w-4" />
            粘贴
          </Button>
          <Button onClick={runTranslate} disabled={!canTranslate}>
            <Languages className={`h-4 w-4 ${translating ? "animate-pulse" : ""}`} />
            {translating ? "翻译中..." : "翻译"}
          </Button>
        </div>
      </header>

      {status && <Notice tone={translatedText ? "success" : "warning"}>{status}</Notice>}

      <section className="tk-translate-grid">
        <div className="tk-panel">
          <div className="tk-panel-header">
            <h2 className="tk-panel-title">原文</h2>
            <div className="flex items-center gap-2">
              <select
                className="tk-select tk-compact-select"
                value={sourceLang}
                onChange={(event) => setSourceLang(event.target.value)}>
                <option value="auto">自动识别</option>
                {targetOptions.map((lang) => (
                  <option key={lang} value={lang}>
                    {lang}
                  </option>
                ))}
              </select>
              <button className="tk-icon-button" onClick={() => setSourceText("")} title="清空">
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="tk-panel-body">
            <textarea
              className="tk-textarea tk-translate-textarea"
              value={sourceText}
              onChange={(event) => setSourceText(event.target.value)}
              placeholder="输入或粘贴要翻译的文本"
            />
          </div>
          <div className="tk-command-bar">
            <span className="text-xs text-muted-foreground">{sourceText.trim().length} 字符</span>
          </div>
        </div>

        <div className="tk-panel">
          <div className="tk-panel-header">
            <h2 className="tk-panel-title">译文</h2>
            <div className="flex items-center gap-2">
              <select
                className="tk-select tk-compact-select"
                value={targetLang}
                onChange={(event) => setTargetLang(event.target.value)}>
                {targetOptions.map((lang) => (
                  <option key={lang} value={lang}>
                    {lang}
                  </option>
                ))}
              </select>
              <button className="tk-icon-button" onClick={copyResult} title="复制译文" disabled={!translatedText}>
                <Copy className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="tk-panel-body">
            <textarea
              className="tk-textarea tk-translate-textarea"
              value={translatedText}
              onChange={(event) => setTranslatedText(event.target.value)}
              placeholder={translating ? "正在生成译文..." : "译文会显示在这里"}
            />
          </div>
          <div className="tk-command-bar">
            <Button variant="secondary" onClick={swapText} disabled={!translatedText}>
              交换
            </Button>
            <span className="text-xs text-muted-foreground">{translatedText.trim().length} 字符</span>
          </div>
        </div>
      </section>

      <section className="tk-panel">
        <div className="tk-panel-header">
          <div>
            <h2 className="tk-panel-title">划词翻译</h2>
            <p className="text-xs text-muted-foreground">
              在任意应用中选中文字，按 {selectionConfig.hotkey} 直接翻译
            </p>
          </div>
          <span className={`tk-badge ${selectionConfig.enabled ? "tk-badge-success" : "tk-badge-warning"}`}>
            {selectionConfig.enabled ? "已启用" : "已关闭"}
          </span>
        </div>
        <div className="tk-panel-body space-y-4">
          <div className="tk-form-grid">
            <label className="tk-field">
              <span className="tk-label">快捷键</span>
              <input className="tk-input" value={selectionConfig.hotkey} readOnly />
            </label>
            <label className="tk-field">
              <span className="tk-label">源语言</span>
              <select
                className="tk-select"
                value={selectionConfig.sourceLang}
                onChange={(event) =>
                  setSelectionConfigState({
                    ...selectionConfig,
                    sourceLang: event.target.value,
                  })
                }>
                <option value="auto">自动识别</option>
                {targetOptions.map((lang) => (
                  <option key={lang} value={lang}>
                    {lang}
                  </option>
                ))}
              </select>
            </label>
            <label className="tk-field">
              <span className="tk-label">目标语言</span>
              <select
                className="tk-select"
                value={selectionConfig.targetLang}
                onChange={(event) =>
                  setSelectionConfigState({
                    ...selectionConfig,
                    targetLang: event.target.value,
                  })
                }>
                {targetOptions.map((lang) => (
                  <option key={lang} value={lang}>
                    {lang}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <Checkbox
            label="启用全局划词翻译快捷键"
            checked={selectionConfig.enabled}
            onChange={(enabled) => setSelectionConfigState({ ...selectionConfig, enabled })}
          />
          {selectionConfig.hotkeyError && (
            <Notice tone="warning">{selectionConfig.hotkeyError}</Notice>
          )}
        </div>
        <div className="tk-command-bar">
          <Button onClick={saveSelectionTranslateSettings} disabled={selectionSaving}>
            <Settings2 className="h-4 w-4" />
            {selectionSaving ? "保存中..." : "保存划词设置"}
          </Button>
          <Button
            variant="secondary"
            onClick={runSelectionTranslateTest}
            disabled={selectionTriggering}>
            <Keyboard className={`h-4 w-4 ${selectionTriggering ? "animate-pulse" : ""}`} />
            {selectionTriggering ? "读取中..." : "手动测试"}
          </Button>
        </div>
      </section>

      <section className="tk-panel">
        <div className="tk-panel-header">
          <div>
            <h2 className="tk-panel-title">固定区域翻译框</h2>
            <p className="text-xs text-muted-foreground">把区域框放到游戏或视频字幕上，直接翻译框内内容</p>
          </div>
          <span className="tk-badge">区域</span>
        </div>
        <div className="tk-panel-body">
          <div className="flex flex-wrap gap-2">
            <Button onClick={openFixedRegion}>
              <Move className="h-4 w-4" />
              打开固定翻译框
            </Button>
            <Button variant="secondary" onClick={closeFixedRegion}>
              <X className="h-4 w-4" />
              关闭固定翻译框
            </Button>
          </div>
        </div>
      </section>

      <section className="tk-panel">
        <div className="tk-panel-header">
          <div>
            <h2 className="tk-panel-title">快速翻译 Provider</h2>
            <p className="text-xs text-muted-foreground">
              文本翻译、截图翻译和固定区域翻译都会使用这里保存的 provider
            </p>
          </div>
          <span className="tk-badge">
            {translateProviderConfig.provider === "openai_compatible"
              ? "模型"
              : translateProviderConfig.provider === "baidu"
                ? "百度"
                : "火山"}
          </span>
        </div>
        <div className="tk-panel-body space-y-4">
          <div className="tk-form-grid">
            <label className="tk-field">
              <span className="tk-label">Provider</span>
              <select
                className="tk-select"
                value={translateProviderConfig.provider}
                onChange={(event) =>
                  setTranslateProviderConfigState({
                    ...translateProviderConfig,
                    provider: event.target.value as TranslateProvider,
                  })
                }>
                <option value="openai_compatible">OpenAI-compatible 精翻</option>
                <option value="baidu">百度翻译 快速</option>
                <option value="volcengine">火山翻译 快速</option>
              </select>
            </label>

            {translateProviderConfig.provider === "baidu" && (
              <>
                <TextField
                  label="百度 App ID"
                  value={translateProviderConfig.baiduAppId}
                  onChange={(value) =>
                    setTranslateProviderConfigState({
                      ...translateProviderConfig,
                      baiduAppId: value,
                    })
                  }
                  placeholder="在百度翻译开放平台获取"
                />
                <TextField
                  label="百度密钥"
                  type="password"
                  value={translateProviderConfig.baiduSecret}
                  onChange={(value) =>
                    setTranslateProviderConfigState({
                      ...translateProviderConfig,
                      baiduSecret: value,
                    })
                  }
                  placeholder="Secret Key"
                />
              </>
            )}

            {translateProviderConfig.provider === "volcengine" && (
              <>
                <TextField
                  label="火山 Access Key"
                  value={translateProviderConfig.volcengineAccessKey}
                  onChange={(value) =>
                    setTranslateProviderConfigState({
                      ...translateProviderConfig,
                      volcengineAccessKey: value,
                    })
                  }
                  placeholder="Access Key ID"
                />
                <TextField
                  label="火山 Secret Key"
                  type="password"
                  value={translateProviderConfig.volcengineSecretKey}
                  onChange={(value) =>
                    setTranslateProviderConfigState({
                      ...translateProviderConfig,
                      volcengineSecretKey: value,
                    })
                  }
                  placeholder="Secret Access Key"
                />
                <TextField
                  label="火山 Region"
                  value={translateProviderConfig.volcengineRegion}
                  onChange={(value) =>
                    setTranslateProviderConfigState({
                      ...translateProviderConfig,
                      volcengineRegion: value,
                    })
                  }
                  placeholder="cn-north-1"
                />
              </>
            )}
          </div>
        </div>
        <div className="tk-command-bar">
          <Button
            variant="secondary"
            onClick={testCurrentTranslateProvider}
            disabled={translateProviderTesting}>
            <PlugZap className={`h-4 w-4 ${translateProviderTesting ? "animate-pulse" : ""}`} />
            {translateProviderTesting ? "测试中..." : "测试连接"}
          </Button>
          <Button onClick={saveTranslateProviderSettings} disabled={translateProviderSaving}>
            <Settings2 className="h-4 w-4" />
            {translateProviderSaving ? "保存中..." : "保存 Provider 设置"}
          </Button>
          <Button
            variant="ghost"
            onClick={() => setTranslateProviderConfigState(DEFAULT_TRANSLATE_PROVIDER_CONFIG)}>
            <RotateCcw className="h-4 w-4" />
            重置为模型翻译
          </Button>
          {translateProviderTest && (
            <span
              className={`text-sm ${
                translateProviderTest.ok ? "text-emerald-700" : "text-rose-700"
              }`}>
              {translateProviderTest.ok
                ? `${translateProviderTest.provider} · ${translateProviderTest.latencyMs}ms · ${translateProviderTest.translatedText ?? ""}`
                : translateProviderTest.error ?? "测试失败"}
            </span>
          )}
        </div>
      </section>

      <section className="tk-panel">
        <div className="tk-panel-header">
          <div>
            <h2 className="tk-panel-title">截图 OCR</h2>
            <p className="text-xs text-muted-foreground">框选屏幕区域后，结果会在置顶悬浮窗显示</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => runScreenshotOcr("recognize")}
              disabled={ocrBusy !== null}>
              <Camera className={`h-4 w-4 ${ocrBusy === "recognize" ? "animate-pulse" : ""}`} />
              截图 OCR
            </Button>
            <Button onClick={() => runScreenshotOcr("translate")} disabled={ocrBusy !== null}>
              <Languages className={`h-4 w-4 ${ocrBusy === "translate" ? "animate-pulse" : ""}`} />
              截图翻译
            </Button>
          </div>
        </div>
        <div className="tk-panel-body space-y-4">
          <div className="tk-form-grid">
            <label className="tk-field">
              <span className="tk-label">OCR Provider</span>
              <select
                className="tk-select"
                value={ocrConfig.provider}
                onChange={(event) =>
                  setOcrConfigState({
                    ...ocrConfig,
                    provider: event.target.value as OcrProvider,
                  })
                }>
                <option value="windows_ocr">Windows OCR</option>
                <option value="paddleocr_json">PaddleOCR-json</option>
              </select>
            </label>
            <TextField
              label="PaddleOCR-json.exe"
              value={ocrConfig.paddleExePath}
              onChange={(value) => setOcrConfigState({ ...ocrConfig, paddleExePath: value })}
              placeholder="D:\\PaddleOCR-json\\PaddleOCR-json.exe"
            />
            <TextField
              label="Paddle models"
              value={ocrConfig.paddleModelsPath}
              onChange={(value) => setOcrConfigState({ ...ocrConfig, paddleModelsPath: value })}
              placeholder="可留空"
            />
            <TextField
              label="Paddle config"
              value={ocrConfig.paddleConfigPath}
              onChange={(value) => setOcrConfigState({ ...ocrConfig, paddleConfigPath: value })}
              placeholder="可留空"
            />
            <TextField
              label="Paddle 最低置信度"
              type="number"
              value={String(ocrConfig.paddleMinScore)}
              onChange={(value) => updateOcrNumber("paddleMinScore", value, DEFAULT_OCR_CONFIG.paddleMinScore)}
              placeholder="0.45"
            />
          </div>

          <div className="rounded-md border border-white/70 bg-[rgb(247_250_248)] p-3 ring-1 ring-slate-900/5">
            <div className="mb-3">
              <h3 className="text-sm font-semibold text-slate-900">图像预处理</h3>
              <p className="mt-1 text-xs text-muted-foreground">适合小字、字幕描边和复杂背景，二值化建议只在普通增强不够时开启</p>
            </div>
            <div className="tk-form-grid">
              <Checkbox
                label="启用图像预处理"
                checked={ocrConfig.preprocessEnabled}
                onChange={(checked) => setOcrConfigState({ ...ocrConfig, preprocessEnabled: checked })}
              />
              <label className="tk-field">
                <span className="tk-label">放大倍率</span>
                <select
                  className="tk-select"
                  value={String(ocrConfig.preprocessScale)}
                  onChange={(event) =>
                    updateOcrNumber("preprocessScale", event.target.value, DEFAULT_OCR_CONFIG.preprocessScale)
                  }>
                  <option value="1">1x</option>
                  <option value="2">2x</option>
                  <option value="3">3x</option>
                  <option value="4">4x</option>
                </select>
              </label>
              <TextField
                label="对比度增强"
                type="number"
                value={String(ocrConfig.preprocessContrast)}
                onChange={(value) =>
                  updateOcrNumber("preprocessContrast", value, DEFAULT_OCR_CONFIG.preprocessContrast)
                }
                placeholder="18"
              />
              <Checkbox
                label="灰度化"
                checked={ocrConfig.preprocessGrayscale}
                onChange={(checked) => setOcrConfigState({ ...ocrConfig, preprocessGrayscale: checked })}
              />
              <Checkbox
                label="锐化文字边缘"
                checked={ocrConfig.preprocessSharpen}
                onChange={(checked) => setOcrConfigState({ ...ocrConfig, preprocessSharpen: checked })}
              />
              <Checkbox
                label="二值化"
                checked={ocrConfig.preprocessThreshold}
                onChange={(checked) => setOcrConfigState({ ...ocrConfig, preprocessThreshold: checked })}
              />
            </div>
          </div>

          <div className="rounded-md border border-white/70 bg-[rgb(247_250_248)] p-3 ring-1 ring-slate-900/5">
            <div className="mb-3">
              <h3 className="text-sm font-semibold text-slate-900">文本后处理</h3>
              <p className="mt-1 text-xs text-muted-foreground">清理 OCR 空格、噪声和相邻重复行，翻译前会先使用处理后的文本</p>
            </div>
            <div className="tk-form-grid">
              <Checkbox
                label="启用文本后处理"
                checked={ocrConfig.textPostprocessEnabled}
                onChange={(checked) => setOcrConfigState({ ...ocrConfig, textPostprocessEnabled: checked })}
              />
              <Checkbox
                label="合并换行"
                checked={ocrConfig.textMergeLines}
                onChange={(checked) => setOcrConfigState({ ...ocrConfig, textMergeLines: checked })}
              />
            </div>
          </div>
        </div>
        <div className="tk-command-bar">
          <Button onClick={saveOcrSettings} disabled={ocrSaving}>
            <Settings2 className="h-4 w-4" />
            {ocrSaving ? "保存中..." : "保存 OCR 设置"}
          </Button>
          <Button
            variant="ghost"
            onClick={() => setOcrConfigState(DEFAULT_OCR_CONFIG)}>
            <RotateCcw className="h-4 w-4" />
            重置为 PaddleOCR-json
          </Button>
        </div>
      </section>

    </div>
  )
}

function OcrDebugSection() {
  const [ocrConfig, setOcrConfigState] = useState<OcrConfig>(DEFAULT_OCR_CONFIG)
  const [result, setResult] = useState<OcrDebugResult | null>(null)
  const [status, setStatus] = useState("打开固定区域框后，运行一次调试即可对比原图和预处理效果")
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    getOcrConfig()
      .then((config) => {
        setOcrConfigState(config)
      })
      .catch((err) => {
        setStatus(`读取 OCR 设置失败: ${errorMessage(err)}`)
      })
      .finally(() => setLoading(false))
  }, [])

  const updateNumber = (
    key: "paddleMinScore" | "preprocessScale" | "preprocessContrast",
    value: string,
    fallback: number,
  ) => {
    const numeric = Number(value)
    setOcrConfigState({
      ...ocrConfig,
      [key]: Number.isFinite(numeric) ? numeric : fallback,
    })
  }

  const saveDebugSettings = async () => {
    setSaving(true)
    try {
      await setOcrConfig(ocrConfig)
      setStatus("调试参数已保存，下一次 OCR 会使用这组设置")
    } catch (err) {
      setStatus(`保存 OCR 设置失败: ${errorMessage(err)}`)
    } finally {
      setSaving(false)
    }
  }

  const runDebug = async () => {
    setRunning(true)
    setStatus("正在捕获固定区域并运行 OCR 调试...")
    try {
      await setOcrConfig(ocrConfig)
      const nextResult = await debugRegionOcr()
      setResult(nextResult)
      const textState = nextResult.text.trim() ? "已识别到文本" : "未识别到文本"
      setStatus(`${textState}，耗时 ${nextResult.elapsedMs} ms`)
    } catch (err) {
      setStatus(`OCR 调试失败: ${errorMessage(err)}`)
    } finally {
      setRunning(false)
    }
  }

  const copyText = async (value: string, label: string) => {
    await navigator.clipboard.writeText(value)
    setStatus(`${label}已复制`)
  }

  const originalSize = result ? `${result.originalWidth} x ${result.originalHeight}` : "--"
  const preprocessedSize = result?.preprocessedWidth && result.preprocessedHeight
    ? `${result.preprocessedWidth} x ${result.preprocessedHeight}`
    : result?.preprocessedImagePath
      ? "已生成"
      : "未启用"

  return (
    <div className="space-y-5">
      <header className="tk-topbar">
        <div>
          <h1 className="tk-page-title">OCR 调试</h1>
          <p className="tk-page-subtitle">对比固定区域原图、预处理图和文本后处理结果</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="secondary" onClick={openRegionBox}>
            打开固定区域框
          </Button>
          <Button onClick={runDebug} disabled={loading || running}>
            {running ? "调试中..." : "运行区域 OCR 调试"}
          </Button>
        </div>
      </header>

      <Notice tone={status.includes("失败") ? "warning" : result ? "success" : "neutral"}>
        {status}
      </Notice>

      <section className="tk-ocr-debug-layout">
        <div className="space-y-4">
          <section className="tk-panel">
            <div className="tk-panel-header">
              <div>
                <h2 className="tk-panel-title">图像对比</h2>
                <p className="mt-1 text-xs text-muted-foreground">左侧是固定区域原图，右侧是 OCR 实际使用的预处理图</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <span className="tk-badge">原图 {originalSize}</span>
                <span className="tk-badge">预处理 {preprocessedSize}</span>
                {result && <span className="tk-badge">耗时 {result.elapsedMs} ms</span>}
              </div>
            </div>
            <div className="tk-panel-body">
              <div className="tk-ocr-debug-images">
                <DebugImagePreview
                  title="原始区域"
                  imageDataUrl={result?.originalImageDataUrl}
                  path={result?.originalImagePath}
                />
                <DebugImagePreview
                  title="预处理后"
                  imageDataUrl={result?.preprocessedImageDataUrl}
                  path={result?.preprocessedImagePath}
                />
              </div>
            </div>
          </section>

          <section className="tk-panel">
            <div className="tk-panel-header">
              <div>
                <h2 className="tk-panel-title">文本对比</h2>
                <p className="mt-1 text-xs text-muted-foreground">原始输出用于判断 OCR 质量，后处理输出会进入翻译流程</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="ghost"
                  disabled={!result?.rawText}
                  onClick={() => result && copyText(result.rawText, "原始 OCR 文本")}>
                  复制原始文本
                </Button>
                <Button
                  variant="ghost"
                  disabled={!result?.text}
                  onClick={() => result && copyText(result.text, "后处理文本")}>
                  复制后处理文本
                </Button>
              </div>
            </div>
            <div className="tk-panel-body">
              <div className="tk-ocr-debug-text-grid">
                <DebugTextBlock title="原始 OCR 输出" value={result?.rawText ?? ""} />
                <DebugTextBlock title="后处理输出" value={result?.text ?? ""} />
              </div>
            </div>
          </section>
        </div>

        <aside className="tk-panel">
          <div className="tk-panel-header">
            <div>
              <h2 className="tk-panel-title">调试参数</h2>
              <p className="mt-1 text-xs text-muted-foreground">保存后会同步影响截图 OCR、固定区域翻译和划词外的 OCR 流程</p>
            </div>
          </div>
          <div className="tk-panel-body space-y-4">
            <label className="tk-field">
              <span className="tk-label">OCR Provider</span>
              <select
                className="tk-select"
                value={ocrConfig.provider}
                onChange={(event) =>
                  setOcrConfigState({
                    ...ocrConfig,
                    provider: event.target.value as OcrProvider,
                  })
                }>
                <option value="paddleocr_json">PaddleOCR-json</option>
                <option value="windows_ocr">Windows OCR</option>
              </select>
            </label>
            <TextField
              label="PaddleOCR-json.exe"
              value={ocrConfig.paddleExePath}
              onChange={(value) => setOcrConfigState({ ...ocrConfig, paddleExePath: value })}
              placeholder="E:\\Applications\\OpenWikii\\PaddleOCR-json_v1.4.1\\PaddleOCR-json.exe"
            />
            <TextField
              label="模型目录"
              value={ocrConfig.paddleModelsPath}
              onChange={(value) => setOcrConfigState({ ...ocrConfig, paddleModelsPath: value })}
              placeholder="models"
            />
            <TextField
              label="最低置信度"
              type="number"
              value={String(ocrConfig.paddleMinScore)}
              onChange={(value) => updateNumber("paddleMinScore", value, DEFAULT_OCR_CONFIG.paddleMinScore)}
            />

            <div className="space-y-3 rounded-md border border-white/70 bg-[rgb(247_250_248)] p-3 ring-1 ring-slate-900/5">
              <h3 className="text-sm font-semibold text-slate-900">图像预处理</h3>
              <Checkbox
                label="启用图像预处理"
                checked={ocrConfig.preprocessEnabled}
                onChange={(checked) => setOcrConfigState({ ...ocrConfig, preprocessEnabled: checked })}
              />
              <label className="tk-field">
                <span className="tk-label">放大倍率</span>
                <select
                  className="tk-select"
                  value={String(ocrConfig.preprocessScale)}
                  onChange={(event) =>
                    updateNumber("preprocessScale", event.target.value, DEFAULT_OCR_CONFIG.preprocessScale)
                  }>
                  <option value="1">1x</option>
                  <option value="2">2x</option>
                  <option value="3">3x</option>
                  <option value="4">4x</option>
                </select>
              </label>
              <TextField
                label="对比度增强"
                type="number"
                value={String(ocrConfig.preprocessContrast)}
                onChange={(value) =>
                  updateNumber("preprocessContrast", value, DEFAULT_OCR_CONFIG.preprocessContrast)
                }
              />
              <Checkbox
                label="灰度化"
                checked={ocrConfig.preprocessGrayscale}
                onChange={(checked) => setOcrConfigState({ ...ocrConfig, preprocessGrayscale: checked })}
              />
              <Checkbox
                label="锐化边缘"
                checked={ocrConfig.preprocessSharpen}
                onChange={(checked) => setOcrConfigState({ ...ocrConfig, preprocessSharpen: checked })}
              />
              <Checkbox
                label="二值化"
                checked={ocrConfig.preprocessThreshold}
                onChange={(checked) => setOcrConfigState({ ...ocrConfig, preprocessThreshold: checked })}
              />
            </div>

            <div className="space-y-3 rounded-md border border-white/70 bg-[rgb(247_250_248)] p-3 ring-1 ring-slate-900/5">
              <h3 className="text-sm font-semibold text-slate-900">文本后处理</h3>
              <Checkbox
                label="启用文本后处理"
                checked={ocrConfig.textPostprocessEnabled}
                onChange={(checked) => setOcrConfigState({ ...ocrConfig, textPostprocessEnabled: checked })}
              />
              <Checkbox
                label="合并换行"
                checked={ocrConfig.textMergeLines}
                onChange={(checked) => setOcrConfigState({ ...ocrConfig, textMergeLines: checked })}
              />
            </div>
          </div>
          <div className="tk-command-bar">
            <Button onClick={saveDebugSettings} disabled={saving || loading}>
              {saving ? "保存中..." : "保存参数"}
            </Button>
            <Button variant="ghost" onClick={() => setOcrConfigState(DEFAULT_OCR_CONFIG)}>
              重置默认
            </Button>
          </div>
        </aside>
      </section>
    </div>
  )
}

function DebugImagePreview({
  title,
  imageDataUrl,
  path,
}: {
  title: string
  imageDataUrl?: string | null
  path?: string | null
}) {
  return (
    <div className="tk-ocr-debug-preview">
      <div className="flex items-center justify-between gap-2 border-b border-slate-200/65 px-3 py-2">
        <span className="text-sm font-semibold text-slate-800">{title}</span>
        {path && <span className="max-w-[56%] truncate text-[11px] text-muted-foreground">{path}</span>}
      </div>
      <div className="tk-ocr-debug-image-stage">
        {imageDataUrl ? (
          <img className="tk-ocr-debug-image" src={imageDataUrl} alt={title} />
        ) : (
          <div className="text-sm text-muted-foreground">暂无图片</div>
        )}
      </div>
    </div>
  )
}

function DebugTextBlock({ title, value }: { title: string; value: string }) {
  return (
    <div className="tk-ocr-debug-text-block">
      <div className="border-b border-slate-200/65 px-3 py-2 text-sm font-semibold text-slate-800">
        {title}
      </div>
      <pre className="tk-ocr-debug-text">{value.trim() || "暂无文本"}</pre>
    </div>
  )
}

function CaptureOverlay() {
  const [drag, setDrag] = useState<{
    startX: number
    startY: number
    currentX: number
    currentY: number
  } | null>(null)
  const [notice, setNotice] = useState("拖拽框选区域，Esc 取消")
  const finishingRef = useRef(false)

  useEffect(() => {
    const previousHtmlBg = document.documentElement.style.background
    const previousBodyBg = document.body.style.background
    document.documentElement.style.background = "transparent"
    document.body.style.background = "transparent"

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        finishingRef.current = true
        cancelScreenSelection().catch(() => undefined)
      }
    }
    window.addEventListener("keydown", handleKey)
    return () => {
      window.removeEventListener("keydown", handleKey)
      document.documentElement.style.background = previousHtmlBg
      document.body.style.background = previousBodyBg
    }
  }, [])

  const selection = useMemo(() => {
    if (!drag) return null
    const x = Math.min(drag.startX, drag.currentX)
    const y = Math.min(drag.startY, drag.currentY)
    const width = Math.abs(drag.currentX - drag.startX)
    const height = Math.abs(drag.currentY - drag.startY)
    return { x, y, width, height }
  }, [drag])

  const finish = async () => {
    if (!selection || finishingRef.current) return
    if (selection.width < 8 || selection.height < 8) {
      setNotice("选区太小，请重新框选")
      setDrag(null)
      return
    }
    finishingRef.current = true
    setNotice("正在识别...")
    try {
      await finishScreenSelection({
        ...selection,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      })
    } catch (err) {
      finishingRef.current = false
      setNotice(errorMessage(err))
    }
  }

  return (
    <div
      className="tk-capture-root"
      onMouseDown={(event) => {
        if (event.button !== 0 || finishingRef.current) return
        setDrag({
          startX: event.clientX,
          startY: event.clientY,
          currentX: event.clientX,
          currentY: event.clientY,
        })
      }}
      onMouseMove={(event) => {
        if (!drag || finishingRef.current) return
        setDrag({
          ...drag,
          currentX: event.clientX,
          currentY: event.clientY,
        })
      }}
      onMouseUp={finish}>
      <div className="tk-capture-hint">{notice}</div>
      {selection && (
        <div
          className="tk-capture-selection"
          style={{
            left: selection.x,
            top: selection.y,
            width: selection.width,
            height: selection.height,
          }}
        />
      )}
    </div>
  )
}

function OcrResultWindow() {
  const [result, setResult] = useState<OcrFlowResult | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let unlisten: (() => void) | undefined
    getLatestOcrResult()
      .then(setResult)
      .catch((err) => setNotice(errorMessage(err)))
    listen<OcrFlowResult>("ocr-result-updated", (event) => {
      setResult(event.payload)
      setNotice(event.payload.message ?? null)
    }).then((value) => {
      unlisten = value
    })
    return () => {
      unlisten?.()
    }
  }, [])

  const copy = async (value?: string | null) => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setNotice("已复制")
    } catch (err) {
      setNotice(`复制失败: ${errorMessage(err)}`)
    }
  }

  const providerLabel = result?.provider === "paddleocr_json" ? "PaddleOCR-json" : "Windows OCR"

  return (
    <div className="tk-result-shell">
      <header className="tk-result-header">
        <div>
          <h1 className="tk-page-title">OCR 结果</h1>
          <p className="tk-page-subtitle">{result ? providerLabel : "等待截图结果"}</p>
        </div>
        {result && (
          <span className={`tk-badge ${result.ok ? "tk-badge-success" : "tk-badge-warning"}`}>
            {result.phase === "translate" ? "翻译中" : result.ok ? "完成" : "需处理"}
          </span>
        )}
      </header>

      {notice && <Notice tone="neutral">{notice}</Notice>}
      {result?.error && <Notice tone="warning">{result.error}</Notice>}

      {result?.imageDataUrl && (
        <section className="tk-result-image-wrap">
          <img className="tk-result-image" src={result.imageDataUrl} alt="OCR selection" />
        </section>
      )}

      <section className="tk-panel">
        <div className="tk-panel-header">
          <h2 className="tk-panel-title">识别文本</h2>
          <button className="tk-icon-button" onClick={() => copy(result?.text)} title="复制识别文本">
            <Copy className="h-4 w-4" />
          </button>
        </div>
        <div className="tk-panel-body">
          <pre className="tk-result-text">{result?.text || "暂无识别文本"}</pre>
        </div>
      </section>

      {(result?.translatedText || result?.model || result?.phase === "translate" || (result?.error && result?.text)) && (
        <section className="tk-panel">
          <div className="tk-panel-header">
            <h2 className="tk-panel-title">译文{result.model ? ` · ${result.model}` : ""}</h2>
            <button
              className="tk-icon-button"
              onClick={() => copy(result.translatedText)}
              title="复制译文">
              <Copy className="h-4 w-4" />
            </button>
          </div>
          <div className="tk-panel-body">
            <pre
              className={`tk-result-text tk-result-translation ${
                result.error && !result.translatedText ? "tk-region-result-error" : ""
              }`}>
              {result.translatedText ||
                (result.phase === "translate"
                  ? "正在翻译..."
                  : result.error
                    ? `翻译失败: ${result.error}`
                    : "暂无译文")}
            </pre>
          </div>
        </section>
      )}
    </div>
  )
}

function RegionBoxWindow() {
  const [config, setConfig] = useState<RegionBoxConfig>(DEFAULT_REGION_BOX_CONFIG)
  const [notice, setNotice] = useState<string | null>(null)
  const configRef = useRef(config)

  useEffect(() => {
    configRef.current = config
  }, [config])

  useEffect(() => {
    const previousHtmlBg = document.documentElement.style.background
    const previousBodyBg = document.body.style.background
    const root = document.getElementById("root")
    document.documentElement.style.background = "transparent"
    document.body.style.background = "transparent"
    document.documentElement.classList.add("tk-region-window-root")
    document.body.classList.add("tk-region-window-root")
    root?.classList.add("tk-region-window-root")

    const currentWindow = getCurrentWindow()
    let timer: number | undefined
    let unlistenMoved: (() => void) | undefined
    let unlistenResized: (() => void) | undefined
    let unlistenConfig: (() => void) | undefined
    let unlistenResult: (() => void) | undefined

    const syncGeometry = () => {
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(async () => {
        try {
          const [position, size] = await Promise.all([
            currentWindow.outerPosition(),
            currentWindow.outerSize(),
          ])
          const next = await setRegionBoxConfig({
            ...configRef.current,
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
          })
          configRef.current = next
          setConfig(next)
        } catch {
          // Window move/resize events can fire while the window is being closed.
        }
      }, 140)
    }

    getRegionBoxConfig().then((value) => {
      configRef.current = value
      setConfig(value)
    })
    currentWindow.onMoved(syncGeometry).then((value) => {
      unlistenMoved = value
    })
    currentWindow.onResized(syncGeometry).then((value) => {
      unlistenResized = value
    })
    listen<RegionBoxConfig>("region-config-updated", (event) => {
      configRef.current = event.payload
      setConfig(event.payload)
    }).then((value) => {
      unlistenConfig = value
    })
    listen<OcrFlowResult>("region-result-updated", (event) => {
      const payload = event.payload
      setNotice(
        payload.message ??
          (payload.translatedText
            ? "翻译完成"
            : payload.error
              ? payload.error
              : payload.phase === "translate"
                ? "正在翻译..."
                : null),
      )
    }).then((value) => {
      unlistenResult = value
    })

    return () => {
      if (timer) window.clearTimeout(timer)
      unlistenMoved?.()
      unlistenResized?.()
      unlistenConfig?.()
      unlistenResult?.()
      document.documentElement.style.background = previousHtmlBg
      document.body.style.background = previousBodyBg
      document.documentElement.classList.remove("tk-region-window-root")
      document.body.classList.remove("tk-region-window-root")
      root?.classList.remove("tk-region-window-root")
    }
  }, [])

  const startDrag = async () => {
    if (config.passThrough) return
    try {
      await getCurrentWindow().startDragging()
    } catch {
      // Native dragging can be rejected if the pointer is already released.
    }
  }

  const closeRegion = async () => {
    try {
      await closeRegionBox()
    } catch {
      try {
        await getCurrentWindow().close()
      } catch {
        // The command path is authoritative; this is only a UI fallback.
      }
    }
  }

  const startResize = async (direction: ResizeDirection) => {
    if (config.passThrough) return
    try {
      await getCurrentWindow().startResizeDragging(direction)
    } catch {
      // Same as dragging: a missed native resize is harmless.
    }
  }

  const handles: { direction: ResizeDirection; className: string }[] = [
    { direction: "North", className: "tk-region-handle-n" },
    { direction: "South", className: "tk-region-handle-s" },
    { direction: "West", className: "tk-region-handle-w" },
    { direction: "East", className: "tk-region-handle-e" },
    { direction: "NorthWest", className: "tk-region-handle-nw" },
    { direction: "NorthEast", className: "tk-region-handle-ne" },
    { direction: "SouthWest", className: "tk-region-handle-sw" },
    { direction: "SouthEast", className: "tk-region-handle-se" },
  ]

  const frameStyle = config.passThrough
    ? {
        borderColor: "rgba(52, 211, 153, 0.9)",
        background: "rgba(16, 185, 129, 0.035)",
        boxShadow:
          "0 0 0 1px rgba(255, 255, 255, 0.55) inset, 0 0 22px rgba(16, 185, 129, 0.36)",
      }
    : {
        borderColor: "rgba(16, 185, 129, 0.98)",
        background: "rgba(16, 185, 129, 0.12)",
        boxShadow:
          "0 0 0 1px rgba(255, 255, 255, 0.9) inset, 0 0 0 9999px rgba(15, 23, 42, 0.05), 0 12px 32px rgba(15, 23, 42, 0.28)",
      }

  return (
    <div
      className={`tk-region-box ${config.passThrough ? "tk-region-box-passthrough" : ""}`}
      style={frameStyle}>
      {!config.passThrough && (
        <div className="tk-region-frame-toolbar" onMouseDown={startDrag}>
          <div className="tk-region-frame-title" onMouseDown={startDrag}>
            <Move className="h-3.5 w-3.5" />
            <span>TabKeep 区域框</span>
          </div>
          <span className="tk-region-frame-hint">{notice ?? "拖动这里移动，拖四周调整大小"}</span>
          <button
            className="tk-region-frame-close"
            onMouseDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            onClick={closeRegion}
            title="关闭区域框">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <div className="tk-region-drag-surface" onMouseDown={startDrag}>
        {!config.passThrough && (
          <div className="tk-region-box-label">
            OCR 区域
          </div>
        )}
      </div>
      {!config.passThrough &&
        handles.map((handle) => (
          <button
            key={handle.direction}
            className={`tk-region-handle ${handle.className}`}
            onMouseDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
              startResize(handle.direction)
            }}
            title="调整区域"
          />
        ))}
    </div>
  )
}

function RegionPanelWindow() {
  const [result, setResult] = useState<OcrFlowResult | null>(null)
  const [config, setConfig] = useState<RegionBoxConfig>(DEFAULT_REGION_BOX_CONFIG)
  const [busy, setBusy] = useState<"translate" | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const configRef = useRef(config)
  const languageOptions = ["auto", "简体中文", "English", "日本語", "한국어", "Français", "Deutsch"]

  useEffect(() => {
    configRef.current = config
  }, [config])

  useEffect(() => {
    const previousHtmlBg = document.documentElement.style.background
    const previousBodyBg = document.body.style.background
    const root = document.getElementById("root")
    document.documentElement.style.background = "transparent"
    document.body.style.background = "transparent"
    document.documentElement.classList.add("tk-region-panel-window-root")
    document.body.classList.add("tk-region-panel-window-root")
    root?.classList.add("tk-region-panel-window-root")

    return () => {
      document.documentElement.style.background = previousHtmlBg
      document.body.style.background = previousBodyBg
      document.documentElement.classList.remove("tk-region-panel-window-root")
      document.body.classList.remove("tk-region-panel-window-root")
      root?.classList.remove("tk-region-panel-window-root")
    }
  }, [])

  useEffect(() => {
    let unlistenResult: (() => void) | undefined
    let unlistenConfig: (() => void) | undefined
    let unlistenMoved: (() => void) | undefined
    let unlistenResized: (() => void) | undefined
    let geometryTimer: number | undefined
    const currentWindow = getCurrentWindow()

    const syncPanelGeometry = () => {
      if (geometryTimer) window.clearTimeout(geometryTimer)
      geometryTimer = window.setTimeout(async () => {
        try {
          const [position, size] = await Promise.all([
            currentWindow.outerPosition(),
            currentWindow.innerSize(),
          ])
          const current = configRef.current
          if (
            current.panelX === position.x &&
            current.panelY === position.y &&
            current.panelWidth === size.width &&
            current.panelHeight === size.height
          ) {
            return
          }
          const next = await setRegionBoxConfig({
            ...current,
            panelX: position.x,
            panelY: position.y,
            panelWidth: size.width,
            panelHeight: size.height,
          })
          configRef.current = next
          setConfig(next)
        } catch {
          // Resize/move events may fire while the panel is closing.
        }
      }, 140)
    }

    getRegionBoxConfig().then((value) => {
      configRef.current = value
      setConfig(value)
    })
    currentWindow.onMoved(syncPanelGeometry).then((value) => {
      unlistenMoved = value
    })
    currentWindow.onResized(syncPanelGeometry).then((value) => {
      unlistenResized = value
    })
    listen<RegionBoxConfig>("region-config-updated", (event) => {
      configRef.current = event.payload
      setConfig(event.payload)
    }).then((value) => {
      unlistenConfig = value
    })
    listen<OcrFlowResult>("region-result-updated", (event) => {
      setResult(event.payload)
      setNotice(event.payload.message ?? (event.payload.ok ? "完成" : event.payload.error ?? "未完成"))
      if (event.payload.phase !== "translate") {
        setBusy(null)
      }
    }).then((value) => {
      unlistenResult = value
    })
    return () => {
      if (geometryTimer) window.clearTimeout(geometryTimer)
      unlistenMoved?.()
      unlistenResized?.()
      unlistenConfig?.()
      unlistenResult?.()
    }
  }, [])

  const copy = async (value?: string | null) => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setNotice("已复制")
    } catch (err) {
      setNotice(`复制失败: ${errorMessage(err)}`)
    }
  }

  const close = async () => {
    try {
      await closeRegionBox()
    } catch (err) {
      setNotice(errorMessage(err))
    }
  }

  const updateConfig = async (partial: Partial<RegionBoxConfig>) => {
    try {
      const next = await setRegionBoxConfig({ ...configRef.current, ...partial })
      configRef.current = next
      setConfig(next)
    } catch (err) {
      setNotice(errorMessage(err))
    }
  }

  const togglePassthrough = async () => {
    try {
      const next = await setRegionBoxPassthrough(!configRef.current.passThrough)
      configRef.current = next
      setConfig(next)
      setNotice(next.passThrough ? "内容区域已穿透，按钮仍可使用" : "已回到编辑模式")
    } catch (err) {
      setNotice(errorMessage(err))
    }
  }

  const runTranslate = async () => {
    setBusy("translate")
    setNotice("正在识别并翻译区域...")
    try {
      const value = await runRegionTranslate()
      setResult(value)
      setNotice(value.message ?? (value.ok ? "翻译完成" : value.error ?? "翻译未完成"))
    } catch (err) {
      setNotice(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const startPanelDrag = async (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest("button, input, select, textarea, a")) return
    try {
      await getCurrentWindow().startDragging()
    } catch (err) {
      setNotice(errorMessage(err))
    }
  }

  const startPanelResize = async (direction: ResizeDirection) => {
    try {
      await getCurrentWindow().startResizeDragging(direction)
    } catch (err) {
      setNotice(errorMessage(err))
    }
  }

  const panelResizeHandles: { direction: ResizeDirection; className: string }[] = [
    { direction: "North", className: "tk-region-panel-resize-n" },
    { direction: "South", className: "tk-region-panel-resize-s" },
    { direction: "West", className: "tk-region-panel-resize-w" },
    { direction: "East", className: "tk-region-panel-resize-e" },
    { direction: "NorthWest", className: "tk-region-panel-resize-nw" },
    { direction: "NorthEast", className: "tk-region-panel-resize-ne" },
    { direction: "SouthWest", className: "tk-region-panel-resize-sw" },
    { direction: "SouthEast", className: "tk-region-panel-resize-se" },
  ]

  const translationText =
    result?.translatedText ||
    (result?.error ? `翻译失败: ${result.error}` : "等待译文")
  const formattedTranslationText = result?.translatedText
    ? formatTranslationForPanel(result.translatedText)
    : translationText

  return (
    <div className="tk-region-panel tk-region-translation-panel tk-region-panel-resizable">
      <div
        className="tk-region-panel-toolbar tk-region-panel-dragbar"
        onMouseDown={startPanelDrag}
        title="按住拖动译文窗口">
        <div className="tk-region-result-title-inline">
          <Languages className="h-4 w-4 text-blue-600" />
          <span>固定区域翻译{result?.model ? ` · ${result.model}` : ""}</span>
        </div>
        <button
          className="tk-icon-button"
          onClick={() => copy(result?.translatedText)}
          title="复制译文"
          disabled={!result?.translatedText}>
          <Copy className="h-4 w-4" />
        </button>
        <button className="tk-icon-button" onClick={close} title="关闭固定翻译框">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="tk-region-panel-controls">
        <select
          className="tk-select tk-region-select"
          value={config.sourceLang}
          onChange={(event) => updateConfig({ sourceLang: event.target.value })}
          title="源语言">
          <option value="auto">自动</option>
          {languageOptions
            .filter((lang) => lang !== "auto")
            .map((lang) => (
              <option key={lang} value={lang}>
                {lang}
              </option>
            ))}
        </select>
        <select
          className="tk-select tk-region-select"
          value={config.targetLang}
          onChange={(event) => updateConfig({ targetLang: event.target.value })}
          title="目标语言">
          {languageOptions
            .filter((lang) => lang !== "auto")
            .map((lang) => (
              <option key={lang} value={lang}>
                {lang}
              </option>
            ))}
        </select>
        <Button className="h-8" onClick={runTranslate} disabled={busy !== null}>
          <Languages className={`h-4 w-4 ${busy === "translate" ? "animate-pulse" : ""}`} />
          {busy === "translate" ? "翻译中" : "翻译"}
        </Button>
        <Button className="h-8" variant="ghost" onClick={togglePassthrough}>
          <MousePointer2 className="h-4 w-4" />
          {config.passThrough ? "编辑" : "穿透"}
        </Button>
      </div>

      {notice && <div className="tk-region-notice">{notice}</div>}

      <pre
        className={`tk-region-result-text tk-region-result-translation ${
          result && !result.ok && result.error ? "tk-region-result-error" : ""
        }`}>
        {formattedTranslationText}
      </pre>
      {panelResizeHandles.map((handle) => (
        <button
          key={handle.direction}
          className={`tk-region-panel-resize-handle ${handle.className}`}
          onMouseDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
            startPanelResize(handle.direction)
          }}
          title="调整译文框大小"
        />
      ))}
    </div>
  )
}

function SelectionPanelWindow() {
  const [result, setResult] = useState<SelectionTranslateResult | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    const previousHtmlBg = document.documentElement.style.background
    const previousBodyBg = document.body.style.background
    const root = document.getElementById("root")
    document.documentElement.style.background = "transparent"
    document.body.style.background = "transparent"
    document.documentElement.classList.add("tk-region-panel-window-root")
    document.body.classList.add("tk-region-panel-window-root")
    root?.classList.add("tk-region-panel-window-root")

    return () => {
      document.documentElement.style.background = previousHtmlBg
      document.body.style.background = previousBodyBg
      document.documentElement.classList.remove("tk-region-panel-window-root")
      document.body.classList.remove("tk-region-panel-window-root")
      root?.classList.remove("tk-region-panel-window-root")
    }
  }, [])

  useEffect(() => {
    let unlistenResult: (() => void) | undefined
    getLatestSelectionTranslateResult()
      .then((value) => {
        if (value) {
          setResult(value)
          setNotice(value.message ?? null)
        }
      })
      .catch((err) => setNotice(errorMessage(err)))
    listen<SelectionTranslateResult>("selection-result-updated", (event) => {
      setResult(event.payload)
      setNotice(
        event.payload.message ??
          (event.payload.ok ? "完成" : event.payload.error ?? "未完成"),
      )
    }).then((value) => {
      unlistenResult = value
    })
    return () => {
      unlistenResult?.()
    }
  }, [])

  const copy = async (value?: string | null) => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setNotice("已复制")
    } catch (err) {
      setNotice(`复制失败: ${errorMessage(err)}`)
    }
  }

  const close = async () => {
    try {
      await getCurrentWindow().hide()
    } catch (err) {
      setNotice(errorMessage(err))
    }
  }

  const startPanelDrag = async (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest("button, input, select, textarea, a")) return
    try {
      await getCurrentWindow().startDragging()
    } catch (err) {
      setNotice(errorMessage(err))
    }
  }

  const translationText = result?.translatedText
    ? formatTranslationForPanel(result.translatedText)
    : result?.phase === "copy"
      ? "正在读取选中文本..."
      : result?.phase === "translate"
        ? "正在翻译..."
        : result?.error
          ? `翻译失败: ${result.error}`
          : "等待划词翻译"

  return (
    <div className="tk-region-panel tk-region-translation-panel">
      <div
        className="tk-region-panel-toolbar tk-region-panel-dragbar"
        onMouseDown={startPanelDrag}
        title="按住拖动划词译文窗口">
        <div className="tk-region-result-title-inline">
          <Keyboard className="h-4 w-4 text-blue-600" />
          <span>划词译文{result?.model ? ` · ${result.model}` : ""}</span>
        </div>
        <button
          className="tk-icon-button"
          onClick={() => copy(result?.translatedText)}
          title="复制译文"
          disabled={!result?.translatedText}>
          <Copy className="h-4 w-4" />
        </button>
        <button className="tk-icon-button" onClick={close} title="关闭译文">
          <X className="h-4 w-4" />
        </button>
      </div>

      {notice && <div className="tk-region-notice">{notice}</div>}

      <pre
        className={`tk-region-result-text tk-region-result-translation ${
          result && !result.ok && result.error ? "tk-region-result-error" : ""
        }`}>
        {translationText}
      </pre>
    </div>
  )
}

function ModelApiSection({
  config,
  setConfig,
}: {
  config: ModelConfig
  setConfig: (config: ModelConfig) => void
}) {
  const [draft, setDraft] = useState(config)
  const [status, setStatus] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setDraft(config)
  }, [config])

  const save = async () => {
    setSaving(true)
    setStatus(null)
    try {
      await syncConfigToBackend({ modelConfig: draft })
      setConfig(draft)
      setStatus("已保存")
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-5">
      <header className="tk-topbar">
        <div>
          <h1 className="tk-page-title">模型 API</h1>
          <p className="tk-page-subtitle">OpenAI-compatible 模型配置</p>
        </div>
      </header>

      <section className="tk-panel max-w-3xl">
        <div className="tk-panel-body space-y-4">
          <label className="tk-field">
            <span className="tk-label">模型名</span>
            <input
              className="tk-input"
              value={draft.model}
              onChange={(event) => setDraft({ ...draft, model: event.target.value })}
              placeholder="gpt-4o-mini / MiniMax-M3"
            />
          </label>
          <label className="tk-field">
            <span className="tk-label">BaseURL</span>
            <input
              className="tk-input"
              value={draft.baseURL}
              onChange={(event) => setDraft({ ...draft, baseURL: event.target.value })}
              placeholder="https://api.openai.com/v1"
            />
          </label>
          <label className="tk-field">
            <span className="tk-label">API Key</span>
            <input
              className="tk-input"
              type="password"
              value={draft.apiKey}
              onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
              placeholder="sk-..."
            />
          </label>
        </div>
        <div className="tk-command-bar">
          <Button onClick={save} disabled={saving}>
            {saving ? "保存中..." : "保存设置"}
          </Button>
          <Button variant="ghost" onClick={() => setDraft(DEFAULT_MODEL_CONFIG)}>
            <RotateCcw className="h-4 w-4" />
            重置
          </Button>
          {status && <span className="text-sm text-muted-foreground">{status}</span>}
        </div>
      </section>
    </div>
  )
}

function CategoriesSection({
  tabs,
  categories,
  setCategories,
}: {
  tabs: TabData[]
  categories: TabCategory[]
  setCategories: (categories: TabCategory[]) => void
}) {
  const [savedCategories, setSavedCategories] = useState<TabCategory[]>(categories)
  const [draftCategories, setDraftCategories] = useState<TabCategory[]>(categories)
  const [newName, setNewName] = useState("")
  const [newDescription, setNewDescription] = useState("")
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState("")
  const [editDescription, setEditDescription] = useState("")
  const [status, setStatus] = useState<string | null>(null)
  const [classifying, setClassifying] = useState(false)

  useEffect(() => {
    setSavedCategories(categories)
    setDraftCategories(categories)
  }, [categories])

  const addCategory = () => {
    const name = newName.trim()
    if (!name) return
    setDraftCategories([
      ...draftCategories,
      {
        id: Date.now().toString(),
        name,
        description: newDescription.trim() || undefined,
      },
    ])
    setNewName("")
    setNewDescription("")
  }

  const save = async () => {
    setStatus(null)
    try {
      await syncConfigToBackend({ tabCategories: draftCategories })
      setSavedCategories(draftCategories)
      setCategories(draftCategories)
      setStatus("已保存")
    } catch (err) {
      setStatus(errorMessage(err))
    }
  }

  const runClassify = async () => {
    setClassifying(true)
    setStatus(null)
    try {
      const result = await backendRequest<ClassifyResponse>("POST", "/classify", { tabs })
      if (result.error) {
        setStatus(result.error)
        return
      }
      const count = Object.keys(result.result ?? {}).length
      setStatus(`分类完成：${count} 个标签`)
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setClassifying(false)
    }
  }

  const startEdit = (category: TabCategory) => {
    setEditingId(category.id)
    setEditName(category.name)
    setEditDescription(category.description ?? "")
  }

  const commitEdit = () => {
    const name = editName.trim()
    if (!editingId || !name) return
    setDraftCategories(
      draftCategories.map((category) =>
        category.id === editingId
          ? {
              ...category,
              name,
              description: editDescription.trim() || undefined,
            }
          : category,
      ),
    )
    setEditingId(null)
  }

  return (
    <div className="space-y-5">
      <header className="tk-topbar">
        <div>
          <h1 className="tk-page-title">分组</h1>
          <p className="tk-page-subtitle">自定义分类组，并用 LLM 测试当前标签归类</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={runClassify} disabled={classifying || tabs.length === 0}>
            <Sparkles className="h-4 w-4" />
            {classifying ? "分类中..." : "AI 分组测试"}
          </Button>
          <Button onClick={save}>保存设置</Button>
          <Button
            variant="ghost"
            onClick={() => {
              setDraftCategories(savedCategories)
              setNewName("")
              setNewDescription("")
              setEditingId(null)
            }}>
            <RotateCcw className="h-4 w-4" />
            重置
          </Button>
        </div>
      </header>

      {status && <Notice>{status}</Notice>}

      <section className="tk-panel max-w-4xl">
        <div className="tk-panel-body space-y-4">
          <div className="tk-form-grid">
            <label className="tk-field">
              <span className="tk-label">名称</span>
              <input
                className="tk-input"
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && addCategory()}
                placeholder="学习"
              />
            </label>
            <label className="tk-field">
              <span className="tk-label">描述</span>
              <input
                className="tk-input"
                value={newDescription}
                onChange={(event) => setNewDescription(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && addCategory()}
                placeholder="技术文档、教程"
              />
            </label>
          </div>
          <Button variant="secondary" onClick={addCategory} disabled={!newName.trim()}>
            <Plus className="h-4 w-4" />
            添加
          </Button>
        </div>
        <div className="border-t border-border p-4">
          {draftCategories.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无分组</p>
          ) : (
            <div className="grid gap-2 md:grid-cols-2">
              {draftCategories.map((category) =>
                editingId === category.id ? (
                  <div key={category.id} className="space-y-2 rounded-md border border-border p-3 md:col-span-2">
                    <input
                      className="tk-input"
                      value={editName}
                      onChange={(event) => setEditName(event.target.value)}
                      autoFocus
                    />
                    <input
                      className="tk-input"
                      value={editDescription}
                      onChange={(event) => setEditDescription(event.target.value)}
                      placeholder="描述"
                    />
                    <div className="flex gap-2">
                      <Button onClick={commitEdit} disabled={!editName.trim()}>
                        保存
                      </Button>
                      <Button variant="ghost" onClick={() => setEditingId(null)}>
                        取消
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div key={category.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-slate-900">{category.name}</p>
                      {category.description && (
                        <p className="truncate text-xs text-muted-foreground">{category.description}</p>
                      )}
                    </div>
                    <button className="tk-icon-button" onClick={() => startEdit(category)} title="编辑">
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      className="tk-icon-button"
                      onClick={() => {
                        setDraftCategories(draftCategories.filter((item) => item.id !== category.id))
                        if (editingId === category.id) setEditingId(null)
                      }}
                      title="删除">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ),
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function KnowledgeSection() {
  const [config, setConfigState] = useState<KnowledgeConfig>(DEFAULT_KNOWLEDGE_CONFIG)
  const [pathText, setPathText] = useState("")
  const [stats, setStats] = useState<KnowledgeStats | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [reindexing, setReindexing] = useState(false)
  const [syncingSiyuan, setSyncingSiyuan] = useState(false)
  const [checkingSiyuan, setCheckingSiyuan] = useState(false)
  const [siyuanPrecheck, setSiyuanPrecheck] = useState<KnowledgeSiyuanPrecheckResponse | null>(null)
  const [siyuanNotebookId, setSiyuanNotebookId] = useState("")
  const [siyuanLimit, setSiyuanLimit] = useState("")
  const [searchQuery, setSearchQuery] = useState("")
  const [searchResult, setSearchResult] = useState<KnowledgeSearchResponse | null>(null)
  const [searching, setSearching] = useState(false)
  const [question, setQuestion] = useState("")
  const [askResult, setAskResult] = useState<KnowledgeAskResponse | null>(null)
  const [asking, setAsking] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)

  const refresh = async () => {
    setLoading(true)
    setStatus(null)
    try {
      const [nextConfig, nextStats] = await Promise.all([getKnowledgeConfig(), getKnowledgeStats()])
      setConfigState(nextConfig)
      setPathText(nextConfig.markdownPaths.join("\n"))
      setStats(nextStats)
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  const buildDraft = (): KnowledgeConfig => ({
    ...config,
    markdownPaths: pathText
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean),
    maxFileBytes: Number.isFinite(config.maxFileBytes) && config.maxFileBytes > 0
      ? config.maxFileBytes
      : DEFAULT_KNOWLEDGE_CONFIG.maxFileBytes,
  })

  const save = async () => {
    setSaving(true)
    setStatus(null)
    try {
      const saved = await setKnowledgeConfig(buildDraft())
      setConfigState(saved)
      setPathText(saved.markdownPaths.join("\n"))
      setStatus("知识库设置已保存")
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const runReindex = async () => {
    setReindexing(true)
    setStatus(null)
    try {
      await setKnowledgeConfig(buildDraft())
      const result = await reindexKnowledge()
      setStats(result.stats)
      setStatus(
        result.ok
          ? `重建完成：${result.documentsIndexed} 篇文档，${result.chunksIndexed} 个片段`
          : `重建完成但有错误：${result.errors.slice(0, 2).join("；")}`,
      )
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setReindexing(false)
    }
  }

  const runSiyuanSync = async () => {
    setSyncingSiyuan(true)
    setStatus(null)
    try {
      await setKnowledgeConfig(buildDraft())
      const precheck = await precheckSiyuanKnowledge()
      setSiyuanPrecheck(precheck)
      if (!precheck.ok) {
        setStatus(precheck.error ?? "SiYuan 同步预检查失败")
        return
      }
      const limit = siyuanLimit.trim() ? Number(siyuanLimit) : null
      const result = await syncSiyuanKnowledge(siyuanNotebookId || null, limit)
      setStats(result.stats)
      setStatus(formatSiyuanSyncStatus(result))
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setSyncingSiyuan(false)
    }
  }

  const runSiyuanPrecheck = async () => {
    setCheckingSiyuan(true)
    setStatus(null)
    try {
      const result = await precheckSiyuanKnowledge()
      setSiyuanPrecheck(result)
      setStatus(
        result.ok
          ? `SiYuan 可用：${result.notebooks.length} 个笔记本`
          : result.error ?? "SiYuan 预检查失败",
      )
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setCheckingSiyuan(false)
    }
  }

  const runSearch = async () => {
    const query = searchQuery.trim()
    if (!query) return
    setSearching(true)
    setStatus(null)
    try {
      const result = await searchKnowledge(query, 8)
      setSearchResult(result)
      if (!result.ok) setStatus(result.error ?? "搜索失败")
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setSearching(false)
    }
  }

  const runAsk = async () => {
    const value = question.trim()
    if (!value) return
    setAsking(true)
    setStatus(null)
    try {
      const result = await askKnowledge(value, sessionId, 8)
      setAskResult(result)
      if (result.sessionId) setSessionId(result.sessionId)
      if (!result.ok) setStatus(result.error ?? "知识库问答失败")
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setAsking(false)
    }
  }

  const copyAnswer = async () => {
    if (!askResult?.answer) return
    try {
      await navigator.clipboard.writeText(askResult.answer)
      setStatus("回答已复制")
    } catch (err) {
      setStatus(`复制失败: ${errorMessage(err)}`)
    }
  }

  const statusTone =
    status?.includes("已保存") ||
    status?.includes("完成") ||
    status?.includes("已复制") ||
    status?.includes("可用")
      ? "success"
      : "warning"

  return (
    <div className="space-y-5">
      <header className="tk-topbar">
        <div>
          <h1 className="tk-page-title">知识库</h1>
          <p className="tk-page-subtitle">索引 TabKeep 收藏和 Markdown / Obsidian 笔记，进行搜索与 RAG 问答</p>
        </div>
        <Button variant="secondary" onClick={refresh} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          刷新
        </Button>
      </header>

      {status && <Notice tone={statusTone}>{status}</Notice>}

      <section className="tk-status-grid">
        <StatusCard title="文档" value={`${stats?.documents ?? 0} 篇`} tone="neutral" />
        <StatusCard title="片段" value={`${stats?.chunks ?? 0} 个`} tone="neutral" />
        <StatusCard
          title="向量层"
          value={stats?.vectorAvailable ? "可用" : "未启用"}
          tone={stats?.vectorAvailable ? "success" : "warning"}
        />
        <StatusCard
          title="最近索引"
          value={stats?.lastIndexedAt ? formatCompactDate(stats.lastIndexedAt) : "暂无"}
          tone={stats?.lastIndexedAt ? "success" : "warning"}
        />
      </section>

      <section className="tk-grid-two">
        <section className="tk-panel">
          <div className="tk-panel-header">
            <div>
              <h2 className="tk-panel-title">索引设置</h2>
              <p className="text-xs text-muted-foreground">每行一个 Markdown / Obsidian 路径</p>
            </div>
            <span className="tk-badge">{config.enabled ? "启用" : "关闭"}</span>
          </div>
          <div className="tk-panel-body space-y-4">
            <Checkbox
              label="启用本地知识库"
              checked={config.enabled}
              onChange={(checked) => setConfigState({ ...config, enabled: checked })}
            />
            <label className="tk-field">
              <span className="tk-label">Markdown / Obsidian 路径</span>
              <textarea
                className="tk-textarea min-h-36"
                value={pathText}
                onChange={(event) => setPathText(event.target.value)}
                placeholder={"E:\\Notes\\ObsidianVault\nE:\\Projects\\TabKeep\\docs"}
              />
            </label>
            <TextField
              label="单文件最大字节数"
              type="number"
              value={String(config.maxFileBytes)}
              onChange={(value) =>
                setConfigState({ ...config, maxFileBytes: Number(value) || 1_000_000 })
              }
              placeholder="1000000"
            />
            {stats?.vectorMessage && <div className="tk-muted-box">{stats.vectorMessage}</div>}
            <div className="rounded-md border border-border p-3">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">SiYuan 同步</h3>
                  <p className="text-xs text-muted-foreground">使用「笔记集成」里的 SiYuan 配置导出 Markdown 入库</p>
                </div>
                <span className="tk-badge">
                  {siyuanPrecheck?.ok ? `${siyuanPrecheck.notebooks.length} 个笔记本` : "未检查"}
                </span>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="tk-field">
                  <span className="tk-label">同步范围</span>
                  <select
                    className="tk-select"
                    value={siyuanNotebookId}
                    onChange={(event) => setSiyuanNotebookId(event.target.value)}>
                    <option value="">全部笔记本</option>
                    {(siyuanPrecheck?.notebooks ?? []).map((notebook) => (
                      <option key={notebook.id} value={notebook.id}>
                        {notebook.name}
                      </option>
                    ))}
                  </select>
                </label>
                <TextField
                  label="测试同步上限"
                  type="number"
                  value={siyuanLimit}
                  onChange={setSiyuanLimit}
                  placeholder="留空 = 全量"
                />
              </div>
              {siyuanPrecheck?.error && (
                <div className="mt-3 rounded-md border border-amber-100 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  {siyuanPrecheck.error}
                </div>
              )}
            </div>
          </div>
          <div className="tk-command-bar">
            <Button onClick={save} disabled={saving}>
              {saving ? "保存中..." : "保存设置"}
            </Button>
            <Button variant="secondary" onClick={runReindex} disabled={reindexing}>
              <RefreshCw className={`h-4 w-4 ${reindexing ? "animate-spin" : ""}`} />
              {reindexing ? "重建中..." : "重建索引"}
            </Button>
            <Button variant="secondary" onClick={runSiyuanPrecheck} disabled={checkingSiyuan}>
              <CheckCircle2 className="h-4 w-4" />
              {checkingSiyuan ? "检查中..." : "检查 SiYuan"}
            </Button>
            <Button variant="secondary" onClick={runSiyuanSync} disabled={syncingSiyuan}>
              <BookOpen className="h-4 w-4" />
              {syncingSiyuan ? "同步中..." : "同步 SiYuan"}
            </Button>
          </div>
        </section>

        <section className="tk-panel">
          <div className="tk-panel-header">
            <div>
              <h2 className="tk-panel-title">Embedding</h2>
              <p className="text-xs text-muted-foreground">可选；关闭时使用全文检索</p>
            </div>
            <span className="tk-badge">{config.embedding.enabled ? "语义检索" : "FTS"}</span>
          </div>
          <div className="tk-panel-body space-y-4">
            <Checkbox
              label="启用 OpenAI-compatible embedding"
              checked={config.embedding.enabled}
              onChange={(checked) =>
                setConfigState({
                  ...config,
                  embedding: { ...config.embedding, enabled: checked },
                })
              }
            />
            <TextField
              label="Embedding BaseURL"
              value={config.embedding.baseURL}
              onChange={(value) =>
                setConfigState({
                  ...config,
                  embedding: { ...config.embedding, baseURL: value },
                })
              }
              placeholder="https://api.openai.com/v1"
            />
            <TextField
              label="Embedding Model"
              value={config.embedding.model}
              onChange={(value) =>
                setConfigState({
                  ...config,
                  embedding: { ...config.embedding, model: value },
                })
              }
              placeholder="text-embedding-3-small"
            />
            <TextField
              label="Embedding API Key"
              type="password"
              value={config.embedding.apiKey}
              onChange={(value) =>
                setConfigState({
                  ...config,
                  embedding: { ...config.embedding, apiKey: value },
                })
              }
              placeholder="sk-..."
            />
          </div>
        </section>
      </section>

      <section className="tk-grid-two">
        <section className="tk-panel">
          <div className="tk-panel-header">
            <h2 className="tk-panel-title">搜索</h2>
            <span className="tk-badge">{searchResult?.sourceMode ?? "未搜索"}</span>
          </div>
          <div className="tk-panel-body space-y-4">
            <div className="flex gap-2">
              <input
                className="tk-input"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") runSearch()
                }}
                placeholder="搜索项目方案、错误信息、笔记主题"
              />
              <Button onClick={runSearch} disabled={searching || !searchQuery.trim()}>
                <Search className="h-4 w-4" />
                {searching ? "搜索中..." : "搜索"}
              </Button>
            </div>
            <CitationList
              items={searchResult?.items ?? []}
              emptyText="暂无搜索结果"
              onStatus={setStatus}
            />
          </div>
        </section>

        <section className="tk-panel">
          <div className="tk-panel-header">
            <h2 className="tk-panel-title">知识库问答</h2>
            <span className="tk-badge">{askResult?.sourceMode ?? "RAG"}</span>
          </div>
          <div className="tk-panel-body space-y-4">
            <textarea
              className="tk-textarea"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="例如：TabKeep 桌面端翻译功能目前做到哪一步了？"
            />
            <div className="flex flex-wrap gap-2">
              <Button onClick={runAsk} disabled={asking || !question.trim()}>
                <Sparkles className="h-4 w-4" />
                {asking ? "思考中..." : "提问"}
              </Button>
              <Button variant="secondary" onClick={copyAnswer} disabled={!askResult?.answer}>
                <Copy className="h-4 w-4" />
                复制回答
              </Button>
            </div>
            {askResult?.answer ? (
              <div className="rounded-md border border-border bg-white p-3 text-sm leading-7 text-slate-800 whitespace-pre-wrap">
                {askResult.answer}
              </div>
            ) : (
              <div className="tk-muted-box">回答会基于下方引用片段生成，不会默认读取整个笔记库。</div>
            )}
            <CitationList
              items={askResult?.citations ?? []}
              emptyText="暂无引用来源"
              compact
              onStatus={setStatus}
            />
          </div>
        </section>
      </section>
    </div>
  )
}

function KnowledgeGraphSection({ noteAdapter }: { noteAdapter: NoteAdapterConfig }) {
  const [status, setStatus] = useState<string | null>(null)
  const statusTone =
    status?.includes("已重建") || status?.includes("已打开") || status?.includes("已复制")
      ? "success"
      : "warning"

  return (
    <div className="space-y-5">
      <header className="tk-topbar">
        <div>
          <h1 className="tk-page-title">知识工作台</h1>
          <p className="tk-page-subtitle">围绕主题查笔记、看证据、回到原文，并继续整理知识</p>
        </div>
      </header>
      {status && <Notice tone={statusTone}>{status}</Notice>}
      <TopicMapPanel onStatus={setStatus} noteAdapter={noteAdapter} />
    </div>
  )
}

function TopicMapPanel({
  onStatus,
  noteAdapter,
}: {
  onStatus: (message: string) => void
  noteAdapter: NoteAdapterConfig
}) {
  const [topicQuery, setTopicQuery] = useState("")
  const [topicSourceType, setTopicSourceType] = useState("")
  const [topicResult, setTopicResult] = useState<KnowledgeTopicListResponse | null>(null)
  const [topicDetail, setTopicDetail] = useState<KnowledgeTopicDetailResponse | null>(null)
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null)
  const [selectedTopicDocument, setSelectedTopicDocument] = useState<KnowledgeTopicDocument | null>(null)
  const [topicAnswer, setTopicAnswer] = useState<KnowledgeAskResponse | null>(null)
  const [topicLoading, setTopicLoading] = useState(false)
  const [topicDetailLoading, setTopicDetailLoading] = useState(false)
  const [topicRebuilding, setTopicRebuilding] = useState(false)
  const [topicEnriching, setTopicEnriching] = useState(false)
  const [topicExporting, setTopicExporting] = useState(false)
  const [topicAsking, setTopicAsking] = useState(false)

  const selectedTopic = topicDetail?.topic ?? topicResult?.topics.find((topic) => topic.id === selectedTopicId) ?? null
  const selectedTopicRelations = useMemo(() => {
    const topicMap = new Map((topicResult?.topics ?? []).map((topic) => [topic.id, topic]))
    return (topicDetail?.relations ?? [])
      .map((relation) => {
        const relatedTopicId =
          relation.sourceTopicId === selectedTopicId ? relation.targetTopicId : relation.sourceTopicId
        return {
          relation,
          topic: topicMap.get(relatedTopicId),
        }
      })
      .filter((item): item is { relation: KnowledgeTopicRelation; topic: KnowledgeTopic } => Boolean(item.topic))
  }, [selectedTopicId, topicDetail?.relations, topicResult?.topics])

  const loadTopics = async (preferredTopicId?: string | null) => {
    setTopicLoading(true)
    try {
      const result = await getKnowledgeTopics({
        query: topicQuery,
        sourceType: topicSourceType,
        limit: 80,
      })
      setTopicResult(result)
      if (!result.ok) {
        onStatus(result.error ?? "主题工作台加载失败")
        return
      }
      const nextTopicId = preferredTopicId && result.topics.some((topic) => topic.id === preferredTopicId)
        ? preferredTopicId
        : result.topics[0]?.id ?? null
      setSelectedTopicId(nextTopicId)
      if (nextTopicId) {
        await loadTopicDetail(nextTopicId)
      } else {
        setTopicDetail(null)
        setSelectedTopicDocument(null)
      }
    } catch (err) {
      onStatus(`主题工作台加载失败: ${errorMessage(err)}`)
    } finally {
      setTopicLoading(false)
    }
  }

  const loadTopicDetail = async (topicId: string) => {
    setTopicDetailLoading(true)
    try {
      const detail = await getKnowledgeTopicDetail(topicId)
      setTopicDetail(detail)
      setTopicAnswer(null)
      if (!detail.ok) {
        onStatus(detail.error ?? "主题详情加载失败")
        setSelectedTopicDocument(null)
        return
      }
      setSelectedTopicDocument(detail.documents[0] ?? null)
    } catch (err) {
      onStatus(`主题详情加载失败: ${errorMessage(err)}`)
    } finally {
      setTopicDetailLoading(false)
    }
  }

  useEffect(() => {
    loadTopics()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selectTopic = async (topic: KnowledgeTopic) => {
    setSelectedTopicId(topic.id)
    await loadTopicDetail(topic.id)
  }

  const rebuildTopics = async () => {
    setTopicRebuilding(true)
    try {
      const result = await rebuildKnowledgeTopics()
      if (!result.ok) {
        onStatus(result.error ?? "主题工作台重建失败")
        return
      }
      onStatus(`主题工作台已重建：${result.topics} 个主题，${result.topicDocuments} 篇笔记`)
      await loadTopics(selectedTopicId)
    } catch (err) {
      onStatus(`主题工作台重建失败: ${errorMessage(err)}`)
    } finally {
      setTopicRebuilding(false)
    }
  }

  const enrichCurrentTopic = async () => {
    if (!selectedTopicId) return
    setTopicEnriching(true)
    try {
      const result = await enrichKnowledgeTopics(selectedTopicId)
      if (!result.ok) {
        onStatus(result.error ?? "AI 整理主题失败")
        return
      }
      onStatus(`AI 已整理 ${result.topics} 个主题`)
      await loadTopics(selectedTopicId)
    } catch (err) {
      onStatus(`AI 整理主题失败: ${errorMessage(err)}`)
    } finally {
      setTopicEnriching(false)
    }
  }

  const exportCurrentTopic = async () => {
    if (!selectedTopicId) return
    setTopicExporting(true)
    try {
      const result = await exportKnowledgeTopic(selectedTopicId)
      if (!result.ok) {
        onStatus(result.error ?? "主题目录页导出失败")
        return
      }
      onStatus("主题目录页已写入笔记软件")
      if (result.openTarget) {
        try {
          await openExternalTarget(result.openTarget)
        } catch (err) {
          onStatus(`主题目录页已生成，但打开失败: ${errorMessage(err)}`)
        }
      }
    } catch (err) {
      onStatus(`主题目录页导出失败: ${errorMessage(err)}`)
    } finally {
      setTopicExporting(false)
    }
  }

  const askCurrentTopic = async () => {
    if (!selectedTopic) return
    setTopicAsking(true)
    try {
      const result = await askKnowledge(
        `请基于我的知识库解释“${selectedTopic.title}”这个主题，并给出下一步最值得阅读的笔记。`,
        null,
        8,
      )
      setTopicAnswer(result)
      onStatus(result.ok ? "已围绕主题生成回答" : result.error ?? "主题提问失败")
    } catch (err) {
      onStatus(`主题提问失败: ${errorMessage(err)}`)
    } finally {
      setTopicAsking(false)
    }
  }

  const copyTopicCitation = async () => {
    if (!selectedTopicDocument) return
    const text = `${selectedTopicDocument.title}\n${topicDocumentTarget(selectedTopicDocument) || selectedTopicDocument.documentId}\n\n${selectedTopicDocument.snippet}`
    try {
      await navigator.clipboard.writeText(text)
      onStatus("引用已复制")
    } catch (err) {
      onStatus(`复制引用失败: ${errorMessage(err)}`)
    }
  }

  return (
    <section className="tk-panel overflow-hidden">
      <div className="tk-panel-header">
        <div>
          <h2 className="tk-panel-title">主题工作台</h2>
          <p className="text-xs text-muted-foreground">
            {topicResult
              ? `当前 ${topicResult.stats.topics}/${topicResult.stats.totalTopics} 个主题，覆盖 ${topicResult.stats.documents} 篇笔记`
              : "从已索引知识库生成主题"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="tk-badge">{topicResult?.stats.topics ?? 0} 个主题</span>
          <span className="tk-badge">{topicResult?.stats.relations ?? 0} 条主题关联</span>
          {selectedTopic?.aiEnhanced && <span className="tk-badge">AI 已整理</span>}
        </div>
      </div>

      <div className="tk-visual-strip">
        <div className="tk-visual-tile">
          <div className="min-w-0">
            <div className="tk-visual-index">01 / FIND</div>
            <div className="text-xs font-semibold text-slate-900">搜主题</div>
            <div className="truncate text-xs text-muted-foreground">按关键词、来源或摘要定位知识范围</div>
          </div>
        </div>
        <div className="tk-visual-tile tk-visual-tile-mint">
          <div className="min-w-0">
            <div className="tk-visual-index">02 / READ</div>
            <div className="text-xs font-semibold text-slate-900">回到原笔记</div>
            <div className="truncate text-xs text-muted-foreground">打开 Obsidian / SiYuan / Markdown 来源</div>
          </div>
        </div>
        <div className="tk-visual-tile tk-visual-tile-amber">
          <div className="min-w-0">
            <div className="tk-visual-index">03 / BUILD</div>
            <div className="text-xs font-semibold text-slate-900">整理主题页</div>
            <div className="truncate text-xs text-muted-foreground">把主题工作台写回笔记软件形成目录</div>
          </div>
        </div>
      </div>

      <div className="tk-panel-body bg-[rgb(235_243_240/0.52)]">
        <div className="grid items-start gap-4 xl:grid-cols-[310px_minmax(0,1fr)_360px]">
          <aside className="sticky top-4 space-y-4 rounded-md border border-white/70 bg-[rgb(247_250_248)] p-3 shadow-[0_14px_34px_rgb(15_23_42/0.045)] ring-1 ring-slate-900/5">
            <div className="grid gap-3">
              <label className="tk-field">
                <span className="tk-label">关键词</span>
                <input
                  className="tk-input"
                  value={topicQuery}
                  onChange={(event) => setTopicQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") loadTopics(selectedTopicId)
                  }}
                  placeholder="搜索主题、关键词或摘要"
                />
              </label>
              <label className="tk-field">
                <span className="tk-label">来源</span>
                <select
                  className="tk-select"
                  value={topicSourceType}
                  onChange={(event) => setTopicSourceType(event.target.value)}>
                  <option value="">全部来源</option>
                  <option value="tabkeep_note">TabKeep</option>
                  <option value="markdown">Markdown / Obsidian</option>
                  <option value="siyuan">SiYuan</option>
                </select>
              </label>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => loadTopics(selectedTopicId)} disabled={topicLoading}>
                  <Search className="h-4 w-4" />
                  {topicLoading ? "加载中..." : "应用"}
                </Button>
                <Button variant="secondary" onClick={rebuildTopics} disabled={topicRebuilding}>
                  <RefreshCw className={`h-4 w-4 ${topicRebuilding ? "animate-spin" : ""}`} />
                  {topicRebuilding ? "重建中..." : "重建"}
                </Button>
              </div>
            </div>

            <div className="grid max-h-[620px] gap-2 overflow-auto pr-1">
              {topicResult?.topics.length ? (
                topicResult.topics.map((topic) => (
                  <button
                    key={topic.id}
                    className={`group relative overflow-hidden rounded-md border bg-[rgb(250_252_250)] px-3 py-3 text-left transition-colors ${
                      selectedTopicId === topic.id
                        ? "border-blue-300 bg-blue-50/45 ring-2 ring-blue-100"
                        : "border-white/70 ring-1 ring-slate-900/5 hover:border-blue-200/80 hover:bg-slate-50"
                    }`}
                    onClick={() => selectTopic(topic)}>
                    <span
                      className={`absolute inset-y-0 left-0 w-1 ${
                        selectedTopicId === topic.id ? "bg-blue-500" : "bg-transparent group-hover:bg-blue-200"
                      }`}
                    />
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">
                        {topic.title}
                      </span>
                      <span className="tk-badge">{topic.documentCount} 篇</span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{topic.summary}</p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {topic.keywords.slice(0, 3).map((keyword) => (
                        <span key={keyword} className="rounded-md bg-[rgb(241_247_244)] px-1.5 py-0.5 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200/70">
                          {keyword}
                        </span>
                      ))}
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                      <span>{Math.round(topic.confidence * 100)}% 匹配</span>
                      {topic.aiEnhanced && (
                        <span className="rounded-sm bg-blue-100 px-1.5 py-0.5 font-medium text-blue-700">AI 整理</span>
                      )}
                    </div>
                  </button>
                ))
              ) : (
                <div className="tk-muted-box">
                  暂无主题。先重建知识库索引，或点击“重建”从已有索引生成主题。
                </div>
              )}
            </div>
          </aside>

          <main className="space-y-4 rounded-md border border-white/70 bg-[rgb(249_251_249)] p-4 shadow-[0_16px_38px_rgb(15_23_42/0.045)] ring-1 ring-slate-900/5">
            {selectedTopic ? (
              <>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span className="tk-badge">{selectedTopic.documentCount} 篇笔记</span>
                      <span className="tk-badge">{Math.round(selectedTopic.confidence * 100)}% 匹配</span>
                      {selectedTopic.sourceTypes.map((source) => (
                        <span key={source} className="tk-badge">{formatSourceType(source)}</span>
                      ))}
                    </div>
                    <h3 className="text-xl font-semibold leading-7 text-slate-950">{selectedTopic.title}</h3>
                    <p className="mt-2 text-sm leading-6 text-slate-600">{selectedTopic.summary}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="secondary" onClick={exportCurrentTopic} disabled={topicExporting || !selectedTopicId}>
                      <BookOpen className={`h-4 w-4 ${topicExporting ? "animate-pulse" : ""}`} />
                      {topicExporting ? "生成中..." : "生成目录页"}
                    </Button>
                    <Button variant="secondary" onClick={enrichCurrentTopic} disabled={topicEnriching || !selectedTopicId}>
                      <Sparkles className={`h-4 w-4 ${topicEnriching ? "animate-pulse" : ""}`} />
                      {topicEnriching ? "整理中..." : "AI 整理"}
                    </Button>
                    <Button onClick={askCurrentTopic} disabled={topicAsking}>
                      <Brain className={`h-4 w-4 ${topicAsking ? "animate-pulse" : ""}`} />
                      {topicAsking ? "提问中..." : "围绕主题提问"}
                    </Button>
                  </div>
                </div>

                <div className="rounded-md border border-white/70 bg-[rgb(238_245_242)] p-3 ring-1 ring-slate-900/5">
                  <div className="mb-2 text-xs font-semibold text-slate-700">主题关键词</div>
                  <div className="flex flex-wrap gap-2">
                    {selectedTopic.keywords.map((keyword) => (
                      <span key={keyword} className="rounded-md border border-white/70 bg-[rgb(250_252_250)] px-2 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-900/5">
                        {keyword}
                      </span>
                    ))}
                  </div>
                </div>

                {topicDetailLoading ? (
                  <div className="tk-muted-box">主题详情加载中...</div>
                ) : (
                  <>
                    <section>
                      <div className="mb-2 flex items-center justify-between">
                        <h4 className="text-sm font-semibold text-slate-900">推荐阅读顺序</h4>
                        <span className="tk-badge">{topicDetail?.documents.length ?? 0}</span>
                      </div>
                      <div className="grid gap-2">
                        {(topicDetail?.documents ?? []).map((document, index) => (
                          <div
                            key={document.documentId}
                            className={`group relative rounded-md border p-3 pl-12 text-left transition-colors ${
                              selectedTopicDocument?.documentId === document.documentId
                                ? "border-blue-300 bg-blue-50/50 ring-2 ring-blue-100"
                                : "border-white/70 ring-1 ring-slate-900/5 hover:border-blue-200/80 hover:bg-blue-50/25"
                            }`}
                            onDoubleClick={() => openTopicDocumentSource(document, onStatus, noteAdapter)}>
                            <div className="absolute left-3 top-3 flex h-7 w-7 items-center justify-center rounded-md bg-[rgb(238_245_242)] text-xs font-semibold text-slate-700 ring-1 ring-slate-200/80">
                              {String(index + 1).padStart(2, "0")}
                            </div>
                            <div className="mb-1 flex items-center gap-2">
                              <span className="h-7 w-1.5 rounded-full bg-blue-400" />
                              <button
                                className="min-w-0 flex-1 truncate text-left text-sm font-semibold text-slate-900 hover:text-blue-700"
                                title="查看这篇笔记的关键片段"
                                onClick={() => setSelectedTopicDocument(document)}>
                                {document.title}
                              </button>
                              <span className="tk-badge">{formatSourceType(document.sourceType)}</span>
                              <button
                                className="tk-icon-button h-7 w-7 bg-white/80 ring-1 ring-slate-200/70 group-hover:text-blue-700"
                                title={formatTopicOpenTitle(document, noteAdapter)}
                                onClick={() => openTopicDocumentSource(document, onStatus, noteAdapter)}
                                disabled={!topicDocumentOpenTarget(document, noteAdapter)}>
                                <Folder className="h-3.5 w-3.5" />
                              </button>
                            </div>
                            <button
                              className="block w-full text-left"
                              onClick={() => setSelectedTopicDocument(document)}
                              title="单击选中，双击卡片可打开原笔记">
                              <p className="line-clamp-2 text-xs leading-5 text-slate-600">{document.snippet}</p>
                              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                <span>{document.reason}</span>
                                {document.anchor && (
                                  <span className="rounded-md bg-blue-50 px-1.5 py-0.5 font-medium text-blue-700">
                                    可跳到 {document.anchor}
                                  </span>
                                )}
                              </div>
                            </button>
                          </div>
                        ))}
                      </div>
                    </section>

                    <section className="rounded-md border border-white/70 bg-[rgb(238_245_242)] p-3 ring-1 ring-slate-900/5">
                      <h4 className="mb-2 text-sm font-semibold text-slate-900">主题证据</h4>
                      <div className="grid max-h-52 gap-2 overflow-auto pr-1 md:grid-cols-2">
                        {(topicDetail?.evidence ?? []).slice(0, 16).map((item) => (
                          <div key={item.id} className="rounded-md border border-white/70 bg-[rgb(250_252_250)] px-3 py-2 text-xs ring-1 ring-slate-900/5">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-medium text-slate-900">{item.label}</span>
                              <span className="tk-badge">{formatTopicEvidenceKind(item.kind)}</span>
                            </div>
                            <p className="mt-1 text-muted-foreground">关联强度 {item.weight.toFixed(1)}</p>
                          </div>
                        ))}
                        {(topicDetail?.evidence ?? []).length === 0 && (
                          <div className="tk-muted-box md:col-span-2">暂无可展示的主题证据</div>
                        )}
                      </div>
                    </section>

                    {topicAnswer && (
                      <section className="rounded-md border border-blue-100 bg-blue-50/50 p-3">
                        <h4 className="mb-2 text-sm font-semibold text-blue-950">主题问答</h4>
                        <div className="whitespace-pre-wrap text-sm leading-6 text-slate-700">
                          {topicAnswer.answer || topicAnswer.error || "没有生成有效回答。"}
                        </div>
                      </section>
                    )}
                  </>
                )}
              </>
            ) : (
              <div className="tk-muted-box">选择左侧主题后，这里会展示主题摘要、推荐阅读和主题证据。</div>
            )}
          </main>

          <aside className="sticky top-4 space-y-3 rounded-md border border-white/70 bg-[rgb(247_250_248)] p-3 shadow-[0_14px_34px_rgb(15_23_42/0.045)] ring-1 ring-slate-900/5">
            {selectedTopicDocument ? (
              <>
                <div className="rounded-md border border-white/70 bg-[rgb(238_245_242)] p-3 ring-1 ring-slate-900/5">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="tk-badge">{formatSourceType(selectedTopicDocument.sourceType)}</span>
                    {selectedTopicDocument.anchor && (
                      <span className="rounded-md bg-blue-100 px-2 py-1 text-xs font-medium text-blue-700">
                        可定位
                      </span>
                    )}
                  </div>
                  <h3 className="text-sm font-semibold leading-6 text-slate-950">
                    {selectedTopicDocument.title}
                  </h3>
                  <p className="mt-2 break-all rounded-md bg-white/70 px-2 py-1.5 text-xs text-muted-foreground ring-1 ring-slate-200/70">
                    {topicDocumentTarget(selectedTopicDocument) || selectedTopicDocument.documentId}
                  </p>
                </div>
                <div className="rounded-md border border-white/70 bg-white/70 p-3 ring-1 ring-slate-900/5">
                  <div className="mb-2 text-xs font-semibold text-slate-900">关键片段</div>
                  <div className="text-sm leading-6 text-slate-700">
                    {selectedTopicDocument.snippet || "暂无片段"}
                  </div>
                </div>
                <div className="rounded-md border border-white/70 bg-white/70 p-3 text-xs leading-5 text-slate-600 ring-1 ring-slate-900/5">
                  <div className="mb-1 font-semibold text-slate-900">推荐原因</div>
                  {selectedTopicDocument.reason || "来自主题匹配"}
                </div>
                {selectedTopicDocument.anchor && (
                  <div className="rounded-md border border-blue-100 bg-blue-50/70 p-3 text-xs text-blue-900">
                    <div className="mb-1 font-semibold">可定位标题</div>
                    {selectedTopicDocument.anchor}
                  </div>
                )}
                <div className="grid gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => openTopicDocumentSource(selectedTopicDocument, onStatus, noteAdapter)}
                    disabled={!topicDocumentOpenTarget(selectedTopicDocument, noteAdapter)}>
                    <Folder className="h-4 w-4" />
                    打开笔记
                  </Button>
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => copyTopicDocumentSource(selectedTopicDocument, onStatus)}>
                      <Copy className="h-4 w-4" />
                      复制来源
                    </Button>
                    <Button variant="secondary" onClick={copyTopicCitation}>
                      <Clipboard className="h-4 w-4" />
                      复制引用
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <div className="tk-muted-box">点击推荐笔记后，这里会显示来源、片段和操作。</div>
            )}

            {selectedTopic && (
              <div className="rounded-md border border-white/70 bg-[rgb(238_245_242)] p-3 ring-1 ring-slate-900/5">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h4 className="text-sm font-semibold text-slate-900">继续探索</h4>
                  <span className="tk-badge">{selectedTopicRelations.length}</span>
                </div>
                <div className="grid max-h-64 gap-2 overflow-auto pr-1">
                  {selectedTopicRelations.length > 0 ? (
                    selectedTopicRelations.slice(0, 10).map(({ relation, topic }) => (
                      <button
                        key={relation.id}
                        className="rounded-md border border-white/70 bg-[rgb(250_252_250)] px-3 py-2 text-left text-xs ring-1 ring-slate-900/5 transition-colors hover:border-blue-200/80 hover:bg-blue-50"
                        onClick={() => selectTopic(topic)}>
                        <div className="font-medium text-slate-900">{topic.title}</div>
                        <div className="mt-1 text-muted-foreground">{relation.label || "相关主题"}</div>
                      </button>
                    ))
                  ) : (
                    <div className="tk-muted-box">暂无相关主题</div>
                  )}
                </div>
              </div>
            )}
          </aside>
        </div>
      </div>
    </section>
  )
}

function KnowledgeGraphPanel({ onStatus }: { onStatus: (message: string) => void }) {
  const [graphLayer, setGraphLayer] = useState<KnowledgeGraphLayer>("all")
  const [graphQuery, setGraphQuery] = useState("")
  const [graphSourceType, setGraphSourceType] = useState("")
  const [graphResult, setGraphResult] = useState<KnowledgeGraphResponse | null>(null)
  const [selectedGraphNode, setSelectedGraphNode] = useState<KnowledgeGraphNode | null>(null)
  const [selectedGraphRelation, setSelectedGraphRelation] = useState<GraphSelectedRelation | null>(null)
  const [expandedGraphNodeIds, setExpandedGraphNodeIds] = useState<Set<string>>(() => new Set())
  const [graphLoading, setGraphLoading] = useState(false)
  const [graphRebuilding, setGraphRebuilding] = useState(false)

  const graphRelation = useMemo(
    () => buildGraphRelation(graphResult?.nodes ?? [], graphResult?.edges ?? []),
    [graphResult],
  )
  const graphNodeMap = useMemo(
    () => new Map((graphResult?.nodes ?? []).map((node) => [node.id, node])),
    [graphResult],
  )

  const selectGraphNode = (node: KnowledgeGraphNode) => {
    setSelectedGraphRelation(null)
    setSelectedGraphNode(node)
  }

  const selectedRelationKey = useMemo(
    () =>
      selectedGraphRelation
        ? `${selectedGraphRelation.source.id}->${selectedGraphRelation.target.id}:${selectedGraphRelation.kind}`
        : null,
    [selectedGraphRelation],
  )

  const toggleGraphNode = (node: KnowledgeGraphNode) => {
    const children = graphRelation.childMap.get(node.id) ?? []
    selectGraphNode(node)
    if (children.length === 0) return
    setExpandedGraphNodeIds((current) => {
      const next = new Set(current)
      if (next.has(node.id)) {
        collapseGraphBranch(node.id, next, graphRelation.childMap)
      } else {
        next.add(node.id)
      }
      return next
    })
  }

  const graphData = useMemo(
    () =>
      buildVisibleGraphData({
        graphResult,
        relation: graphRelation,
        expandedNodeIds: expandedGraphNodeIds,
        selectedNodeId: selectedGraphNode?.id ?? null,
        selectedRelationKey,
        onSelect: selectGraphNode,
        onToggle: toggleGraphNode,
      }),
    // toggleGraphNode intentionally closes over the current relation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [expandedGraphNodeIds, graphRelation, graphResult, selectedGraphNode?.id, selectedRelationKey],
  )

  const rootNodes = useMemo(() => {
    const nodeMap = new Map((graphResult?.nodes ?? []).map((node) => [node.id, node]))
    return graphRelation.roots
      .map((rootId) => nodeMap.get(rootId))
      .filter((node): node is KnowledgeGraphNode => Boolean(node))
  }, [graphRelation.roots, graphResult])

  const selectedChildren = useMemo(() => {
    if (!selectedGraphNode || !graphResult) return []
    const nodeMap = new Map(graphResult.nodes.map((node) => [node.id, node]))
    return (graphRelation.childMap.get(selectedGraphNode.id) ?? [])
      .map((nodeId) => nodeMap.get(nodeId))
      .filter((node): node is KnowledgeGraphNode => Boolean(node))
  }, [graphRelation.childMap, graphResult, selectedGraphNode])

  const selectedOutgoing = useMemo(
    () => graphNodeRelations(selectedGraphNode?.id ?? null, graphResult, graphRelation, "out"),
    [graphRelation, graphResult, selectedGraphNode],
  )
  const selectedIncoming = useMemo(
    () => graphNodeRelations(selectedGraphNode?.id ?? null, graphResult, graphRelation, "in"),
    [graphRelation, graphResult, selectedGraphNode],
  )
  const selectedGraphPath = useMemo(
    () => graphNodePath(selectedGraphNode?.id ?? null, graphResult, graphRelation),
    [graphRelation, graphResult, selectedGraphNode],
  )
  const graphKindStats = useMemo(() => graphNodeKindStats(graphResult?.nodes ?? []), [graphResult])
  const graphEdgeStats = useMemo(() => graphEdgeKindStats(graphResult?.edges ?? []), [graphResult])
  const visibleLevelCount = useMemo(
    () =>
      new Set(graphData.nodes.map((node) => Math.round((node.position.x - GRAPH_NODE_X) / GRAPH_COLUMN_WIDTH))).size,
    [graphData.nodes],
  )
  const selectedDirectRelationCount = selectedOutgoing.length + selectedIncoming.length
  const hasCollapsedVisibleBranch = graphData.nodes.some(
    (node) => graphRelation.childMap.has(node.id) && !expandedGraphNodeIds.has(node.id),
  )
  const expandableNodeCount = graphRelation.childMap.size

  const nodeTypes = useMemo(() => ({ knowledgeMap: KnowledgeMapNode }), [])

  const loadGraph = async () => {
    setGraphLoading(true)
    try {
      const result = await getKnowledgeGraph({
        layer: graphLayer,
        query: graphQuery,
        sourceType: graphSourceType,
        limit: 300,
      })
      setGraphResult(result)
      if (!result.ok) {
        onStatus(result.error ?? "知识图谱加载失败")
        return
      }
      const relation = buildGraphRelation(result.nodes, result.edges)
      setExpandedGraphNodeIds(new Set())
      setSelectedGraphRelation(null)
      setSelectedGraphNode(result.nodes.find((node) => node.id === relation.roots[0]) ?? null)
    } catch (err) {
      onStatus(`知识图谱加载失败: ${errorMessage(err)}`)
    } finally {
      setGraphLoading(false)
    }
  }

  useEffect(() => {
    loadGraph()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const rebuildGraph = async () => {
    setGraphRebuilding(true)
    try {
      const result = await rebuildKnowledgeGraph()
      if (!result.ok) {
        onStatus(result.error ?? "知识图谱重建失败")
        return
      }
      onStatus(`知识图谱已重建：${result.nodes} 个节点，${result.edges} 条关系`)
      await loadGraph()
    } catch (err) {
      onStatus(`知识图谱重建失败: ${errorMessage(err)}`)
    } finally {
      setGraphRebuilding(false)
    }
  }

  const expandAllGraph = () => {
    const allExpandable = new Set(graphRelation.childMap.keys())
    setExpandedGraphNodeIds(allExpandable)
    setSelectedGraphNode((current) => current ?? rootNodes[0] ?? null)
  }

  const expandNextGraphLevel = () => {
    setExpandedGraphNodeIds((current) => {
      const next = new Set(current)
      for (const node of graphData.nodes) {
        if (graphRelation.childMap.has(node.id)) next.add(node.id)
      }
      return next
    })
    setSelectedGraphNode((current) => current ?? rootNodes[0] ?? null)
  }

  const selectGraphEdge = (edge: GraphFlowEdge) => {
    const source = graphNodeMap.get(edge.source)
    const target = graphNodeMap.get(edge.target)
    if (!source || !target) return
    setSelectedGraphRelation({ source, target, kind: edge.data?.kind ?? "related" })
    setSelectedGraphNode(source)
  }

  const copySelectedGraphRelation = async () => {
    if (!selectedGraphRelation) return
    const text = `${selectedGraphRelation.source.label} --${formatGraphEdgeKind(selectedGraphRelation.kind)}--> ${selectedGraphRelation.target.label}`
    try {
      await navigator.clipboard.writeText(text)
      onStatus("关系已复制")
    } catch (err) {
      onStatus(`复制关系失败: ${errorMessage(err)}`)
    }
  }

  const copySelectedGraphPath = async () => {
    if (selectedGraphPath.length === 0) return
    const text = selectedGraphPath.map((node) => node.label).join(" > ")
    try {
      await navigator.clipboard.writeText(text)
      onStatus("路径已复制")
    } catch (err) {
      onStatus(`复制路径失败: ${errorMessage(err)}`)
    }
  }

  return (
    <section className="tk-panel">
      <div className="tk-panel-header">
        <div>
          <h2 className="tk-panel-title">知识地图</h2>
          <p className="text-xs text-muted-foreground">
            {graphResult
              ? `当前显示 ${graphData.nodes.length}/${graphResult.stats.totalNodes} 个节点`
              : "等待载入"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="tk-badge">{graphData.nodes.length} 个可见节点</span>
          <span className="tk-badge">{graphData.edges.length} 条可见关系</span>
          <span className="tk-badge">{visibleLevelCount} 层</span>
          <span className="tk-badge">{expandedGraphNodeIds.size}/{expandableNodeCount} 已展开</span>
          {selectedGraphNode && <span className="tk-badge">{selectedDirectRelationCount} 个直接关联</span>}
        </div>
      </div>
      <div className="tk-panel-body">
        <div className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)_320px]">
          <aside className="space-y-4 rounded-md border border-slate-200 bg-slate-50 p-3">
            <div className="grid gap-3">
              <label className="tk-field">
                <span className="tk-label">层级</span>
                <select
                  className="tk-select"
                  value={graphLayer}
                  onChange={(event) => setGraphLayer(event.target.value as KnowledgeGraphLayer)}>
                  <option value="all">全部</option>
                  <option value="documents">文档关系</option>
                  <option value="concepts">显式概念</option>
                </select>
              </label>
              <label className="tk-field">
                <span className="tk-label">来源</span>
                <select
                  className="tk-select"
                  value={graphSourceType}
                  onChange={(event) => setGraphSourceType(event.target.value)}>
                  <option value="">全部来源</option>
                  <option value="tabkeep_note">TabKeep</option>
                  <option value="markdown">Markdown / Obsidian</option>
                  <option value="siyuan">SiYuan</option>
                </select>
              </label>
              <label className="tk-field">
                <span className="tk-label">关键词</span>
                <input
                  className="tk-input"
                  value={graphQuery}
                  onChange={(event) => setGraphQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") loadGraph()
                  }}
                  placeholder="标题、标签、概念或路径"
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={loadGraph} disabled={graphLoading}>
                  <Search className="h-4 w-4" />
                  {graphLoading ? "加载中..." : "应用"}
                </Button>
                <Button variant="secondary" onClick={rebuildGraph} disabled={graphRebuilding}>
                  <RefreshCw className={`h-4 w-4 ${graphRebuilding ? "animate-spin" : ""}`} />
                  {graphRebuilding ? "重建中..." : "重建"}
                </Button>
                <Button
                  variant="ghost"
                  onClick={expandNextGraphLevel}
                  disabled={!hasCollapsedVisibleBranch}>
                  展开一层
                </Button>
                <Button
                  variant="ghost"
                  onClick={expandAllGraph}
                  disabled={expandableNodeCount === 0 || expandedGraphNodeIds.size === expandableNodeCount}>
                  展开全部
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setExpandedGraphNodeIds(new Set())
                    setSelectedGraphRelation(null)
                    setSelectedGraphNode(rootNodes[0] ?? null)
                  }}
                  disabled={expandedGraphNodeIds.size === 0}>
                  收起全部
                </Button>
              </div>
            </div>

            <div className="rounded-md border border-slate-200 bg-white p-3">
              <h3 className="mb-2 text-sm font-semibold text-slate-900">关系摘要</h3>
              <div className="grid grid-cols-2 gap-2 text-xs">
                {["source", "document", "tag", "heading", "concept"].map((kind) => (
                  <div key={kind} className="flex items-center justify-between rounded-md bg-slate-50 px-2 py-1.5">
                    <span className="flex items-center gap-1.5 text-slate-600">
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ backgroundColor: graphNodeColor(kind) }}
                      />
                      {formatGraphNodeKind(kind)}
                    </span>
                    <span className="font-medium text-slate-900">{graphKindStats[kind] ?? 0}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-md border border-slate-200 bg-white p-3">
              <h3 className="mb-2 text-sm font-semibold text-slate-900">关系类型</h3>
              <div className="grid gap-2 text-xs">
                {["belongs_to_source", "links_to_document", "has_tag", "has_heading", "mentions_concept"].map((kind) => (
                  <div key={kind} className="flex items-center justify-between rounded-md bg-slate-50 px-2 py-1.5">
                    <span className="flex min-w-0 items-center gap-1.5 text-slate-600">
                      <span
                        className="h-2 w-4 rounded-full"
                        style={{ backgroundColor: graphEdgeColor(kind) }}
                      />
                      <span className="truncate">{formatGraphEdgeKind(kind)}</span>
                    </span>
                    <span className="font-medium text-slate-900">{graphEdgeStats[kind] ?? 0}</span>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-900">根节点</h3>
                <span className="tk-badge">{rootNodes.length}</span>
              </div>
              <div className="grid max-h-[430px] gap-2 overflow-auto pr-1">
                {rootNodes.length > 0 ? (
                  rootNodes.map((node) => {
                    const active = selectedGraphNode?.id === node.id
                    const childCount = graphRelation.childMap.get(node.id)?.length ?? 0
                    return (
                      <button
                        key={node.id}
                        className={`rounded-md border bg-white px-3 py-2 text-left transition-colors ${
                          active ? "border-blue-300 ring-2 ring-blue-100" : "border-slate-200 hover:border-blue-200"
                        }`}
                        onClick={() => selectGraphNode(node)}>
                        <div className="mb-1 flex items-center gap-2">
                          <span
                            className="h-2.5 w-2.5 rounded-full"
                            style={{ backgroundColor: graphNodeColor(node.kind) }}
                          />
                          <span className="truncate text-sm font-medium text-slate-900">
                            {node.label}
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {formatGraphNodeKind(node.kind)} · {childCount} 个子节点
                        </div>
                      </button>
                    )
                  })
                ) : (
                  <div className="tk-muted-box">暂无根节点</div>
                )}
              </div>
            </div>
          </aside>

          <div className="h-[620px] overflow-hidden rounded-md border border-slate-200 bg-[#f8fafc]">
            {graphData.nodes.length > 0 ? (
              <ReactFlow<GraphFlowNode, GraphFlowEdge>
                key={`${graphData.nodes.length}:${graphData.edges.length}:${expandedGraphNodeIds.size}:${selectedGraphNode?.id ?? ""}`}
                nodes={graphData.nodes}
                edges={graphData.edges}
                nodeTypes={nodeTypes}
                fitView
                fitViewOptions={{ padding: 0.22 }}
                minZoom={0.35}
                maxZoom={1.4}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable
                onlyRenderVisibleElements
                proOptions={{ hideAttribution: true }}
                onNodeClick={(_, node) => selectGraphNode(node.data.graphNode)}
                onEdgeClick={(_, edge) => selectGraphEdge(edge)}>
                <Background color="#cbd5e1" gap={24} />
                <Controls showInteractive={false} />
                <MiniMap
                  pannable
                  zoomable
                  nodeColor={(node) => graphMiniMapNodeColor(node)}
                  nodeStrokeWidth={2}
                />
                <Panel position="top-left">
                  <div className="rounded-md border border-slate-200 bg-white/90 px-3 py-2 text-xs text-slate-600 shadow-sm">
                    {expandedGraphNodeIds.size === 0
                      ? "根节点已收起"
                      : selectedGraphNode
                        ? `高亮：${selectedGraphNode.label.length > 18 ? `${selectedGraphNode.label.slice(0, 17)}...` : selectedGraphNode.label}`
                        : expandedGraphNodeIds.size === expandableNodeCount
                          ? "已全部展开"
                          : `已展开 ${expandedGraphNodeIds.size} 个分支`}
                  </div>
                </Panel>
              </ReactFlow>
            ) : (
              <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
                暂无图谱数据。先重建知识库索引，或点击“重建”从已有索引生成关系。
              </div>
            )}
          </div>

          <aside className="rounded-md border border-slate-200 bg-white p-3">
            {selectedGraphNode ? (
              <div className="space-y-3">
                <div>
                  <span className="tk-badge">{formatGraphNodeKind(selectedGraphNode.kind)}</span>
                  <h3 className="mt-2 text-sm font-semibold leading-6 text-slate-900">
                    {selectedGraphNode.label}
                  </h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    连接度 {selectedGraphNode.degree} · 子级 {(graphRelation.childMap.get(selectedGraphNode.id) ?? []).length}
                  </p>
                </div>
                {selectedGraphRelation && (
                  <div className="rounded-md border border-blue-100 bg-blue-50/50 p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <h4 className="text-xs font-semibold text-blue-900">关系详情</h4>
                      <div className="flex items-center gap-2">
                        <span
                          className="rounded-full px-2 py-0.5 text-xs font-medium text-slate-700"
                          style={{ backgroundColor: graphEdgeColor(selectedGraphRelation.kind) }}>
                          {formatGraphEdgeKind(selectedGraphRelation.kind)}
                        </span>
                        <button
                          className="tk-icon-button h-7 w-7"
                          onClick={copySelectedGraphRelation}
                          title="复制关系">
                          <Copy className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                    <div className="grid gap-2 text-xs">
                      <button
                        className="rounded-md border border-blue-100 bg-white px-2 py-1.5 text-left hover:border-blue-200"
                        onClick={() => selectGraphNode(selectedGraphRelation.source)}>
                        <span className="text-muted-foreground">从：</span>
                        <span className="font-medium text-slate-900">{selectedGraphRelation.source.label}</span>
                      </button>
                      <button
                        className="rounded-md border border-blue-100 bg-white px-2 py-1.5 text-left hover:border-blue-200"
                        onClick={() => selectGraphNode(selectedGraphRelation.target)}>
                        <span className="text-muted-foreground">到：</span>
                        <span className="font-medium text-slate-900">{selectedGraphRelation.target.label}</span>
                      </button>
                    </div>
                  </div>
                )}
                {selectedGraphPath.length > 1 && (
                  <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <h4 className="text-xs font-semibold text-slate-700">路径</h4>
                      <button
                        className="tk-icon-button h-7 w-7"
                        onClick={copySelectedGraphPath}
                        title="复制路径">
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                      {selectedGraphPath.map((node, index) => (
                        <div key={node.id} className="flex items-center gap-1.5">
                          {index > 0 && <span className="text-slate-400">&gt;</span>}
                          <button
                            className="rounded-md bg-white px-2 py-1 font-medium text-slate-700 ring-1 ring-slate-200 hover:ring-blue-200"
                            onClick={() => selectGraphNode(node)}>
                            {node.label.length > 16 ? `${node.label.slice(0, 15)}...` : node.label}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {selectedGraphNode.sourceType && (
                  <div className="tk-muted-box">
                    <div className="mb-1 text-xs font-medium text-slate-700">
                      {formatSourceType(selectedGraphNode.sourceType)}
                    </div>
                    <div className="break-all text-xs">
                      {graphNodeTarget(selectedGraphNode) || selectedGraphNode.documentId}
                    </div>
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  {(graphRelation.childMap.get(selectedGraphNode.id) ?? []).length > 0 && (
                    <Button variant="secondary" onClick={() => toggleGraphNode(selectedGraphNode)}>
                      {expandedGraphNodeIds.has(selectedGraphNode.id) ? "收起节点" : "展开节点"}
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    onClick={() => openGraphNodeSource(selectedGraphNode, onStatus)}
                    disabled={!graphNodeTarget(selectedGraphNode)}>
                    <Folder className="h-4 w-4" />
                    打开来源
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => copyGraphNodeSource(selectedGraphNode, onStatus)}>
                    <Copy className="h-4 w-4" />
                    复制
                  </Button>
                </div>
                {selectedChildren.length > 0 && (
                  <div>
                    <h4 className="mb-2 text-xs font-semibold text-slate-700">下一层</h4>
                    <div className="grid max-h-64 gap-2 overflow-auto pr-1">
                      {selectedChildren.map((child) => (
                        <button
                          key={child.id}
                          className="rounded-md border border-slate-200 px-3 py-2 text-left text-sm transition-colors hover:border-blue-200 hover:bg-blue-50/40"
                          onClick={() => {
                            setExpandedGraphNodeIds((current) => new Set(current).add(selectedGraphNode.id))
                            selectGraphNode(child)
                          }}>
                          <div className="flex items-center gap-2">
                            <span
                              className="h-2.5 w-2.5 rounded-full"
                              style={{ backgroundColor: graphNodeColor(child.kind) }}
                            />
                            <span className="min-w-0 flex-1 truncate font-medium text-slate-900">
                              {child.label}
                            </span>
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {formatGraphEdgeKind(graphRelation.edgeKindMap.get(`${selectedGraphNode.id}->${child.id}`) ?? "related")} · {formatGraphNodeKind(child.kind)} · {(graphRelation.childMap.get(child.id) ?? []).length} 个子节点
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {(selectedOutgoing.length > 0 || selectedIncoming.length > 0) && (
                  <div className="space-y-3">
                    {selectedOutgoing.length > 0 && (
                      <GraphRelationList
                        title="指向"
                        items={selectedOutgoing}
                        onSelect={selectGraphNode}
                      />
                    )}
                    {selectedIncoming.length > 0 && (
                      <GraphRelationList
                        title="来自"
                        items={selectedIncoming}
                        onSelect={selectGraphNode}
                      />
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="tk-muted-box">点击图谱节点后，这里会显示来源和关系信息。</div>
            )}
          </aside>

        </div>
      </div>
    </section>
  )
}

function CitationList({
  items,
  emptyText,
  compact = false,
  onStatus,
}: {
  items: KnowledgeCitation[]
  emptyText: string
  compact?: boolean
  onStatus?: (message: string) => void
}) {
  if (items.length === 0) {
    return <div className="tk-muted-box">{emptyText}</div>
  }
  return (
    <div className="grid gap-2">
      {items.map((item, index) => (
        <div key={item.chunkId} className="rounded-md border border-border p-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="tk-badge">来源 {index + 1}</span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900">
              {item.title}
            </span>
            <span className="tk-badge">{formatSourceType(item.sourceType)}</span>
          </div>
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {sourceTarget(item) || item.documentId}
            </p>
            <button
              className="tk-icon-button"
              title="打开来源"
              disabled={!sourceTarget(item)}
              onClick={() => openCitationSource(item, onStatus)}>
              <Folder className="h-4 w-4" />
            </button>
            <button
              className="tk-icon-button"
              title="复制来源"
              onClick={() => copyCitationSource(item, onStatus)}>
              <Copy className="h-4 w-4" />
            </button>
          </div>
          {!compact && (
            <p className="mt-2 max-h-24 overflow-hidden whitespace-pre-wrap text-sm leading-6 text-slate-700">
              {item.content}
            </p>
          )}
        </div>
      ))}
    </div>
  )
}

function NotesSection({
  config,
  setConfig,
}: {
  config: NoteAdapterConfig
  setConfig: (config: NoteAdapterConfig) => void
}) {
  const [draft, setDraft] = useState<NoteAdapterConfig>(config)
  const [status, setStatus] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [notebooks, setNotebooks] = useState<NotebookInfo[]>([])

  useEffect(() => {
    setDraft(config)
  }, [config])

  const save = async () => {
    setStatus(null)
    try {
      await syncConfigToBackend({ noteAdapter: draft })
      setConfig(draft)
      setStatus("已保存")
    } catch (err) {
      setStatus(errorMessage(err))
    }
  }

  const test = async () => {
    setTesting(true)
    setStatus(null)
    setNotebooks([])
    try {
      await syncConfigToBackend({ noteAdapter: draft })
      setConfig(draft)
      const result = await backendRequest<NotesTestResponse>("POST", "/notes/test")
      if (!result.ok) {
        setStatus(result.error ?? "连接失败")
        return
      }
      const list = await backendRequest<NotebookInfo[]>("GET", "/notes/notebooks")
      setNotebooks(Array.isArray(list) ? list : [])
      setStatus(`连接成功：${result.provider ?? draft.provider}`)
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setTesting(false)
    }
  }

  const provider = draft.provider

  return (
    <div className="space-y-5">
      <header className="tk-topbar">
        <div>
          <h1 className="tk-page-title">笔记集成</h1>
          <p className="tk-page-subtitle">收藏当前标签页到本地 Markdown、思源或 Obsidian</p>
        </div>
      </header>

      {status && <Notice tone={status.startsWith("连接成功") || status === "已保存" ? "success" : "warning"}>{status}</Notice>}

      <section className="tk-panel max-w-3xl">
        <div className="tk-panel-body space-y-4">
          <label className="tk-field">
            <span className="tk-label">Provider</span>
            <select
              className="tk-select"
              value={provider}
              onChange={(event) => {
                const next = event.target.value as NoteAdapterConfig["provider"]
                setDraft({
                  provider: next,
                  endpoint: next === "siyuan" ? draft.endpoint ?? "http://127.0.0.1:6806" : undefined,
                  token: next === "siyuan" ? draft.token : undefined,
                  vault: next === "obsidian" ? draft.vault : undefined,
                  defaultFolder: next === "obsidian" ? draft.defaultFolder ?? "TabKeep Inbox" : undefined,
                  writeMode: next === "obsidian" ? draft.writeMode ?? "new_file" : undefined,
                  defaultNotebook: next === "siyuan" ? draft.defaultNotebook : undefined,
                  defaultTargetDoc: next !== "local" ? draft.defaultTargetDoc : undefined,
                })
              }}>
              <option value="local">本地 Markdown</option>
              <option value="siyuan">思源笔记</option>
              <option value="obsidian">Obsidian / Markdown 文件夹</option>
            </select>
          </label>

          {provider === "siyuan" && (
            <div className="tk-form-grid">
              <TextField
                label="Endpoint"
                value={draft.endpoint ?? ""}
                onChange={(value) => setDraft({ ...draft, endpoint: value })}
                placeholder="http://127.0.0.1:6806"
              />
              <TextField
                label="Token"
                type="password"
                value={draft.token ?? ""}
                onChange={(value) => setDraft({ ...draft, token: value })}
                placeholder="思源 API token"
              />
              <TextField
                label="默认笔记本 ID"
                value={draft.defaultNotebook ?? ""}
                onChange={(value) => setDraft({ ...draft, defaultNotebook: value })}
                placeholder="留空则每次选择"
              />
              <TextField
                label="默认目标文档"
                value={draft.defaultTargetDoc ?? ""}
                onChange={(value) => setDraft({ ...draft, defaultTargetDoc: value })}
                placeholder="留空 = 新建"
              />
            </div>
          )}

          {provider === "obsidian" && (
            <div className="tk-form-grid">
              <TextField
                label="Vault / Markdown 文件夹路径"
                value={draft.vault ?? ""}
                onChange={(value) => setDraft({ ...draft, vault: value })}
                placeholder="E:\\Notes\\MyVault"
              />
              <TextField
                label="默认保存目录"
                value={draft.defaultFolder ?? ""}
                onChange={(value) => setDraft({ ...draft, defaultFolder: value })}
                placeholder="TabKeep Inbox"
              />
              <label className="tk-field">
                <span className="tk-label">写入模式</span>
                <select
                  className="tk-select"
                  value={draft.writeMode ?? "new_file"}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      writeMode: event.target.value as NonNullable<NoteAdapterConfig["writeMode"]>,
                    })
                  }>
                  <option value="new_file">每天目录下新建 Markdown 文件</option>
                  <option value="append">追加到选中的 Markdown 文件</option>
                </select>
              </label>
              <TextField
                label="默认目标 Markdown"
                value={draft.defaultTargetDoc ?? ""}
                onChange={(value) => setDraft({ ...draft, defaultTargetDoc: value })}
                placeholder="相对路径，可留空"
              />
            </div>
          )}

          {provider === "local" && (
            <div className="tk-muted-box">本地模式会写入后端 data/notes/inbox.md。</div>
          )}
        </div>
        <div className="tk-command-bar">
          <Button onClick={save}>保存设置</Button>
          <Button variant="secondary" onClick={test} disabled={testing}>
            {testing ? "测试中..." : "测试连接"}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setDraft(DEFAULT_NOTE_ADAPTER)
              setNotebooks([])
              setStatus(null)
            }}>
            <RotateCcw className="h-4 w-4" />
            重置
          </Button>
        </div>
      </section>

      {notebooks.length > 0 && (
        <section className="tk-panel max-w-3xl">
          <div className="tk-panel-header">
            <h2 className="tk-panel-title">{provider === "obsidian" ? "Markdown 目录" : "笔记本列表"}</h2>
            <span className="tk-badge tk-badge-success">{notebooks.length} 项</span>
          </div>
          <div className="tk-panel-body">
            <div className="grid gap-2">
              {notebooks.map((notebook) => (
                <button
                  key={notebook.id}
                  className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-left text-sm transition-colors hover:bg-slate-50"
                  onClick={() => setDraft({ ...draft, defaultNotebook: notebook.id })}>
                  <CheckCircle2 className="h-4 w-4 text-slate-400" />
                  <span className="font-medium text-slate-900">{notebook.name}</span>
                  <code className="text-xs text-muted-foreground">{notebook.id}</code>
                </button>
              ))}
            </div>
          </div>
        </section>
      )}
    </div>
  )
}

function StatusCard({
  title,
  value,
  tone,
}: {
  title: string
  value: string
  tone: "success" | "warning" | "error" | "neutral"
}) {
  const dotClass =
    tone === "success"
      ? "tk-status-dot"
      : tone === "error"
        ? "tk-status-dot tk-status-dot-error"
        : tone === "warning"
          ? "tk-status-dot tk-status-dot-warning"
          : "tk-status-dot bg-slate-300"
  const valueClass =
    tone === "success"
      ? "tk-status-value"
      : tone === "error"
        ? "tk-status-value tk-status-value-error"
        : tone === "warning"
          ? "tk-status-value tk-status-value-warning"
          : "mt-0.5 text-xs font-medium text-slate-500"

  return (
    <div className="tk-status-card">
      <span className={dotClass} />
      <div className="min-w-0">
        <p className="tk-status-title">{title}</p>
        <p className={`${valueClass} truncate`}>{value}</p>
      </div>
    </div>
  )
}

function Notice({
  children,
  tone = "neutral",
}: {
  children: string
  tone?: "success" | "warning" | "neutral"
}) {
  const className =
    tone === "success"
      ? "border-green-100 bg-green-50 text-green-700 before:bg-green-500"
      : tone === "warning"
        ? "border-amber-100 bg-amber-50 text-amber-800 before:bg-amber-500"
        : "border-blue-100 bg-blue-50 text-blue-800 before:bg-blue-500"
  return (
    <div className={`relative overflow-hidden rounded-md border px-3 py-2 pl-4 text-sm leading-6 before:absolute before:inset-y-0 before:left-0 before:w-1 before:content-[''] ${className}`}>
      {children}
    </div>
  )
}

function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost"
}) {
  const base =
    variant === "secondary"
      ? "tk-secondary-button"
      : variant === "ghost"
        ? "tk-ghost-button"
        : "tk-primary-button"
  return <button className={`${base} ${className}`} {...props} />
}

function Checkbox({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex items-center gap-3 rounded-md border border-white/70 bg-[rgb(247_250_248)] px-3 py-2 text-sm text-slate-700 ring-1 ring-slate-900/5 transition-colors hover:bg-[rgb(250_252_250)]">
      <input
        className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-100"
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  )
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  type?: string
}) {
  return (
    <label className="tk-field">
      <span className="tk-label">{label}</span>
      <input
        className="tk-input"
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </label>
  )
}

function loadTabGroupStyle(): TabGroupStyleOptions {
  try {
    const stored = localStorage.getItem(TAB_GROUP_STYLE_KEY)
    if (!stored) return DEFAULT_STYLE
    return { ...DEFAULT_STYLE, ...JSON.parse(stored) }
  } catch {
    return DEFAULT_STYLE
  }
}

function formatTranslationForPanel(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n").trim()
  if (!normalized) return ""

  if (normalized.includes("\n")) {
    return normalized
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
  }

  return normalized
    .replace(/([。！？!?；;][”’"』」】）》）]*)\s*/g, "$1\n")
    .replace(/([.][”’"』」】）》）]*)\s+(?=[A-Z0-9\u4e00-\u9fff])/g, "$1\n")
    .replace(/([:：])\s+(?=(?:[-*•]|\d+[.)、]))/g, "$1\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function buildGraphRelation(
  nodes: KnowledgeGraphNode[],
  edges: KnowledgeGraphEdge[],
): GraphRelation {
  const nodeIds = new Set(nodes.map((node) => node.id))
  const childMap = new Map<string, string[]>()
  const parentMap = new Map<string, string[]>()
  const edgeKindMap = new Map<string, string>()

  const addChild = (parentId: string, childId: string, kind: string) => {
    if (!nodeIds.has(parentId) || !nodeIds.has(childId) || parentId === childId) return
    const children = childMap.get(parentId) ?? []
    if (!children.includes(childId)) childMap.set(parentId, [...children, childId])
    const parents = parentMap.get(childId) ?? []
    if (!parents.includes(parentId)) parentMap.set(childId, [...parents, parentId])
    edgeKindMap.set(`${parentId}->${childId}`, kind)
  }

  for (const edge of edges) {
    if (edge.kind === "belongs_to_source") {
      addChild(edge.target, edge.source, edge.kind)
    } else {
      addChild(edge.source, edge.target, edge.kind)
    }
  }

  for (const [parentId, children] of childMap.entries()) {
    childMap.set(parentId, sortGraphNodeIds(children, nodes))
  }

  const sourceRoots = sortGraphNodeIds(
    nodes.filter((node) => node.kind === "source").map((node) => node.id),
    nodes,
  )
  const documentRoots = sortGraphNodeIds(
    nodes
      .filter((node) => node.kind === "document" && !(parentMap.get(node.id) ?? []).some(Boolean))
      .map((node) => node.id),
    nodes,
  )
  const fallbackDocuments = sortGraphNodeIds(
    nodes.filter((node) => node.kind === "document").map((node) => node.id),
    nodes,
  )
  const fallbackAny = sortGraphNodeIds(nodes.map((node) => node.id), nodes)
  const roots = sourceRoots.length
    ? sourceRoots
    : documentRoots.length
      ? documentRoots
      : fallbackDocuments.length
        ? fallbackDocuments
        : fallbackAny.slice(0, 12)

  return { childMap, parentMap, edgeKindMap, roots }
}

function sortGraphNodeIds(nodeIds: string[], nodes: KnowledgeGraphNode[]): string[] {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]))
  return [...nodeIds].sort((a, b) => {
    const left = nodeMap.get(a)
    const right = nodeMap.get(b)
    if (!left || !right) return a.localeCompare(b)
    return (
      graphKindSort(left.kind) - graphKindSort(right.kind) ||
      right.degree - left.degree ||
      left.label.localeCompare(right.label)
    )
  })
}

function graphKindSort(kind: string): number {
  if (kind === "source") return 0
  if (kind === "document") return 1
  if (kind === "tag") return 2
  if (kind === "heading") return 3
  if (kind === "concept") return 4
  return 5
}

function buildVisibleGraphData({
  graphResult,
  relation,
  expandedNodeIds,
  selectedNodeId,
  selectedRelationKey,
  onSelect,
  onToggle,
}: {
  graphResult: KnowledgeGraphResponse | null
  relation: GraphRelation
  expandedNodeIds: Set<string>
  selectedNodeId: string | null
  selectedRelationKey: string | null
  onSelect: (node: KnowledgeGraphNode) => void
  onToggle: (node: KnowledgeGraphNode) => void
}): { nodes: GraphFlowNode[]; edges: GraphFlowEdge[] } {
  if (!graphResult) return { nodes: [], edges: [] }
  const nodeMap = new Map(graphResult.nodes.map((node) => [node.id, node]))

  const visibleIds = new Set<string>()
  const levels = new Map<string, number>()
  const visit = (nodeId: string, depth: number, visiting = new Set<string>()) => {
    if (!nodeMap.has(nodeId)) return
    if (visiting.has(nodeId)) return
    const previousDepth = levels.get(nodeId)
    if (visibleIds.has(nodeId)) {
      if (previousDepth !== undefined && depth <= previousDepth) return
    } else {
      visibleIds.add(nodeId)
    }
    levels.set(nodeId, depth)
    if (!expandedNodeIds.has(nodeId)) return
    const nextVisiting = new Set(visiting)
    nextVisiting.add(nodeId)
    const children = relation.childMap.get(nodeId) ?? []
    for (const childId of children) visit(childId, depth + 1, nextVisiting)
  }

  for (const rootId of relation.roots) visit(rootId, 0)

  const byLevel = new Map<number, KnowledgeGraphNode[]>()
  for (const nodeId of visibleIds) {
    const node = nodeMap.get(nodeId)
    if (!node) continue
    const level = levels.get(nodeId) ?? 0
    byLevel.set(level, [...(byLevel.get(level) ?? []), node])
  }

  const visibleChildren = new Map<string, string[]>()
  for (const [parentId, children] of relation.childMap.entries()) {
    if (!visibleIds.has(parentId)) continue
    const parentLevel = levels.get(parentId) ?? 0
    const forwardChildren = children.filter((childId) => {
      if (!visibleIds.has(childId)) return false
      return (levels.get(childId) ?? 0) > parentLevel
    })
    if (forwardChildren.length > 0) {
      visibleChildren.set(parentId, sortGraphNodeIds(forwardChildren, graphResult.nodes))
    }
  }

  const rawSlots = new Map<string, number>()
  let slotCursor = 0
  const assignSlot = (nodeId: string, visiting = new Set<string>()): number => {
    const existing = rawSlots.get(nodeId)
    if (existing !== undefined) return existing
    if (visiting.has(nodeId)) {
      const cycleSlot = slotCursor
      slotCursor += 1
      rawSlots.set(nodeId, cycleSlot)
      return cycleSlot
    }

    const children = visibleChildren.get(nodeId) ?? []
    if (!expandedNodeIds.has(nodeId) || children.length === 0) {
      const leafSlot = slotCursor
      slotCursor += 1
      rawSlots.set(nodeId, leafSlot)
      return leafSlot
    }

    const nextVisiting = new Set(visiting)
    nextVisiting.add(nodeId)
    const childSlots = children.map((childId) => assignSlot(childId, nextVisiting))
    const branchSlot = childSlots.reduce((sum, slot) => sum + slot, 0) / childSlots.length
    rawSlots.set(nodeId, branchSlot)
    return branchSlot
  }

  const orderedRoots = sortGraphNodeIds(relation.roots.filter((rootId) => visibleIds.has(rootId)), graphResult.nodes)
  for (const rootId of orderedRoots) assignSlot(rootId)
  for (const nodeId of visibleIds) assignSlot(nodeId)

  const selectedNeighborhood = new Set<string>()
  if (selectedNodeId) {
    selectedNeighborhood.add(selectedNodeId)
    for (const childId of relation.childMap.get(selectedNodeId) ?? []) selectedNeighborhood.add(childId)
    for (const parentId of relation.parentMap.get(selectedNodeId) ?? []) selectedNeighborhood.add(parentId)
  }

  const adjustedSlots = new Map<string, number>()
  for (const [, levelNodes] of [...byLevel.entries()].sort(([left], [right]) => left - right)) {
    const ordered = sortGraphNodeIds(levelNodes.map((node) => node.id), graphResult.nodes)
      .map((nodeId) => nodeMap.get(nodeId))
      .filter((node): node is KnowledgeGraphNode => Boolean(node))
      .sort((left, right) => {
        const slotDelta = (rawSlots.get(left.id) ?? 0) - (rawSlots.get(right.id) ?? 0)
        if (slotDelta !== 0) return slotDelta
        return graphKindSort(left.kind) - graphKindSort(right.kind) || left.label.localeCompare(right.label, "zh-Hans-CN")
      })

    let previousSlot = -1
    for (const node of ordered) {
      const slot = Math.max(rawSlots.get(node.id) ?? 0, previousSlot + 1)
      adjustedSlots.set(node.id, slot)
      previousSlot = slot
    }
  }
  const minSlot = adjustedSlots.size > 0 ? Math.min(...adjustedSlots.values()) : 0

  const nodes: GraphFlowNode[] = []
  for (const [level, levelNodes] of [...byLevel.entries()].sort(([left], [right]) => left - right)) {
    const ordered = sortGraphNodeIds(levelNodes.map((node) => node.id), graphResult.nodes)
      .map((nodeId) => nodeMap.get(nodeId))
      .filter((node): node is KnowledgeGraphNode => Boolean(node))
      .sort((left, right) => (adjustedSlots.get(left.id) ?? 0) - (adjustedSlots.get(right.id) ?? 0))
    ordered.forEach((node, index) => {
      const childCount = relation.childMap.get(node.id)?.length ?? 0
      const ySlot = adjustedSlots.get(node.id) ?? index
      nodes.push({
        id: node.id,
        type: "knowledgeMap",
        position: {
          x: GRAPH_NODE_X + level * GRAPH_COLUMN_WIDTH,
          y: GRAPH_NODE_Y + (ySlot - minSlot) * GRAPH_ROW_HEIGHT,
        },
        data: {
          graphNode: node,
          childCount,
          expanded: expandedNodeIds.has(node.id),
          selected: selectedNodeId === node.id,
          relatedToSelected: !selectedNodeId || selectedNeighborhood.has(node.id),
          isLeaf: childCount === 0,
          onSelect,
          onToggle,
        },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        draggable: false,
        selectable: true,
      })
    })
  }

  let visibleEdgeCount = 0
  for (const [parentId, children] of relation.childMap.entries()) {
    if (!visibleIds.has(parentId)) continue
    visibleEdgeCount += children.filter((childId) => visibleIds.has(childId)).length
  }
  const showAllEdgeLabels = visibleEdgeCount <= GRAPH_EDGE_LABEL_LIMIT

  const edges: GraphFlowEdge[] = []
  for (const [parentId, children] of relation.childMap.entries()) {
    if (!visibleIds.has(parentId)) continue
    for (const childId of children) {
      if (!visibleIds.has(childId)) continue
      const kind = relation.edgeKindMap.get(`${parentId}->${childId}`) ?? "related"
      const color = graphEdgeColor(kind)
      const connectsSelected = selectedNodeId === parentId || selectedNodeId === childId
      const edgeKey = `${parentId}->${childId}:${kind}`
      const selectedEdge = selectedRelationKey === edgeKey
      const dimmed = Boolean(selectedNodeId && !connectsSelected)
      const showLabel = showAllEdgeLabels || connectsSelected || selectedEdge
      edges.push({
        id: `flow:${parentId}->${childId}:${kind}`,
        source: parentId,
        target: childId,
        type: "smoothstep",
        data: { kind },
        label: showLabel ? formatGraphEdgeKind(kind) : undefined,
        labelStyle: { fill: dimmed ? "#94a3b8" : "#475569", fontSize: 11, fontWeight: 600 },
        labelBgPadding: [6, 4],
        labelBgBorderRadius: 4,
        labelBgStyle: { fill: "#ffffff", fillOpacity: 0.88 },
        animated: selectedEdge || connectsSelected || expandedNodeIds.has(parentId),
        selected: selectedEdge,
        style: {
          stroke: color,
          strokeWidth: selectedEdge ? 3.4 : connectsSelected ? 2.6 : 1.6,
          opacity: selectedEdge ? 1 : dimmed ? 0.28 : 0.9,
        },
        markerEnd: { type: MarkerType.ArrowClosed, color },
      })
    }
  }

  return { nodes, edges }
}

function collapseGraphBranch(
  nodeId: string,
  expandedNodeIds: Set<string>,
  childMap: Map<string, string[]>,
  visited = new Set<string>(),
) {
  if (visited.has(nodeId)) return
  visited.add(nodeId)
  expandedNodeIds.delete(nodeId)
  for (const childId of childMap.get(nodeId) ?? []) {
    collapseGraphBranch(childId, expandedNodeIds, childMap, visited)
  }
}

function KnowledgeMapNode({ data }: NodeProps<GraphFlowNode>) {
  const node = data.graphNode
  const color = graphNodeColor(node.kind)
  const label = node.label.length > 42 ? `${node.label.slice(0, 41)}...` : node.label

  if (data.isLeaf) {
    return (
      <button
        className={`relative flex h-24 w-24 items-center justify-center rounded-full border-2 bg-white px-3 text-center text-xs font-semibold leading-4 shadow-sm transition-colors ${
          data.selected ? "ring-4 ring-blue-100" : "hover:bg-slate-50"
        } ${data.relatedToSelected ? "" : "opacity-40"}`}
        style={{ borderColor: color, color }}
        title={node.label}
        onClick={() => data.onSelect(node)}>
        <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-0 !bg-slate-300" />
        <span className="line-clamp-3">{label}</span>
      </button>
    )
  }

  return (
    <div
      className={`relative w-56 rounded-md border bg-white p-3 shadow-sm transition-colors ${
        data.selected ? "ring-4 ring-blue-100" : "hover:bg-slate-50"
      } ${data.relatedToSelected ? "" : "opacity-40"}`}
      style={{ borderColor: data.selected ? color : "#e2e8f0" }}>
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-0 !bg-slate-300" />
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-0 !bg-slate-300" />
      <button className="block w-full text-left" title={node.label} onClick={() => data.onSelect(node)}>
        <div className="mb-2 flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
          <span className="tk-badge">{formatGraphNodeKind(node.kind)}</span>
        </div>
        <div className="line-clamp-2 text-sm font-semibold leading-5 text-slate-900">{label}</div>
        <div className="mt-2 text-xs text-muted-foreground">
          {data.childCount} 个子节点 · 连接度 {node.degree}
        </div>
      </button>
      <button
        className="nodrag nopan mt-3 inline-flex h-7 items-center rounded-md border border-slate-200 px-2 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100"
        onClick={(event) => {
          event.stopPropagation()
          data.onToggle(node)
        }}>
        {data.expanded ? "收起" : "展开"}
      </button>
    </div>
  )
}

function GraphRelationList({
  title,
  items,
  onSelect,
}: {
  title: string
  items: GraphNodeRelation[]
  onSelect: (node: KnowledgeGraphNode) => void
}) {
  return (
    <div>
      <h4 className="mb-2 text-xs font-semibold text-slate-700">{title}</h4>
      <div className="grid max-h-44 gap-2 overflow-auto pr-1">
        {items.map((item) => (
          <button
            key={`${item.kind}:${item.node.id}`}
            className="rounded-md border border-slate-200 px-3 py-2 text-left text-sm transition-colors hover:border-blue-200 hover:bg-blue-50/40"
            onClick={() => onSelect(item.node)}>
            <div className="flex items-center gap-2">
              <span
                className="h-2 w-4 rounded-full"
                style={{ backgroundColor: graphEdgeColor(item.kind) }}
              />
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: graphNodeColor(item.node.kind) }}
              />
              <span className="min-w-0 flex-1 truncate font-medium text-slate-900">
                {item.node.label}
              </span>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {formatGraphEdgeKind(item.kind)} · {formatGraphNodeKind(item.node.kind)}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

function graphMiniMapNodeColor(node: Node): string {
  const graphNode = (node.data as Partial<GraphFlowNodeData> | undefined)?.graphNode
  return graphNode ? graphNodeColor(graphNode.kind) : "#64748b"
}

function graphNodeRelations(
  nodeId: string | null,
  graphResult: KnowledgeGraphResponse | null,
  relation: GraphRelation,
  direction: "in" | "out",
): GraphNodeRelation[] {
  if (!nodeId || !graphResult) return []
  const nodeMap = new Map(graphResult.nodes.map((node) => [node.id, node]))
  const ids = direction === "out" ? relation.childMap.get(nodeId) ?? [] : relation.parentMap.get(nodeId) ?? []
  return ids
    .map((id) => {
      const node = nodeMap.get(id)
      if (!node) return null
      const kind =
        direction === "out"
          ? relation.edgeKindMap.get(`${nodeId}->${id}`) ?? "related"
          : relation.edgeKindMap.get(`${id}->${nodeId}`) ?? "related"
      return { node, kind }
    })
    .filter((item): item is GraphNodeRelation => Boolean(item))
}

function graphNodePath(
  nodeId: string | null,
  graphResult: KnowledgeGraphResponse | null,
  relation: GraphRelation,
): KnowledgeGraphNode[] {
  if (!nodeId || !graphResult) return []
  const nodeMap = new Map(graphResult.nodes.map((node) => [node.id, node]))
  const pathIds = [nodeId]
  const visited = new Set(pathIds)
  let currentId = nodeId

  for (let depth = 0; depth < 8; depth += 1) {
    const parents = sortGraphNodeIds(relation.parentMap.get(currentId) ?? [], graphResult.nodes)
    const nextParentId = parents.find((parentId) => !visited.has(parentId))
    if (!nextParentId) break
    pathIds.unshift(nextParentId)
    visited.add(nextParentId)
    currentId = nextParentId
  }

  return pathIds.map((id) => nodeMap.get(id)).filter((node): node is KnowledgeGraphNode => Boolean(node))
}

function graphNodeKindStats(nodes: KnowledgeGraphNode[]): Record<string, number> {
  return nodes.reduce<Record<string, number>>((acc, node) => {
    acc[node.kind] = (acc[node.kind] ?? 0) + 1
    return acc
  }, {})
}

function graphEdgeKindStats(edges: KnowledgeGraphEdge[]): Record<string, number> {
  return edges.reduce<Record<string, number>>((acc, edge) => {
    acc[edge.kind] = (acc[edge.kind] ?? 0) + 1
    return acc
  }, {})
}

function graphNodeColor(kind: string): string {
  if (kind === "document") return "#2563eb"
  if (kind === "source") return "#0f766e"
  if (kind === "tag") return "#7c3aed"
  if (kind === "heading") return "#d97706"
  if (kind === "concept") return "#dc2626"
  return "#64748b"
}

function graphEdgeColor(kind: string): string {
  if (kind === "belongs_to_source") return "rgba(15, 118, 110, 0.42)"
  if (kind === "links_to_document") return "rgba(37, 99, 235, 0.5)"
  if (kind === "has_tag") return "rgba(124, 58, 237, 0.42)"
  if (kind === "has_heading") return "rgba(217, 119, 6, 0.36)"
  if (kind === "mentions_concept") return "rgba(220, 38, 38, 0.36)"
  return "rgba(100, 116, 139, 0.35)"
}

function formatGraphEdgeKind(kind: string): string {
  if (kind === "belongs_to_source") return "来源"
  if (kind === "links_to_document") return "双链"
  if (kind === "has_tag") return "标签"
  if (kind === "has_heading") return "标题"
  if (kind === "mentions_concept") return "提及"
  return "关联"
}

function formatGraphNodeKind(kind: string): string {
  if (kind === "document") return "文档"
  if (kind === "source") return "来源"
  if (kind === "tag") return "标签"
  if (kind === "heading") return "标题"
  if (kind === "concept") return "概念"
  return kind || "节点"
}

function formatCompactDate(value: string): string {
  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}

function formatSiyuanSyncStatus(result: KnowledgeSiyuanSyncResponse): string {
  const base = `SiYuan 同步${result.ok ? "完成" : "完成但有错误"}：扫描 ${result.notebooksScanned} 个笔记本，发现 ${result.documentsFound} 篇文档，更新 ${result.documentsIndexed} 篇，跳过 ${result.documentsSkipped} 篇`
  if (result.errors.length === 0) return base
  return `${base}；${result.errors.slice(0, 2).join("；")}`
}

function sourceTarget(item: KnowledgeCitation): string {
  return item.url || item.path || ""
}

function graphNodeTarget(item: KnowledgeGraphNode): string {
  return item.url || item.path || ""
}

function topicDocumentTarget(item: KnowledgeTopicDocument): string {
  return item.url || item.path || ""
}

function topicDocumentOpenTarget(item: KnowledgeTopicDocument, noteAdapter?: NoteAdapterConfig): string {
  if (item.sourceType === "markdown" && item.path && noteAdapter?.provider === "obsidian" && noteAdapter.vault) {
    const obsidianTarget = obsidianOpenUri(item.path, noteAdapter.vault, item.anchor)
    if (obsidianTarget) return obsidianTarget
  }
  return topicDocumentTarget(item)
}

function obsidianOpenUri(path: string, vault: string, anchor?: string | null): string {
  const normalizedPath = normalizeLocalPath(path)
  const normalizedVault = normalizeLocalPath(vault).replace(/\/+$/, "")
  if (!normalizedPath || !normalizedVault) return ""

  const lowerPath = normalizedPath.toLowerCase()
  const lowerVault = normalizedVault.toLowerCase()
  if (lowerPath !== lowerVault && !lowerPath.startsWith(`${lowerVault}/`)) return ""

  const vaultName = normalizedVault.split("/").filter(Boolean).pop()
  const relativeFile = normalizedPath.slice(normalizedVault.length).replace(/^\/+/, "").replace(/\.md$/i, "")
  if (!vaultName || !relativeFile) return ""
  const target = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(relativeFile)}`
  return anchor ? `${target}&heading=${encodeURIComponent(anchor)}` : target
}

function normalizeLocalPath(value: string): string {
  return value.trim().replace(/\\/g, "/")
}

function formatTopicOpenTitle(item: KnowledgeTopicDocument, noteAdapter?: NoteAdapterConfig): string {
  if (item.sourceType === "siyuan") return "在 SiYuan 中打开"
  if (item.sourceType === "markdown" && noteAdapter?.provider === "obsidian") {
    return item.anchor ? `在 Obsidian 中打开到标题：${item.anchor}` : "在 Obsidian 中打开"
  }
  if (item.url) return "打开网页来源"
  return "打开笔记来源"
}

async function openCitationSource(
  item: KnowledgeCitation,
  onStatus?: (message: string) => void,
): Promise<void> {
  const target = sourceTarget(item)
  if (!target) {
    onStatus?.("这个来源没有可打开的路径")
    return
  }
  try {
    await openExternalTarget(target)
    onStatus?.("已打开来源")
  } catch (err) {
    onStatus?.(`打开来源失败: ${errorMessage(err)}`)
  }
}

async function openGraphNodeSource(
  item: KnowledgeGraphNode,
  onStatus?: (message: string) => void,
): Promise<void> {
  const target = graphNodeTarget(item)
  if (!target) {
    onStatus?.("这个节点没有可打开的来源")
    return
  }
  try {
    await openExternalTarget(target)
    onStatus?.("已打开来源")
  } catch (err) {
    onStatus?.(`打开来源失败: ${errorMessage(err)}`)
  }
}

async function openTopicDocumentSource(
  item: KnowledgeTopicDocument,
  onStatus?: (message: string) => void,
  noteAdapter?: NoteAdapterConfig,
): Promise<void> {
  const target = topicDocumentOpenTarget(item, noteAdapter)
  if (!target) {
    onStatus?.("这篇笔记没有可打开的来源")
    return
  }
  try {
    await openExternalTarget(target)
    onStatus?.("已打开来源")
  } catch (err) {
    onStatus?.(`打开来源失败: ${errorMessage(err)}`)
  }
}

async function copyCitationSource(
  item: KnowledgeCitation,
  onStatus?: (message: string) => void,
): Promise<void> {
  const target = sourceTarget(item) || item.documentId
  try {
    await navigator.clipboard.writeText(target)
    onStatus?.("来源已复制")
  } catch (err) {
    onStatus?.(`复制来源失败: ${errorMessage(err)}`)
  }
}

async function copyGraphNodeSource(
  item: KnowledgeGraphNode,
  onStatus?: (message: string) => void,
): Promise<void> {
  const target = graphNodeTarget(item) || item.label || item.id
  try {
    await navigator.clipboard.writeText(target)
    onStatus?.("节点信息已复制")
  } catch (err) {
    onStatus?.(`复制失败: ${errorMessage(err)}`)
  }
}

async function copyTopicDocumentSource(
  item: KnowledgeTopicDocument,
  onStatus?: (message: string) => void,
): Promise<void> {
  const target = topicDocumentTarget(item) || item.title || item.documentId
  try {
    await navigator.clipboard.writeText(target)
    onStatus?.("来源已复制")
  } catch (err) {
    onStatus?.(`复制来源失败: ${errorMessage(err)}`)
  }
}

function formatSourceType(value: string): string {
  if (value === "siyuan") return "SiYuan"
  if (value === "markdown") return "Markdown"
  if (value === "tabkeep_note") return "TabKeep"
  return value || "来源"
}

function formatTopicEvidenceKind(value: string): string {
  if (value === "tag") return "标签"
  if (value === "wikilink") return "双链"
  if (value === "heading") return "标题"
  if (value === "path") return "路径"
  if (value === "embedding") return "语义相似"
  if (value === "fallback") return "兜底"
  return value || "证据"
}

function errorMessage(err: unknown): string {
  if (err instanceof BackendRequestError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}

export default App
