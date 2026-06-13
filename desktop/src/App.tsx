import { useEffect, useMemo, useState } from "react"
import type { ButtonHTMLAttributes } from "react"
import type { LucideIcon } from "lucide-react"
import {
  BookOpen,
  Brain,
  CheckCircle2,
  Folder,
  LayoutDashboard,
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
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
  syncConfigToBackend,
} from "./api"
import type {
  ClassifyResponse,
  DesktopStatus,
  ModelConfig,
  NoteAdapterConfig,
  NotebookInfo,
  NotesTestResponse,
  TabCategory,
  TabData,
  TabGroupColor,
  TabGroupStyleOptions,
} from "./types"
import { groupTabsByDomain } from "./utils"

type Section = "overview" | "categories" | "modelApi" | "notes"

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

function errorMessage(err: unknown): string {
  if (err instanceof BackendRequestError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}

export default App
