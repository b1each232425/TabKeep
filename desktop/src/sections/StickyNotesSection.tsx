import { useEffect, useMemo, useState } from "react"
import { Maximize2, Plus, Search, StickyNote as StickyNoteIcon, Trash2 } from "lucide-react"

import {
  createStickyNoteWindow,
  deleteStickyNote,
  listStickyNotes,
  openStickyNoteWindow,
} from "../api"
import { Button, Notice } from "../components/primitives"
import type { StickyNote } from "../types"
import { StickyNoteEditor } from "./stickyNotes/StickyNoteEditor"
import {
  formatStickyNoteTime,
  searchableStickyText,
  stickyNotePreview,
  stickyNoteTitle,
} from "./stickyNotes/stickyNoteModel"

export function StickyNotesSection() {
  const [notes, setNotes] = useState<StickyNote[]>([])
  const [selectedId, setSelectedId] = useState("")
  const [query, setQuery] = useState("")
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState("")

  const refresh = async () => {
    setLoading(true)
    try {
      const loaded = await listStickyNotes()
      setNotes(loaded)
      setSelectedId((current) => current || loaded[0]?.id || "")
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const filteredNotes = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return notes
    return notes.filter((note) => searchableStickyText(note).includes(needle))
  }, [notes, query])

  const selectedNote = notes.find((note) => note.id === selectedId) ?? filteredNotes[0] ?? null

  const createNote = async () => {
    try {
      const note = await createStickyNoteWindow()
      setNotes((current) => [note, ...current])
      setSelectedId(note.id)
      setStatus("已创建并打开便签")
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    }
  }

  const updateNote = (updated: StickyNote) => {
    setNotes((current) => sortNotes(current.map((note) => (note.id === updated.id ? updated : note))))
  }

  const deleteNote = async (note: StickyNote) => {
    const confirmed = window.confirm(`删除「${stickyNoteTitle(note)}」？`)
    if (!confirmed) return
    try {
      await deleteStickyNote(note.id)
      setNotes((current) => current.filter((item) => item.id !== note.id))
      setSelectedId((current) => {
        if (current !== note.id) return current
        return notes.find((item) => item.id !== note.id)?.id ?? ""
      })
      setStatus("便签已删除")
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    }
  }

  const openNoteWindow = async (note: StickyNote) => {
    try {
      await openStickyNoteWindow(note.id)
      setStatus("已打开便签小窗")
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="space-y-5">
      <section className="tk-page-hero">
        <div>
          <h1 className="tk-page-title">便签</h1>
          <p className="tk-page-subtitle">本地快速记录、自动保存、可打开独立置顶小窗</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="tk-badge">{notes.length} 条</span>
          <Button onClick={createNote}>
            <Plus className="h-4 w-4" />
            新建便签
          </Button>
        </div>
      </section>

      {status && <Notice>{status}</Notice>}

      <section className="tk-sticky-workspace">
        <aside className="tk-sticky-sidebar-panel">
          <div className="tk-sticky-search">
            <Search className="h-4 w-4 text-slate-400" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索标题或正文"
            />
          </div>
          <div className="tk-sticky-list">
            {filteredNotes.map((note) => (
              <button
                key={note.id}
                className={`tk-sticky-list-item ${selectedNote?.id === note.id ? "tk-sticky-list-item-active" : ""}`}
                type="button"
                onClick={() => setSelectedId(note.id)}>
                <span className="tk-sticky-list-color" style={{ backgroundColor: note.color }} />
                <span className="min-w-0 flex-1">
                  <span className="tk-sticky-list-title">
                    {note.pinned && <StickyNoteIcon className="h-3.5 w-3.5 text-emerald-500" />}
                    {stickyNoteTitle(note)}
                  </span>
                  <span className="tk-sticky-list-preview">{stickyNotePreview(note.content)}</span>
                </span>
                <span className="tk-sticky-list-time">{formatStickyNoteTime(note.updatedAt)}</span>
              </button>
            ))}
            {!loading && filteredNotes.length === 0 && (
              <div className="tk-empty-state">暂无匹配便签</div>
            )}
          </div>
        </aside>

        <main className="tk-sticky-main-panel">
          {selectedNote ? (
            <>
              <div className="tk-sticky-main-header">
                <div>
                  <h2 className="tk-panel-title">{stickyNoteTitle(selectedNote)}</h2>
                  <p className="text-xs text-muted-foreground">本地保存，不依赖后端或知识库配置</p>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="secondary" onClick={() => openNoteWindow(selectedNote)}>
                    <Maximize2 className="h-4 w-4" />
                    小窗
                  </Button>
                  <Button variant="ghost" onClick={() => deleteNote(selectedNote)}>
                    <Trash2 className="h-4 w-4" />
                    删除
                  </Button>
                </div>
              </div>
              <StickyNoteEditor
                note={selectedNote}
                onSaved={updateNote}
                onDelete={deleteNote}
                onOpenWindow={openNoteWindow}
              />
            </>
          ) : (
            <div className="tk-sticky-empty">
              <StickyNoteIcon className="h-8 w-8 text-slate-400" />
              <p>还没有便签</p>
              <Button onClick={createNote}>
                <Plus className="h-4 w-4" />
                新建第一条
              </Button>
            </div>
          )}
        </main>
      </section>
    </div>
  )
}

function sortNotes(notes: StickyNote[]): StickyNote[] {
  return [...notes].sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
    return right.updatedAt.localeCompare(left.updatedAt)
  })
}
