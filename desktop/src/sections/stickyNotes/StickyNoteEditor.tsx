import { useCallback, useEffect, useRef, useState } from "react"
import { ExternalLink, Eye, PanelTop, Pencil, Pin, PinOff, Trash2 } from "lucide-react"

import { saveStickyNote } from "../../api/stickyNotes"
import type { StickyNote, StickyNoteDraft } from "../../types"
import {
  DEFAULT_STICKY_NOTE_COLOR,
  formatStickyNoteTime,
  stickyNoteSignature,
} from "./stickyNoteModel"
import { StickyMarkdownPreview } from "./StickyMarkdownPreview"

interface StickyNoteEditorProps {
  note: StickyNote
  compact?: boolean
  tile?: boolean
  categories?: string[]
  onSaved?: (note: StickyNote) => void
  onDelete?: (note: StickyNote) => void | Promise<void>
  onOpenWindow?: (note: StickyNote) => void
  onOpenTile?: (note: StickyNote) => void
  onCloseTile?: () => void
}

type StickyFlushEvent = CustomEvent<{ done?: () => void }>
type StickySaveState = "idle" | "dirty" | "saving" | "error"

export function StickyNoteEditor({
  note,
  compact = false,
  tile = false,
  categories = [],
  onSaved,
  onDelete,
  onOpenWindow,
  onOpenTile,
  onCloseTile,
}: StickyNoteEditorProps) {
  const [draft, setDraft] = useState<StickyNoteDraft>(() => noteToDraft(note))
  const [error, setError] = useState("")
  const [saveState, setSaveState] = useState<StickySaveState>("idle")
  const [deleteRequested, setDeleteRequested] = useState(false)
  const lastSavedSignature = useRef(stickyNoteSignature(noteToDraft(note)))
  const latestDraft = useRef(draft)
  const saveTimer = useRef<number | null>(null)
  const saveQueue = useRef<Promise<StickyNote | null>>(Promise.resolve(null))
  const deleting = useRef(false)
  latestDraft.current = draft

  useEffect(() => {
    const next = noteToDraft(note)
    setDraft(next)
    latestDraft.current = next
    lastSavedSignature.current = stickyNoteSignature(next)
    deleting.current = false
    setDeleteRequested(false)
    setSaveState("idle")
    setError("")
  }, [note.id, note.updatedAt])

  const clearPendingSave = useCallback(() => {
    if (saveTimer.current === null) return
    window.clearTimeout(saveTimer.current)
    saveTimer.current = null
  }, [])

  const persist = useCallback((next: StickyNoteDraft): Promise<StickyNote | null> => {
    if (deleting.current) return Promise.resolve(null)
    const requestSignature = stickyNoteSignature(next)
    setError("")
    setSaveState("saving")

    const saveTask = saveQueue.current
      .catch(() => null)
      .then(async () => {
        if (deleting.current) return null
        try {
          const saved = await saveStickyNote(next)
          if (deleting.current) return saved
          if (stickyNoteSignature(latestDraft.current) === requestSignature) {
            lastSavedSignature.current = stickyNoteSignature(noteToDraft(saved))
            setSaveState("idle")
            onSaved?.(saved)
          } else {
            setSaveState("dirty")
          }
          return saved
        } catch (err) {
          if (!deleting.current && stickyNoteSignature(latestDraft.current) === requestSignature) {
            setError(err instanceof Error ? err.message : String(err))
            setSaveState("error")
          }
          return null
        }
      })

    saveQueue.current = saveTask.catch(() => null)
    return saveTask
  }, [onSaved])

  const persistLatestAfterQueue = useCallback(async (): Promise<StickyNote | null> => {
    const queuedDraft = latestDraft.current
    const queuedSignature = stickyNoteSignature(queuedDraft)
    const saved = await persist(queuedDraft)
    if (!deleting.current && stickyNoteSignature(latestDraft.current) !== queuedSignature) {
      return persistLatestAfterQueue()
    }
    return saved
  }, [persist])

  const persistIfChanged = useCallback(async (): Promise<StickyNote> => {
    const next = latestDraft.current
    if (stickyNoteSignature(next) === lastSavedSignature.current) {
      setSaveState("idle")
      return note
    }
    clearPendingSave()
    return (await persistLatestAfterQueue()) ?? note
  }, [clearPendingSave, note, persistLatestAfterQueue])

  useEffect(() => {
    const signature = stickyNoteSignature(draft)
    if (signature === lastSavedSignature.current || deleting.current) return

    const timer = window.setTimeout(() => {
      saveTimer.current = null
      void persistLatestAfterQueue()
    }, 360)
    saveTimer.current = timer
    return () => {
      if (saveTimer.current === timer) saveTimer.current = null
      window.clearTimeout(timer)
    }
  }, [draft, persistLatestAfterQueue])

  useEffect(() => {
    const handleFlush = (event: Event) => {
      const detail = (event as StickyFlushEvent).detail
      void persistIfChanged().finally(() => detail?.done?.())
    }

    window.addEventListener("tk-sticky-request-flush", handleFlush)
    return () => window.removeEventListener("tk-sticky-request-flush", handleFlush)
  }, [persistIfChanged])

  const updateDraft = (partial: Partial<StickyNoteDraft>) => {
    const next = { ...latestDraft.current, ...partial }
    latestDraft.current = next
    setDraft(next)
    setSaveState(stickyNoteSignature(next) === lastSavedSignature.current ? "idle" : "dirty")
  }

  const updateAndPersist = async (partial: Partial<StickyNoteDraft>) => {
    const next = { ...latestDraft.current, ...partial }
    latestDraft.current = next
    setDraft(next)
    setSaveState(stickyNoteSignature(next) === lastSavedSignature.current ? "idle" : "dirty")
    clearPendingSave()
    await persist(next)
  }

  const requestDelete = async () => {
    if (!onDelete || deleteRequested) return
    deleting.current = true
    setDeleteRequested(true)
    clearPendingSave()
    try {
      await onDelete(note)
    } catch (err) {
      deleting.current = false
      setDeleteRequested(false)
      setSaveState(stickyNoteSignature(latestDraft.current) === lastSavedSignature.current ? "idle" : "dirty")
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const viewMode = draft.viewMode === "preview" ? "preview" : "edit"
  const categoryOptions = Array.from(new Set(categories.filter(Boolean)))
  const editorModeClass = tile
    ? "tk-sticky-editor-tile"
    : compact
      ? "tk-sticky-editor-compact"
      : "tk-sticky-editor-main"

  return (
    <article
      className={`tk-sticky-editor ${editorModeClass}`}
      data-save-state={saveState}
      aria-busy={deleteRequested}
      style={{ ["--sticky-note-color" as string]: DEFAULT_STICKY_NOTE_COLOR }}>
      <div className="tk-sticky-editor-toolbar">
        <div className="tk-sticky-toolbar-meta">
          {!tile && (
            <select
              className="tk-sticky-category-select"
              value={draft.category ?? ""}
              disabled={deleteRequested}
              onChange={(event) => {
                void updateAndPersist({ category: event.target.value })
              }}>
              <option value="">未分类</option>
              {categoryOptions.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="tk-sticky-toolbar-actions">
          <button
            className={`tk-icon-button ${viewMode === "edit" ? "tk-icon-button-active" : ""}`}
            type="button"
            title="编辑"
            aria-label="切换到编辑"
            disabled={deleteRequested}
            onClick={() => {
              void updateAndPersist({ viewMode: "edit" })
            }}>
            <Pencil className="h-4 w-4" />
          </button>
          <button
            className={`tk-icon-button ${viewMode === "preview" ? "tk-icon-button-active" : ""}`}
            type="button"
            title="预览"
            aria-label="切换到预览"
            disabled={deleteRequested}
            onClick={() => {
              void updateAndPersist({ viewMode: "preview" })
            }}>
            <Eye className="h-4 w-4" />
          </button>
          <button
            className="tk-icon-button"
            type="button"
            title={draft.pinned ? "取消置顶" : "置顶"}
            aria-label={draft.pinned ? "取消置顶" : "置顶"}
            disabled={deleteRequested}
            onClick={() => {
              void updateAndPersist({ pinned: !latestDraft.current.pinned })
            }}>
            <Pin className="h-4 w-4" />
          </button>
          {onOpenWindow && (
            <button
              className="tk-icon-button"
              type="button"
              title="打开小窗"
              aria-label="打开便签小窗"
              disabled={deleteRequested}
              onClick={() => {
                void persistIfChanged().then(onOpenWindow)
              }}>
              <ExternalLink className="h-4 w-4" />
            </button>
          )}
          {onOpenTile && !tile && (
            <button
              className="tk-icon-button"
              type="button"
              title="固定到桌面"
              aria-label="固定到桌面"
              disabled={deleteRequested}
              onClick={() => {
                void persistIfChanged().then(onOpenTile)
              }}>
              <PanelTop className="h-4 w-4" />
            </button>
          )}
          {tile && onCloseTile && (
            <button
              className="tk-icon-button"
              type="button"
              title="取消固定"
              aria-label="取消固定"
              disabled={deleteRequested}
              onClick={() => {
                void updateAndPersist({ tilePinned: false }).then(onCloseTile)
              }}>
              <PinOff className="h-4 w-4" />
            </button>
          )}
          {onDelete && (
            <button
              className="tk-icon-button tk-icon-button-danger"
              type="button"
              title="删除便签"
              aria-label="删除便签"
              disabled={deleteRequested}
              onClick={() => {
                void requestDelete()
              }}>
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      <input
        className="tk-sticky-title-input"
        value={draft.title}
        disabled={deleteRequested}
        onChange={(event) => updateDraft({ title: event.target.value })}
        onBlur={() => {
          void persistIfChanged()
        }}
        placeholder="便签标题"
      />
      <div className={`tk-sticky-editor-content tk-sticky-view-${viewMode}`}>
        {viewMode === "edit" && (
          <textarea
            className="tk-sticky-content-input"
            value={draft.content}
            disabled={deleteRequested}
            onChange={(event) => updateDraft({ content: event.target.value })}
            onBlur={() => {
              void persistIfChanged()
            }}
            placeholder="写点临时想法、待办、代码片段或备忘..."
          />
        )}
        {viewMode === "preview" && <StickyMarkdownPreview content={draft.content} />}
      </div>
      <div className="tk-sticky-editor-footer">
        <span>{draft.content.trim().length} 字符</span>
        <span>更新于 {formatStickyNoteTime(note.updatedAt)}</span>
      </div>
      {error && <p className="tk-sticky-error" role="alert">{error}</p>}
    </article>
  )
}

function noteToDraft(note: StickyNote): StickyNoteDraft {
  return {
    id: note.id,
    title: note.title,
    content: note.content,
    color: DEFAULT_STICKY_NOTE_COLOR,
    pinned: note.pinned,
    category: note.category,
    viewMode: note.viewMode === "preview" ? "preview" : "edit",
    tilePinned: note.tilePinned,
  }
}
