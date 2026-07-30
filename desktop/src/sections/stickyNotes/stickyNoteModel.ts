import type { StickyNote, StickyNoteDraft } from "../../types"

export const DEFAULT_STICKY_NOTE_COLOR = "#ffd6e8"

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
  ].join("\u0000")
}

export function formatStickyNoteTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "--"
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

export function formatStickyReminderTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "时间无效"
  const now = new Date()
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  const dayAfterTomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2)
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
  if (date >= tomorrow && date < dayAfterTomorrow) return `明天 ${time}`
  if (date.toDateString() === now.toDateString()) return `今天 ${time}`
  return `${date.getMonth() + 1}/${date.getDate()} ${time}`
}

export function stickyTaskProgress(content: string): { completed: number; total: number } {
  const tasks = Array.from(content.matchAll(/^\s*[-*+]\s+\[([ xX])\]\s+/gm))
  return {
    completed: tasks.filter((match) => match[1].toLowerCase() === "x").length,
    total: tasks.length,
  }
}

export function stickyReminderIsOverdue(
  reminder: StickyNote["reminder"],
  now = Date.now(),
): boolean {
  if (!reminder || reminder.status === "completed") return false
  const dueAt = new Date(reminder.dueAt).getTime()
  return reminder.status === "notified" || (!Number.isNaN(dueAt) && dueAt <= now)
}

export function searchableStickyText(note: StickyNote): string {
  return [note.title, note.content, note.category, note.preview, note.updatedAt].join(" ").toLowerCase()
}
