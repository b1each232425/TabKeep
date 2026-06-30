import { useCallback, useEffect, useRef, useState } from "react"
import { Columns2, ExternalLink, Eye, Loader2, PanelTop, Pencil, Pin, PinOff, Trash2 } from "lucide-react"

import { saveStickyNote } from "../../api/stickyNotes"
import type { StickyNote, StickyNoteDraft } from "../../types"
import {
  STICKY_NOTE_COLORS,
  formatStickyNoteTime,
  stickyNoteSignature,
} from "./stickyNoteModel"
import { StickyMarkdownPreview } from "./StickyMarkdownPreview"

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error"

interface StickyNoteEditorProps {
  note: StickyNote
  compact?: boolean
  tile?: boolean
  categories?: string[]
  onSaved?: (note: StickyNote) => void
  onDelete?: (note: StickyNote) => void
  onOpenWindow?: (note: StickyNote) => void
  onOpenTile?: (note: StickyNote) => void
  onCloseTile?: () => void
}

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
  const [saveState, setSaveState] = useState<SaveState>("idle")
  const [error, setError] = useState("")
  const lastSavedSignature = useRef(stickyNoteSignature(noteToDraft(note)))
  const latestDraft = useRef(draft)
  latestDraft.current = draft

  useEffect(() => {
    const next = noteToDraft(note)
    setDraft(next)
    lastSavedSignature.current = stickyNoteSignature(next)
    setSaveState("idle")
    setError("")
  }, [note.id, note.updatedAt])

  const persist = useCallback(async (next: StickyNoteDraft) => {
    setSaveState("saving")
    setError("")
    try {
      const saved = await saveStickyNote(next)
      lastSavedSignature.current = stickyNoteSignature(noteToDraft(saved))
      setSaveState("saved")
      onSaved?.(saved)
    } catch (err) {
      setSaveState("error")
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [onSaved])

  useEffect(() => {
    const signature = stickyNoteSignature(draft)
    if (signature === lastSavedSignature.current) return

    setSaveState("dirty")
    const timer = window.setTimeout(() => {
      void persist(latestDraft.current)
    }, 520)
    return () => window.clearTimeout(timer)
  }, [draft, persist])

  const updateDraft = (partial: Partial<StickyNoteDraft>) => {
    setDraft((current) => ({ ...current, ...partial }))
  }

  const updateAndPersist = async (partial: Partial<StickyNoteDraft>) => {
    const next = { ...latestDraft.current, ...partial }
    setDraft(next)
    await persist(next)
  }

  const rawViewMode = draft.viewMode ?? "edit"
  const viewMode = tile && rawViewMode === "split" ? "edit" : rawViewMode
  const categoryOptions = Array.from(new Set(categories.filter(Boolean)))

  const saveLabel =
    saveState === "saving"
      ? "保存中"
      : saveState === "dirty"
        ? "未保存"
        : saveState === "saved"
          ? "已保存"
          : saveState === "error"
            ? "保存失败"
            : "本地"

  return (
    <article
      className={`tk-sticky-editor ${compact ? "tk-sticky-editor-compact" : ""} ${tile ? "tk-sticky-editor-tile" : ""}`}
      style={{ ["--sticky-note-color" as string]: draft.color }}>
      <div className="tk-sticky-editor-toolbar">
        <div className="tk-sticky-toolbar-meta">
          <span className={`tk-badge ${draft.pinned ? "tk-badge-success" : ""}`}>
            {draft.pinned ? "已置顶" : "便签"}
          </span>
          <span className={`tk-badge ${saveState === "error" ? "tk-badge-error" : ""}`}>
            {saveState === "saving" && <Loader2 className="h-3 w-3 animate-spin" />}
            {saveLabel}
          </span>
          {!tile && (
            <select
              className="tk-sticky-category-select"
              value={draft.category ?? ""}
              onChange={(event) => updateDraft({ category: event.target.value })}>
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
          {STICKY_NOTE_COLORS.map((color) => (
            <button
              key={color}
              className={`tk-sticky-color-swatch ${draft.color === color ? "tk-sticky-color-active" : ""}`}
              type="button"
              style={{ backgroundColor: color }}
              title={`颜色 ${color}`}
              onClick={() => updateDraft({ color })}
            />
          ))}
          <button
            className={`tk-icon-button ${viewMode === "edit" ? "tk-icon-button-active" : ""}`}
            type="button"
            title="编辑"
            onClick={() => updateDraft({ viewMode: "edit" })}>
            <Pencil className="h-4 w-4" />
          </button>
          {!tile && (
            <button
              className={`tk-icon-button ${viewMode === "split" ? "tk-icon-button-active" : ""}`}
              type="button"
              title="分屏"
              onClick={() => updateDraft({ viewMode: "split" })}>
              <Columns2 className="h-4 w-4" />
            </button>
          )}
          <button
            className={`tk-icon-button ${viewMode === "preview" ? "tk-icon-button-active" : ""}`}
            type="button"
            title="预览"
            onClick={() => updateDraft({ viewMode: "preview" })}>
            <Eye className="h-4 w-4" />
          </button>
          <button
            className="tk-icon-button"
            type="button"
            title={draft.pinned ? "取消置顶" : "置顶"}
            onClick={() => updateDraft({ pinned: !draft.pinned })}>
            <Pin className="h-4 w-4" />
          </button>
          {onOpenWindow && (
            <button
              className="tk-icon-button"
              type="button"
              title="打开小窗"
              onClick={() => onOpenWindow(note)}>
              <ExternalLink className="h-4 w-4" />
            </button>
          )}
          {onOpenTile && !tile && (
            <button
              className="tk-icon-button"
              type="button"
              title="固定到桌面"
              onClick={() => onOpenTile(note)}>
              <PanelTop className="h-4 w-4" />
            </button>
          )}
          {tile && onCloseTile && (
            <button
              className="tk-icon-button"
              type="button"
              title="取消固定"
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
              onClick={() => onDelete(note)}>
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      <input
        className="tk-sticky-title-input"
        value={draft.title}
        onChange={(event) => updateDraft({ title: event.target.value })}
        placeholder="便签标题"
      />
      <div className={`tk-sticky-editor-content tk-sticky-view-${viewMode}`}>
        {(viewMode === "edit" || viewMode === "split") && (
          <textarea
            className="tk-sticky-content-input"
            value={draft.content}
            onChange={(event) => updateDraft({ content: event.target.value })}
            placeholder="写点临时想法、待办、代码片段或备忘..."
          />
        )}
        {(viewMode === "preview" || viewMode === "split") && (
          <StickyMarkdownPreview content={draft.content} />
        )}
      </div>
      <div className="tk-sticky-editor-footer">
        <span>{draft.content.trim().length} 字符</span>
        <span>更新于 {formatStickyNoteTime(note.updatedAt)}</span>
      </div>
      {error && <p className="tk-sticky-error">{error}</p>}
    </article>
  )
}

function noteToDraft(note: StickyNote): StickyNoteDraft {
  return {
    id: note.id,
    title: note.title,
    content: note.content,
    color: note.color,
    pinned: note.pinned,
    category: note.category,
    viewMode: note.viewMode,
    tilePinned: note.tilePinned,
  }
}
