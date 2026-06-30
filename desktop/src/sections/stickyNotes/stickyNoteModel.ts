import type { StickyNote, StickyNoteDraft } from "../../types"

export const STICKY_NOTE_COLORS = ["#fff7c2", "#e0f2fe", "#dcfce7", "#fae8ff", "#ffe4e6"]

export const DEFAULT_STICKY_NOTE_COLOR = STICKY_NOTE_COLORS[0]

export function stickyNoteTitle(note: Pick<StickyNote, "title" | "content">): string {
  const title = note.title.trim()
  if (title) return title
  const firstLine = note.content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
  return firstLine ? firstLine.slice(0, 28) : "未命名便签"
}

export function stickyNotePreview(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 92) || "空白便签"
}

export function stickyNoteSignature(draft: StickyNoteDraft): string {
  return [
    draft.id ?? "",
    draft.title,
    draft.content,
    draft.color ?? "",
    draft.pinned ? "1" : "0",
    draft.category ?? "",
    draft.viewMode ?? "edit",
    draft.tilePinned ? "1" : "0",
  ].join("\u0000")
}

export function formatStickyNoteTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "--"
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

export function searchableStickyText(note: StickyNote): string {
  return [note.title, note.content, note.category, note.preview, note.updatedAt].join(" ").toLowerCase()
}
