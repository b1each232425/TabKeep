import { useEffect, useState } from "react"
import { Keyboard, Pencil, Plus, RotateCcw, Sparkles, Trash2 } from "lucide-react"

import {
  DEFAULT_MODEL_CONFIG,
  backendRequest,
  getStickyNoteShortcutConfig,
  setStickyNoteShortcutConfig,
  syncConfigToBackend,
} from "../api"
import type {
  ClassifyResponse,
  ModelConfig,
  NoteAdapterConfig,
  StickyShortcutConfig,
  TabCategory,
  TabData,
} from "../types"
import { Button, Notice } from "../components/primitives"
import { errorMessage } from "../lib/errors"
import { NotesConfigPanel } from "./NotesSection"

export function SettingsSection({
  tabs,
  categories,
  setCategories,
  modelConfig,
  setModelConfig,
  noteAdapter,
  setNoteAdapter,
}: {
  tabs: TabData[]
  categories: TabCategory[]
  setCategories: (categories: TabCategory[]) => void
  modelConfig: ModelConfig
  setModelConfig: (config: ModelConfig) => void
  noteAdapter: NoteAdapterConfig
  setNoteAdapter: (config: NoteAdapterConfig) => void
}) {
  return (
    <div className="space-y-5">
      <header className="tk-topbar">
        <div>
          <h1 className="tk-page-title">设置</h1>
          <p className="tk-page-subtitle">分组、模型与笔记</p>
        </div>
      </header>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
        <CategoriesConfigPanel
          tabs={tabs}
          categories={categories}
          setCategories={setCategories}
        />
        <ModelApiConfigPanel
          config={modelConfig}
          setConfig={setModelConfig}
        />
      </div>

      <NotesConfigPanel config={noteAdapter} setConfig={setNoteAdapter} />
      <StickyShortcutConfigPanel />
    </div>
  )
}

function StickyShortcutConfigPanel() {
  const [draft, setDraft] = useState<StickyShortcutConfig>({
    newNoteHotkey: "Ctrl+Alt+N",
    toggleWindowHotkey: "Ctrl+Alt+M",
  })
  const [status, setStatus] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const config = await getStickyNoteShortcutConfig()
        if (!cancelled) setDraft(config)
      } catch (err) {
        if (!cancelled) setStatus(errorMessage(err))
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  const save = async () => {
    setSaving(true)
    setStatus(null)
    try {
      const saved = await setStickyNoteShortcutConfig(draft)
      setDraft(saved)
      setStatus("便签快捷键已保存，重启桌面端后生效")
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="tk-panel">
      <div className="tk-panel-header">
        <div>
          <h2 className="tk-panel-title">便签快捷键</h2>
          <p className="text-xs text-muted-foreground">新建便签与切换最近小窗</p>
        </div>
        <Keyboard className="h-5 w-5 text-slate-400" />
      </div>
      <div className="tk-panel-body space-y-4">
        {status && <Notice>{status}</Notice>}
        <div className="tk-form-grid">
          <label className="tk-field">
            <span className="tk-label">新建便签</span>
            <input
              className="tk-input"
              value={draft.newNoteHotkey}
              onChange={(event) => setDraft({ ...draft, newNoteHotkey: event.target.value })}
              placeholder="Ctrl+Alt+N"
            />
          </label>
          <label className="tk-field">
            <span className="tk-label">显示 / 隐藏最近小窗</span>
            <input
              className="tk-input"
              value={draft.toggleWindowHotkey}
              onChange={(event) => setDraft({ ...draft, toggleWindowHotkey: event.target.value })}
              placeholder="Ctrl+Alt+M"
            />
          </label>
        </div>
      </div>
      <div className="tk-command-bar">
        <Button onClick={save} disabled={saving}>
          {saving ? "保存中..." : "保存便签快捷键"}
        </Button>
        <Button
          variant="ghost"
          onClick={() => setDraft({ newNoteHotkey: "Ctrl+Alt+N", toggleWindowHotkey: "Ctrl+Alt+M" })}>
          <RotateCcw className="h-4 w-4" />
          重置
        </Button>
      </div>
    </section>
  )
}

function ModelApiConfigPanel({
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
      setStatus("模型 API 已保存")
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="tk-panel">
      <div className="tk-panel-header">
        <div>
          <h2 className="tk-panel-title">模型 API</h2>
          <p className="text-xs text-muted-foreground">摘要、分组、问答</p>
        </div>
      </div>
      <div className="tk-panel-body space-y-4">
        {status && <Notice>{status}</Notice>}
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
          {saving ? "保存中..." : "保存模型 API"}
        </Button>
        <Button variant="ghost" onClick={() => setDraft(DEFAULT_MODEL_CONFIG)}>
          <RotateCcw className="h-4 w-4" />
          重置
        </Button>
      </div>
    </section>
  )
}

function CategoriesConfigPanel({
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
      setStatus("分组设置已保存")
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
    <section className="tk-panel">
      <div className="tk-panel-header">
        <div>
          <h2 className="tk-panel-title">分组</h2>
          <p className="text-xs text-muted-foreground">标签归类规则</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={runClassify} disabled={classifying || tabs.length === 0}>
            <Sparkles className="h-4 w-4" />
            {classifying ? "分类中..." : "AI 分组测试"}
          </Button>
          <Button onClick={save}>保存分组</Button>
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
      </div>

      <div className="tk-panel-body space-y-4">
        {status && <Notice>{status}</Notice>}
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
  )
}
