// Popup UI —— 弹窗主页面,500px 宽。
//
// 按职能分 4 段:
//   1. imports + 常量 + 类型
//   2. IndexPopup 主组件:tab 列表 / 按钮 / 弹窗触发
//   3. NotebookPickerModal:选笔记本 + 文档树 + 保存按钮
//   4. DocTree 递归子组件

import { useEffect, useState } from "react"
import { Bookmark, BookmarkCheck, Camera, ChevronDown, ChevronRight, Copy, Languages, Settings, Sparkles, Star, StarOff, X } from "lucide-react"
import type { DocNode, NotebookInfo, TabData } from "./types"
import { groupTabsByDomain } from "./utils/tabUtils"
import { loadFromIDB } from "./utils/indexedDB"
import { Button } from "./components/ui/button"
import { apiFetch, captureWithDesktop, checkBackendHealth, checkDesktopHealth, translateWithDesktop } from "./config/api"
import "./style.css"


// ─────────────────────────────────────────────────────────────
// 1. 常量 + 类型
// ─────────────────────────────────────────────────────────────
const MAX_CONTENT_CHARS = 200_000

// 单个 tab 当前保存状态(驱动按钮的图标颜色 / 是否转圈 / 禁用)
type SaveStatus = "extracting" | "summarizing" | "saving" | "ok" | "error"
// 三档收藏模式
type SaveMode = "link" | "full" | "summary"
// 弹窗状态
type Pending = {
  tab: TabData
  full: boolean          // true 表示有 content(全文 / 摘录)
  summary: boolean       // 标记当前是否"摘录模式"(用于弹窗 badge / 预览区)
  content: string | undefined
  extractError?: string
  summarizeError?: string
} | null

type TranslationState = {
  title: string
  source: string
  translated?: string
  model?: string
  error?: string
} | null

const openDashboard = () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("options.html") })
}


