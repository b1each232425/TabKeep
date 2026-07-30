import { useCallback, useEffect, useRef, useState } from "react"
import type { MouseEvent } from "react"
import { listen } from "@tauri-apps/api/event"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { Minus, X } from "lucide-react"

import { deleteStickyNote, getStickyNote, listStickyNoteCategories } from "../../api/stickyNotes"
import type { StickyNote } from "../../types"
import { DEFAULT_STICKY_NOTE_COLOR } from "./stickyNoteModel"
import { StickyNoteEditor } from "./StickyNoteEditor"

type StickyNotesChangedPayload = {
  action?: string
  noteId?: string | null
}

export function StickyNoteWindow() {
  const noteId = getStickyNoteId()
  const [note, setNote] = useState<StickyNote | null>(null)
  const [categories, setCategories] = useState<string[]>([])
  const [error, setError] = useState("")
  const closing = useRef(false)

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
    if (!note) return
    void getCurrentWindow().setTitle(`TabKeep 便签 - ${stickyWindowTitle(note)}`)
  }, [note])

  const flushAndDestroyWindow = useCallback(async () => {
    if (closing.current) return
    closing.current = true
    try {
      if (!note) {
        await getCurrentWindow().destroy()
        return
      }
      const activeElement = document.activeElement
      if (activeElement instanceof HTMLElement) {
        activeElement.blur()
      }
      await requestStickyEditorFlush()
      await getCurrentWindow().destroy()
    } catch (err) {
      closing.current = false
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [note])

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined

    getCurrentWindow().onCloseRequested((event) => {
      if (closing.current) return
      event.preventDefault()
      void flushAndDestroyWindow()
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
  }, [flushAndDestroyWindow])

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
        closing.current = true
        void getCurrentWindow().destroy()
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
      closing.current = true
      await getCurrentWindow().destroy()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      throw new Error(message)
    }
  }

  const startDrag = async (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.detail > 1) return
    try {
      await getCurrentWindow().startDragging()
    } catch {
      // Native dragging may be rejected if the pointer is already released.
    }
  }

  const stopControlDrag = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
  }

  const closeWindow = () => {
    void flushAndDestroyWindow()
  }

  const minimizeWindow = () => {
    void getCurrentWindow().minimize()
  }

  return (
    <div
      className="tk-sticky-window-shell tk-sticky-window-shell-note"
      style={{ ["--sticky-note-color" as string]: DEFAULT_STICKY_NOTE_COLOR }}>
      <div className="tk-sticky-window-titlebar" onMouseDown={startDrag}>
        <div className="tk-sticky-window-title">
          <span className="tk-sticky-window-title-mark" />
          <span>便签</span>
          {note && <span className="tk-sticky-window-title-name">{note.title.trim() || "未命名"}</span>}
        </div>
        <div className="tk-sticky-window-controls">
          <button
            type="button"
            title="最小化"
            aria-label="最小化便签窗口"
            onMouseDown={stopControlDrag}
            onClick={minimizeWindow}>
            <Minus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title="关闭"
            aria-label="关闭便签窗口"
            onMouseDown={stopControlDrag}
            onClick={closeWindow}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {note ? (
        <>
          <StickyNoteEditor
            note={note}
            compact
            categories={categories}
            onSaved={setNote}
            onDelete={note.systemKind === "dailyPoetry" ? undefined : deleteNote}
          />
          {error && <p className="tk-sticky-error px-3 pb-2" role="alert">{error}</p>}
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

function stickyWindowTitle(note: StickyNote): string {
  const title = note.title.trim()
  if (title) return title.slice(0, 24)
  const firstLine = note.content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
  return firstLine ? firstLine.slice(0, 24) : "未命名"
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

function requestStickyEditorFlush(): Promise<void> {
  return new Promise((resolve) => {
    let resolved = false
    const done = () => {
      if (resolved) return
      resolved = true
      resolve()
    }
    window.dispatchEvent(new CustomEvent("tk-sticky-request-flush", { detail: { done } }))
    window.setTimeout(done, 2500)
  })
}
