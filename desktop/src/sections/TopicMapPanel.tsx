import { useEffect, useState } from "react"
import { BookOpen, Folder, RefreshCw, Search } from "lucide-react"

import {
  exportKnowledgeTopic,
  getKnowledgeTopicDetail,
  getKnowledgeTopics,
  openExternalTarget,
  rebuildKnowledgeTopics,
} from "../api"
import type {
  KnowledgeTopic,
  KnowledgeTopicDetailResponse,
  KnowledgeTopicDocument,
  KnowledgeTopicListResponse,
  NoteAdapterConfig,
} from "../types"
import { Button } from "../components/primitives"
import { errorMessage } from "../lib/errors"

export function TopicMapPanel({
  onStatus,
  noteAdapter,
}: {
  onStatus: (message: string) => void
  noteAdapter: NoteAdapterConfig
}) {
  const [topicResult, setTopicResult] = useState<KnowledgeTopicListResponse | null>(null)
  const [topicDetail, setTopicDetail] = useState<KnowledgeTopicDetailResponse | null>(null)
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null)
  const [selectedTopicDocument, setSelectedTopicDocument] = useState<KnowledgeTopicDocument | null>(null)
  const [topicQuery, setTopicQuery] = useState("")
  const [topicLoading, setTopicLoading] = useState(false)
  const [topicDetailLoading, setTopicDetailLoading] = useState(false)
  const [topicRebuilding, setTopicRebuilding] = useState(false)
  const [topicExporting, setTopicExporting] = useState(false)

  const selectedTopic = topicDetail?.topic ?? topicResult?.topics.find((topic) => topic.id === selectedTopicId) ?? null

  const loadTopics = async (preferredTopicId?: string | null) => {
    setTopicLoading(true)
    try {
      const result = await getKnowledgeTopics({ query: topicQuery, limit: 80 })
      setTopicResult(result)
      if (!result.ok) {
        onStatus(result.error ?? "主题目录加载失败")
        return
      }
      const nextTopicId = preferredTopicId && result.topics.some((topic) => topic.id === preferredTopicId)
        ? preferredTopicId
        : result.topics[0]?.id ?? null
      setSelectedTopicId(nextTopicId)
      if (nextTopicId) {
        await loadTopicDetail(nextTopicId)
      } else {
        setTopicDetail(null)
        setSelectedTopicDocument(null)
      }
    } catch (err) {
      onStatus(`主题目录加载失败: ${errorMessage(err)}`)
    } finally {
      setTopicLoading(false)
    }
  }

  const loadTopicDetail = async (topicId: string) => {
    setTopicDetailLoading(true)
    try {
      const detail = await getKnowledgeTopicDetail(topicId)
      setTopicDetail(detail)
      if (!detail.ok) {
        onStatus(detail.error ?? "主题详情加载失败")
        setSelectedTopicDocument(null)
        return
      }
      setSelectedTopicDocument(detail.documents[0] ?? null)
    } catch (err) {
      onStatus(`主题详情加载失败: ${errorMessage(err)}`)
    } finally {
      setTopicDetailLoading(false)
    }
  }

  useEffect(() => {
    loadTopics()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selectTopic = async (topic: KnowledgeTopic) => {
    setSelectedTopicId(topic.id)
    await loadTopicDetail(topic.id)
  }

  const rebuildTopics = async () => {
    setTopicRebuilding(true)
    try {
      const result = await rebuildKnowledgeTopics()
      if (!result.ok) {
        onStatus(result.error ?? "主题目录生成失败")
        return
      }
      onStatus(`主题目录已更新：${result.topics} 个主题，覆盖 ${result.topicDocuments} 篇笔记`)
      await loadTopics(selectedTopicId)
    } catch (err) {
      onStatus(`主题目录生成失败: ${errorMessage(err)}`)
    } finally {
      setTopicRebuilding(false)
    }
  }

  const exportCurrentTopic = async () => {
    if (!selectedTopicId) return
    setTopicExporting(true)
    try {
      const result = await exportKnowledgeTopic(selectedTopicId)
      if (!result.ok) {
        onStatus(result.error ?? "目录页生成失败")
        return
      }
      onStatus("目录页已写入笔记软件")
      if (result.openTarget) {
        try {
          await openExternalTarget(result.openTarget)
          onStatus("目录页已生成并打开")
        } catch (err) {
          onStatus(`目录页已生成，但打开失败: ${errorMessage(err)}`)
        }
      }
    } catch (err) {
      onStatus(`目录页生成失败: ${errorMessage(err)}`)
    } finally {
      setTopicExporting(false)
    }
  }

  return (
    <section className="tk-panel overflow-hidden">
      <div className="tk-panel-header">
        <div>
          <h2 className="tk-panel-title">主题目录</h2>
          <p className="text-xs text-muted-foreground">
            {topicResult
              ? `${topicResult.stats.topics}/${topicResult.stats.totalTopics} 个主题，覆盖 ${topicResult.stats.documents} 篇笔记`
              : "从已索引知识库生成主题目录"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="tk-badge">{topicResult?.stats.topics ?? 0} 个主题</span>
          <Button variant="secondary" onClick={() => loadTopics(selectedTopicId)} disabled={topicLoading}>
            <RefreshCw className={`h-4 w-4 ${topicLoading ? "animate-spin" : ""}`} />
            {topicLoading ? "刷新中..." : "刷新"}
          </Button>
          <Button variant="secondary" onClick={rebuildTopics} disabled={topicRebuilding}>
            <RefreshCw className={`h-4 w-4 ${topicRebuilding ? "animate-spin" : ""}`} />
            {topicRebuilding ? "生成中..." : "更新主题列表"}
          </Button>
        </div>
      </div>

      <div className="tk-panel-body bg-[rgb(235_243_240/0.52)]">
        <div className="grid items-start gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="sticky top-4 space-y-3 rounded-md border border-white/70 bg-[rgb(247_250_248)] p-3 shadow-[0_14px_34px_rgb(15_23_42/0.045)] ring-1 ring-slate-900/5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-950">主题列表</h3>
              <span className="tk-badge">{topicResult?.topics.length ?? 0}</span>
            </div>
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                loadTopics(selectedTopicId)
              }}>
              <input
                className="tk-input min-w-0 flex-1"
                value={topicQuery}
                onChange={(event) => setTopicQuery(event.target.value)}
                placeholder="搜索主题、关键词或摘要"
              />
              <Button type="submit" variant="secondary" className="shrink-0" disabled={topicLoading}>
                <Search className="h-4 w-4" />
                搜索
              </Button>
            </form>
            <div className="grid max-h-[680px] gap-2 overflow-auto pr-1">
              {topicResult?.topics.length ? (
                topicResult.topics.map((topic) => (
                  <button
                    key={topic.id}
                    className={`group relative overflow-hidden rounded-md border bg-[rgb(250_252_250)] px-3 py-3 text-left transition-colors ${
                      selectedTopicId === topic.id
                        ? "border-blue-300 bg-blue-50/45 ring-2 ring-blue-100"
                        : "border-white/70 ring-1 ring-slate-900/5 hover:border-blue-200/80 hover:bg-slate-50"
                    }`}
                    onClick={() => selectTopic(topic)}>
                    <span
                      className={`absolute inset-y-0 left-0 w-1 ${
                        selectedTopicId === topic.id ? "bg-blue-500" : "bg-transparent group-hover:bg-blue-200"
                      }`}
                    />
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">
                        {topic.title}
                      </span>
                      <span className="tk-badge">{topic.documentCount} 篇</span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{topic.summary}</p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {topic.keywords.slice(0, 4).map((keyword) => (
                        <span key={keyword} className="rounded-md bg-[rgb(241_247_244)] px-1.5 py-0.5 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200/70">
                          {keyword}
                        </span>
                      ))}
                    </div>
                  </button>
                ))
              ) : (
                <div className="tk-muted-box">
                  暂无主题。先同步知识库，再点击“更新主题列表”生成主题目录。
                </div>
              )}
            </div>
          </aside>

          <main className="space-y-4 rounded-md border border-white/70 bg-[rgb(249_251_249)] p-4 shadow-[0_16px_38px_rgb(15_23_42/0.045)] ring-1 ring-slate-900/5">
            {selectedTopic ? (
              <>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span className="tk-badge">{selectedTopic.documentCount} 篇笔记</span>
                      <span className="tk-badge">{Math.round(selectedTopic.confidence * 100)}% 匹配</span>
                      {selectedTopic.sourceTypes.map((source) => (
                        <span key={source} className="tk-badge">{formatSourceType(source)}</span>
                      ))}
                    </div>
                    <h3 className="text-xl font-semibold leading-7 text-slate-950">{selectedTopic.title}</h3>
                    <p className="mt-2 text-sm leading-6 text-slate-600">{selectedTopic.summary}</p>
                  </div>
                  <Button onClick={exportCurrentTopic} disabled={topicExporting || !selectedTopicId}>
                    <BookOpen className={`h-4 w-4 ${topicExporting ? "animate-pulse" : ""}`} />
                    {topicExporting ? "生成中..." : "生成目录页"}
                  </Button>
                </div>

                <div className="rounded-md border border-white/70 bg-[rgb(238_245_242)] p-3 ring-1 ring-slate-900/5">
                  <div className="mb-2 text-xs font-semibold text-slate-700">目录关键词</div>
                  <div className="flex flex-wrap gap-2">
                    {selectedTopic.keywords.map((keyword) => (
                      <span key={keyword} className="rounded-md border border-white/70 bg-[rgb(250_252_250)] px-2 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-900/5">
                        {keyword}
                      </span>
                    ))}
                  </div>
                </div>

                {topicDetailLoading ? (
                  <div className="tk-muted-box">主题笔记加载中...</div>
                ) : (
                  <section>
                    <div className="mb-2 flex items-center justify-between">
                      <h4 className="text-sm font-semibold text-slate-900">对应笔记</h4>
                      <span className="tk-badge">{topicDetail?.documents.length ?? 0}</span>
                    </div>
                    <div className="grid gap-3">
                      {(topicDetail?.documents ?? []).map((document, index) => (
                        <TopicDocumentCard
                          key={document.documentId}
                          document={document}
                          index={index}
                          active={selectedTopicDocument?.documentId === document.documentId}
                          noteAdapter={noteAdapter}
                          onSelect={() => setSelectedTopicDocument(document)}
                          onStatus={onStatus}
                        />
                      ))}
                      {(topicDetail?.documents ?? []).length === 0 && (
                        <div className="tk-muted-box">这个主题暂时没有对应笔记。</div>
                      )}
                    </div>
                  </section>
                )}

                {selectedTopicDocument && (
                  <section className="rounded-md border border-white/70 bg-white/80 p-3 ring-1 ring-slate-900/5">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <h4 className="min-w-0 truncate text-sm font-semibold text-slate-900">
                        {selectedTopicDocument.title}
                      </h4>
                      <Button
                        variant="secondary"
                        onClick={() => openTopicDocumentSource(selectedTopicDocument, onStatus, noteAdapter)}
                        disabled={!topicDocumentOpenTarget(selectedTopicDocument, noteAdapter)}>
                        <Folder className="h-4 w-4" />
                        打开笔记
                      </Button>
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs">
                      <span className="tk-badge">{formatSourceType(selectedTopicDocument.sourceType)}</span>
                      {selectedTopicDocument.anchor && <span className="tk-badge">可定位到标题</span>}
                    </div>
                    <div className="mt-3 text-sm leading-6 text-slate-700">
                      {formatTopicSnippet(selectedTopicDocument)}
                    </div>
                    {selectedTopicDocument.anchor && (
                      <div className="mt-3 rounded-md border border-blue-100 bg-blue-50/70 px-3 py-2 text-xs text-blue-900">
                        打开时会尽量定位到标题：{selectedTopicDocument.anchor}
                      </div>
                    )}
                  </section>
                )}
              </>
            ) : (
              <div className="tk-muted-box">选择左侧主题后，这里会展示目录摘要和对应笔记。</div>
            )}
          </main>
        </div>
      </div>
    </section>
  )
}

