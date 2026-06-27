import { useEffect, useState } from "react"
import { Copy, Folder, RefreshCw, RotateCcw, Search, Sparkles } from "lucide-react"

import {
  DEFAULT_KNOWLEDGE_CONFIG,
  askKnowledge,
  getKnowledgeConfig,
  getKnowledgeIndexHealth,
  getKnowledgeSyncLogs,
  getKnowledgeStats,
  openExternalTarget,
  repairKnowledgeIndex,
  searchKnowledge,
  setKnowledgeConfig,
  syncAllKnowledge,
} from "../api"
import type {
  KnowledgeAskResponse,
  KnowledgeCitation,
  KnowledgeConfig,
  KnowledgeIndexHealthResponse,
  KnowledgeIndexRepairResponse,
  KnowledgeSearchResponse,
  KnowledgeStats,
  KnowledgeSyncAllResponse,
  KnowledgeSyncSourceResult,
} from "../types"
import { Button, Checkbox, Notice, StatusCard, TextField } from "../components/primitives"
import { errorMessage } from "../lib/errors"

export function KnowledgeSection() {
  const [config, setConfigState] = useState<KnowledgeConfig>(DEFAULT_KNOWLEDGE_CONFIG)
  const [pathText, setPathText] = useState("")
  const [stats, setStats] = useState<KnowledgeStats | null>(null)
  const [indexHealth, setIndexHealth] = useState<KnowledgeIndexHealthResponse | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [syncingKnowledge, setSyncingKnowledge] = useState(false)
  const [checkingIndex, setCheckingIndex] = useState(false)
  const [repairingIndex, setRepairingIndex] = useState(false)
  const [syncResult, setSyncResult] = useState<KnowledgeSyncAllResponse | null>(null)
  const [syncLogs, setSyncLogs] = useState<KnowledgeSyncAllResponse[]>([])
  const [searchQuery, setSearchQuery] = useState("")
  const [searchResult, setSearchResult] = useState<KnowledgeSearchResponse | null>(null)
  const [searching, setSearching] = useState(false)
  const [question, setQuestion] = useState("")
  const [askResult, setAskResult] = useState<KnowledgeAskResponse | null>(null)
  const [asking, setAsking] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const autoRerankReady = Boolean(config.embedding.enabled && config.embedding.apiKey.trim())

  const refresh = async () => {
    setLoading(true)
    setStatus(null)
    try {
      const [nextConfig, nextStats, nextHealth, nextLogs] = await Promise.all([
        getKnowledgeConfig(),
        getKnowledgeStats(),
        getKnowledgeIndexHealth(),
        getKnowledgeSyncLogs(),
      ])
      setConfigState(nextConfig)
      setPathText(nextConfig.markdownPaths.join("\n"))
      setStats(nextStats)
      setIndexHealth(nextHealth)
      setSyncLogs(nextLogs.items)
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  const buildDraft = (): KnowledgeConfig => ({
    ...config,
    markdownPaths: pathText
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean),
    maxFileBytes:
      Number.isFinite(config.maxFileBytes) && config.maxFileBytes > 0
        ? config.maxFileBytes
        : DEFAULT_KNOWLEDGE_CONFIG.maxFileBytes,
    embedding: {
      ...config.embedding,
      baseURL: DEFAULT_KNOWLEDGE_CONFIG.embedding.baseURL,
      model: DEFAULT_KNOWLEDGE_CONFIG.embedding.model,
    },
  })

  const save = async () => {
    setSaving(true)
    setStatus(null)
    try {
      const saved = await setKnowledgeConfig(buildDraft())
      setConfigState(saved)
      setPathText(saved.markdownPaths.join("\n"))
      setStatus("知识库设置已保存")
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const runSyncAll = async () => {
    setSyncingKnowledge(true)
    setStatus(null)
    setSyncResult(null)
    try {
      const saved = await setKnowledgeConfig(buildDraft())
      setConfigState(saved)
      setPathText(saved.markdownPaths.join("\n"))
      const result = await syncAllKnowledge()
      setStats(result.stats)
      setSyncResult(result)
      setStatus(formatKnowledgeSyncStatus(result))
      const health = await getKnowledgeIndexHealth()
      setIndexHealth(health)
      const logs = await getKnowledgeSyncLogs()
      setSyncLogs(logs.items)
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setSyncingKnowledge(false)
    }
  }

  const checkIndexHealth = async () => {
    setCheckingIndex(true)
    setStatus(null)
    try {
      const health = await getKnowledgeIndexHealth()
      setIndexHealth(health)
      setStats(health.stats)
      setStatus(formatIndexHealthStatus(health))
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setCheckingIndex(false)
    }
  }

  const repairIndex = async () => {
    setRepairingIndex(true)
    setStatus(null)
    try {
      const result = await repairKnowledgeIndex()
      setIndexHealth(result.health)
      setStats(result.health.stats)
      setStatus(formatIndexRepairStatus(result))
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setRepairingIndex(false)
    }
  }

  const runSearch = async () => {
    const query = searchQuery.trim()
    if (!query) return
    setSearching(true)
    setStatus(null)
    try {
      const result = await searchKnowledge(query, 8)
      setSearchResult(result)
      if (!result.ok) setStatus(result.error ?? "搜索失败")
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setSearching(false)
    }
  }

  const runAsk = async () => {
    const value = question.trim()
    if (!value) return
    setAsking(true)
    setStatus(null)
    try {
      const result = await askKnowledge(value, sessionId, 8)
      setAskResult(result)
      if (result.sessionId) setSessionId(result.sessionId)
      if (!result.ok) setStatus(result.error ?? "知识库问答失败")
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setAsking(false)
    }
  }

  const copyAnswer = async () => {
    if (!askResult?.answer) return
    try {
      await navigator.clipboard.writeText(askResult.answer)
      setStatus("回答已复制")
    } catch (err) {
      setStatus(`复制失败: ${errorMessage(err)}`)
    }
  }

  const statusTone =
    status?.includes("已保存") ||
    status?.includes("完成") ||
    status?.includes("健康") ||
    status?.includes("已复制") ||
    status?.includes("可用")
      ? "success"
      : "warning"

  return (
    <div className="space-y-5">
      <header className="tk-topbar">
        <div>
          <h1 className="tk-page-title">知识库</h1>
          <p className="tk-page-subtitle">索引 TabKeep 收藏和 Markdown / Obsidian 笔记，进行搜索与 RAG 问答</p>
        </div>
        <Button variant="secondary" onClick={refresh} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          刷新
        </Button>
      </header>

      {status && <Notice tone={statusTone}>{status}</Notice>}

      <section className="tk-grid-two">
        <section className="tk-panel">
          <div className="tk-panel-header">
            <h2 className="tk-panel-title">搜索</h2>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <span className="tk-badge">{searchResult?.sourceMode ?? "未搜索"}</span>
              {searchResult?.rerankUsed && <span className="tk-badge tk-badge-success">Rerank</span>}
            </div>
          </div>
          <div className="tk-panel-body space-y-4">
            <div className="flex gap-2">
              <input
                className="tk-input"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") runSearch()
                }}
                placeholder="搜索项目方案、错误信息、笔记主题"
              />
              <Button onClick={runSearch} disabled={searching || !searchQuery.trim()}>
                <Search className="h-4 w-4" />
                {searching ? "搜索中..." : "搜索"}
              </Button>
            </div>
            <CitationList
              items={searchResult?.items ?? []}
              emptyText="暂无搜索结果"
              onStatus={setStatus}
            />
            {searchResult?.rerankMessage && <div className="tk-muted-box">{searchResult.rerankMessage}</div>}
          </div>
        </section>

        <section className="tk-panel">
          <div className="tk-panel-header">
            <h2 className="tk-panel-title">知识库问答</h2>
            <span className="tk-badge">{askResult?.sourceMode ?? "RAG"}</span>
          </div>
          <div className="tk-panel-body space-y-4">
            <textarea
              className="tk-textarea"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="例如：TabKeep 桌面端翻译功能目前做到哪一步了？"
            />
            <div className="flex flex-wrap gap-2">
              <Button onClick={runAsk} disabled={asking || !question.trim()}>
                <Sparkles className="h-4 w-4" />
                {asking ? "思考中..." : "提问"}
              </Button>
              <Button variant="secondary" onClick={copyAnswer} disabled={!askResult?.answer}>
                <Copy className="h-4 w-4" />
                复制回答
              </Button>
            </div>
            {askResult?.answer ? (
              <div className="rounded-md border border-border bg-white p-3 text-sm leading-7 text-slate-800 whitespace-pre-wrap">
                {askResult.answer}
              </div>
            ) : (
              <div className="tk-muted-box">回答会基于下方引用段落生成，不会默认读取整个笔记库。</div>
            )}
            <CitationList
              items={askResult?.citations ?? []}
              emptyText="暂无引用来源"
              compact
              onStatus={setStatus}
            />
          </div>
        </section>
      </section>

      <KnowledgeHealthSummary
        stats={stats}
        health={indexHealth}
        checking={checkingIndex}
        repairing={repairingIndex}
        onCheck={checkIndexHealth}
        onRepair={repairIndex}
      />

      <KnowledgeSyncPanel
        current={syncResult}
        logs={syncLogs}
        syncing={syncingKnowledge}
      />

      <section className="tk-panel">
        <div className="tk-panel-header">
          <div>
            <h2 className="tk-panel-title">知识库索引与检索</h2>
            <p className="text-xs text-muted-foreground">统一配置同步来源和语义检索；rerank 自动复用同一 API Key</p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="tk-badge">{config.enabled ? "索引启用" : "索引关闭"}</span>
            <span className="tk-badge">{config.embedding.enabled ? "语义检索" : "FTS"}</span>
            <span className="tk-badge">{autoRerankReady ? "自动 Rerank" : "未重排"}</span>
          </div>
        </div>
        <div className="tk-panel-body">
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.08fr)_minmax(300px,0.92fr)]">
            <section className="space-y-4 lg:border-r lg:border-slate-200/70 lg:pr-6">
              <div>
                <h3 className="text-sm font-semibold text-slate-950">同步来源</h3>
                <p className="mt-1 text-xs text-muted-foreground">本地 Markdown、Obsidian 和已配置的笔记集成</p>
              </div>
              <Checkbox
                label="启用知识库索引"
                checked={config.enabled}
                onChange={(checked) => setConfigState({ ...config, enabled: checked })}
              />
              <label className="tk-field">
                <span className="tk-label">Markdown / Obsidian 路径</span>
                <textarea
                  className="tk-textarea min-h-36"
                  value={pathText}
                  onChange={(event) => setPathText(event.target.value)}
                  placeholder={"E:\\Notes\\ObsidianVault\nE:\\Projects\\TabKeep\\docs"}
                />
              </label>
              <TextField
                label="单文件最大字节数"
                type="number"
                value={String(config.maxFileBytes)}
                onChange={(value) =>
                  setConfigState({ ...config, maxFileBytes: Number(value) || 1_000_000 })
                }
                placeholder="1000000"
              />
            </section>

            <section className="space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-slate-950">向量检索</h3>
                <p className="mt-1 text-xs text-muted-foreground">默认使用 SiliconFlow embedding 和 rerank</p>
              </div>
              <Checkbox
                label="启用语义检索"
                checked={config.embedding.enabled}
                onChange={(checked) =>
                  setConfigState({
                    ...config,
                    embedding: { ...config.embedding, enabled: checked },
                  })
                }
              />
              <TextField
                label="API Key"
                type="password"
                value={config.embedding.apiKey}
                onChange={(value) =>
                  setConfigState({
                    ...config,
                    embedding: { ...config.embedding, apiKey: value },
                  })
                }
                placeholder="sk-..."
              />
              {stats?.vectorMessage && <div className="tk-muted-box">{stats.vectorMessage}</div>}
            </section>
          </div>
        </div>
        <div className="tk-command-bar justify-between">
          <span className="text-xs text-muted-foreground">保存会同时写入同步来源和向量检索配置</span>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={save} disabled={saving || syncingKnowledge}>
              {saving ? "保存中..." : "保存知识库设置"}
            </Button>
            <Button onClick={runSyncAll} disabled={syncingKnowledge || saving}>
              <RefreshCw className={`h-4 w-4 ${syncingKnowledge ? "animate-spin" : ""}`} />
              {syncingKnowledge ? "同步中..." : "同步知识库"}
            </Button>
          </div>
        </div>
      </section>

    </div>
  )
}

