import { useEffect, useState } from "react"
import { Bookmark, BookmarkCheck, ChevronDown, ChevronRight, Settings, Sparkles, Star, StarOff, X } from "lucide-react"
import type { DocNode, NotebookInfo, TabData } from "./types"
import { groupTabsByDomain } from "./utils/tabUtils"
import { loadFromIDB } from "./utils/indexedDB"
import { Button } from "./components/ui/button"
import "./style.css"

const BACKEND_URL = "http://127.0.0.1:38471"
const MAX_CONTENT_CHARS = 200_000

const openDashboard = () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("options.html") })
}

type SaveStatus = "extracting" | "summarizing" | "saving" | "ok" | "error"

type SaveMode = "link" | "full" | "summary"

type Pending = {
  tab: TabData
  full: boolean
  summary: boolean
  content: string | undefined
  extractError?: string
  summarizeError?: string
} | null

function IndexPopup() {
  const [tabs, setTabs] = useState<TabData[]>([])
  const [loading, setLoading] = useState(true)
  const [showGrouped, setShowGrouped] = useState(false)
  const [aiGrouping, setAiGrouping] = useState(false)
  const [saveStatus, setSaveStatus] = useState<Record<number, SaveStatus>>({})
  const [pending, setPending] = useState<Pending>(null)

  useEffect(() => {
    loadFromIDB<TabData>().then((data) => {
      if (data) {
        setTabs(data)
      }
      setLoading(false)
    })
  }, [])

  const groupedTabs = groupTabsByDomain(tabs)

  const handleSave = async (tab: TabData, mode: SaveMode) => {
    if (tab.id === undefined) return
    const tabId = tab.id

    let content: string | undefined
    let summary = false
    let extractError: string | undefined
    let summarizeError: string | undefined

    if (mode !== "link") {
      setSaveStatus((s) => ({ ...s, [tabId]: "extracting" }))
      try {
        const res = await chrome.runtime.sendMessage({ type: "EXTRACT_CONTENT_FOR_PICKER", tab })
        if (res?.ok && res.content) {
          content = res.content
        } else {
          extractError = res?.error ?? "提取失败"
          console.warn(`[TabKeep] 提取失败: ${extractError}`)
        }
      } catch (e) {
        extractError = `消息到 background 失败: ${String(e)}（可能扩展需要重新加载）`
        console.warn(`[TabKeep] ${extractError}`)
      }
    }

    // summary 模式不在 popup 阶段调 LLM,推迟到弹窗内"AI 摘要并保存"按钮
    // 这样用户能先选好目标再决定是否要等 LLM

    setSaveStatus((s) => ({ ...s, [tabId]: "saving" }))
    setPending({
      tab,
      full: mode !== "link",
      summary,
      content,
      extractError,
      summarizeError
    })
  }

  const handleModalClose = () => {
    if (pending) {
      setSaveStatus((s) => ({ ...s, [pending.tab.id!]: "error" }))
    }
    setPending(null)
  }

  const handleModalSaved = (ok: boolean, _error?: string) => {
    if (!pending) return
    setSaveStatus((s) => ({ ...s, [pending.tab.id!]: ok ? "ok" : "error" }))
    setPending(null)
  }

  return (
    <div className="p-4 max-h-96 overflow-y-auto" style={{ minWidth: 500, width: 500 }}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1">
          <h3 className="text-lg font-semibold">TabKeep</h3>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={openDashboard}
            title="打开仪表盘">
            <Settings className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={showGrouped ? "default" : "outline"}
            onClick={() => setShowGrouped(!showGrouped)}>
            {showGrouped ? "原始" : "整理"}
          </Button>
          {showGrouped && (
            <>
              <Button
                size="sm"
                onClick={() => chrome.runtime.sendMessage({ type: "CREATE_TAB_GROUPS" })}>
                执行分组
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={aiGrouping}
                onClick={async () => {
                  setAiGrouping(true)
                  try {
                    await chrome.runtime.sendMessage({ type: "CLASSIFY_AND_GROUP_TABS" })
                  } finally {
                    setAiGrouping(false)
                  }
                }}>
                <Sparkles className="h-4 w-4 mr-1" />
                {aiGrouping ? "分组中..." : "AI 分组"}
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="text-xs text-gray-500 mb-2 flex items-center gap-3">
        <span className="flex items-center gap-1">
          <Bookmark className="h-3 w-3" /> 仅链接
        </span>
        <span className="flex items-center gap-1">
          <Star className="h-3 w-3" /> 全文（用 Defuddle 提取）
        </span>
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">加载中...</p>
      ) : showGrouped ? (
        <>
          <p className="text-sm text-gray-600 mb-3">共 {tabs.length} 个标签页，{groupedTabs.length} 个域名</p>
          <div className="space-y-2">
            {groupedTabs.map((group) => (
              <div key={group.domain} className="border border-gray-200 rounded-lg p-2">
                <div className="flex items-center gap-2 mb-2">
                  {group.favIconUrl ? (
                    <img
                      src={group.favIconUrl}
                      className="w-5 h-5 flex-shrink-0 object-cover"
                      alt=""
                      onError={(e) => e.currentTarget.classList.add("hidden")}
                    />
                  ) : (
                    <div className="w-5 h-5 flex-shrink-0 bg-gray-200 rounded flex items-center justify-center text-xs text-gray-500">
                      {group.isOther ? "?" : group.domain[0].toUpperCase()}
                    </div>
                  )}
                  <span className="flex-1 text-sm font-medium truncate">{group.domain}</span>
                  <span className="text-xs text-gray-500">({group.count})</span>
                </div>
                <div className="pl-7">
                  {group.tabs.map((tab, idx) => (
                    <div key={tab.id}>
                      <a
                        href={tab.url}
                        target="_blank"
                        className="block text-xs truncate text-blue-600 hover:underline"
                        title={tab.url}>
                        {tab.title || "无标题"}
                      </a>
                      {idx < group.tabs.length - 1 && <br />}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <p className="text-sm text-gray-600 mb-3">共 {tabs.length} 个标签页</p>
          <div className="space-y-1">
            {tabs.map((tab) => {
              const status = tab.id !== undefined ? saveStatus[tab.id] : undefined
              const busy = status === "saving" || status === "extracting"
              const LinkIcon = status === "ok" ? BookmarkCheck : Bookmark
              const FullIcon = status === "ok" ? StarOff : Star
              return (
                <div key={tab.id} className="flex items-center gap-2 py-1 border-b border-gray-100">
                  {tab.favIconUrl && (
                    <img
                      src={tab.favIconUrl}
                      className="w-3 h-3 flex-shrink-0"
                      style={{ width: 12, height: 12 }}
                      alt=""
                      onError={(e) => e.currentTarget.classList.add("hidden")}
                    />
                  )}
                  <a
                    href={tab.url}
                    target="_blank"
                    className="flex-1 text-xs truncate text-blue-600 hover:underline"
                    title={tab.url}>
                    {tab.title || "无标题"}
                  </a>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6"
                    disabled={busy}
                    onClick={() => handleSave(tab, "link")}
                    title={status === "ok" ? "已收藏链接" : "仅链接收藏"}>
                    <LinkIcon
                      className={`h-3 w-3 ${
                        status === "ok"
                          ? "text-green-600"
                          : status === "error"
                          ? "text-red-600"
                          : ""
                      }`}
                    />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6"
                    disabled={busy}
                    onClick={() => handleSave(tab, "full")}
                    title={status === "extracting" ? "提取中..." : "全文收藏（含正文）"}>
                    <FullIcon
                      className={`h-3 w-3 ${
                        status === "ok"
                          ? "text-green-600"
                          : status === "error"
                          ? "text-red-600"
                          : "text-amber-500"
                      } ${status === "extracting" ? "animate-pulse" : ""}`}
                    />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6"
                    disabled={busy}
                    onClick={() => handleSave(tab, "summary")}
                    title={
                      status === "summarizing"
                        ? "LLM 摘录中..."
                        : status === "extracting"
                        ? "提取中..."
                        : "重点摘录（LLM 提取 + 保留配图）"
                    }>
                    <Sparkles
                      className={`h-3 w-3 ${
                        status === "ok"
                          ? "text-green-600"
                          : status === "error"
                          ? "text-red-600"
                          : "text-purple-500"
                      } ${
                        status === "summarizing" || status === "extracting"
                          ? "animate-pulse"
                          : ""
                      }`}
                    />
                  </Button>
                </div>
              )
            })}
          </div>
        </>
      )}

      {pending && (
        <NotebookPickerModal
          tab={pending.tab}
          content={pending.content}
          summary={pending.summary}
          extractError={pending.extractError}
          summarizeError={pending.summarizeError}
          onClose={handleModalClose}
          onSaved={handleModalSaved}
          onContentUpdate={(c) =>
            setPending((p) => (p ? { ...p, content: c } : p))
          }
          onSummaryUpdate={(s) =>
            setPending((p) => (p ? { ...p, summary: s } : p))
          }
          onSummarizeErrorUpdate={(e) =>
            setPending((p) => (p ? { ...p, summarizeError: e } : p))
          }
        />
      )}
    </div>
  )
}

type Selected = { notebookId: string; docId?: string } | null

function NotebookPickerModal({
  tab,
  content,
  summary,
  extractError,
  summarizeError,
  onClose,
  onSaved,
  onContentUpdate,
  onSummaryUpdate,
  onSummarizeErrorUpdate,
}: {
  tab: TabData
  content: string | undefined
  summary: boolean
  extractError?: string
  summarizeError?: string
  onClose: () => void
  onSaved: (ok: boolean, error?: string) => void
  onContentUpdate: (content: string) => void
  onSummaryUpdate: (summary: boolean) => void
  onSummarizeErrorUpdate: (err: string | undefined) => void
}) {
  const [notebooks, setNotebooks] = useState<NotebookInfo[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [docsByNotebook, setDocsByNotebook] = useState<Record<string, DocNode[]>>({})
  const [docsLoading, setDocsLoading] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Selected>(null)
  const [loadingNotebooks, setLoadingNotebooks] = useState(true)
  const [saving, setSaving] = useState(false)
  const [summarizing, setSummarizing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`${BACKEND_URL}/notes/notebooks`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return
        setNotebooks(Array.isArray(data) ? data : [])
        setLoadingNotebooks(false)
      })
      .catch((e) => {
        if (cancelled) return
        setError(String(e))
        setLoadingNotebooks(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const toggleExpand = async (notebookId: string) => {
    if (expanded.has(notebookId)) {
      setExpanded((s) => {
        const n = new Set(s)
        n.delete(notebookId)
        return n
      })
      return
    }
    if (!docsByNotebook[notebookId]) {
      setDocsLoading((s) => new Set(s).add(notebookId))
      try {
        const res = await fetch(`${BACKEND_URL}/notes/notebooks/${notebookId}/docs`)
        const data = await res.json()
        setDocsByNotebook((m) => ({ ...m, [notebookId]: Array.isArray(data) ? data : [] }))
      } catch (e) {
        setDocsByNotebook((m) => ({ ...m, [notebookId]: [] }))
        setError(`加载文档树失败: ${String(e)}`)
      } finally {
        setDocsLoading((s) => {
          const n = new Set(s)
          n.delete(notebookId)
          return n
        })
      }
    }
    setExpanded((s) => new Set(s).add(notebookId))
  }

  const postSave = async (bodyContent: string | undefined) => {
    setError(null)
    const res = await fetch(`${BACKEND_URL}/notes/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: tab.title ?? "",
        url: tab.url ?? "",
        content: bodyContent || undefined,
        notebook_id: selected!.notebookId,
        target_doc: selected!.docId ?? null,
      }),
    })
    const data = await res.json()
    if (!data.ok) {
      setError(data.error || "保存失败")
      return false
    }
    return true
  }

  const handleConfirm = async () => {
    if (!selected) return
    setSaving(true)
    try {
      const ok = await postSave(content)
      if (ok) {
        onSaved(true)
      } else {
        setSaving(false)
      }
    } catch (e) {
      setError(String(e))
      setSaving(false)
    }
  }

  const handleSummarize = async () => {
    if (!selected) {
      setError("请先选择目标")
      return
    }
    if (!content) {
      setError("没有正文可摘录")
      return
    }
    const notebookId = selected.notebookId
    const targetDoc = selected.docId ?? null
    // 立即把弹窗关了 —— 后续 LLM + 写笔记全在 background 端跑
    // 用回调 (不是 await) 避免 popup 卸载时 sendMessage 被 abort
    chrome.runtime.sendMessage(
      {
        type: "SUMMARIZE_AND_SAVE",
        tab,
        content,
        notebookId,
        targetDoc
      },
      (res: any) => {
        // 这个回调在 background 端完成后会触发 (如果 popup 还活着)
        // popup 已关也无所谓 —— background 会用 chrome.notifications 通知用户
        if (chrome.runtime.lastError) {
          console.warn(
            `[TabKeep] 摘录+保存消息通道异常: ${chrome.runtime.lastError.message}`
          )
          return
        }
        console.log(`[TabKeep] 摘录+保存 完成回调`, res)
      }
    )
    console.log(
      `[TabKeep] 摘录+保存已派发到 background, 立即关闭弹窗。` +
        `notebook=${notebookId} target_doc=${targetDoc ?? "(新建)"}`
    )
    onSaved(true)
  }

  const handleSelectDoc = (notebookId: string, docId: string) => {
    setSelected({ notebookId, docId })
  }

  const handleSelectNotebook = (notebookId: string) => {
    setSelected({ notebookId })
  }

  const statusText = !selected
    ? "请选择目标"
    : selected.docId
    ? "→ 追加到选中文档"
    : "→ 在笔记本根新建 doc"

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-2">
      <div className="bg-white rounded-lg shadow-lg w-full max-w-md max-h-[80vh] flex flex-col">
        <div className="p-3 border-b flex items-center justify-between">
          <h4 className="text-sm font-semibold truncate pr-2">
            收藏「{tab.title || "无标题"}」
          </h4>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 flex-shrink-0"
            title="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-3 py-2 border-b text-xs text-gray-600 flex items-center gap-2 flex-wrap">
          <span
            className={`px-1.5 py-0.5 rounded ${
              summary
                ? "bg-purple-100 text-purple-800"
                : content
                ? "bg-amber-100 text-amber-800"
                : "bg-gray-100"
            }`}>
            {summary
              ? `🪄 摘录 (${content?.length ?? 0} 字)`
              : content
              ? `全文 (${content.length} 字)`
              : "仅链接"}
          </span>
          <span className="truncate text-gray-500 flex-1" title={tab.url}>
            {tab.url}
          </span>
        </div>
        {extractError && !content && (
          <div className="px-3 py-1.5 text-xs text-red-700 bg-red-50 border-b border-red-100">
            ⚠ 提取失败: {extractError}
          </div>
        )}
        {summarizeError && (
          <div className="px-3 py-1.5 text-xs text-orange-700 bg-orange-50 border-b border-orange-100">
            ⚠ 摘录失败,请改用「📄 全文保存」或重试: {summarizeError}
          </div>
        )}
        {content && !summary && !summarizing && (
          <details className="border-b bg-amber-50/50">
            <summary className="px-3 py-1 text-xs font-medium cursor-pointer text-amber-800 select-none">
              📄 全文已就绪 ({content.length} 字) — 点下方按钮可摘录或直接保存全文
            </summary>
            <pre className="px-3 py-2 text-xs whitespace-pre-wrap font-sans text-gray-700 max-h-24 overflow-y-auto">
              {content.slice(0, 500)}
              {content.length > 500 ? `\n… (已截断预览, 全文 ${content.length} 字)` : ""}
            </pre>
          </details>
        )}
        {summarizing && (
          <div className="px-3 py-3 text-xs text-purple-700 bg-purple-50 border-b border-purple-100 flex items-center gap-2">
            <Sparkles className="h-3 w-3 animate-pulse" />
            🪄 LLM 正在提取重点 + 写入笔记... (中文长文通常 10-30 秒)
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-2 text-sm">
          {loadingNotebooks ? (
            <p className="text-gray-500 text-center py-4">加载笔记本...</p>
          ) : error && notebooks.length === 0 ? (
            <p className="text-red-600 py-2 text-center">{error}</p>
          ) : notebooks.length === 0 ? (
            <p className="text-gray-500 text-center py-4">
              没有笔记本
              <br />
              <span className="text-xs text-gray-400">
                请在仪表盘配置笔记适配器（当前可能不是 SiYuan）
              </span>
            </p>
          ) : (
            notebooks.map((nb) => (
              <div key={nb.id}>
                <div className="flex items-center gap-1 py-0.5 hover:bg-gray-50">
                  <button
                    className="w-5 h-5 flex items-center justify-center text-gray-400 hover:text-gray-700"
                    onClick={() => toggleExpand(nb.id)}
                    title="展开文档">
                    {docsLoading.has(nb.id) ? (
                      <span className="text-xs">...</span>
                    ) : expanded.has(nb.id) ? (
                      <ChevronDown className="h-3 w-3" />
                    ) : (
                      <ChevronRight className="h-3 w-3" />
                    )}
                  </button>
                  <button
                    className={`flex-1 text-left px-1 py-1 rounded truncate ${
                      selected?.notebookId === nb.id && !selected?.docId
                        ? "bg-blue-100 text-blue-800"
                        : "hover:bg-gray-100"
                    }`}
                    onClick={() => handleSelectNotebook(nb.id)}
                    title={`在 ${nb.name} 下新建 doc`}>
                    <span className="mr-1">📘</span>
                    {nb.name}
                  </button>
                </div>
                {expanded.has(nb.id) && (
                  <div className="ml-5 border-l border-gray-200">
                    {docsByNotebook[nb.id] === undefined ? null :
                     docsByNotebook[nb.id].length === 0 ? (
                      <p className="text-xs text-gray-400 py-1 pl-2">（空，没有子文档）</p>
                    ) : (
                      <DocTree
                        nodes={docsByNotebook[nb.id]}
                        depth={1}
                        selected={selected?.notebookId === nb.id ? selected : null}
                        onSelect={(docId) => handleSelectDoc(nb.id, docId)}
                      />
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {error && notebooks.length > 0 && (
          <div className="px-3 py-1 text-xs text-red-600 border-t">{error}</div>
        )}

        <div className="p-2 border-t flex items-center justify-between">
          <p className="text-xs text-gray-500 truncate pr-2">{statusText}</p>
          <div className="flex gap-2 flex-shrink-0">
            <Button size="sm" variant="outline" onClick={onClose} disabled={saving || summarizing}>
              取消
            </Button>
            {content && !summary && (
              <Button
                size="sm"
                variant="outline"
                onClick={handleConfirm}
                disabled={!selected || saving || summarizing}
                title="直接把全文保存到目标">
                📄 全文保存
              </Button>
            )}
            <Button
              size="sm"
              onClick={summary ? handleConfirm : handleSummarize}
              disabled={
                !selected ||
                saving ||
                summarizing ||
                (!summary && !content)
              }
              className={!summary ? "bg-purple-600 hover:bg-purple-700" : ""}>
              {summarizing
                ? "🪄 摘录并保存中..."
                : saving
                ? "保存中..."
                : summary
                ? "🪄 再次保存(摘录)"
                : "🪄 重点摘录并保存"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function DocTree({
  nodes,
  depth,
  selected,
  onSelect,
}: {
  nodes: DocNode[]
  depth: number
  selected: Selected
  onSelect: (docId: string) => void
}) {
  return (
    <>
      {nodes.map((node) => (
        <div key={node.id}>
          <button
            className={`w-full text-left px-1 py-1 rounded truncate ${
              selected?.docId === node.id
                ? "bg-blue-100 text-blue-800"
                : "hover:bg-gray-100"
            }`}
            style={{ paddingLeft: depth * 8 }}
            onClick={() => onSelect(node.id)}
            title={node.path}>
            <span className="mr-1">{node.type === "Container" ? "📁" : "📄"}</span>
            {node.name}
          </button>
          {node.children.length > 0 && (
            <DocTree
              nodes={node.children}
              depth={depth + 1}
              selected={selected}
              onSelect={onSelect}
            />
          )}
        </div>
      ))}
    </>
  )
}

export default IndexPopup