function TopicDocumentCard({
  document,
  index,
  active,
  noteAdapter,
  onSelect,
  onStatus,
}: {
  document: KnowledgeTopicDocument
  index: number
  active: boolean
  noteAdapter: NoteAdapterConfig
  onSelect: () => void
  onStatus: (message: string) => void
}) {
  return (
    <div
      className={`group relative rounded-md border p-3 pl-12 text-left transition-colors ${
        active
          ? "border-blue-300 bg-blue-50/50 ring-2 ring-blue-100"
          : "border-white/70 bg-[rgb(250_252_250)] ring-1 ring-slate-900/5 hover:border-blue-200/80 hover:bg-blue-50/25"
      }`}
      onDoubleClick={() => openTopicDocumentSource(document, onStatus, noteAdapter)}>
      <div className="absolute left-3 top-3 flex h-7 w-7 items-center justify-center rounded-md bg-[rgb(238_245_242)] text-xs font-semibold text-slate-700 ring-1 ring-slate-200/80">
        {String(index + 1).padStart(2, "0")}
      </div>
      <div className="mb-1 flex items-center gap-2">
        <button
          className="min-w-0 flex-1 truncate text-left text-sm font-semibold text-slate-900 hover:text-blue-700"
          title="查看这篇笔记的关键片段"
          onClick={onSelect}>
          {document.title}
        </button>
        <span className="tk-badge">{formatSourceType(document.sourceType)}</span>
        {document.anchor && <span className="tk-badge">可定位</span>}
        <button
          className="tk-icon-button h-7 w-7 bg-white/80 ring-1 ring-slate-200/70 group-hover:text-blue-700"
          title={formatTopicOpenTitle(document, noteAdapter)}
          onClick={() => openTopicDocumentSource(document, onStatus, noteAdapter)}
          disabled={!topicDocumentOpenTarget(document, noteAdapter)}>
          <Folder className="h-3.5 w-3.5" />
        </button>
      </div>
      <button
        className="block w-full text-left"
        onClick={onSelect}
        title="单击选中，双击卡片可打开原笔记">
        <p className="line-clamp-2 text-xs leading-5 text-slate-600">{formatTopicSnippet(document)}</p>
      </button>
    </div>
  )
}