function KnowledgeHealthSummary({
  stats,
  health,
  checking,
  repairing,
  onCheck,
  onRepair,
}: {
  stats: KnowledgeStats | null
  health: KnowledgeIndexHealthResponse | null
  checking: boolean
  repairing: boolean
  onCheck: () => void
  onRepair: () => void
}) {
  const issueCount = health?.issues.length ?? 0
  const repairableCount = health?.repairableIssues.length ?? 0
  const healthy = Boolean(health && issueCount === 0)
  const displayStats = health?.stats ?? stats
  const documents = health?.documents ?? displayStats?.documents ?? 0
  const paragraphs = health?.paragraphs ?? displayStats?.paragraphs ?? 0
  const chunks = health?.chunks ?? displayStats?.chunks ?? 0
  const vectorAvailable = displayStats?.vectorAvailable ?? false
  const lastIndexedAt = displayStats?.lastIndexedAt ?? null
  const statusText = !health
    ? "待检查"
    : healthy
      ? "健康"
      : repairableCount > 0
        ? "可修复"
        : "需要关注"
  const statusClass = healthy ? "tk-badge-success" : health ? "tk-badge-warning" : ""
  const summary = !health
    ? "检查后会显示知识库是否可以正常搜索。"
    : healthy
      ? `知识库状态正常：${documents} 篇文档，${paragraphs} 个段落，${chunks} 个检索片段。`
      : repairableCount > 0
        ? `发现 ${repairableCount} 项可修复问题，可能影响搜索结果完整性。`
        : `发现 ${issueCount} 项需要关注的问题，建议重新同步知识库。`

  return (
    <section className="tk-panel">
      <div className="tk-panel-header">
        <div>
          <h2 className="tk-panel-title">知识库状态</h2>
          <p className="text-xs text-muted-foreground">
            {health ? `最近检查 ${formatCompactDate(health.checkedAt)}` : "检查知识库是否可以正常搜索"}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className={`tk-badge ${statusClass}`}>{statusText}</span>
          <Button variant="secondary" onClick={onCheck} disabled={checking || repairing}>
            <RefreshCw className={`h-4 w-4 ${checking ? "animate-spin" : ""}`} />
            {checking ? "检查中..." : "检查状态"}
          </Button>
          <Button
            variant="secondary"
            onClick={onRepair}
            disabled={checking || repairing || !health || repairableCount === 0}
            title={repairableCount > 0 ? "自动修复可处理的索引问题" : "当前没有可自动修复的问题"}>
            <RotateCcw className={`h-4 w-4 ${repairing ? "animate-spin" : ""}`} />
            {repairing ? "修复中..." : "修复问题"}
          </Button>
        </div>
      </div>
      <div className="tk-panel-body space-y-4">
        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <StatusCard title="文档" value={`${documents} 篇`} tone={displayStats || health ? "success" : "neutral"} />
          <StatusCard title="段落" value={`${paragraphs} 个`} tone={displayStats || health ? "success" : "neutral"} />
          <StatusCard title="检索片段" value={`${chunks} 个`} tone={displayStats || health ? "success" : "neutral"} />
          <StatusCard
            title="向量层"
            value={vectorAvailable ? "可用" : "未启用"}
            tone={vectorAvailable ? "success" : "warning"}
          />
          <StatusCard
            title="最近索引"
            value={lastIndexedAt ? formatCompactDate(lastIndexedAt) : "暂无"}
            tone={lastIndexedAt ? "success" : "warning"}
          />
          <StatusCard
            title="自动修复"
            value={health ? `${repairableCount} 项` : "待检查"}
            tone={repairableCount > 0 ? "warning" : health ? "success" : "neutral"}
          />
        </section>
        <div className={`rounded-md border px-3 py-2 text-sm leading-6 ${
          healthy
            ? "border-emerald-100 bg-emerald-50 text-emerald-700"
            : health
              ? "border-amber-100 bg-amber-50 text-amber-800"
              : "border-border bg-white text-slate-700"
        }`}>
          {summary}
        </div>
      </div>
    </section>
  )
}

