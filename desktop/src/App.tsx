import { useEffect, useMemo, useRef, useState } from "react"
import type { ButtonHTMLAttributes, MouseEvent } from "react"
import { listen } from "@tauri-apps/api/event"
import { getCurrentWindow } from "@tauri-apps/api/window"
import type { LucideIcon } from "lucide-react"
import {
  BookOpen,
  Brain,
  Camera,
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
  closeRegionBox,
  finishScreenSelection,
  getCachedApiToken,
  getDesktopStatus,
  getKnowledgeConfig,
  getKnowledgeStats,
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
  KnowledgeSearchResponse,
  KnowledgeStats,
  KnowledgeSiyuanPrecheckResponse,
  KnowledgeSiyuanSyncResponse,
  ModelConfig,
  NoteAdapterConfig,
  NotebookInfo,
  NotesTestResponse,
  OcrConfig,
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

type Section = "overview" | "translate" | "knowledge" | "categories" | "modelApi" | "notes"
type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West"

const TAB_GROUP_STYLE_KEY = "tabkeep.desktop.tabGroupStyle"

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
    { id: "categories", label: "分组", icon: Folder },
    { id: "modelApi", label: "模型 API", icon: Brain },
    { id: "notes", label: "笔记集成", icon: BookOpen },
  ]

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
    <div className="tk-desktop-shell">
      <aside className="tk-sidebar">
        <div>
          <div className="tk-wordmark">
            Tab<span className="tk-wordmark-accent">Keep</span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Desktop Companion</p>
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
      </main>
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
          title="桌面伴侣"
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
              打开扩展 popup 或设置页后，桌面伴侣会自动缓存扩展传来的 token。
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
            重置为 Windows OCR
          </Button>
        </div>
      </section>

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
      if (payload.phase !== "translate") {
        setBusy(null)
      }
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

  const updateConfig = async (partial: Partial<RegionBoxConfig>) => {
    if (config.passThrough) return
    try {
      const next = await setRegionBoxConfig({ ...configRef.current, ...partial })
      configRef.current = next
      setConfig(next)
    } catch (err) {
      setNotice(errorMessage(err))
    }
  }

  const togglePassthrough = async () => {
    if (config.passThrough) return
    try {
      const next = await setRegionBoxPassthrough(true)
      configRef.current = next
      setConfig(next)
      setNotice("区域框已穿透")
    } catch (err) {
      setNotice(errorMessage(err))
    }
  }

  const runTranslate = async () => {
    if (config.passThrough) return
    setBusy("translate")
    setNotice("正在识别并翻译区域...")
    try {
      const value = await runRegionTranslate()
      setNotice(value.message ?? (value.ok ? "翻译完成" : value.error ?? "翻译未完成"))
    } catch (err) {
      setNotice(errorMessage(err))
    } finally {
      setBusy(null)
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
      {!config.passThrough && (
        <div
          className="tk-region-edge-toolbar"
          onMouseDown={(event) => {
            event.stopPropagation()
          }}>
          <select
            className="tk-select tk-region-edge-select"
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
            className="tk-select tk-region-edge-select"
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
            穿透
          </Button>
          <button className="tk-icon-button" onClick={closeRegion} title="关闭固定翻译框">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
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
    listen<OcrFlowResult>("region-result-updated", (event) => {
      setResult(event.payload)
      setNotice(event.payload.message ?? (event.payload.ok ? "完成" : event.payload.error ?? "未完成"))
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

  const translationText =
    result?.translatedText ||
    (result?.error ? `翻译失败: ${result.error}` : "等待译文")
  const formattedTranslationText = result?.translatedText
    ? formatTranslationForPanel(result.translatedText)
    : translationText

  return (
    <div className="tk-region-panel tk-region-translation-panel">
      <div
        className="tk-region-panel-toolbar tk-region-panel-dragbar"
        onMouseDown={startPanelDrag}
        title="按住拖动译文窗口">
        <div className="tk-region-result-title-inline">
          <Languages className="h-4 w-4 text-blue-600" />
          <span>译文{result?.model ? ` · ${result.model}` : ""}</span>
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
        {formattedTranslationText}
      </pre>
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
      <div>
        <p className="tk-status-title">{title}</p>
        <p className={valueClass}>{value}</p>
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
      ? "border-green-100 bg-green-50 text-green-700"
      : tone === "warning"
        ? "border-amber-100 bg-amber-50 text-amber-800"
        : "border-blue-100 bg-blue-50 text-blue-800"
  return <div className={`rounded-md border px-3 py-2 text-sm ${className}`}>{children}</div>
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
    <label className="flex items-center gap-2 text-sm text-slate-700">
      <input
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

function formatSourceType(value: string): string {
  if (value === "siyuan") return "SiYuan"
  if (value === "markdown") return "Markdown"
  if (value === "tabkeep_note") return "TabKeep"
  return value || "来源"
}

function errorMessage(err: unknown): string {
  if (err instanceof BackendRequestError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}

export default App
