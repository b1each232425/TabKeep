import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import {
  Bell,
  BellOff,
  Bold,
  CheckCircle2,
  Clock3,
  Code2,
  ExternalLink,
  Eye,
  ImagePlus,
  Italic,
  Link,
  ListChecks,
  Pencil,
  Pin,
  Quote,
  Trash2,
} from "lucide-react"

import {
  cancelStickyNoteReminder,
  completeStickyNoteReminder,
  getStickyNote,
  saveStickyNote,
  saveStickyNoteImage,
  setStickyNoteReminder,
  snoozeStickyNoteReminder,
} from "../../api/stickyNotes"
import { ConfirmDialog } from "../../components/primitives"
import type { StickyNote, StickyNoteDraft } from "../../types"
import {
  DEFAULT_STICKY_NOTE_COLOR,
  formatStickyReminderTime,
  formatStickyNoteTime,
  stickyReminderIsOverdue,
  stickyTaskProgress,
  stickyNoteSignature,
  stickyNoteTitle,
} from "./stickyNoteModel"
import { StickyMarkdownPreview } from "./StickyMarkdownPreview"
import {
  indentMarkdownSelection,
  insertMarkdownAtSelection,
  prefixMarkdownLines,
  wrapMarkdownSelection,
  type MarkdownEditResult,
} from "./stickyMarkdownEditing"

interface StickyNoteEditorProps {
  note: StickyNote
  compact?: boolean
  categories?: string[]
  onSaved?: (note: StickyNote) => void
  onDelete?: (note: StickyNote) => void | Promise<void>
  onOpenWindow?: (note: StickyNote) => void
}

type StickyFlushEvent = CustomEvent<{ done?: () => void }>
type StickySaveState = "idle" | "dirty" | "saving" | "error"
type MarkdownAction = "bold" | "italic" | "link" | "code" | "quote" | "task"

const MAX_STICKY_IMAGE_BYTES = 12 * 1024 * 1024
const STICKY_NOTE_CONFLICT_PREFIX = "STICKY_NOTE_CONFLICT:"
const SUPPORTED_STICKY_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
])