function KnowledgeSyncPanel({
  current,
  logs,
  syncing,
}: {
  current: KnowledgeSyncAllResponse | null
  logs: KnowledgeSyncAllResponse[]
  syncing: boolean
}) {
  const latest = current ?? logs[0] ?? null
  const displayStatus = syncing ? "running" : latest?.status ?? "idle"
  const displayLabel = syncing ? "同步中" : latest ? formatSyncRunStatus(latest.status) : "暂无记录"

  return (
    <section className="tk-panel">
      <div className="tk-panel-header">
        <div>
          <h2 className="tk-panel-title">同步状态</h2>
          <p className="text-xs text-muted-foreground">
            {latest?.endedAt
              ? `最近完成于 ${formatCompactDate(latest.endedAt)}，耗时 ${formatDuration(latest.durationMs)}`
              : "保存配置后同步所有已配置来源"}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className={`tk-badge ${syncStatusBadgeClass(displayStatus)}`}>{displayLabel}</span>
          {latest?.runId && <span className="tk-badge">Run {latest.runId.slice(0, 8)}</span>}
        </div>
      </div>
      <div className="tk-panel-body space-y-4">
        {syncing && (
          <div className="rounded-md border border-blue-100 bg-blue-50 px-3 py-2 text-sm text-blue-800">
            正在保存配置并同步可用来源，完成后这里会显示每个来源的耗时和错误。
          </div>
        )}

        {latest ? (
          <div className="grid gap-2 lg:grid-cols-2">
            {latest.sources.map((source) => (
              <KnowledgeSyncSourceCard key={`${latest.runId}:${source.source}`} source={source} />
            ))}
          </div>
        ) : (
          <div className="tk-muted-box">还没有同步记录。点击「同步知识库」后会保存运行日志。</div>
        )}

        <div className="rounded-md border border-border bg-white">
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <span className="text-sm font-semibold text-slate-950">最近同步记录</span>
            <span className="tk-badge">{logs.length} 条</span>
          </div>
          {logs.length > 0 ? (
            <div className="divide-y divide-border">
              {logs.slice(0, 5).map((item) => (
                <div key={item.runId || item.startedAt || item.endedAt || String(item.durationMs)} className="grid gap-2 px-3 py-2 text-sm md:grid-cols-[minmax(0,1fr)_120px_120px_110px]">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`tk-badge ${syncStatusBadgeClass(item.status)}`}>
                        {formatSyncRunStatus(item.status)}
                      </span>
                      <span className="truncate font-medium text-slate-900">
                        {formatSyncSourceSummary(item)}
                      </span>
                    </div>
                    {item.errors.length > 0 && (
                      <p className="mt-1 truncate text-xs text-amber-700">{item.errors[0]}</p>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {item.endedAt ? formatCompactDate(item.endedAt) : "未完成"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatDuration(item.durationMs)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatSyncCountSummary(item)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-3 py-3 text-sm text-muted-foreground">暂无历史同步记录</div>
          )}
        </div>
      </div>
    </section>
  )
}

function KnowledgeSyncSourceCard({ source }: { source: KnowledgeSyncSourceResult }) {
  const toneClass = source.skipped
    ? "border-slate-200 bg-slate-50 text-slate-600"
    : source.ok
      ? "border-emerald-100 bg-emerald-50 text-emerald-700"
      : "border-amber-100 bg-amber-50 text-amber-800"
  const badgeClass = source.skipped
    ? ""
    : source.ok
      ? "tk-badge-success"
      : "tk-badge-warning"
  const stateText = source.skipped ? "跳过" : source.ok ? "完成" : "有错误"
  const summaryText = source.skipped
    ? source.reason ?? "未配置为可同步来源"
    : formatSyncCountSummary(source)

  return (
    <div className={`rounded-md border px-3 py-2 text-sm ${toneClass}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-slate-900">{source.label}</span>
        <span className={`tk-badge ${badgeClass}`}>{stateText}</span>
        <span className="tk-badge">{formatDuration(source.durationMs)}</span>
        {source.documentsFound > 0 && <span className="tk-badge">发现 {source.documentsFound} 篇</span>}
        {source.notebooksScanned > 0 && <span className="tk-badge">扫描 {source.notebooksScanned} 个笔记本</span>}
      </div>
      <p className="mt-1 text-xs leading-5">{summaryText}</p>
      {source.errors.length > 0 && (
        <p className="mt-1 text-xs leading-5">{source.errors.slice(0, 2).join("；")}</p>
      )}
    </div>
  )
}

function CitationList({
  items,
  emptyText,
  compact = false,
  onStatus,
}: {
  items: KnowledgeCitation[]
  emptyText: string
  compact?: boolean
  onStatus?: (message: string) => void
}) {
  if (items.length === 0) {
    return <div className="tk-muted-box">{emptyText}</div>
  }
  return (
    <div className="grid gap-2">
      {items.map((item, index) => (
        <div key={`${item.paragraphId ?? item.chunkId}:${index}`} className="rounded-md border border-border p-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="tk-badge">来源 {index + 1}</span>
            <span className="tk-badge">段落</span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900">
              {item.title}
            </span>
            <span className="tk-badge">{formatSourceType(item.sourceType)}</span>
          </div>
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {sourceTarget(item) || item.documentId}
            </p>
            <button
              className="tk-icon-button"
              title="打开来源"
              disabled={!sourceTarget(item)}
              onClick={() => openCitationSource(item, onStatus)}>
              <Folder className="h-4 w-4" />
            </button>
            <button
              className="tk-icon-button"
              title="复制来源"
              onClick={() => copyCitationSource(item, onStatus)}>
              <Copy className="h-4 w-4" />
            </button>
          </div>
          {!compact && (
            <p className="mt-2 max-h-24 overflow-hidden whitespace-pre-wrap text-sm leading-6 text-slate-700">
              {item.content}
            </p>
          )}
        </div>
      ))}
    </div>
  )
}

function formatCompactDate(value: string): string {
  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}

function formatDuration(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 ms"
  if (value < 1000) return `${value} ms`
  return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)} s`
}

function formatSyncRunStatus(value: string): string {
  if (value === "success") return "完成"
  if (value === "partial") return "部分完成"
  if (value === "failed") return "失败"
  if (value === "skipped") return "全部跳过"
  if (value === "running") return "同步中"
  return value || "未知"
}

function syncStatusBadgeClass(value: string): string {
  if (value === "success") return "tk-badge-success"
  if (value === "partial" || value === "skipped" || value === "running") return "tk-badge-warning"
  if (value === "failed" || value === "error") return "tk-badge-warning"
  return ""
}

function formatSyncSourceSummary(result: KnowledgeSyncAllResponse): string {
  const active = result.sources.filter((source) => !source.skipped)
  if (active.length === 0) return "没有可同步来源"
  return active.map((source) => source.label).join("、")
}

function formatSyncCountSummary(
  result: Pick<KnowledgeSyncAllResponse, "documentsIndexed" | "documentsSkipped" | "documentsDeleted" | "chunksIndexed">,
): string {
  const deleted = result.documentsDeleted ?? 0
  const deletedText = deleted > 0 ? `，清理 ${deleted} 篇` : ""
  return `更新 ${result.documentsIndexed} 篇，跳过 ${result.documentsSkipped} 篇${deletedText}，生成 ${result.chunksIndexed} 个检索片段`
}

function formatKnowledgeSyncStatus(result: KnowledgeSyncAllResponse): string {
  const activeSources = result.sources.filter((source) => !source.skipped)
  const skippedSources = result.sources.filter((source) => source.skipped)
  const sourceText = activeSources.length > 0
    ? activeSources.map((source) => source.label).join("、")
    : "没有可同步来源"
  const base = `知识库同步${result.ok ? "完成" : "完成但有错误"}：${sourceText}，${formatSyncCountSummary(result)}`
  const skippedText = skippedSources.length > 0
    ? `；已跳过 ${skippedSources.map((source) => source.label).join("、")}`
    : ""
  const errorText = result.errors.length > 0 ? `；${result.errors.slice(0, 2).join("；")}` : ""
  return `${base}${skippedText}${errorText}`
}

function formatIndexHealthStatus(health: KnowledgeIndexHealthResponse): string {
  if (health.issues.length === 0) {
    return `索引健康：${health.documents} 篇文档，${health.paragraphs} 个段落，${health.chunks} 个检索片段`
  }
  const repairableText = health.repairableIssues.length > 0
    ? `，${health.repairableIssues.length} 项可轻量修复`
    : ""
  return `索引需要关注：发现 ${health.issues.length} 项问题${repairableText}`
}

function formatIndexRepairStatus(result: KnowledgeIndexRepairResponse): string {
  const errorText = result.errors.length > 0 ? `；${result.errors.slice(0, 2).join("；")}` : ""
  if (!result.ok) return `索引修复失败${errorText}`
  if (!result.repaired) return `索引健康：没有发现需要轻量修复的问题${errorText}`
  return `索引修复完成：已处理 ${result.orphanFtsRowsDeleted + result.missingFtsRowsInserted} 项索引问题${errorText}`
}

function sourceTarget(item: KnowledgeCitation): string {
  return item.url || item.path || ""
}

async function openCitationSource(
  item: KnowledgeCitation,
  onStatus?: (message: string) => void,
): Promise<void> {
  const target = sourceTarget(item)
  if (!target) {
    onStatus?.("这个来源没有可打开的路径")
    return
  }
  try {
    await openExternalTarget(target)
    onStatus?.("已打开来源")
  } catch (err) {
    onStatus?.(`打开来源失败: ${errorMessage(err)}`)
  }
}

async function copyCitationSource(
  item: KnowledgeCitation,
  onStatus?: (message: string) => void,
): Promise<void> {
  const target = sourceTarget(item) || item.documentId
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
