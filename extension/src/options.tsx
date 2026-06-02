import { useEffect, useState } from "react"
import {
  BookOpen,
  Brain,
  Folder,
  LayoutDashboard,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2
} from "lucide-react"
import type {
  ModelConfig,
  TabCategory,
  TabData,
  TabGroupColor,
  TabGroupStyleOptions
} from "./types"
import { groupTabsByDomain } from "./utils/tabUtils"
import { loadFromIDB } from "./utils/indexedDB"
import { Button } from "./components/ui/button"
import "./style.css"

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

type Section = "overview" | "categories" | "modelApi"

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

function IndexOptions() {
  const [section, setSection] = useState<Section>("overview")

  const navItems: { id: Section; label: string; icon: typeof LayoutDashboard; disabled?: boolean }[] = [
    { id: "overview", label: "概览", icon: LayoutDashboard },
    { id: "categories", label: "分组", icon: Folder },
    { id: "modelApi", label: "模型 API", icon: Brain },
    { id: "overview", label: "笔记集成", icon: BookOpen, disabled: true }
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
        </div>
      </main>
    </div>
  )
}

export default IndexOptions