// ─────────────────────────────────────────────────────────────
// 2. IndexPopup 主组件
// ─────────────────────────────────────────────────────────────
function IndexPopup() {
  // 状态
  const [tabs, setTabs] = useState<TabData[]>([])
  const [loading, setLoading] = useState(true)
  const [showGrouped, setShowGrouped] = useState(false)        // "原始" vs "整理" 视图切换
  const [aiGrouping, setAiGrouping] = useState(false)          // AI 分组按钮 loading
  const [saveStatus, setSaveStatus] = useState<Record<number, SaveStatus>>({})  // 每个 tab id 一份状态
  const [pending, setPending] = useState<Pending>(null)        // 弹窗状态
  const [backendReady, setBackendReady] = useState<boolean | null>(null)
  const [desktopReady, setDesktopReady] = useState<boolean | null>(null)
  const [translation, setTranslation] = useState<TranslationState>(null)
  const [translating, setTranslating] = useState(false)
  const [desktopOcrStatus, setDesktopOcrStatus] = useState<string | null>(null)

  // 启动:从 IDB 拉 tab 列表
  useEffect(() => {
    loadFromIDB<TabData>().then((data) => {
      if (data) {
        setTabs(data)
      }
      setLoading(false)
    })
  }, [])

  // 打开 popup 时探测后端,给用户一个明确状态。
  useEffect(() => {
    let cancelled = false
    checkBackendHealth().then((ok) => {
      if (!cancelled) setBackendReady(ok)
    })
    checkDesktopHealth().then((ok) => {
      if (!cancelled) setDesktopReady(ok)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const groupedTabs = groupTabsByDomain(tabs)

  const getActiveTab = async (): Promise<TabData | null> => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab) return null
    return {
      id: tab.id,
      title: tab.title,
      url: tab.url,
      favIconUrl: tab.favIconUrl,
      active: tab.active,
      pinned: tab.pinned,
    }
  }

  const handleTranslateTitle = async () => {
    setTranslating(true)
    try {
      const tab = await getActiveTab()
      const text = tab?.title?.trim()
      if (!text) {
        setTranslation({ title: "翻译标题", source: "", error: "当前标签页没有标题" })
        return
      }
      const result = await translateWithDesktop(
        {
          text,
          targetLang: "简体中文",
          context: tab?.url,
        },
        "/translate",
      )
      setTranslation({
        title: "翻译标题",
        source: text,
        translated: result.translatedText,
        model: result.model,
        error: result.ok ? undefined : result.error,
      })
    } catch (e) {
      setTranslation({ title: "翻译标题", source: "", error: String(e) })
    } finally {
      setTranslating(false)
    }
  }

  const handleTranslateSelection = async () => {
    setTranslating(true)
    try {
      const tab = await getActiveTab()
      if (!tab?.id) {
        setTranslation({ title: "翻译选中", source: "", error: "找不到当前标签页" })
        return
      }
      let text = ""
      try {
        const selection = await chrome.tabs.sendMessage(tab.id, { type: "GET_SELECTION" })
        text = selection?.text?.trim() ?? ""
      } catch {
        text = ""
      }
      if (!text) {
        setTranslation({
          title: "翻译选中",
          source: "",
          error: "当前页面没有选中文本,或该页面暂不可访问",
        })
        return
      }
      const result = await translateWithDesktop(
        {
          text,
          targetLang: "简体中文",
          context: tab.url,
        },
        "/selection_translate",
      )
      setTranslation({
        title: "翻译选中",
        source: text,
        translated: result.translatedText,
        model: result.model,
        error: result.ok ? undefined : result.error,
      })
    } catch (e) {
      setTranslation({ title: "翻译选中", source: "", error: String(e) })
    } finally {
      setTranslating(false)
    }
  }

  const handleDesktopOcr = (mode: "recognize" | "translate") => {
    setDesktopOcrStatus("已交给桌面端,请在屏幕上框选区域")
    chrome.runtime.sendMessage(
      {
        type: mode === "recognize" ? "START_DESKTOP_OCR_RECOGNIZE" : "START_DESKTOP_OCR_TRANSLATE",
        sourceLang: "auto",
        targetLang: "简体中文",
      },
      (res: { ok?: boolean; error?: string } | undefined) => {
        if (chrome.runtime.lastError) {
          return
        }
        if (!res?.ok) {
          setDesktopOcrStatus(res?.error ?? "桌面端 OCR 未完成")
          return
        }
        setDesktopOcrStatus("结果已显示在桌面悬浮窗")
      },
    )
  }

  /**
   * 三档收藏的入口(☆/★/🪄)。
   * 流程:
   *   1. link  → 直接弹窗(无 content)
   *   2. full  → 让 background extract content,弹窗(有 content)
   *   3. summary → 让 background extract content,弹窗(有 content 但 summary 推迟到弹窗内的按钮触发)
   */
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
        extractError = `消息到 background 失败: ${String(e)}(可能扩展需要重新加载)`
        console.warn(`[TabKeep] ${extractError}`)
      }
    }

    // summary 模式不在 popup 阶段调 LLM,推迟到弹窗内"重点摘录并保存"按钮
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

  // 弹窗关闭(右上角 ✕)
  const handleModalClose = () => {
    if (pending) {
      setSaveStatus((s) => ({ ...s, [pending.tab.id!]: "error" }))
    }
    setPending(null)
  }

  // 弹窗保存回调
  const handleModalSaved = (ok: boolean, _error?: string) => {
    if (!pending) return
    setSaveStatus((s) => ({ ...s, [pending.tab.id!]: ok ? "ok" : "error" }))
    setPending(null)
  }

  return (
    <div className="p-4 max-h-96 overflow-y-auto" style={{ minWidth: 500, width: 500 }}>
      {/* ── 顶部条:标题 + 工具按钮 ── */}
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
          <span
            className={`text-[11px] ${
              backendReady === null
                ? "text-gray-400"
                : backendReady
                ? "text-green-600"
                : "text-red-600"
            }`}>
            {backendReady === null ? "检查中" : backendReady ? "后端已连接" : "后端未连接"}
          </span>
          <span
            className={`text-[11px] ${
              desktopReady === null
                ? "text-gray-400"
                : desktopReady
                ? "text-green-600"
                : "text-gray-400"
            }`}>
            {desktopReady === null ? "桌面检查中" : desktopReady ? "桌面已连接" : "桌面未连接"}
          </span>
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

      {/* ── 图例 ── */}
      <div className="text-xs text-gray-500 mb-2 flex items-center gap-3">
        <span className="flex items-center gap-1">
          <Bookmark className="h-3 w-3" /> 仅链接
        </span>
        <span className="flex items-center gap-1">
          <Star className="h-3 w-3" /> 全文(用 Defuddle 提取)
        </span>
      </div>

      <div className="mb-3 flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={translating || desktopReady === false}
          onClick={handleTranslateTitle}
          title="翻译当前标签页标题">
          <Languages className={`h-3 w-3 mr-1 ${translating ? "animate-pulse" : ""}`} />
          译标题
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={translating || desktopReady === false}
          onClick={handleTranslateSelection}
          title="翻译当前页面选中文本">
          <Languages className={`h-3 w-3 mr-1 ${translating ? "animate-pulse" : ""}`} />
          译选中
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={desktopReady === false}
          onClick={() => handleDesktopOcr("recognize")}
          title="调用桌面端截图 OCR">
          <Camera className="h-3 w-3 mr-1" />
          截图 OCR
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={desktopReady === false}
          onClick={() => handleDesktopOcr("translate")}
          title="调用桌面端截图翻译">
          <Languages className="h-3 w-3 mr-1" />
          截图翻译
        </Button>
      </div>

      {desktopOcrStatus && (
        <div className="mb-3 rounded border border-blue-100 bg-blue-50 px-2 py-1.5 text-xs text-blue-700">
          {desktopOcrStatus}
        </div>
      )}

      {/* ── 视图切换:加载中 / 整理视图 / 原始视图 ── */}
      {loading ? (
        <p className="text-sm text-gray-500">加载中...</p>
      ) : showGrouped ? (
        // 整理视图:按域分组
        <>
          <p className="text-sm text-gray-600 mb-3">共 {tabs.length} 个标签页,{groupedTabs.length} 个域名</p>
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
        // 原始视图:每个 tab 一行,带 ☆ / ★ / 🪄 三个按钮
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
                  {/* ☆ 仅链接 */}
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
                  {/* ★ 全文 */}
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6"
                    disabled={busy}
                    onClick={() => handleSave(tab, "full")}
                    title={status === "extracting" ? "提取中..." : "全文收藏(含正文)"}>
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
                  {/* 🪄 重点摘录 */}
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
                        : "重点摘录(LLM 提取 + 保留配图)"
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

      {/* ── 弹窗:有 pending 时挂载 ── */}
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
      {translation && (
        <TranslationModal
          translation={translation}
          onClose={() => setTranslation(null)}
        />
      )}
    </div>
  )
}


function TranslationModal({
  translation,
  onClose,
}: {
  translation: NonNullable<TranslationState>
  onClose: () => void
}) {
  const copyText = async () => {
    if (!translation.translated) return
    await navigator.clipboard.writeText(translation.translated)
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-2">
      <div className="bg-white rounded-lg shadow-lg w-full max-w-md max-h-[80vh] flex flex-col">
        <div className="p-3 border-b flex items-center justify-between">
          <h4 className="text-sm font-semibold truncate pr-2">{translation.title}</h4>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 flex-shrink-0"
            title="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-3 text-sm">
          {translation.error ? (
            <div className="rounded border border-red-100 bg-red-50 px-3 py-2 text-red-700">
              {translation.error}
            </div>
          ) : (
            <>
              <div>
                <p className="mb-1 text-xs font-medium text-gray-500">原文</p>
                <pre className="max-h-28 overflow-y-auto whitespace-pre-wrap rounded border bg-gray-50 p-2 font-sans text-xs text-gray-700">
                  {translation.source}
                </pre>
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-gray-500">
                  译文{translation.model ? ` · ${translation.model}` : ""}
                </p>
                <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded border bg-blue-50/50 p-2 font-sans text-xs text-gray-800">
                  {translation.translated}
                </pre>
              </div>
            </>
          )}
        </div>

        <div className="p-2 border-t flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={onClose}>
            关闭
          </Button>
          <Button size="sm" onClick={copyText} disabled={!translation.translated}>
            <Copy className="h-3 w-3 mr-1" />
            复制译文
          </Button>
        </div>
      </div>
    </div>
  )
}


// ─────────────────────────────────────────────────────────────
// 3. 笔记本选择弹窗
// ─────────────────────────────────────────────────────────────
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
  // 状态
  const [notebooks, setNotebooks] = useState<NotebookInfo[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())         // 哪些笔记本已展开
  const [docsByNotebook, setDocsByNotebook] = useState<Record<string, DocNode[]>>({})  // 缓存:nbId → 子文档树
  const [docsLoading, setDocsLoading] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Selected>(null)
  const [loadingNotebooks, setLoadingNotebooks] = useState(true)
  const [saving, setSaving] = useState(false)
  const [summarizing, setSummarizing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 拉笔记本列表(挂载时一次)
  useEffect(() => {
    let cancelled = false
    apiFetch("/notes/notebooks")
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

  // 展开 / 收起笔记本:第一次展开时拉子文档树(惰性加载)
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
        const res = await apiFetch(`/notes/notebooks/${notebookId}/docs`)
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

  // 共享保存入口:桌面端优先,失败后回退 FastAPI /notes/save。
  const postSave = async (bodyContent: string | undefined) => {
    setError(null)
    const mode = summary ? "summary" : bodyContent ? "full" : "link"
    const desktopSaved = await captureWithDesktop({
      source: "tabkeep",
      mode,
      title: tab.title ?? "",
      url: tab.url ?? "",
      contentMarkdown: bodyContent || undefined,
      favIconUrl: tab.favIconUrl,
      capturedAt: new Date().toISOString(),
      notebookId: selected!.notebookId,
      targetDoc: selected!.docId ?? null,
    })
    if (desktopSaved) return true

    const res = await apiFetch("/notes/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: tab.title ?? "",
        url: tab.url ?? "",
        content: bodyContent || undefined,
        notebook_id: selected!.notebookId,
        target_doc: selected!.docId ?? null,
        mode,
      }),
    })
    const data = await res.json()
    if (!res.ok || !data.ok) {
      setError(data.detail || data.error || "保存失败")
      return false
    }
    return true
  }
  // "📄 全文保存" / "再次保存(摘录)" 按钮:直接 POST 当前 content
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

  // "🪄 重点摘录并保存" 按钮:fire-and-forget 派给 background,弹窗立即关
  // (background 跑完会用 chrome.notifications 通知用户)
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

  const isLinkMode = !content && !summary

  // 底部状态文字
  const statusText = !selected
    ? "请选择目标"
    : selected.docId
    ? "→ 追加到选中文档"
    : "→ 在笔记本根新建 doc"

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-2">
      <div className="bg-white rounded-lg shadow-lg w-full max-w-md max-h-[80vh] flex flex-col">
        {/* ── 标题栏 + 关闭 ── */}
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

        {/* ── 模式 badge + URL ── */}
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

        {/* ── 错误 banner(提取 / 摘录失败)── */}
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

        {/* ── 全文预览(摘录前用户能扫一眼)── */}
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

        {/* ── LLM 跑中(只在前端 await 期间显示,新流程里基本不会看到)── */}
        {summarizing && (
          <div className="px-3 py-3 text-xs text-purple-700 bg-purple-50 border-b border-purple-100 flex items-center gap-2">
            <Sparkles className="h-3 w-3 animate-pulse" />
            🪄 LLM 正在提取重点 + 写入笔记... (中文长文通常 10-30 秒)
          </div>
        )}

        {/* ── 笔记本树 ── */}
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
                请在仪表盘配置笔记适配器(当前可能不是 SiYuan)
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
                      <p className="text-xs text-gray-400 py-1 pl-2">(空,没有子文档)</p>
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

        {/* ── 中部错误(有 notebooks 但单条加载失败)── */}
        {error && notebooks.length > 0 && (
          <div className="px-3 py-1 text-xs text-red-600 border-t">{error}</div>
        )}

        {/* ── 底部按钮 ── */}
        <div className="p-2 border-t flex items-center justify-between">
          <p className="text-xs text-gray-500 truncate pr-2">{statusText}</p>
          <div className="flex gap-2 flex-shrink-0">
            <Button size="sm" variant="outline" onClick={onClose} disabled={saving || summarizing}>
              取消
            </Button>
            {/* 全文模式才出现"📄 全文保存"二级入口(避开和"🪄"主按钮冲突) */}
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
            {/* 主按钮:三种文案三档行为 */}
            <Button
              size="sm"
              onClick={isLinkMode || summary ? handleConfirm : handleSummarize}
              disabled={
                !selected ||
                saving ||
                summarizing ||
                (!isLinkMode && !summary && !content)
              }
              className={!summary ? "bg-purple-600 hover:bg-purple-700" : ""}>
              {summarizing
                ? "🪄 摘录并保存中..."
                : saving
                ? "保存中..."
                : isLinkMode
                ? "保存链接"
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


// ─────────────────────────────────────────────────────────────
// 4. DocTree 递归子组件
// ─────────────────────────────────────────────────────────────
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
