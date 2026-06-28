import { useEffect, useState } from "react"
import type { MouseEvent } from "react"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { Minimize2, X } from "lucide-react"

import { getStickyNote } from "../../api"
import type { StickyNote } from "../../types"
import { StickyNoteEditor } from "./StickyNoteEditor"
import { stickyNoteTitle } from "./stickyNoteModel"

type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West"

const RESIZE_HANDLES: Array<{
  direction: ResizeDirection
  className: string
  label: string
}> = [
  { direction: "North", className: "tk-sticky-resize-n", label: "向上调整大小" },
  { direction: "South", className: "tk-sticky-resize-s", label: "向下调整大小" },
  { direction: "West", className: "tk-sticky-resize-w", label: "向左调整大小" },
  { direction: "East", className: "tk-sticky-resize-e", label: "向右调整大小" },
  { direction: "NorthWest", className: "tk-sticky-resize-nw", label: "左上调整大小" },
  { direction: "NorthEast", className: "tk-sticky-resize-ne", label: "右上调整大小" },
  { direction: "SouthWest", className: "tk-sticky-resize-sw", label: "左下调整大小" },
  { direction: "SouthEast", className: "tk-sticky-resize-se", label: "右下调整大小" },
]

export function StickyNoteWindow() {
  const noteId = new URLSearchParams(window.location.search).get("noteId") ?? ""
  const [note, setNote] = useState<StickyNote | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    const root = document.getElementById("root")
    document.documentElement.classList.add("tk-sticky-window-root")
    document.body.classList.add("tk-sticky-window-root")
    root?.classList.add("tk-sticky-window-root")
    return () => {
      document.documentElement.classList.remove("tk-sticky-window-root")
      document.body.classList.remove("tk-sticky-window-root")
      root?.classList.remove("tk-sticky-window-root")
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const loaded = await getStickyNote(noteId)
        if (!cancelled) setNote(loaded)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [noteId])

  const startDrag = async (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    try {
      await getCurrentWindow().startDragging()
    } catch (err) {
      // Tauri can reject dragging after the pointer is released.
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const startResize = async (
    direction: ResizeDirection,
    event: MouseEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    try {
      await getCurrentWindow().startResizeDragging(direction)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const minimize = async () => {
    try {
      await getCurrentWindow().minimize()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const close = async () => {
    try {
      await getCurrentWindow().close()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="tk-sticky-window-shell">
      {RESIZE_HANDLES.map((handle) => (
        <div
          key={handle.direction}
          className={`tk-sticky-resize-handle ${handle.className}`}
          role="presentation"
          aria-label={handle.label}
          onMouseDown={(event) => startResize(handle.direction, event)}
        />
      ))}
      <div className="tk-sticky-window-titlebar">
        <div
          className="tk-sticky-window-drag"
          data-tauri-drag-region="true"
          onMouseDown={startDrag}>
          <span className="tk-sticky-window-dot" style={{ backgroundColor: note?.color }} />
          <span className="truncate">{note ? stickyNoteTitle(note) : "TabKeep 便签"}</span>
        </div>
        <div className="tk-sticky-window-controls">
          <button type="button" onClick={minimize} aria-label="最小化">
            <Minimize2 className="h-4 w-4" />
          </button>
          <button type="button" onClick={close} aria-label="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {note ? (
        <StickyNoteEditor note={note} compact onSaved={setNote} />
      ) : (
        <div className="tk-sticky-window-loading">{error || "正在加载便签..."}</div>
      )}
    </div>
  )
}
