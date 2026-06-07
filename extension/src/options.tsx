import { useEffect, useState } from "react"
import {
  BookOpen,
  Brain,
  CheckCircle2,
  Folder,
  LayoutDashboard,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2
} from "lucide-react"
import type {
  ModelConfig,
  NoteAdapterConfig,
  NotebookInfo,
  TabCategory,
  TabData,
  TabGroupColor,
  TabGroupStyleOptions
} from "./types"
import { groupTabsByDomain } from "./utils/tabUtils"
import { loadFromIDB } from "./utils/indexedDB"
import { Button } from "./components/ui/button"
import "./style.css"

const BACKEND_URL = "http://127.0.0.1:38471"

/**
 * 把已修改的字段增量同步到后端。
 * 后端用 Pydantic model_fields_set 判断"前端是否传了这个字段"——未传则保留原值,
 * 避免在保存 modelConfig 时把 tabCategories 清空。
 */
const syncConfigToBackend = async (partial: {
  modelConfig?: ModelConfig
  tabCategories?: TabCategory[]
  noteAdapter?: NoteAdapterConfig
}) => {
  const body: Record<string, unknown> = {}
  if (partial.modelConfig !== undefined) body.modelConfig = partial.modelConfig
  if (partial.tabCategories !== undefined) body.tabCategories = partial.tabCategories
  if (partial.noteAdapter !== undefined) body.noteAdapter = partial.noteAdapter
  try {
    const res = await fetch(`${BACKEND_URL}/config/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
    const data = await res.json()
    if (!data.ok) {
      console.warn("[TabKeep] 同步配置到后端失败：", data)
    }
  } catch (err) {
    console.warn("[TabKeep] 同步配置到后端异常：", err)
  }
}

const COLORS: TabGroupColor[] = [
  "grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"
]
const COLOR_LABEL: Record<TabGroupColor, string> = {
  grey: "灰色", blue: "蓝色", red: "红色", yellow: "黄色", green: "绿色",
  pink: "粉色", purple: "紫色", cyan: "青色", orange: "橙色"
}

const DEFAULT_STYLE: TabGroupStyleOptions = {
  defaultColor: "blue",
  useDomainAsTitle: true,
  collapsedByDefault: false
}

const DEFAULT_MODEL_CONFIG: ModelConfig = {
  model: "",
  baseURL: "",
  apiKey: ""
}

type Section = "overview" | "categories" | "modelApi" | "notes"

function OverviewSection() {
  const [tabs, setTabs] = useState<TabData[]>([])
  const [loading, setLoading] = useState(true)
  const [style, setStyle] = useState<TabGroupStyleOptions>(DEFAULT_STYLE)
  const [saved, setSaved] = useState(false)

  const loadData = async () => {
    setLoading(true)
    const data = await loadFromIDB<TabData>()
    if (data) setTabs(data)

    const stored = await chrome.storage.local.get("tabGroupStyle")
    if (stored.tabGroupStyle) {
      setStyle({ ...DEFAULT_STYLE, ...stored.tabGroupStyle })
    }
    setLoading(false)
  }

  useEffect(() => {
    loadData()
  }, [])

  const groupedTabs = groupTabsByDomain(tabs)
  const groupableCount = groupedTabs.reduce(
    (sum, g) => sum + (g.tabs.length >= 2 ? g.tabs.length : 0),
    0
  )

  const saveStyle = async () => {
    await chrome.storage.local.set({ tabGroupStyle: style })
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  const triggerGroup = () => {
    chrome.runtime.sendMessage({ type: "CREATE_TAB_GROUPS", style })
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">概览</h1>
        <Button size="sm" variant="outline" onClick={loadData} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />
          刷新
        </Button>
      </header>

      <section className="grid grid-cols-3 gap-4">
        <div className="border border-border rounded-lg p-4">
          <p className="text-xs text-muted-foreground">标签页总数</p>
          <p className="text-2xl font-semibold mt-1">{tabs.length}</p>
        </div>
        <div className="border border-border rounded-lg p-4">
          <p className="text-xs text-muted-foreground">域名数量</p>
          <p className="text-2xl font-semibold mt-1">{groupedTabs.length}</p>
        </div>
        <div className="border border-border rounded-lg p-4">
          <p className="text-xs text-muted-foreground">可分组标签</p>
          <p className="text-2xl font-semibold mt-1">{groupableCount}</p>
        </div>
      </section>

      <section className="border border-border rounded-lg p-4 space-y-4">
        <h2 className="text-lg font-medium">Tab Group 默认样式</h2>

        <div>
          <label className="text-sm text-muted-foreground block mb-1">默认颜色</label>
          <select
            className="w-40 h-9 px-2 rounded-md border border-input bg-background text-sm"
            value={style.defaultColor}
            onChange={(e) =>
              setStyle({ ...style, defaultColor: e.target.value as TabGroupColor })
            }>
            {COLORS.map((c) => (
              <option key={c} value={c}>
                {COLOR_LABEL[c]}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={style.useDomainAsTitle}
              onChange={(e) =>
                setStyle({ ...style, useDomainAsTitle: e.target.checked })
              }
            />
            使用域名作为分组标题
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={style.collapsedByDefault}
              onChange={(e) =>
                setStyle({ ...style, collapsedByDefault: e.target.checked })
              }
            />
            默认折叠分组
          </label>
        </div>

        <div className="flex items-center gap-2 pt-2">
          <Button size="sm" onClick={saveStyle}>
            {saved ? "已保存" : "保存设置"}
          </Button>
          <Button size="sm" variant="outline" onClick={triggerGroup}>
            立即对当前窗口分组
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setStyle(DEFAULT_STYLE)
            }}>
            <RotateCcw className="h-4 w-4 mr-1" />
            重置
          </Button>
        </div>
      </section>

      <section className="border border-border rounded-lg p-4">
        <h2 className="text-lg font-medium mb-3">域名分布</h2>
        {loading ? (
          <p className="text-sm text-muted-foreground">加载中...</p>
        ) : groupedTabs.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无标签页数据</p>
        ) : (
          <div className="space-y-1">
            {groupedTabs.map((group) => (
              <div
                key={group.domain}
                className="flex items-center gap-2 text-sm py-1">
                <span className="flex-1 truncate">{group.domain}</span>
                <span className="text-xs text-muted-foreground">
                  {group.tabs.length} 个
                  {group.tabs.length >= 2 ? "（可分组）" : ""}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function ModelApiSection() {
  const [config, setConfig] = useState<ModelConfig>(DEFAULT_MODEL_CONFIG)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    chrome.storage.local.get("modelConfig").then((stored) => {
      if (stored.modelConfig) {
        setConfig({ ...DEFAULT_MODEL_CONFIG, ...stored.modelConfig })
      }
    })
  }, [])

  const save = async () => {
    await chrome.storage.local.set({ modelConfig: config })
    syncConfigToBackend({ modelConfig: config })
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  const reset = () => {
    setConfig(DEFAULT_MODEL_CONFIG)
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">模型 API</h1>
        <p className="text-sm text-muted-foreground mt-1">
          为后续接入大模型模块准备，配置后会在调用 LLM 时使用
        </p>
      </header>

      <section className="border border-border rounded-lg p-4 space-y-4 max-w-xl">
        <div>
          <label className="text-sm text-muted-foreground block mb-1">
            模型名
          </label>
          <input
            type="text"
            className="w-full h-9 px-2 rounded-md border border-input bg-background text-sm"
            placeholder="gpt-4 / claude-3-5-sonnet"
            value={config.model}
            onChange={(e) => setConfig({ ...config, model: e.target.value })}
          />
        </div>

        <div>
          <label className="text-sm text-muted-foreground block mb-1">
            BaseURL
          </label>
          <input
            type="text"
            className="w-full h-9 px-2 rounded-md border border-input bg-background text-sm"
            placeholder="https://api.openai.com/v1"
            value={config.baseURL}
            onChange={(e) => setConfig({ ...config, baseURL: e.target.value })}
          />
        </div>

        <div>
          <label className="text-sm text-muted-foreground block mb-1">
            API Key
          </label>
          <input
            type="password"
            className="w-full h-9 px-2 rounded-md border border-input bg-background text-sm"
            placeholder="sk-..."
            value={config.apiKey}
            onChange={(e) => setConfig({ ...config, apiKey: e.target.value })}
          />
        </div>

        <div className="flex items-center gap-2 pt-2">
          <Button size="sm" onClick={save}>
            {saved ? "已保存" : "保存设置"}
          </Button>
          <Button size="sm" variant="ghost" onClick={reset}>
            <RotateCcw className="h-4 w-4 mr-1" />
            重置
          </Button>
        </div>
      </section>
    </div>
  )
}

function CategoriesSection() {
  const [savedCategories, setSavedCategories] = useState<TabCategory[]>([])
  const [draftCategories, setDraftCategories] = useState<TabCategory[]>([])
  const [saved, setSaved] = useState(false)
  const [classifying, setClassifying] = useState(false)
  const [newName, setNewName] = useState("")
  const [newDescription, setNewDescription] = useState("")
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState("")
  const [editDescription, setEditDescription] = useState("")

  useEffect(() => {
    chrome.storage.local.get("tabCategories").then((stored) => {
      const list: TabCategory[] = Array.isArray(stored.tabCategories)
        ? stored.tabCategories
        : []
      setSavedCategories(list)
      setDraftCategories(list)
    })
  }, [])

  const save = async () => {
    await chrome.storage.local.set({ tabCategories: draftCategories })
    syncConfigToBackend({ tabCategories: draftCategories })
    setSavedCategories(draftCategories)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  const reset = () => {
    setDraftCategories(savedCategories)
    setNewName("")
    setNewDescription("")
    setEditingId(null)
  }

  const addCategory = () => {
    const name = newName.trim()
    if (!name) return
    setDraftCategories([
      ...draftCategories,
      { id: Date.now().toString(), name, description: newDescription.trim() || undefined }
    ])
    setNewName("")
    setNewDescription("")
  }

  const startEdit = (cat: TabCategory) => {
    setEditingId(cat.id)
    setEditName(cat.name)
    setEditDescription(cat.description ?? "")
  }

  const commitEdit = () => {
    const name = editName.trim()
    if (!name) return
    setDraftCategories(
      draftCategories.map((c) =>
        c.id === editingId
          ? { ...c, name, description: editDescription.trim() || undefined }
          : c
      )
    )
    setEditingId(null)
  }

  const cancelEdit = () => {
    setEditingId(null)
  }

  const removeCategory = (cat: TabCategory) => {
    if (!window.confirm(`确认删除「${cat.name}」？`)) return
    setDraftCategories(draftCategories.filter((c) => c.id !== cat.id))
    if (editingId === cat.id) setEditingId(null)
  }

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">分组</h1>
          <p className="text-sm text-muted-foreground mt-1">
            自定义分组类别（暂未对接实际分类逻辑）
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={classifying}
            onClick={async () => {
              setClassifying(true)
              try {
                await chrome.runtime.sendMessage({ type: "CLASSIFY_TABS" })
              } finally {
                setClassifying(false)
              }
            }}>
            <Sparkles className="h-4 w-4 mr-1" />
            {classifying ? "分类中..." : "AI 分组测试"}
          </Button>
          <Button size="sm" onClick={save}>
            {saved ? "已保存" : "保存设置"}
          </Button>
          <Button size="sm" variant="ghost" onClick={reset}>
            <RotateCcw className="h-4 w-4 mr-1" />
            重置
          </Button>
        </div>
      </header>

      <section className="border border-border rounded-lg p-4 space-y-4 max-w-3xl">
        <div className="space-y-2">
          <div>
            <label className="text-sm text-muted-foreground block mb-1">
              名称
            </label>
            <input
              type="text"
              className="w-full h-9 px-2 rounded-md border border-input bg-background text-sm"
              placeholder="学习"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addCategory()}
            />
          </div>
          <div>
            <label className="text-sm text-muted-foreground block mb-1">
              描述（可选）
            </label>
            <input
              type="text"
              className="w-full h-9 px-2 rounded-md border border-input bg-background text-sm"
              placeholder="技术文档、教程"
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addCategory()}
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={addCategory}
            disabled={!newName.trim()}>
            <Plus className="h-4 w-4 mr-1" />
            添加
          </Button>
        </div>

        <div className="border-t border-border pt-4">
          {draftCategories.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无分组，点击上方添加</p>
          ) : (
            <ul className="grid grid-cols-2 gap-2">
              {draftCategories.map((cat) =>
                editingId === cat.id ? (
                  <li
                    key={cat.id}
                    className="col-span-2 border border-border rounded-md p-2 space-y-2">
                    <input
                      type="text"
                      className="w-full h-9 px-2 rounded-md border border-input bg-background text-sm"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      autoFocus
                    />
                    <input
                      type="text"
                      className="w-full h-9 px-2 rounded-md border border-input bg-background text-sm"
                      placeholder="描述（可选）"
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                    />
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        onClick={commitEdit}
                        disabled={!editName.trim()}>
                        保存
                      </Button>
                      <Button size="sm" variant="ghost" onClick={cancelEdit}>
                        取消
                      </Button>
                    </div>
                  </li>
                ) : (
                  <li
                    key={cat.id}
                    className="flex items-center gap-1 border border-border rounded-md py-1.5 px-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{cat.name}</p>
                      {cat.description && (
                        <p className="text-xs text-muted-foreground truncate">
                          {cat.description}
                        </p>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 px-2"
                      onClick={() => startEdit(cat)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 px-2"
                      onClick={() => removeCategory(cat)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </li>
                )
              )}
            </ul>
          )}
        </div>
      </section>
    </div>
  )
}

const DEFAULT_NOTE_ADAPTER: NoteAdapterConfig = {
  provider: "local"
}

function NotesSection() {
  const [config, setConfig] = useState<NoteAdapterConfig>(DEFAULT_NOTE_ADAPTER)
  const [saved, setSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [notebooks, setNotebooks] = useState<NotebookInfo[]>([])

  useEffect(() => {
    chrome.storage.local.get("noteAdapter").then((stored) => {
      if (stored.noteAdapter) {
        setConfig({ ...DEFAULT_NOTE_ADAPTER, ...stored.noteAdapter })
      }
    })
  }, [])

  const save = async () => {
    await chrome.storage.local.set({ noteAdapter: config })
    syncConfigToBackend({ noteAdapter: config })
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  const reset = () => {
    setConfig(DEFAULT_NOTE_ADAPTER)
  }

  const test = async () => {
    setTesting(true)
    setTestResult(null)
    setNotebooks([])
    console.log("[TabKeep] 测试连接开始", { provider: config.provider, endpoint: config.endpoint })
    try {
      const res = await fetch(`${BACKEND_URL}/notes/test`, { method: "POST" })
      console.log("[TabKeep] /notes/test HTTP", res.status, res.statusText)
      if (!res.ok) {
        const text = await res.text()
        const err = `后端 HTTP ${res.status}：${text.slice(0, 200)}`
        console.error("[TabKeep] 测试连接 HTTP 失败", err)
        setTestResult(err)
        return
      }
      const data = await res.json()
      console.log("[TabKeep] /notes/test 响应", data)
      if (data.ok) {
        setTestResult(`连接成功 (provider=${data.provider})`)
        console.log("[TabKeep] 测试连接 ok, 拉笔记本列表")
        const nbRes = await fetch(`${BACKEND_URL}/notes/notebooks`)
        console.log("[TabKeep] /notes/notebooks HTTP", nbRes.status)
        if (!nbRes.ok) {
          const text = await nbRes.text()
          const err = `拉笔记本失败 HTTP ${nbRes.status}：${text.slice(0, 200)}`
          console.error("[TabKeep]", err)
          setTestResult((prev) => `${prev}\n${err}`)
          return
        }
        const nbData = await nbRes.json()
        console.log("[TabKeep] 笔记本列表", nbData)
        setNotebooks(Array.isArray(nbData) ? nbData : [])
      } else {
        const errMsg = data.error ?? "未知错误"
        console.warn("[TabKeep] 测试连接 fail:", errMsg)
        setTestResult(`连接失败：${errMsg}`)
      }
    } catch (err) {
      const errMsg = String(err)
      console.error("[TabKeep] 测试连接 fetch 异常:", err)
      setTestResult(
        `请求失败：${errMsg}\n\n排查：\n1) 后端是否启动：${BACKEND_URL}\n2) 浏览器能否访问该 URL\n3) CORS / 端口冲突`
      )
    } finally {
      setTesting(false)
    }
  }

  const isLocal = config.provider === "local"
  const isObsidian = config.provider === "obsidian"

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">笔记集成</h1>
        <p className="text-sm text-muted-foreground mt-1">
          配置后可在 popup 点 ☆ 把当前标签页收藏到笔记系统
        </p>
      </header>

      <section className="border border-border rounded-lg p-4 space-y-4 max-w-xl">
        <div>
          <label className="text-sm text-muted-foreground block mb-1">Provider</label>
          <select
            className="w-full h-9 px-2 rounded-md border border-input bg-background text-sm"
            value={config.provider}
            onChange={(e) =>
              setConfig({ ...config, provider: e.target.value as NoteAdapterConfig["provider"] })
            }>
            <option value="local">本地 Markdown（写到 data/notes/，零依赖）</option>
            <option value="siyuan">思源笔记（HTTP API @ :6806，需 Token）</option>
            <option value="obsidian">Obsidian（即将推出）</option>
          </select>
        </div>

        {!isLocal && (
          <>
            <div>
              <label className="text-sm text-muted-foreground block mb-1">Endpoint</label>
              <input
                type="text"
                className="w-full h-9 px-2 rounded-md border border-input bg-background text-sm"
                placeholder="http://127.0.0.1:6806"
                value={config.endpoint ?? ""}
                onChange={(e) => setConfig({ ...config, endpoint: e.target.value })}
                disabled={isObsidian}
              />
            </div>
            {!isObsidian && (
              <div>
                <label className="text-sm text-muted-foreground block mb-1">Token</label>
                <input
                  type="password"
                  className="w-full h-9 px-2 rounded-md border border-input bg-background text-sm"
                  placeholder="思源：设置 → 关于 → API token"
                  value={config.token ?? ""}
                  onChange={(e) => setConfig({ ...config, token: e.target.value })}
                />
              </div>
            )}
            <div>
              <label className="text-sm text-muted-foreground block mb-1">
                默认笔记本 ID（可选）
              </label>
              <input
                type="text"
                className="w-full h-9 px-2 rounded-md border border-input bg-background text-sm"
                placeholder="留空则每次收藏时新建"
                value={config.defaultNotebook ?? ""}
                onChange={(e) => setConfig({ ...config, defaultNotebook: e.target.value })}
              />
            </div>
            <div>
              <label className="text-sm text-muted-foreground block mb-1">
                默认目标文档（可选）
              </label>
              <input
                type="text"
                className="w-full h-9 px-2 rounded-md border border-input bg-background text-sm"
                placeholder="留空 = 每次新建；填 = 追加到此文档"
                value={config.defaultTargetDoc ?? ""}
                onChange={(e) => setConfig({ ...config, defaultTargetDoc: e.target.value })}
              />
            </div>
          </>
        )}

        {isLocal && (
          <p className="text-xs text-muted-foreground">
            本地模式无需配置，收藏会写入 <code>data/notes/inbox.md</code>（可在 dataDir 下查看）。
          </p>
        )}
        {isObsidian && (
          <p className="text-xs text-muted-foreground">
            Obsidian 适配器尚未实现（占位）。后续版本接入 Local REST API 插件。
          </p>
        )}

        <div className="flex items-center gap-2 pt-2">
          <Button size="sm" onClick={save} disabled={isObsidian}>
            {saved ? "已保存" : "保存设置"}
          </Button>
          <Button size="sm" variant="outline" onClick={test} disabled={testing}>
            {testing ? "测试中..." : "测试连接"}
          </Button>
          <Button size="sm" variant="ghost" onClick={reset}>
            <RotateCcw className="h-4 w-4 mr-1" />
            重置
          </Button>
        </div>

        {testResult && (
          <p
            className={`text-xs ${
              testResult.startsWith("连接成功") ? "text-green-600" : "text-red-600"
            }`}>
            {testResult}
          </p>
        )}

        {notebooks.length > 0 && (
          <div className="border-t border-border pt-3">
            <p className="text-xs text-muted-foreground mb-2">笔记本列表：</p>
            <ul className="space-y-1">
              {notebooks.map((nb) => (
                <li
                  key={nb.id}
                  className="text-xs flex items-center gap-2 cursor-pointer hover:bg-accent/30 px-2 py-1 rounded"
                  onClick={() => setConfig({ ...config, defaultNotebook: nb.id })}>
                  <CheckCircle2 className="h-3 w-3 text-muted-foreground" />
                  <span className="font-medium">{nb.name}</span>
                  <code className="text-[10px] text-muted-foreground">{nb.id}</code>
                </li>
              ))}
            </ul>
            <p className="text-[10px] text-muted-foreground mt-2">点击笔记本可填入「默认笔记本 ID」</p>
          </div>
        )}
      </section>
    </div>
  )
}

function IndexOptions() {
  const [section, setSection] = useState<Section>("overview")

  const navItems: { id: Section; label: string; icon: typeof LayoutDashboard; disabled?: boolean }[] = [
    { id: "overview", label: "概览", icon: LayoutDashboard },
    { id: "categories", label: "分组", icon: Folder },
    { id: "modelApi", label: "模型 API", icon: Brain },
    { id: "notes", label: "笔记集成", icon: BookOpen }
  ]

  return (
    <div className="flex h-screen bg-background text-foreground">
      <aside className="w-56 border-r border-border flex flex-col">
        <div className="p-4 border-b border-border">
          <h2 className="text-lg font-semibold">TabKeep</h2>
        </div>
        <nav className="flex-1 p-2 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon
            const isActive = !item.disabled && section === item.id
            return (
              <button
                key={item.label}
                onClick={() => !item.disabled && setSection(item.id)}
                disabled={item.disabled}
                className={`w-full flex items-center gap-2 px-3 h-9 rounded-md text-sm transition-colors ${
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent/50"
                } ${
                  item.disabled
                    ? "opacity-50 cursor-not-allowed"
                    : "cursor-pointer"
                }`}>
                <Icon className="h-4 w-4" />
                <span className="flex-1 text-left">{item.label}</span>
                {item.disabled && (
                  <span className="text-[10px] text-muted-foreground">
                    即将推出
                  </span>
                )}
              </button>
            )
          })}
        </nav>
      </aside>

      <main className="flex-1 overflow-y-auto p-6">
        <div className="max-w-3xl mx-auto">
          {section === "overview" && <OverviewSection />}
          {section === "categories" && <CategoriesSection />}
          {section === "modelApi" && <ModelApiSection />}
          {section === "notes" && <NotesSection />}
        </div>
      </main>
    </div>
  )
}

export default IndexOptions