export function StickyNoteEditor({
  note,
  compact = false,
  categories = [],
  onSaved,
  onDelete,
  onOpenWindow,
}: StickyNoteEditorProps) {
  const [draft, setDraft] = useState<StickyNoteDraft>(() => noteToDraft(note))
  const [error, setError] = useState("")
  const [saveConflict, setSaveConflict] = useState(false)
  const [saveState, setSaveState] = useState<StickySaveState>("idle")
  const [deleteRequested, setDeleteRequested] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [imageBusy, setImageBusy] = useState(false)
  const [imageDragging, setImageDragging] = useState(false)
  const [reminderOpen, setReminderOpen] = useState(false)
  const [customReminderAt, setCustomReminderAt] = useState(() =>
    toDateTimeLocalValue(nextReminderDate(24 * 60)),
  )
  const lastSavedSignature = useRef(stickyNoteSignature(noteToDraft(note)))
  const latestDraft = useRef(draft)
  const contentInput = useRef<HTMLTextAreaElement | null>(null)
  const imagePicker = useRef<HTMLInputElement | null>(null)
  const imageProcessing = useRef(false)
  const saveTimer = useRef<number | null>(null)
  const saveQueue = useRef<Promise<StickyNote | null>>(Promise.resolve(null))
  const deleting = useRef(false)
  latestDraft.current = draft

  useEffect(() => {
    const next = noteToDraft(note)
    const nextSignature = stickyNoteSignature(next)
    const currentSignature = stickyNoteSignature(latestDraft.current)
    const hasLocalChanges = currentSignature !== lastSavedSignature.current
    if (hasLocalChanges && currentSignature !== nextSignature) {
      setSaveConflict(true)
      setSaveState("error")
      setError("便签已在另一个窗口更新，当前修改仍保留在这里")
      return
    }
    setDraft(next)
    latestDraft.current = next
    lastSavedSignature.current = nextSignature
    deleting.current = false
    setDeleteRequested(false)
    setSaveState("idle")
    setSaveConflict(false)
    setError("")
  }, [note.id, note.revision])

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
            const savedDraft = noteToDraft(saved)
            latestDraft.current = savedDraft
            setDraft(savedDraft)
            lastSavedSignature.current = stickyNoteSignature(savedDraft)
            setSaveState("idle")
            setSaveConflict(false)
            onSaved?.(saved)
          } else {
            setSaveState("dirty")
          }
          return saved
        } catch (err) {
          if (!deleting.current && stickyNoteSignature(latestDraft.current) === requestSignature) {
            const message = stickyNoteErrorMessage(err)
            setError(message)
            setSaveConflict(isStickyNoteConflict(err))
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

  const applyMarkdownEdit = (edit: MarkdownEditResult) => {
    updateDraft({ content: edit.value })
    window.requestAnimationFrame(() => {
      contentInput.current?.focus()
      contentInput.current?.setSelectionRange(edit.selectionStart, edit.selectionEnd)
    })
  }

  const applyMarkdownAction = (action: MarkdownAction) => {
    const textarea = contentInput.current
    if (!textarea) return
    const { value, selectionStart, selectionEnd } = textarea
    const edit = (() => {
      switch (action) {
        case "bold":
          return wrapMarkdownSelection(value, selectionStart, selectionEnd, "**")
        case "italic":
          return wrapMarkdownSelection(value, selectionStart, selectionEnd, "_")
        case "link":
          return wrapMarkdownSelection(
            value,
            selectionStart,
            selectionEnd,
            "[",
            "](https://)",
            "链接文字",
          )
        case "code":
          return wrapMarkdownSelection(value, selectionStart, selectionEnd, "`", "`", "代码")
        case "quote":
          return prefixMarkdownLines(value, selectionStart, selectionEnd, "> ")
        case "task":
          return prefixMarkdownLines(value, selectionStart, selectionEnd, "- [ ] ")
      }
    })()
    applyMarkdownEdit(edit)
  }

  const handleEditorKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Tab") {
      event.preventDefault()
      applyMarkdownEdit(
        indentMarkdownSelection(
          event.currentTarget.value,
          event.currentTarget.selectionStart,
          event.currentTarget.selectionEnd,
          event.shiftKey,
        ),
      )
      return
    }
    if (!(event.ctrlKey || event.metaKey)) return
    const action =
      event.key.toLowerCase() === "b"
        ? "bold"
        : event.key.toLowerCase() === "i"
          ? "italic"
          : event.key.toLowerCase() === "k"
            ? "link"
            : null
    if (!action) return
    event.preventDefault()
    applyMarkdownAction(action)
  }

  const insertImages = async (files: File[]) => {
    if (imageProcessing.current || files.length === 0) return
    imageProcessing.current = true
    setImageBusy(true)
    setError("")
    try {
      const markdown: string[] = []
      for (const file of files) {
        if (!SUPPORTED_STICKY_IMAGE_TYPES.has(file.type)) {
          throw new Error("仅支持 PNG、JPEG、GIF 和 WebP 图片")
        }
        if (file.size > MAX_STICKY_IMAGE_BYTES) {
          throw new Error("图片过大，单张不能超过 12 MB")
        }
        const dataUrl = await readFileAsDataUrl(file)
        const asset = await saveStickyNoteImage(note.id, dataUrl)
        const alt = file.name.replace(/\.[^.]+$/, "").replace(/[[\]]/g, "")
        markdown.push(`![${alt}](${asset.markdownUrl})`)
      }

      const textarea = contentInput.current
      const value = latestDraft.current.content
      const selectionStart = textarea?.selectionStart ?? value.length
      const selectionEnd = textarea?.selectionEnd ?? value.length
      applyMarkdownEdit(
        insertMarkdownAtSelection(value, selectionStart, selectionEnd, markdown.join("\n")),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      imageProcessing.current = false
      setImageBusy(false)
      setImageDragging(false)
    }
  }

  const handleImagePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = getImageFiles(event.clipboardData)
    if (files.length === 0) return
    event.preventDefault()
    void insertImages(files)
  }

  const handleImageDrop = (event: React.DragEvent<HTMLTextAreaElement>) => {
    const files = getImageFiles(event.dataTransfer)
    if (files.length === 0) return
    event.preventDefault()
    setImageDragging(false)
    void insertImages(files)
  }

  const requestDelete = async () => {
    if (!onDelete || deleteRequested) return
    setDeleteConfirmOpen(false)
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
  const isSystemNote = note.systemKind === "dailyPoetry"
  const effectiveViewMode = isSystemNote ? "preview" : viewMode
  const reminder = note.reminder
  const reminderActive = reminder && reminder.status !== "completed"
  const reminderOverdue = stickyReminderIsOverdue(reminder)
  const taskProgress = stickyTaskProgress(draft.content)
  const categoryOptions = Array.from(new Set(categories.filter(Boolean)))
  const editorModeClass = compact ? "tk-sticky-editor-compact" : "tk-sticky-editor-main"

  return (
    <article
      className={`tk-sticky-editor ${editorModeClass}`}
      data-save-state={saveState}
      data-system-kind={note.systemKind ?? undefined}
      aria-busy={deleteRequested}
      style={{ ["--sticky-note-color" as string]: DEFAULT_STICKY_NOTE_COLOR }}>
      <div className="tk-sticky-editor-toolbar">
        <div className="tk-sticky-toolbar-meta">
          {isSystemNote ? (
            <span className="tk-sticky-system-label">
              <Quote className="h-3.5 w-3.5" />
              诗笺
            </span>
          ) : (
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
          {!isSystemNote && (
            <>
              <button
                className={`tk-icon-button ${reminderActive ? "tk-icon-button-active" : ""}`}
                type="button"
                title={reminderActive ? formatStickyReminderTime(reminder.dueAt) : "设置提醒"}
                aria-label={reminderActive ? "查看便签提醒" : "设置便签提醒"}
                disabled={deleteRequested}
                onClick={() => setReminderOpen((current) => !current)}>
                <Bell className="h-4 w-4" />
              </button>
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
            </>
          )}
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
          {onDelete && !isSystemNote && (
            <button
              className="tk-icon-button tk-icon-button-danger"
              type="button"
              title="删除便签"
              aria-label="删除便签"
              disabled={deleteRequested}
              onClick={() => {
                setDeleteConfirmOpen(true)
              }}>
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {reminderOpen && !isSystemNote && (
        <div className="tk-sticky-reminder-panel">
          <div className="tk-sticky-reminder-heading">
            <div>
              <strong>提醒</strong>
              <span>{reminderLabel(reminder)}</span>
            </div>
            {reminder && (
              <button
                className="tk-icon-button"
                type="button"
                title="取消提醒"
                aria-label="取消提醒"
                onClick={() => {
                  void runReminderAction(async () => cancelStickyNoteReminder(note.id))
                }}>
                <BellOff className="h-4 w-4" />
              </button>
            )}
          </div>
          <div className="tk-sticky-reminder-presets">
            <button type="button" onClick={() => void setReminder(nextReminderDate(30))}>
              30 分钟后
            </button>
            <button type="button" onClick={() => void setReminder(nextReminderDate(60))}>
              1 小时后
            </button>
            <button type="button" onClick={() => void setReminder(todayAt(20, 0))}>
              今天晚上
            </button>
            <button type="button" onClick={() => void setReminder(tomorrowAt(9, 0))}>
              明天上午
            </button>
          </div>
          <div className="tk-sticky-reminder-custom">
            <input
              type="datetime-local"
              value={customReminderAt}
              min={toDateTimeLocalValue(nextReminderDate(1))}
              onChange={(event) => setCustomReminderAt(event.target.value)}
            />
            <button
              type="button"
              onClick={() => {
                const dueAt = new Date(customReminderAt)
                if (Number.isNaN(dueAt.getTime()) || dueAt <= new Date()) {
                  setError("请选择晚于当前时间的提醒")
                  return
                }
                void setReminder(dueAt)
              }}>
              设置
            </button>
          </div>
          {reminderActive && (
            <div className="tk-sticky-reminder-actions">
              <button
                type="button"
                onClick={() => void runReminderAction(() => snoozeStickyNoteReminder(note.id, 10))}>
                <Clock3 className="h-3.5 w-3.5" />
                延后 10 分钟
              </button>
              <button
                type="button"
                onClick={() => void runReminderAction(() => snoozeStickyNoteReminder(note.id, 60))}>
                延后 1 小时
              </button>
              <button
                type="button"
                onClick={() => void runReminderAction(() => completeStickyNoteReminder(note.id))}>
                <CheckCircle2 className="h-3.5 w-3.5" />
                完成
              </button>
            </div>
          )}
        </div>
      )}

      {effectiveViewMode === "edit" && (
        <div className="tk-sticky-format-toolbar" role="toolbar" aria-label="Markdown 格式">
          <MarkdownToolButton
            label="加粗"
            disabled={deleteRequested}
            onClick={() => applyMarkdownAction("bold")}>
            <Bold className="h-3.5 w-3.5" />
          </MarkdownToolButton>
          <MarkdownToolButton
            label="斜体"
            disabled={deleteRequested}
            onClick={() => applyMarkdownAction("italic")}>
            <Italic className="h-3.5 w-3.5" />
          </MarkdownToolButton>
          <MarkdownToolButton
            label="链接"
            disabled={deleteRequested}
            onClick={() => applyMarkdownAction("link")}>
            <Link className="h-3.5 w-3.5" />
          </MarkdownToolButton>
          <MarkdownToolButton
            label="行内代码"
            disabled={deleteRequested}
            onClick={() => applyMarkdownAction("code")}>
            <Code2 className="h-3.5 w-3.5" />
          </MarkdownToolButton>
          <MarkdownToolButton
            label="引用"
            disabled={deleteRequested}
            onClick={() => applyMarkdownAction("quote")}>
            <Quote className="h-3.5 w-3.5" />
          </MarkdownToolButton>
          <MarkdownToolButton
            label="任务列表"
            disabled={deleteRequested}
            onClick={() => applyMarkdownAction("task")}>
            <ListChecks className="h-3.5 w-3.5" />
          </MarkdownToolButton>
          <MarkdownToolButton
            label="添加图片"
            disabled={deleteRequested || imageBusy}
            onClick={() => imagePicker.current?.click()}>
            <ImagePlus className="h-3.5 w-3.5" />
          </MarkdownToolButton>
          <input
            ref={imagePicker}
            className="hidden"
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            tabIndex={-1}
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? [])
              event.currentTarget.value = ""
              void insertImages(files)
            }}
          />
          {imageBusy && <span className="tk-sticky-image-status">正在添加图片</span>}
        </div>
      )}

      {!isSystemNote && (
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
      )}
      <div className={`tk-sticky-editor-content tk-sticky-view-${effectiveViewMode}`}>
        {effectiveViewMode === "edit" && (
          <textarea
            ref={contentInput}
            className="tk-sticky-content-input"
            value={draft.content}
            disabled={deleteRequested}
            onChange={(event) => updateDraft({ content: event.target.value })}
            onKeyDown={handleEditorKeyDown}
            onPaste={handleImagePaste}
            onDrop={handleImageDrop}
            onDragOver={(event) => {
              if (getImageFiles(event.dataTransfer).length === 0) return
              event.preventDefault()
              event.dataTransfer.dropEffect = "copy"
              setImageDragging(true)
            }}
            onDragLeave={() => setImageDragging(false)}
            onBlur={() => {
              void persistIfChanged()
            }}
            placeholder="写点临时想法、待办、代码片段或备忘..."
          />
        )}
        {effectiveViewMode === "edit" && imageDragging && (
          <div className="tk-sticky-image-drop-hint">松开以添加图片</div>
        )}
        {effectiveViewMode === "preview" && (
          <StickyMarkdownPreview noteId={note.id} content={draft.content} />
        )}
      </div>
      <div className="tk-sticky-editor-footer">
        <div className="tk-sticky-footer-meta">
          {!isSystemNote && <span>{draft.content.trim().length} 字符</span>}
          {!isSystemNote && taskProgress.total > 0 && (
            <span>{taskProgress.completed}/{taskProgress.total} 项完成</span>
          )}
          {!isSystemNote && reminderActive && (
            <span className={reminderOverdue ? "tk-sticky-reminder-overdue" : ""}>
              <Bell className="h-3 w-3" />
              {reminderOverdue
                ? "已到期"
                : formatStickyReminderTime(reminder.dueAt)}
            </span>
          )}
        </div>
        <span>更新于 {formatStickyNoteTime(note.updatedAt)}</span>
      </div>
      {error && (
        <div className="tk-sticky-error" role="alert">
          <span>{error}</span>
          {saveConflict && (
            <button type="button" onClick={() => void reloadLatestNote()}>
              载入最新内容
            </button>
          )}
        </div>
      )}
      {!isSystemNote && <ConfirmDialog
        open={deleteConfirmOpen}
        title="删除便签？"
        description={
          <>
            「{stickyNoteTitle(note)}」删除后无法恢复，请确认是否继续。
          </>
        }
        confirmLabel="删除"
        busy={deleteRequested}
        onCancel={() => setDeleteConfirmOpen(false)}
        onConfirm={() => {
          void requestDelete()
        }}
      />}
    </article>
  )

  async function setReminder(dueAt: Date) {
    await runReminderAction(() => setStickyNoteReminder(note.id, dueAt.toISOString()))
    setReminderOpen(false)
  }

  async function runReminderAction(action: () => Promise<StickyNote>) {
    setError("")
    try {
      await persistIfChanged()
      const updated = await action()
      onSaved?.(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function reloadLatestNote() {
    try {
      const latest = await getStickyNote(note.id)
      const next = noteToDraft(latest)
      latestDraft.current = next
      setDraft(next)
      lastSavedSignature.current = stickyNoteSignature(next)
      setSaveConflict(false)
      setSaveState("idle")
      setError("")
      onSaved?.(latest)
    } catch (err) {
      setError(stickyNoteErrorMessage(err))
    }
  }
}

function MarkdownToolButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      className="tk-sticky-format-button"
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}>
      {children}
    </button>
  )
}

function getImageFiles(dataTransfer: DataTransfer): File[] {
  const files = Array.from(dataTransfer.files).filter((file) =>
    SUPPORTED_STICKY_IMAGE_TYPES.has(file.type),
  )
  if (files.length > 0) return files
  return Array.from(dataTransfer.items)
    .filter((item) => item.kind === "file" && SUPPORTED_STICKY_IMAGE_TYPES.has(item.type))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file))
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result)
      } else {
        reject(new Error("读取图片失败"))
      }
    }
    reader.onerror = () => reject(new Error("读取图片失败"))
    reader.readAsDataURL(file)
  })
}

