import { invoke } from "@tauri-apps/api/core"

import type { StickyNote, StickyNoteDraft } from "../types"

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
