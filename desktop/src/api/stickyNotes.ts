import { invoke } from "@tauri-apps/api/core"

import type { StickyNote, StickyNoteDraft, StickyShortcutConfig } from "../types"

export async function listStickyNotes(): Promise<StickyNote[]> {
  return invoke<StickyNote[]>("sticky_notes_list")
}

export async function getStickyNote(id: string): Promise<StickyNote> {
  return invoke<StickyNote>("sticky_notes_get", { id })
}

export async function saveStickyNote(draft: StickyNoteDraft): Promise<StickyNote> {
  return invoke<StickyNote>("sticky_notes_save", { draft })
}

export async function deleteStickyNote(id: string): Promise<void> {
  await invoke("sticky_notes_delete", { id })
}

export async function openStickyNoteWindow(id: string): Promise<string> {
  return invoke<string>("open_sticky_note_window", { id })
}

export async function createStickyNoteWindow(): Promise<StickyNote> {
  return invoke<StickyNote>("create_sticky_note_window")
}

export async function importStickyNoteMarkdown(path?: string, category?: string): Promise<StickyNote> {
  return invoke<StickyNote>("sticky_notes_import_markdown", { path, category })
}

export async function exportStickyNoteMarkdown(id: string, path?: string): Promise<void> {
  await invoke("sticky_notes_export_markdown", { id, path })
}

export async function listStickyNoteCategories(): Promise<string[]> {
  return invoke<string[]>("sticky_notes_list_categories")
}

export async function createStickyNoteCategory(name: string): Promise<void> {
  await invoke("sticky_notes_create_category", { name })
}

export async function renameStickyNoteCategory(oldName: string, newName: string): Promise<void> {
  await invoke("sticky_notes_rename_category", { oldName, newName })
}

export async function deleteStickyNoteCategory(name: string): Promise<void> {
  await invoke("sticky_notes_delete_category", { name })
}

export async function moveStickyNoteCategory(id: string, category: string): Promise<StickyNote> {
  return invoke<StickyNote>("sticky_notes_move_category", { id, category })
}

export async function openStickyNoteTileWindow(id: string): Promise<string> {
  return invoke<string>("open_sticky_note_tile_window", { id })
}

export async function getStickyNoteShortcutConfig(): Promise<StickyShortcutConfig> {
  return invoke<StickyShortcutConfig>("get_sticky_note_shortcut_config")
}

export async function setStickyNoteShortcutConfig(config: StickyShortcutConfig): Promise<StickyShortcutConfig> {
  return invoke<StickyShortcutConfig>("set_sticky_note_shortcut_config", { config })
}