function noteToDraft(note: StickyNote): StickyNoteDraft {
  return {
    id: note.id,
    revision: note.revision,
    title: note.title,
    content: note.content,
    color: DEFAULT_STICKY_NOTE_COLOR,
    pinned: note.pinned,
    category: note.category,
    viewMode: note.viewMode === "preview" ? "preview" : "edit",
  }
}

function isStickyNoteConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes(STICKY_NOTE_CONFLICT_PREFIX)
}

function stickyNoteErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const prefixIndex = message.indexOf(STICKY_NOTE_CONFLICT_PREFIX)
  return prefixIndex >= 0
    ? message.slice(prefixIndex + STICKY_NOTE_CONFLICT_PREFIX.length)
    : message
}

function reminderLabel(reminder: StickyNote["reminder"]): string {
  if (!reminder) return "选择提醒时间"
  if (reminder.status === "completed") return "已完成"
  if (stickyReminderIsOverdue(reminder)) {
    return `已到期 · ${formatStickyReminderTime(reminder.dueAt)}`
  }
  return formatStickyReminderTime(reminder.dueAt)
}

function nextReminderDate(minutes: number): Date {
  return new Date(Date.now() + minutes * 60_000)
}

function todayAt(hours: number, minutes: number): Date {
  const date = new Date()
  date.setHours(hours, minutes, 0, 0)
  if (date <= new Date()) date.setDate(date.getDate() + 1)
  return date
}

function tomorrowAt(hours: number, minutes: number): Date {
  const date = new Date()
  date.setDate(date.getDate() + 1)
  date.setHours(hours, minutes, 0, 0)
  return date
}

function toDateTimeLocalValue(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}
