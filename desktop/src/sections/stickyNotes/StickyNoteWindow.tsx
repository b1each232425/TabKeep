import { useCallback, useEffect, useState } from "react"
import { listen } from "@tauri-apps/api/event"
import { getCurrentWindow } from "@tauri-apps/api/window"

import { deleteStickyNote, getStickyNote, listStickyNoteCategories } from "../../api/stickyNotes"
import type { StickyNote } from "../../types"
import { StickyNoteEditor } from "./StickyNoteEditor"

type StickyNotesChangedPayload = {
  action?: string
  noteId?: string | null
}

export function StickyNoteWindow() {
  const noteId = getStickyNoteId()
  const mode = new URLSearchParams(window.location.search).get("mode")
  const tileMode = mode === "tile"
  const [note, setNote] = useState<StickyNote | null>(null)
  const [categories, setCategories] = useState<string[]>([])
  const [error, setError] = useState("")

  const loadNote = useCallback(async () => {
    if (!noteId) {
      setError("便签窗口缺少 noteId，请从主窗口重新打开。")
      return
    }
    try {
      const loaded = await getStickyNote(noteId)
      setNote(loaded)
      setError("")
      void postStickyWindowDebugResult({
        ok: true,
        phase: "note-loaded",
        noteId: loaded.id,
        windowLabel: getCurrentWindow().label,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      void postStickyWindowDebugResult({
        ok: false,
        phase: "note-load-error",
        noteId,
        windowLabel: getCurrentWindow().label,
        error: message,
      })
    }
  }, [noteId])

  const loadCategories = useCallback(async () => {
    try {
      const loaded = await listStickyNoteCategories()
      setCategories(loaded)
    } catch {
      setCategories([])
    }
  }, [])

  useEffect(() => {
    const root = document.getElementById("root")
    document.documentElement.classList.add("tk-sticky-window-page")
    document.body.classList.add("tk-sticky-window-page")
    root?.classList.add("tk-sticky-window-page")
    let cancelled = false
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (cancelled) return
        const currentWindow = getCurrentWindow()
        void currentWindow
          .show()
          .then(() => currentWindow.setFocus())
          .catch(() => undefined)
      })
    })
    return () => {
      cancelled = true
      document.documentElement.classList.remove("tk-sticky-window-page")
      document.body.classList.remove("tk-sticky-window-page")
      root?.classList.remove("tk-sticky-window-page")
    }
  }, [])

  useEffect(() => {
    void loadNote()
  }, [loadNote])

  useEffect(() => {
    void loadCategories()
  }, [loadCategories])

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined

    listen<StickyNotesChangedPayload>("sticky-notes-changed", (event) => {
      const payload = event.payload ?? {}
      if (payload.action === "category") {
        void loadCategories()
        void loadNote()
        return
      }
      if (payload.noteId !== noteId) return
      if (payload.action === "delete") {
        void getCurrentWindow().close()
        return
      }
      void loadNote()
    }).then((value) => {
      if (disposed) {
        value()
      } else {
        unlisten = value
      }
    }).catch((err) => {
      setError(err instanceof Error ? err.message : String(err))
    })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [loadCategories, loadNote, noteId])

  const deleteNote = async (target: StickyNote) => {
    try {
      await deleteStickyNote(target.id)
      await getCurrentWindow().close()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div
      className="tk-sticky-window-shell"
      style={{ ["--sticky-note-color" as string]: note?.color ?? "#fff7c2" }}>
      {note ? (
        <>
          <StickyNoteEditor
            note={note}
            compact
            tile={tileMode}
            categories={categories}
            onSaved={setNote}
            onDelete={deleteNote}
            onCloseTile={() => {
              void getCurrentWindow().close()
            }}
          />
          {error && <p className="tk-sticky-error px-3 pb-2">{error}</p>}
        </>
      ) : (
        <div className="tk-sticky-window-loading">{error || "正在加载便签..."}</div>
      )}
    </div>
  )
}

function getStickyNoteId(): string {
  const fromQuery = new URLSearchParams(window.location.search).get("noteId")?.trim()
  if (fromQuery) return fromQuery
  try {
    return stickyNoteIdFromWindowLabel(getCurrentWindow().label)
  } catch {
    return ""
  }
}

function stickyNoteIdFromWindowLabel(label: string): string {
  const stickyMatch = label.match(
    /^sticky-note-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:--\d+)?$/i,
  )
  if (stickyMatch?.[1]) return stickyMatch[1]

  return label.startsWith("sticky-note-") ? label.slice("sticky-note-".length) : ""
}

async function postStickyWindowDebugResult(payload: unknown) {
  const env = (import.meta as ImportMeta & {
    env?: Record<string, string | boolean | undefined>
  }).env
  if (env?.PROD === true) return
  try {
    await fetch("http://127.0.0.1:38472/debug/sticky/frontend-result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  } catch {
    // Debug-only reporting must not affect sticky note editing.
  }
}