function formatTopicSnippet(document: KnowledgeTopicDocument): string {
  const text = stripInternalMetadata(document.snippet, document.title)
  return text || "暂无可展示片段"
}

function stripInternalMetadata(value: string, title?: string): string {
  let text = stripLeadingFrontMatter(value.replace(/\r\n/g, "\n").trim())
  text = text
    .split("\n")
    .filter((line) => !isInternalMetadataLine(line))
    .join("\n")
  text = text.replace(
    /\b(source|notebook|notebook_id|doc_id|h_path|date|lastmod|title)\s*:\s*("[^"]*"|'[^']*'|[^\s#，。；;]+)/gi,
    "",
  )
  text = text.replace(/\s+/g, " ").trim()

  const normalizedTitle = title?.trim()
  if (normalizedTitle) {
    text = text.replace(new RegExp(`^#{1,6}\\s*${escapeRegExp(normalizedTitle)}\\s*`, "i"), "").trim()
  }
  return text
}

function stripLeadingFrontMatter(value: string): string {
  if (!value.startsWith("---")) return value

  const headingIndex = value.search(/(?:^|\s)#{1,6}\s+\S/)
  const markerIndexes = [...value.matchAll(/---/g)]
    .map((match) => match.index ?? 0)
    .filter((index) => index > 0)
  const closingIndex =
    headingIndex >= 0 ? markerIndexes.filter((index) => index < headingIndex).pop() : markerIndexes[0]

  if (closingIndex === undefined) return value.replace(/^---\s*/, "").trim()
  return value.slice(closingIndex + 3).trim()
}

function isInternalMetadataLine(line: string): boolean {
  const key = line.trim().match(/^([a-z_]+)\s*:/i)?.[1]?.toLowerCase()
  return !!key && ["source", "notebook", "notebook_id", "doc_id", "h_path", "date", "lastmod", "title"].includes(key)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function topicDocumentTarget(item: KnowledgeTopicDocument): string {
  return item.url || item.path || ""
}

function topicDocumentOpenTarget(item: KnowledgeTopicDocument, noteAdapter?: NoteAdapterConfig): string {
  if (item.sourceType === "markdown" && item.path && noteAdapter?.provider === "obsidian" && noteAdapter.vault) {
    const obsidianTarget = obsidianOpenUri(item.path, noteAdapter.vault, item.anchor)
    if (obsidianTarget) return obsidianTarget
  }
  return topicDocumentTarget(item)
}

function obsidianOpenUri(path: string, vault: string, anchor?: string | null): string {
  const normalizedPath = normalizeLocalPath(path)
  const normalizedVault = normalizeLocalPath(vault).replace(/\/+$/, "")
  if (!normalizedPath || !normalizedVault) return ""

  const lowerPath = normalizedPath.toLowerCase()
  const lowerVault = normalizedVault.toLowerCase()
  if (lowerPath !== lowerVault && !lowerPath.startsWith(`${lowerVault}/`)) return ""

  const vaultName = normalizedVault.split("/").filter(Boolean).pop()
  const relativeFile = normalizedPath.slice(normalizedVault.length).replace(/^\/+/, "").replace(/\.md$/i, "")
  if (!vaultName || !relativeFile) return ""
  const target = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(relativeFile)}`
  return anchor ? `${target}&heading=${encodeURIComponent(anchor)}` : target
}

function normalizeLocalPath(value: string): string {
  return value.trim().replace(/\\/g, "/")
}

function formatTopicOpenTitle(item: KnowledgeTopicDocument, noteAdapter?: NoteAdapterConfig): string {
  if (item.sourceType === "siyuan") return "在 SiYuan 中打开"
  if (item.sourceType === "markdown" && noteAdapter?.provider === "obsidian") {
    return item.anchor ? `在 Obsidian 中打开到标题：${item.anchor}` : "在 Obsidian 中打开"
  }
  if (item.url) return "打开网页来源"
  return "打开笔记来源"
}

async function openTopicDocumentSource(
  item: KnowledgeTopicDocument,
  onStatus?: (message: string) => void,
  noteAdapter?: NoteAdapterConfig,
): Promise<void> {
  const target = topicDocumentOpenTarget(item, noteAdapter)
  if (!target) {
    onStatus?.("这篇笔记没有可打开的来源")
    return
  }
  try {
    await openExternalTarget(target)
    onStatus?.("已打开来源")
  } catch (err) {
    onStatus?.(`打开来源失败: ${errorMessage(err)}`)
  }
}

function formatSourceType(value: string): string {
  if (value === "source") return "来源"
  if (value === "siyuan") return "SiYuan"
  if (value === "markdown") return "Markdown"
  if (value === "tabkeep_note") return "TabKeep"
  return value || "来源"
}
