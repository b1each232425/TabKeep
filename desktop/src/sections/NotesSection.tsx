import { useEffect, useState } from "react"
import { CheckCircle2, RotateCcw } from "lucide-react"

import { DEFAULT_NOTE_ADAPTER, backendRequest, syncConfigToBackend } from "../api"
import type { NoteAdapterConfig, NotebookInfo, NotesTestResponse } from "../types"
import { Button, Notice, TextField } from "../components/primitives"
import { errorMessage } from "../lib/errors"

export function NotesSection({
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