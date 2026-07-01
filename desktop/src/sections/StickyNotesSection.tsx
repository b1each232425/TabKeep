import { useCallback, useEffect, useMemo, useState } from "react"
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog"
import { listen } from "@tauri-apps/api/event"
import {
  Check,
  FileDown,
  FileUp,
  FolderPlus,
  Maximize2,
  PanelTop,
  Pencil,
  Plus,
  Search,
  StickyNote as StickyNoteIcon,
  Trash2,
  X,
} from "lucide-react"

import {
  createStickyNoteCategory,
  createStickyNoteWindow,
  deleteStickyNoteCategory,
  deleteStickyNote,
  exportStickyNoteMarkdown,
  importStickyNoteMarkdown,
  listStickyNoteCategories,
  listStickyNotes,
  moveStickyNoteCategory,
  openStickyNoteWindow,
  openStickyNoteTileWindow,
  renameStickyNoteCategory,
} from "../api"
import { Button, Notice } from "../components/primitives"
import type { StickyNote } from "../types"
import { StickyNoteEditor } from "./stickyNotes/StickyNoteEditor"
import {
  formatStickyNoteTime,
  searchableStickyText,
  stickyNotePreview,
  stickyNoteTitle,
} from "./stickyNotes/stickyNoteModel"

export function StickyNotesSection() {
  const [notes, setNotes] = useState<StickyNote[]>([])
  const [selectedId, setSelectedId] = useState("")
  const [query, setQuery] = useState("")
  const [categories, setCategories] = useState<string[]>([])
  const [activeCategory, setActiveCategory] = useState("all")
  const [newCategory, setNewCategory] = useState("")
  const [editingCategory, setEditingCategory] = useState<string | null>(null)
  const [editingCategoryName, setEditingCategoryName] = useState("")
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState("")

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [loaded, loadedCategories] = await Promise.all([
        listStickyNotes(),
        listStickyNoteCategories(),
      ])
      setNotes(loaded)
      setCategories(loadedCategories)
      setSelectedId((current) =>
        loaded.some((note) => note.id === current) ? current : loaded[0]?.id || "",
      )
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined

    listen("sticky-notes-changed", () => {
      void refresh()
    }).then((value) => {
      if (disposed) {
        value()
      } else {
        unlisten = value
      }
    }).catch((err) => {
      setStatus(err instanceof Error ? err.message : String(err))
    })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [refresh])

  const filteredNotes = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return notes.filter((note) => {
      const categoryMatched =
        activeCategory === "all" ||
        (activeCategory === "" ? !note.category : note.category === activeCategory)
      if (!categoryMatched) return false
      return !needle || searchableStickyText(note).includes(needle)
    })
  }, [activeCategory, notes, query])

  const selectedNote = filteredNotes.find((note) => note.id === selectedId) ?? filteredNotes[0] ?? null

  const createNote = async () => {
    try {
      const note = await createStickyNoteWindow()
      setNotes((current) => sortNotes([note, ...current.filter((item) => item.id !== note.id)]))
      setSelectedId(note.id)
      setStatus("已创建并打开便签")
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    }
  }

  const updateNote = (updated: StickyNote) => {
    setNotes((current) => sortNotes(current.map((note) => (note.id === updated.id ? updated : note))))
  }

  const addCategory = async () => {
    const name = newCategory.trim()
    if (!name) return
    try {
      await createStickyNoteCategory(name)
      setNewCategory("")
      setActiveCategory(name)
      setStatus("分类已创建")
      await refresh()
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    }
  }

  const startRenameCategory = (category: string) => {
    setEditingCategory(category)
    setEditingCategoryName(category)
  }

  const commitRenameCategory = async () => {
    if (!editingCategory) return
    const name = editingCategoryName.trim()
    if (!name) return
    try {
      await renameStickyNoteCategory(editingCategory, name)
      setActiveCategory((current) => (current === editingCategory ? name : current))
      setEditingCategory(null)
      setEditingCategoryName("")
      setStatus("分类已重命名")
      await refresh()
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    }
  }

  const removeCategory = async (category: string) => {
    try {
      await deleteStickyNoteCategory(category)
      setActiveCategory((current) => (current === category ? "all" : current))
      setStatus("分类已删除，便签已移动到未分类")
      await refresh()
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    }
  }

  const moveSelectedCategory = async (note: StickyNote, category: string) => {
    try {
      const updated = await moveStickyNoteCategory(note.id, category)
      updateNote(updated)
      setStatus(category ? `已移动到「${category}」` : "已移动到未分类")
      await refresh()
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    }
  }

  const deleteNote = async (note: StickyNote, options: { rethrow?: boolean } = {}) => {
    try {
      await deleteStickyNote(note.id)
      setNotes((current) => {
        const next = current.filter((item) => item.id !== note.id)
        setSelectedId((selected) => (selected === note.id ? next[0]?.id ?? "" : selected))
        return next
      })
      setStatus("便签已删除")
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setStatus(message)
      if (options.rethrow) throw new Error(message)
    }
  }

  const openNoteWindow = async (note: StickyNote) => {
    try {
      await openStickyNoteWindow(note.id)
      setStatus("已打开便签小窗")
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    }
  }

  const openNoteTileWindow = async (note: StickyNote) => {
    try {
      await openStickyNoteTileWindow(note.id)
      setStatus("已固定到桌面")
      await refresh()
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    }
  }

  const importMarkdown = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
      })
      const path = Array.isArray(selected) ? selected[0] : selected
      if (!path) return

      const category = activeCategory === "all" ? "" : activeCategory
      const note = await importStickyNoteMarkdown(path, category)
      setNotes((current) => sortNotes([note, ...current.filter((item) => item.id !== note.id)]))
      setSelectedId(note.id)
      setStatus("Markdown 已导入为便签")
      await refresh()
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    }
  }

  const exportMarkdown = async () => {
    if (!selectedNote) return
    try {
      const path = await saveDialog({
        defaultPath: `${suggestMarkdownFileName(selectedNote)}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      })
      if (!path) return

      await exportStickyNoteMarkdown(selectedNote.id, path)
      setStatus("便签已导出为 Markdown")
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="space-y-5">
      <section className="tk-page-hero tk-sticky-hero">
        <div>
          <h1 className="tk-page-title">便签</h1>
          <p className="tk-page-subtitle">随手记</p>
        </div>
        <div className="tk-sticky-hero-actions">
          <span className="tk-sticky-count-badge">{notes.length} 条</span>
          <Button className="tk-sticky-create-button" onClick={createNote}>
            <Plus className="h-4 w-4" />
            新建便签
          </Button>
        </div>
      </section>

      {status && <Notice>{status}</Notice>}

      <section className="tk-sticky-workspace">
        <aside className="tk-sticky-sidebar-panel">
          <div className="tk-sticky-search">
            <Search className="h-4 w-4 text-slate-400" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索标题或正文"
            />
          </div>
          <div className="tk-sticky-category-panel">
            <div className="tk-sticky-category-actions">
              <input
                value={newCategory}
                onChange={(event) => setNewCategory(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && addCategory()}
                placeholder="新分类"
              />
              <button className="tk-icon-button" type="button" title="新建分类" onClick={addCategory}>
                <FolderPlus className="h-4 w-4" />
              </button>
            </div>
            <div className="tk-sticky-category-flow">
              <button
                type="button"
                className={`tk-sticky-category-item ${activeCategory === "all" ? "tk-sticky-category-item-active" : ""}`}
                onClick={() => setActiveCategory("all")}>
                全部
                <span>{notes.length}</span>
              </button>
              <button
                type="button"
                className={`tk-sticky-category-item ${activeCategory === "" ? "tk-sticky-category-item-active" : ""}`}
                onClick={() => setActiveCategory("")}>
                未分类
                <span>{notes.filter((note) => !note.category).length}</span>
              </button>
              {categories.map((category) => (
                <div key={category} className="tk-sticky-category-row">
                  {editingCategory === category ? (
                    <>
                      <input
                        value={editingCategoryName}
                        onChange={(event) => setEditingCategoryName(event.target.value)}
                        onKeyDown={(event) => event.key === "Enter" && commitRenameCategory()}
                        autoFocus
                      />
                      <button className="tk-icon-button" type="button" title="保存" onClick={commitRenameCategory}>
                        <Check className="h-4 w-4" />
                      </button>
                      <button className="tk-icon-button" type="button" title="取消" onClick={() => setEditingCategory(null)}>
                        <X className="h-4 w-4" />
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        title={category}
                        className={`tk-sticky-category-item ${activeCategory === category ? "tk-sticky-category-item-active" : ""}`}
                        onClick={() => setActiveCategory(category)}>
                        {formatCategoryLabel(category)}
                        <span>{notes.filter((note) => note.category === category).length}</span>
                      </button>
                      <button className="tk-icon-button" type="button" title="重命名" onClick={() => startRenameCategory(category)}>
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button className="tk-icon-button tk-icon-button-danger" type="button" title="删除分类" onClick={() => removeCategory(category)}>
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
          <div className="tk-sticky-list">
            {filteredNotes.map((note) => (
              <button
                key={note.id}
                className={`tk-sticky-list-item ${selectedNote?.id === note.id ? "tk-sticky-list-item-active" : ""}`}
                type="button"
                onClick={() => setSelectedId(note.id)}>
                <span className="tk-sticky-list-color" />
                <span className="min-w-0 flex-1">
                  <span className="tk-sticky-list-title">
                    {note.pinned && <StickyNoteIcon className="h-3.5 w-3.5 text-emerald-500" />}
                    {stickyNoteTitle(note)}
                  </span>
                  <span className="tk-sticky-list-preview">{stickyNotePreview(note.content)}</span>
                </span>
                {note.category && <span className="tk-sticky-list-category">{note.category}</span>}
                <span className="tk-sticky-list-time">{formatStickyNoteTime(note.updatedAt)}</span>
              </button>
            ))}
          </div>
          <div className="tk-sticky-import-export">
            <div>
              <span>Markdown 文件</span>
              <p>导入或导出当前便签。</p>
            </div>
            <Button variant="secondary" onClick={importMarkdown}>
              <FileUp className="h-4 w-4" />
              选择并导入
            </Button>
            <Button variant="secondary" onClick={exportMarkdown} disabled={!selectedNote}>
              <FileDown className="h-4 w-4" />
              另存为
            </Button>
          </div>
        </aside>

        <main className="tk-sticky-main-panel">
          {selectedNote ? (
            <>
              <div className="tk-sticky-main-header">
                <div>
                  <h2 className="tk-panel-title">{stickyNoteTitle(selectedNote)}</h2>
                  <select
                    className="tk-sticky-main-category-select"
                    value={selectedNote.category}
                    onChange={(event) => moveSelectedCategory(selectedNote, event.target.value)}>
                    <option value="">未分类</option>
                    {categories.map((category) => (
                      <option key={category} value={category}>
                        {category}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="tk-sticky-main-actions">
                  <Button variant="secondary" onClick={() => openNoteWindow(selectedNote)}>
                    <Maximize2 className="h-4 w-4" />
                    小窗
                  </Button>
                  <Button variant="secondary" onClick={() => openNoteTileWindow(selectedNote)}>
                    <PanelTop className="h-4 w-4" />
                    固定
                  </Button>
                  <Button variant="ghost" onClick={() => deleteNote(selectedNote)}>
                    <Trash2 className="h-4 w-4" />
                    删除
                  </Button>
                </div>
              </div>
              <StickyNoteEditor
                note={selectedNote}
                categories={categories}
                onSaved={updateNote}
                onDelete={(note) => deleteNote(note, { rethrow: true })}
                onOpenWindow={openNoteWindow}
                onOpenTile={openNoteTileWindow}
              />
            </>
          ) : (
            <div className="tk-sticky-empty">
              <StickyNoteIcon className="h-8 w-8 text-slate-400" />
              <p>还没有便签</p>
              <Button onClick={createNote}>
                <Plus className="h-4 w-4" />
                新建第一条
              </Button>
            </div>
          )}
        </main>
      </section>
    </div>
  )
}

function sortNotes(notes: StickyNote[]): StickyNote[] {
  return [...notes].sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
    return right.updatedAt.localeCompare(left.updatedAt)
  })
}

function suggestMarkdownFileName(note: StickyNote): string {
  const name = stickyNoteTitle(note)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return name || "sticky-note"
}

function formatCategoryLabel(category: string): string {
  const chars = Array.from(category)
  return chars.length > 8 ? `${chars.slice(0, 8).join("")}...` : category
}
