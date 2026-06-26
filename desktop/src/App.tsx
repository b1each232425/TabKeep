import { useEffect, useState } from "react"
import type { MouseEvent } from "react"
import { getCurrentWindow } from "@tauri-apps/api/window"
import type { LucideIcon } from "lucide-react"
import {
  BookOpen,
  Brain,
  ChartNetwork,
  Database,
  Folder,
  Languages,
  LayoutDashboard,
  PlugZap,
  RefreshCw,
  Settings2,
} from "lucide-react"
import {
  BackendRequestError,
  DEFAULT_MODEL_CONFIG,
  DEFAULT_NOTE_ADAPTER,
  backendRequest,
  checkBackendHealth,
  clearCachedApiToken,
  getCachedApiToken,
  getDesktopStatus,
  loadBackendConfig,
  setCachedApiToken,
} from "./api"
import type {
  DesktopStatus,
  ModelConfig,
  NoteAdapterConfig,
  TabCategory,
  TabData,
} from "./types"
import { Button } from "./components/primitives"
import { errorMessage } from "./lib/errors"
import { KnowledgeGraphSection } from "./sections/KnowledgeGraphSection"
import { KnowledgeSection } from "./sections/KnowledgeSection"
import { NotesSection } from "./sections/NotesSection"
import { OcrDebugSection } from "./sections/OcrDebugSection"
import {
  CaptureOverlay,
  OcrResultWindow,
  RegionBoxWindow,
  RegionPanelWindow,
  SelectionPanelWindow,
} from "./sections/OcrWindows"
import { OverviewSection } from "./sections/OverviewSection"
import { CategoriesSection, ModelApiSection } from "./sections/SettingsSections"
import { TranslateSection } from "./sections/TranslateSection"
import { VectorDebugSection } from "./sections/VectorDebugSection"

type Section =
  | "overview"
  | "translate"
  | "knowledge"
  | "graph"
  | "categories"
  | "modelApi"
  | "notes"
  | "vectorDebug"
  | "ocrDebug"
const importMetaEnv = (import.meta as ImportMeta & {
  env?: Record<string, string | boolean | undefined>
}).env
const SHOW_OCR_DEBUG =
  importMetaEnv?.DEV === true || importMetaEnv?.VITE_TABKEEP_SHOW_OCR_DEBUG === "true"

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
  const debugNavItems: { id: Section; label: string; icon: LucideIcon }[] = [
    { id: "vectorDebug", label: "向量库", icon: Database },
  ]
  if (SHOW_OCR_DEBUG) {
    debugNavItems.push({ id: "ocrDebug", label: "OCR 调试", icon: Settings2 })
  }

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
        {section === "vectorDebug" && <VectorDebugSection />}
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

export default App
