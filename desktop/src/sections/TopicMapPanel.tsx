import { useEffect, useMemo, useState } from "react"
import { BookOpen, Brain, Clipboard, Copy, Folder, RefreshCw, Search, Sparkles } from "lucide-react"

import {
  askKnowledge,
  enrichKnowledgeTopics,
  exportKnowledgeTopic,
  getKnowledgeTopicDetail,
  getKnowledgeTopics,
  openExternalTarget,
  rebuildKnowledgeTopics,
} from "../api"
import type {
  KnowledgeAskResponse,
  KnowledgeTopic,
  KnowledgeTopicDetailResponse,
  KnowledgeTopicDocument,
  KnowledgeTopicListResponse,
  KnowledgeTopicRelation,
  NoteAdapterConfig,
} from "../types"
import { Button } from "../components/primitives"
import { errorMessage } from "../lib/errors"
import { KnowledgeGraphPanel } from "./KnowledgeGraphPanel"

export function TopicMapPanel({
  onStatus,
  noteAdapter,
}: {
  onStatus: (message: string) => void
  noteAdapter: NoteAdapterConfig
}) {
  const [topicQuery, setTopicQuery] = useState("")
  const [topicSourceType, setTopicSourceType] = useState("")
  const [topicResult, setTopicResult] = useState<KnowledgeTopicListResponse | null>(null)
  const [topicDetail, setTopicDetail] = useState<KnowledgeTopicDetailResponse | null>(null)
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null)
  const [selectedTopicDocument, setSelectedTopicDocument] = useState<KnowledgeTopicDocument | null>(null)
  const [topicAnswer, setTopicAnswer] = useState<KnowledgeAskResponse | null>(null)
  const [topicLoading, setTopicLoading] = useState(false)
  const [topicDetailLoading, setTopicDetailLoading] = useState(false)
  const [topicRebuilding, setTopicRebuilding] = useState(false)
  const [topicEnriching, setTopicEnriching] = useState(false)
  const [topicExporting, setTopicExporting] = useState(false)
  const [topicAsking, setTopicAsking] = useState(false)

  const selectedTopic = topicDetail?.topic ?? topicResult?.topics.find((topic) => topic.id === selectedTopicId) ?? null
  const selectedTopicRelations = useMemo(() => {
    const topicMap = new Map((topicResult?.topics ?? []).map((topic) => [topic.id, topic]))
    return (topicDetail?.relations ?? [])
      .map((relation) => {
        const relatedTopicId =
          relation.sourceTopicId === selectedTopicId ? relation.targetTopicId : relation.sourceTopicId
        return {
          relation,
          topic: topicMap.get(relatedTopicId),
        }
      })
      .filter((item): item is { relation: KnowledgeTopicRelation; topic: KnowledgeTopic } => Boolean(item.topic))
  }, [selectedTopicId, topicDetail?.relations, topicResult?.topics])

  const loadTopics = async (preferredTopicId?: string | null) => {
    setTopicLoading(true)
    try {
      const result = await getKnowledgeTopics({
        query: topicQuery,
        sourceType: topicSourceType,
        limit: 80,
      })
      setTopicResult(result)
      if (!result.ok) {
        onStatus(result.error ?? "主题工作台加载失败")
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
      onStatus(`主题工作台加载失败: ${errorMessage(err)}`)
    } finally {
      setTopicLoading(false)
    }
  }

  const loadTopicDetail = async (topicId: string) => {
    setTopicDetailLoading(true)
    try {
      const detail = await getKnowledgeTopicDetail(topicId)
      setTopicDetail(detail)
      setTopicAnswer(null)
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
        onStatus(result.error ?? "主题工作台重建失败")
        return
      }
      onStatus(`主题工作台已重建：${result.topics} 个主题，${result.topicDocuments} 篇笔记`)
      await loadTopics(selectedTopicId)
    } catch (err) {
      onStatus(`主题工作台重建失败: ${errorMessage(err)}`)
    } finally {
      setTopicRebuilding(false)
    }
  }

  const enrichCurrentTopic = async () => {
    if (!selectedTopicId) return
    setTopicEnriching(true)
    try {
      const result = await enrichKnowledgeTopics(selectedTopicId)
      if (!result.ok) {
        onStatus(result.error ?? "AI 整理主题失败")
        return
      }
      onStatus(`AI 已整理 ${result.topics} 个主题`)
      await loadTopics(selectedTopicId)
    } catch (err) {
      onStatus(`AI 整理主题失败: ${errorMessage(err)}`)
    } finally {
      setTopicEnriching(false)
    }
  }

  const exportCurrentTopic = async () => {
    if (!selectedTopicId) return
    setTopicExporting(true)
    try {
      const result = await exportKnowledgeTopic(selectedTopicId)
      if (!result.ok) {
        onStatus(result.error ?? "主题目录页导出失败")
        return
      }
      onStatus("主题目录页已写入笔记软件")
      if (result.openTarget) {
        try {
          await openExternalTarget(result.openTarget)
        } catch (err) {
          onStatus(`主题目录页已生成，但打开失败: ${errorMessage(err)}`)
        }
      }
    } catch (err) {
      onStatus(`主题目录页导出失败: ${errorMessage(err)}`)
    } finally {
      setTopicExporting(false)
    }
  }

  const askCurrentTopic = async () => {
    if (!selectedTopic) return
    setTopicAsking(true)
    try {
      const result = await askKnowledge(
        `请基于我的知识库解释“${selectedTopic.title}”这个主题，并给出下一步最值得阅读的笔记。`,
        null,
        8,
      )
      setTopicAnswer(result)
      onStatus(result.ok ? "已围绕主题生成回答" : result.error ?? "主题提问失败")
    } catch (err) {
      onStatus(`主题提问失败: ${errorMessage(err)}`)
    } finally {
      setTopicAsking(false)
    }
  }

  const copyTopicCitation = async () => {
    if (!selectedTopicDocument) return
    const text = `${selectedTopicDocument.title}\n${topicDocumentTarget(selectedTopicDocument) || selectedTopicDocument.documentId}\n\n${selectedTopicDocument.snippet}`
    try {
      await navigator.clipboard.writeText(text)
      onStatus("引用已复制")
    } catch (err) {
      onStatus(`复制引用失败: ${errorMessage(err)}`)
    }
  }

  return (
    <section className="tk-panel overflow-hidden">
      <div className="tk-panel-header">
        <div>
          <h2 className="tk-panel-title">主题工作台</h2>
          <p className="text-xs text-muted-foreground">
            {topicResult
              ? `当前 ${topicResult.stats.topics}/${topicResult.stats.totalTopics} 个主题，覆盖 ${topicResult.stats.documents} 篇笔记`
              : "从已索引知识库生成主题"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="tk-badge">{topicResult?.stats.topics ?? 0} 个主题</span>
          <span className="tk-badge">{topicResult?.stats.relations ?? 0} 条主题关联</span>
          {selectedTopic?.aiEnhanced && <span className="tk-badge">AI 已整理</span>}
        </div>
      </div>

      <div className="tk-visual-strip">
        <div className="tk-visual-tile">
          <div className="min-w-0">
            <div className="tk-visual-index">01 / FIND</div>
            <div className="text-xs font-semibold text-slate-900">搜主题</div>
            <div className="truncate text-xs text-muted-foreground">按关键词、来源或摘要定位知识范围</div>
          </div>
        </div>
        <div className="tk-visual-tile tk-visual-tile-mint">
          <div className="min-w-0">
            <div className="tk-visual-index">02 / READ</div>
            <div className="text-xs font-semibold text-slate-900">回到原笔记</div>
            <div className="truncate text-xs text-muted-foreground">打开 Obsidian / SiYuan / Markdown 来源</div>
          </div>
        </div>
        <div className="tk-visual-tile tk-visual-tile-amber">
          <div className="min-w-0">
            <div className="tk-visual-index">03 / BUILD</div>
            <div className="text-xs font-semibold text-slate-900">整理主题页</div>
            <div className="truncate text-xs text-muted-foreground">把主题工作台写回笔记软件形成目录</div>
          </div>
        </div>
      </div>

      <div className="tk-panel-body bg-[rgb(235_243_240/0.52)]">
        <div className="grid items-start gap-4 xl:grid-cols-[310px_minmax(0,1fr)_360px]">
          <aside className="sticky top-4 space-y-4 rounded-md border border-white/70 bg-[rgb(247_250_248)] p-3 shadow-[0_14px_34px_rgb(15_23_42/0.045)] ring-1 ring-slate-900/5">
            <div className="grid gap-3">
              <label className="tk-field">
                <span className="tk-label">关键词</span>
                <input
                  className="tk-input"
                  value={topicQuery}
                  onChange={(event) => setTopicQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") loadTopics(selectedTopicId)
                  }}
                  placeholder="搜索主题、关键词或摘要"
                />
              </label>
              <label className="tk-field">
                <span className="tk-label">来源</span>
                <select
                  className="tk-select"
                  value={topicSourceType}
                  onChange={(event) => setTopicSourceType(event.target.value)}>
                  <option value="">全部来源</option>
                  <option value="tabkeep_note">TabKeep</option>
                  <option value="markdown">Markdown / Obsidian</option>
                  <option value="siyuan">SiYuan</option>
                </select>
              </label>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => loadTopics(selectedTopicId)} disabled={topicLoading}>
                  <Search className="h-4 w-4" />
                  {topicLoading ? "加载中..." : "应用"}
                </Button>
                <Button variant="secondary" onClick={rebuildTopics} disabled={topicRebuilding}>
                  <RefreshCw className={`h-4 w-4 ${topicRebuilding ? "animate-spin" : ""}`} />
                  {topicRebuilding ? "重建中..." : "重建"}
                </Button>
              </div>
            </div>

            <div className="grid max-h-[620px] gap-2 overflow-auto pr-1">
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
                      {topic.keywords.slice(0, 3).map((keyword) => (
                        <span key={keyword} className="rounded-md bg-[rgb(241_247_244)] px-1.5 py-0.5 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200/70">
                          {keyword}
                        </span>
                      ))}
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                      <span>{Math.round(topic.confidence * 100)}% 匹配</span>
                      {topic.aiEnhanced && (
                        <span className="rounded-sm bg-blue-100 px-1.5 py-0.5 font-medium text-blue-700">AI 整理</span>
                      )}
                    </div>
                  </button>
                ))
              ) : (
                <div className="tk-muted-box">
                  暂无主题。先重建知识库索引，或点击“重建”从已有索引生成主题。
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
                  <div className="flex flex-wrap gap-2">
                    <Button variant="secondary" onClick={exportCurrentTopic} disabled={topicExporting || !selectedTopicId}>
                      <BookOpen className={`h-4 w-4 ${topicExporting ? "animate-pulse" : ""}`} />
                      {topicExporting ? "生成中..." : "生成目录页"}
                    </Button>
                    <Button variant="secondary" onClick={enrichCurrentTopic} disabled={topicEnriching || !selectedTopicId}>
                      <Sparkles className={`h-4 w-4 ${topicEnriching ? "animate-pulse" : ""}`} />
                      {topicEnriching ? "整理中..." : "AI 整理"}
                    </Button>
                    <Button onClick={askCurrentTopic} disabled={topicAsking}>
                      <Brain className={`h-4 w-4 ${topicAsking ? "animate-pulse" : ""}`} />
                      {topicAsking ? "提问中..." : "围绕主题提问"}
                    </Button>
                  </div>
                </div>

                <div className="rounded-md border border-white/70 bg-[rgb(238_245_242)] p-3 ring-1 ring-slate-900/5">
                  <div className="mb-2 text-xs font-semibold text-slate-700">主题关键词</div>
                  <div className="flex flex-wrap gap-2">
                    {selectedTopic.keywords.map((keyword) => (
                      <span key={keyword} className="rounded-md border border-white/70 bg-[rgb(250_252_250)] px-2 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-900/5">
                        {keyword}
                      </span>
                    ))}
                  </div>
                </div>

                {topicDetailLoading ? (
                  <div className="tk-muted-box">主题详情加载中...</div>
                ) : (
                  <>
                    <section>
                      <div className="mb-2 flex items-center justify-between">
                        <h4 className="text-sm font-semibold text-slate-900">推荐阅读顺序</h4>
                        <span className="tk-badge">{topicDetail?.documents.length ?? 0}</span>
                      </div>
                      <div className="grid gap-2">
                        {(topicDetail?.documents ?? []).map((document, index) => (
                          <div
                            key={document.documentId}
                            className={`group relative rounded-md border p-3 pl-12 text-left transition-colors ${
                              selectedTopicDocument?.documentId === document.documentId
                                ? "border-blue-300 bg-blue-50/50 ring-2 ring-blue-100"
                                : "border-white/70 ring-1 ring-slate-900/5 hover:border-blue-200/80 hover:bg-blue-50/25"
                            }`}
                            onDoubleClick={() => openTopicDocumentSource(document, onStatus, noteAdapter)}>
                            <div className="absolute left-3 top-3 flex h-7 w-7 items-center justify-center rounded-md bg-[rgb(238_245_242)] text-xs font-semibold text-slate-700 ring-1 ring-slate-200/80">
                              {String(index + 1).padStart(2, "0")}
                            </div>
                            <div className="mb-1 flex items-center gap-2">
                              <span className="h-7 w-1.5 rounded-full bg-blue-400" />
                              <button
                                className="min-w-0 flex-1 truncate text-left text-sm font-semibold text-slate-900 hover:text-blue-700"
                                title="查看这篇笔记的关键片段"
                                onClick={() => setSelectedTopicDocument(document)}>
                                {document.title}
                              </button>
                              <span className="tk-badge">{formatSourceType(document.sourceType)}</span>
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
                              onClick={() => setSelectedTopicDocument(document)}
                              title="单击选中，双击卡片可打开原笔记">
                              <p className="line-clamp-2 text-xs leading-5 text-slate-600">{document.snippet}</p>
                              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                <span>{document.reason}</span>
                                {document.anchor && (
                                  <span className="rounded-md bg-blue-50 px-1.5 py-0.5 font-medium text-blue-700">
                                    可跳到 {document.anchor}
                                  </span>
                                )}
                              </div>
                            </button>
                          </div>
                        ))}
                      </div>
                    </section>

                    <section className="rounded-md border border-white/70 bg-[rgb(238_245_242)] p-3 ring-1 ring-slate-900/5">
                      <h4 className="mb-2 text-sm font-semibold text-slate-900">主题证据</h4>
                      <div className="grid max-h-52 gap-2 overflow-auto pr-1 md:grid-cols-2">
                        {(topicDetail?.evidence ?? []).slice(0, 16).map((item) => (
                          <div key={item.id} className="rounded-md border border-white/70 bg-[rgb(250_252_250)] px-3 py-2 text-xs ring-1 ring-slate-900/5">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-medium text-slate-900">{item.label}</span>
                              <span className="tk-badge">{formatTopicEvidenceKind(item.kind)}</span>
                            </div>
                            <p className="mt-1 text-muted-foreground">关联强度 {item.weight.toFixed(1)}</p>
                          </div>
                        ))}
                        {(topicDetail?.evidence ?? []).length === 0 && (
                          <div className="tk-muted-box md:col-span-2">暂无可展示的主题证据</div>
                        )}
                      </div>
                    </section>

                    {topicAnswer && (
                      <section className="rounded-md border border-blue-100 bg-blue-50/50 p-3">
                        <h4 className="mb-2 text-sm font-semibold text-blue-950">主题问答</h4>
                        <div className="whitespace-pre-wrap text-sm leading-6 text-slate-700">
                          {topicAnswer.answer || topicAnswer.error || "没有生成有效回答。"}
                        </div>
                      </section>
                    )}
                  </>
                )}
              </>
            ) : (
              <div className="tk-muted-box">选择左侧主题后，这里会展示主题摘要、推荐阅读和主题证据。</div>
            )}
          </main>

          <aside className="sticky top-4 space-y-3 rounded-md border border-white/70 bg-[rgb(247_250_248)] p-3 shadow-[0_14px_34px_rgb(15_23_42/0.045)] ring-1 ring-slate-900/5">
            {selectedTopicDocument ? (
              <>
                <div className="rounded-md border border-white/70 bg-[rgb(238_245_242)] p-3 ring-1 ring-slate-900/5">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="tk-badge">{formatSourceType(selectedTopicDocument.sourceType)}</span>
                    {selectedTopicDocument.anchor && (
                      <span className="rounded-md bg-blue-100 px-2 py-1 text-xs font-medium text-blue-700">
                        可定位
                      </span>
                    )}
                  </div>
                  <h3 className="text-sm font-semibold leading-6 text-slate-950">
                    {selectedTopicDocument.title}
                  </h3>
                  <p className="mt-2 break-all rounded-md bg-white/70 px-2 py-1.5 text-xs text-muted-foreground ring-1 ring-slate-200/70">
                    {topicDocumentTarget(selectedTopicDocument) || selectedTopicDocument.documentId}
                  </p>
                </div>
                <div className="rounded-md border border-white/70 bg-white/70 p-3 ring-1 ring-slate-900/5">
                  <div className="mb-2 text-xs font-semibold text-slate-900">关键片段</div>
                  <div className="text-sm leading-6 text-slate-700">
                    {selectedTopicDocument.snippet || "暂无片段"}
                  </div>
                </div>
                <div className="rounded-md border border-white/70 bg-white/70 p-3 text-xs leading-5 text-slate-600 ring-1 ring-slate-900/5">
                  <div className="mb-1 font-semibold text-slate-900">推荐原因</div>
                  {selectedTopicDocument.reason || "来自主题匹配"}
                </div>
                {selectedTopicDocument.anchor && (
                  <div className="rounded-md border border-blue-100 bg-blue-50/70 p-3 text-xs text-blue-900">
                    <div className="mb-1 font-semibold">可定位标题</div>
                    {selectedTopicDocument.anchor}
                  </div>
                )}
                <div className="grid gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => openTopicDocumentSource(selectedTopicDocument, onStatus, noteAdapter)}
                    disabled={!topicDocumentOpenTarget(selectedTopicDocument, noteAdapter)}>
                    <Folder className="h-4 w-4" />
                    打开笔记
                  </Button>
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => copyTopicDocumentSource(selectedTopicDocument, onStatus)}>
                      <Copy className="h-4 w-4" />
                      复制来源
                    </Button>
                    <Button variant="secondary" onClick={copyTopicCitation}>
                      <Clipboard className="h-4 w-4" />
                      复制引用
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <div className="tk-muted-box">点击推荐笔记后，这里会显示来源、片段和操作。</div>
            )}

            {selectedTopic && (
              <div className="rounded-md border border-white/70 bg-[rgb(238_245_242)] p-3 ring-1 ring-slate-900/5">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h4 className="text-sm font-semibold text-slate-900">继续探索</h4>
                  <span className="tk-badge">{selectedTopicRelations.length}</span>
                </div>
                <div className="grid max-h-64 gap-2 overflow-auto pr-1">
                  {selectedTopicRelations.length > 0 ? (
                    selectedTopicRelations.slice(0, 10).map(({ relation, topic }) => (
                      <button
                        key={relation.id}
                        className="rounded-md border border-white/70 bg-[rgb(250_252_250)] px-3 py-2 text-left text-xs ring-1 ring-slate-900/5 transition-colors hover:border-blue-200/80 hover:bg-blue-50"
                        onClick={() => selectTopic(topic)}>
                        <div className="font-medium text-slate-900">{topic.title}</div>
                        <div className="mt-1 text-muted-foreground">{relation.label || "相关主题"}</div>
                      </button>
                    ))
                  ) : (
                    <div className="tk-muted-box">暂无相关主题</div>
                  )}
                </div>
              </div>
            )}
          </aside>
        </div>
      </div>
    </section>
  )
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

async function copyTopicDocumentSource(
  item: KnowledgeTopicDocument,
  onStatus?: (message: string) => void,
): Promise<void> {
  const target = topicDocumentTarget(item) || item.title || item.documentId
  try {
    await navigator.clipboard.writeText(target)
    onStatus?.("来源已复制")
  } catch (err) {
    onStatus?.(`复制来源失败: ${errorMessage(err)}`)
  }
}

function formatSourceType(value: string): string {
  if (value === "source") return "来源"
  if (value === "siyuan") return "SiYuan"
  if (value === "markdown") return "Markdown"
  if (value === "tabkeep_note") return "TabKeep"
  return value || "来源"
}

function formatTopicEvidenceKind(value: string): string {
  if (value === "tag") return "标签"
  if (value === "wikilink") return "双链"
  if (value === "heading") return "标题"
  if (value === "path") return "路径"
  if (value === "embedding") return "语义相似"
  if (value === "fallback") return "兜底"
  return value || "证据"
}
