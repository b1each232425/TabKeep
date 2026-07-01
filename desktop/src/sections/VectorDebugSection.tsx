import { useEffect, useMemo, useState } from "react"
import { Copy, Folder, RefreshCw, Search } from "lucide-react"

import {
  getKnowledgeIndexHealth,
  hitTestKnowledge,
  inspectKnowledgeVector,
  listKnowledgeDocuments,
  migrateKnowledgeVectorSchema,
  openExternalTarget,
  repairKnowledgeIndex,
} from "../api"
import type {
  KnowledgeCitation,
  KnowledgeDocumentIndexListResponse,
  KnowledgeDocumentIndexStatus,
  KnowledgeHitTestItem,
  KnowledgeHitTestResponse,
  KnowledgeIndexHealthResponse,
  KnowledgeIndexRepairResponse,
  KnowledgeSearchMode,
  KnowledgeVectorInspectResponse,
  KnowledgeVectorRecord,
} from "../types"
import { Button, Notice, StatusCard } from "../components/primitives"
import { errorMessage } from "../lib/errors"
import { KnowledgeIndexHealthPanel } from "./KnowledgeIndexHealthPanel"

export function VectorDebugSection() {
  const [query, setQuery] = useState("")
  const [limit, setLimit] = useState("100")
  const [result, setResult] = useState<KnowledgeVectorInspectResponse | null>(null)
  const [documentQuery, setDocumentQuery] = useState("")
  const [documentSource, setDocumentSource] = useState("")
  const [documentLimit, setDocumentLimit] = useState("200")
  const [documentResult, setDocumentResult] = useState<KnowledgeDocumentIndexListResponse | null>(null)
  const [debugQuery, setDebugQuery] = useState("")
  const [debugMode, setDebugMode] = useState<KnowledgeSearchMode>("hybrid")
  const [debugLimit, setDebugLimit] = useState("8")
  const [debugMinScore, setDebugMinScore] = useState("0")
  const [debugResult, setDebugResult] = useState<KnowledgeHitTestResponse | null>(null)
  const [debugging, setDebugging] = useState(false)
  const [selectedChunkId, setSelectedChunkId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingDocuments, setLoadingDocuments] = useState(false)
  const [indexHealth, setIndexHealth] = useState<KnowledgeIndexHealthResponse | null>(null)
  const [checkingIndex, setCheckingIndex] = useState(false)
  const [repairingIndex, setRepairingIndex] = useState(false)
  const [migrating, setMigrating] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  const filteredDocuments = useMemo(() => {
    const items = documentResult?.items ?? []
    const needle = documentQuery.trim().toLowerCase()
    if (!needle) return items
    return items.filter((item) =>
      [
        item.documentId,
        item.title,
        item.sourceType,
        item.path ?? "",
        item.url ?? "",
        item.noteId ?? "",
        item.contentHash,
        item.indexStatus,
        item.embeddingStatus,
        item.lastError,
      ]
        .join("\n")
        .toLowerCase()
        .includes(needle),
    )
  }, [documentQuery, documentResult])

  const documentSummary = useMemo(() => summarizeDocuments(documentResult?.items ?? []), [documentResult])

  const selected = useMemo(
    () => result?.records.find((record) => record.chunkId === selectedChunkId) ?? result?.records[0] ?? null,
    [result, selectedChunkId],
  )

  const refreshVector = async (clearStatus = true) => {
    setLoading(true)
    if (clearStatus) setStatus(null)
    try {
      const nextLimit = Number(limit)
      const data = await inspectKnowledgeVector({
        query,
        limit: Number.isFinite(nextLimit) && nextLimit > 0 ? nextLimit : 100,
      })
      setResult(data)
      setSelectedChunkId((current) =>
        data.records.some((record) => record.chunkId === current)
          ? current
          : data.records[0]?.chunkId ?? null,
      )
      if (!data.ok) setStatus(data.error ?? data.vectorMessage ?? "读取 LanceDB 失败")
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  const refreshDocuments = async (clearStatus = true) => {
    setLoadingDocuments(true)
    if (clearStatus) setStatus(null)
    try {
      const nextLimit = Number(documentLimit)
      const data = await listKnowledgeDocuments(
        documentSource || undefined,
        Number.isFinite(nextLimit) && nextLimit > 0 ? nextLimit : 200,
      )
      setDocumentResult(data)
      if (!data.ok) setStatus("读取文档索引状态失败")
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setLoadingDocuments(false)
    }
  }

  const checkIndexHealth = async (clearStatus = true) => {
    setCheckingIndex(true)
    if (clearStatus) setStatus(null)
    try {
      const health = await getKnowledgeIndexHealth()
      setIndexHealth(health)
      if (clearStatus) setStatus(formatIndexHealthStatus(health))
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
      setStatus(formatIndexRepairStatus(result))
      await Promise.all([refreshDocuments(false), refreshVector(false)])
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setRepairingIndex(false)
    }
  }

  const refreshAll = async () => {
    setStatus(null)
    await Promise.all([refreshDocuments(false), refreshVector(false), checkIndexHealth(false)])
  }

  const runHitTest = async () => {
    const cleanQuery = debugQuery.trim()
    if (!cleanQuery) return
    setDebugging(true)
    setStatus(null)
    try {
      const nextLimit = Number(debugLimit)
      const minScore = Number(debugMinScore)
      const data = await hitTestKnowledge({
        query: cleanQuery,
        limit: Number.isFinite(nextLimit) && nextLimit > 0 ? nextLimit : 8,
        searchMode: debugMode,
        minScore: Number.isFinite(minScore) && minScore > 0 ? minScore : 0,
      })
      setDebugResult(data)
      if (!data.ok) setStatus(data.error ?? "检索诊断失败")
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setDebugging(false)
    }
  }

  const migrateSchema = async () => {
    setMigrating(true)
    setStatus(null)
    try {
      const migrated = await migrateKnowledgeVectorSchema()
      setResult(migrated)
      setStatus(migrated.schemaReady ? "LanceDB schema 已迁移" : "迁移完成，但仍有缺失字段")
      await refreshVector(false)
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setMigrating(false)
    }
  }

  useEffect(() => {
    refreshAll()
  }, [])

  const statusTone = status?.includes("已迁移") || status?.includes("完成") ? "success" : "warning"

  return (
    <div className="space-y-5">
      <header className="tk-topbar">
        <div>
          <h1 className="tk-page-title">向量库</h1>
          <p className="tk-page-subtitle">索引诊断</p>
        </div>
        <Button
          variant="secondary"
          onClick={refreshAll}
          disabled={loading || loadingDocuments || checkingIndex}>
          <RefreshCw className={`h-4 w-4 ${loading || loadingDocuments || checkingIndex ? "animate-spin" : ""}`} />
          刷新
        </Button>
      </header>

      {status && <Notice tone={statusTone}>{status}</Notice>}

      <section className="tk-status-grid">
        <StatusCard title="文档索引" value={`${documentResult?.total ?? 0} 篇`} tone="neutral" />
        <StatusCard
          title="索引状态"
          value={documentSummary.errors > 0 ? `${documentSummary.errors} 异常` : "正常"}
          tone={documentSummary.errors > 0 ? "warning" : "success"}
        />
        <StatusCard
          title="Embedding"
          value={documentSummary.embeddingErrors > 0 ? `${documentSummary.embeddingErrors} 异常` : `${documentSummary.embeddingReady} ready`}
          tone={documentSummary.embeddingErrors > 0 ? "warning" : "success"}
        />
        <StatusCard title="显示文档" value={`${filteredDocuments.length}`} tone="neutral" />
        <StatusCard
          title="LanceDB"
          value={result?.vectorAvailable ? "可用" : "不可用"}
          tone={result?.vectorAvailable ? "success" : "warning"}
        />
        <StatusCard
          title="向量表"
          value={result?.tableExists ? result.tableName : "不存在"}
          tone={result?.tableExists ? "success" : "warning"}
        />
        <StatusCard title="记录数" value={`${result?.rowCount ?? 0}`} tone="neutral" />
        <StatusCard
          title="Schema"
          value={result?.schemaReady ? "已就绪" : `${result?.missingColumns.length ?? 0} 缺失`}
          tone={result?.schemaReady ? "success" : "warning"}
        />
      </section>

      <KnowledgeIndexHealthPanel
        health={indexHealth}
        checking={checkingIndex}
        repairing={repairingIndex}
        onCheck={checkIndexHealth}
        onRepair={repairIndex}
      />

      <section className="tk-panel">
        <div className="tk-panel-header">
          <div>
            <h2 className="tk-panel-title">检索调试台</h2>
            <p className="text-xs text-muted-foreground">
              {debugResult
                ? `${debugResult.items.length} 个命中 · ${debugResult.sourceMode}`
                : "查看 FTS、向量、融合排序和 rerank 结果"}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="tk-badge">{debugResult?.searchMode ?? debugMode}</span>
            {debugResult?.rerankUsed && <span className="tk-badge tk-badge-success">Rerank</span>}
          </div>
        </div>
        <div className="tk-panel-body space-y-4">
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_150px_110px_120px_auto]">
            <input
              className="tk-input"
              value={debugQuery}
              onChange={(event) => setDebugQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") runHitTest()
              }}
              placeholder="输入要诊断的搜索词"
            />
            <select
              className="tk-select"
              value={debugMode}
              onChange={(event) => setDebugMode(event.target.value as KnowledgeSearchMode)}>
              <option value="hybrid">混合</option>
              <option value="fts">FTS</option>
              <option value="vector">向量</option>
            </select>
            <input
              className="tk-input"
              type="number"
              min={1}
              max={50}
              value={debugLimit}
              onChange={(event) => setDebugLimit(event.target.value)}
              aria-label="命中数量"
            />
            <input
              className="tk-input"
              type="number"
              min={0}
              step={0.05}
              value={debugMinScore}
              onChange={(event) => setDebugMinScore(event.target.value)}
              aria-label="最低分"
            />
            <Button onClick={runHitTest} disabled={debugging || !debugQuery.trim()}>
              <Search className="h-4 w-4" />
              {debugging ? "诊断中..." : "诊断"}
            </Button>
          </div>
          {debugResult?.vectorMessage && (
            <div className="tk-muted-box">{debugResult.vectorMessage}</div>
          )}
          {debugResult?.rerankMessage && (
            <div className="tk-muted-box">{debugResult.rerankMessage}</div>
          )}
          <HitTestList
            items={debugResult?.items ?? []}
            emptyText={debugResult ? "暂无命中" : "暂无诊断结果"}
            onStatus={setStatus}
          />
        </div>
      </section>

      <section className="tk-panel">
        <div className="tk-panel-header">
          <div>
            <h2 className="tk-panel-title">文档索引状态</h2>
            <p className="text-xs text-muted-foreground">SQLite documents 表，观察增量同步、内容 hash 和 embedding 状态</p>
          </div>
          <span className="tk-badge">{filteredDocuments.length} / {documentResult?.total ?? 0} 篇</span>
        </div>
        <div className="tk-panel-body space-y-4">
          <div className="grid gap-3 lg:grid-cols-[160px_minmax(0,1fr)_120px_auto]">
            <select
              className="tk-select"
              value={documentSource}
              onChange={(event) => setDocumentSource(event.target.value)}
              aria-label="文档来源">
              <option value="">全部来源</option>
              <option value="markdown">Markdown</option>
              <option value="siyuan">SiYuan</option>
              <option value="tabkeep_note">TabKeep</option>
            </select>
            <input
              className="tk-input"
              value={documentQuery}
              onChange={(event) => setDocumentQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") refreshDocuments()
              }}
              placeholder="过滤标题、路径、document_id、hash、错误信息"
            />
            <input
              className="tk-input"
              type="number"
              min={1}
              max={1000}
              value={documentLimit}
              onChange={(event) => setDocumentLimit(event.target.value)}
              aria-label="文档显示数量"
            />
            <Button onClick={() => refreshDocuments()} disabled={loadingDocuments}>
              <Search className="h-4 w-4" />
              查询
            </Button>
          </div>

          {filteredDocuments.length > 0 ? (
            <div className="grid max-h-[520px] gap-2 overflow-auto pr-1">
              {filteredDocuments.map((item) => (
                <DocumentIndexRow key={item.documentId} item={item} />
              ))}
            </div>
          ) : (
            <div className="tk-muted-box">暂无文档索引记录</div>
          )}
        </div>
      </section>

      <section className="tk-panel">
        <div className="tk-panel-header">
          <div>
            <h2 className="tk-panel-title">检查条件</h2>
            <p className="text-xs text-muted-foreground">{result?.path || "backend/data/knowledge.lance"}</p>
          </div>
          <span className="tk-badge">{result?.records.length ?? 0} 条显示</span>
        </div>
        <div className="tk-panel-body space-y-4">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_120px_auto_auto]">
            <input
              className="tk-input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") refreshVector()
              }}
              placeholder="过滤 chunk_id、paragraph_id、标题、路径或内容"
            />
            <input
              className="tk-input"
              type="number"
              min={1}
              max={500}
              value={limit}
              onChange={(event) => setLimit(event.target.value)}
              aria-label="显示数量"
            />
            <Button onClick={() => refreshVector()} disabled={loading}>
              <Search className="h-4 w-4" />
              查询
            </Button>
            <Button
              variant="secondary"
              onClick={migrateSchema}
              disabled={migrating || !result?.tableExists || result.schemaReady}>
              <RefreshCw className={`h-4 w-4 ${migrating ? "animate-spin" : ""}`} />
              迁移 Schema
            </Button>
          </div>

          {result?.vectorMessage && <div className="tk-muted-box">{result.vectorMessage}</div>}

          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-md border border-border p-3">
              <div className="mb-2 text-xs font-semibold text-slate-900">字段</div>
              <div className="flex flex-wrap gap-2">
                {(result?.columns ?? []).map((column) => (
                  <span key={column.name} className="tk-badge" title={column.type}>
                    {column.name}
                  </span>
                ))}
                {(!result || result.columns.length === 0) && (
                  <span className="text-xs text-muted-foreground">暂无 schema</span>
                )}
              </div>
            </div>
            <div className="rounded-md border border-border p-3">
              <div className="mb-2 text-xs font-semibold text-slate-900">必需字段</div>
              <div className="flex flex-wrap gap-2">
                {(result?.requiredColumns ?? []).map((column) => (
                  <span
                    key={column}
                    className={`tk-badge ${result?.missingColumns.includes(column) ? "border-amber-200 bg-amber-50 text-amber-800" : ""}`}>
                    {column}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <section className="tk-panel">
          <div className="tk-panel-header">
            <h2 className="tk-panel-title">Chunks</h2>
            <span className="tk-badge">{result?.records.length ?? 0}</span>
          </div>
          <div className="tk-panel-body">
            {result?.records.length ? (
              <div className="grid max-h-[620px] gap-2 overflow-auto pr-1">
                {result.records.map((record) => (
                  <VectorRecordButton
                    key={record.chunkId}
                    record={record}
                    active={record.chunkId === selected?.chunkId}
                    onClick={() => setSelectedChunkId(record.chunkId)}
                  />
                ))}
              </div>
            ) : (
              <div className="tk-muted-box">暂无向量记录</div>
            )}
          </div>
        </section>

        <section className="tk-panel">
          <div className="tk-panel-header">
            <h2 className="tk-panel-title">Chunk / Paragraph</h2>
            <span className="tk-badge">{selected?.vectorDims ? `${selected.vectorDims} 维` : "未选择"}</span>
          </div>
          <div className="tk-panel-body">
            {selected ? (
              <VectorRecordDetail record={selected} />
            ) : (
              <div className="tk-muted-box">选择一条 chunk 查看完整信息</div>
            )}
          </div>
        </section>
      </section>
    </div>
  )
}

function DocumentIndexRow({ item }: { item: KnowledgeDocumentIndexStatus }) {
  const target = item.path || item.url || item.noteId || item.documentId
  return (
    <div className="rounded-md border border-border bg-white p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="tk-badge">{formatSourceType(item.sourceType)}</span>
        <span className={`tk-badge ${statusBadgeClass(item.indexStatus, item.lastError)}`}>
          {formatIndexStatus(item.indexStatus)}
        </span>
        <span className={`tk-badge ${embeddingBadgeClass(item.embeddingStatus)}`}>
          {formatEmbeddingStatus(item.embeddingStatus)}
        </span>
        <span className="tk-badge">{shortHash(item.contentHash)}</span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">
          {item.title || "未命名文档"}
        </span>
      </div>
      <p className="truncate font-mono text-xs text-muted-foreground">{target}</p>
      <div className="mt-2 grid gap-2 text-xs text-slate-600 md:grid-cols-5">
        <div className="rounded-md bg-slate-50 px-2 py-1.5">段落 {item.paragraphCount}</div>
        <div className="rounded-md bg-slate-50 px-2 py-1.5">Chunks {item.chunkCount}</div>
        <div className="rounded-md bg-slate-50 px-2 py-1.5">{formatBytes(item.contentBytes)}</div>
        <div className="rounded-md bg-slate-50 px-2 py-1.5">
          索引 {formatCompactDate(item.indexedAt)}
        </div>
        <div className="rounded-md bg-slate-50 px-2 py-1.5">
          发现 {item.lastSeenAt ? formatCompactDate(item.lastSeenAt) : "-"}
        </div>
      </div>
      {item.lastError && (
        <p className="mt-2 max-h-16 overflow-auto whitespace-pre-wrap rounded-md border border-amber-100 bg-amber-50 px-2 py-1.5 text-xs leading-5 text-amber-800">
          {item.lastError}
        </p>
      )}
    </div>
  )
}

function HitTestList({
  items,
  emptyText,
  onStatus,
}: {
  items: KnowledgeHitTestItem[]
  emptyText: string
  onStatus?: (message: string) => void
}) {
  if (items.length === 0) {
    return <div className="tk-muted-box">{emptyText}</div>
  }
  return (
    <div className="grid gap-2">
      {items.map((item) => (
        <div key={item.paragraphId ?? item.chunkId} className="rounded-md border border-border p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="tk-badge">#{item.rank}</span>
            {item.matchedBy.map((source) => (
              <span key={source} className="tk-badge">
                {formatRetrievalSource(source)}
              </span>
            ))}
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900">
              {item.title}
            </span>
            {item.rerankScore !== null && item.rerankScore !== undefined && (
              <span className="tk-badge tk-badge-success">Rerank {formatDebugScore(item.rerankScore)}</span>
            )}
            <span className="tk-badge">{formatSourceType(item.sourceType)}</span>
          </div>
          <div className="grid gap-2 text-xs text-slate-600 md:grid-cols-5">
            <div className="rounded-md bg-slate-50 px-2 py-1.5">
              FTS {item.ftsRank ? `#${item.ftsRank}` : "-"} · {formatDebugScore(item.ftsScore)}
            </div>
            <div className="rounded-md bg-slate-50 px-2 py-1.5">
              Vector {item.vectorRank ? `#${item.vectorRank}` : "-"} · {formatDebugScore(item.vectorScore)}
            </div>
            <div className="rounded-md bg-slate-50 px-2 py-1.5">
              RRF {item.rrfRank ? `#${item.rrfRank}` : "-"} · {formatDebugScore(item.rrfScore)}
            </div>
            <div className="rounded-md bg-slate-50 px-2 py-1.5">
              Rerank {formatDebugScore(item.rerankScore)}
            </div>
            <div className="rounded-md bg-slate-50 px-2 py-1.5">
              Distance {formatDebugScore(item.vectorDistance)}
            </div>
          </div>
          <div className="mt-2 flex items-center gap-2">
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
          {item.matchedContent && item.matchedContent !== item.content && (
            <p className="mt-2 max-h-16 overflow-hidden whitespace-pre-wrap rounded-md bg-slate-50 px-2 py-1.5 text-xs leading-5 text-slate-600">
              命中片段：{item.matchedContent}
            </p>
          )}
          <p className="mt-2 max-h-24 overflow-hidden whitespace-pre-wrap text-sm leading-6 text-slate-700">
            {item.content}
          </p>
        </div>
      ))}
    </div>
  )
}

function VectorRecordButton({
  record,
  active,
  onClick,
}: {
  record: KnowledgeVectorRecord
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      className={`rounded-md border p-3 text-left transition ${
        active ? "border-primary bg-primary/5" : "border-border bg-white hover:border-primary/50"
      }`}
      onClick={onClick}>
      <div className="mb-2 flex items-center gap-2">
        <span className="tk-badge">{record.sourceType || "source"}</span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">
          {record.documentTitle || record.title || "未命名 chunk"}
        </span>
        <span className="tk-badge">{record.vectorDims}d</span>
      </div>
      <p className="truncate font-mono text-xs text-muted-foreground">{record.chunkId}</p>
      {record.paragraphId && (
        <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{record.paragraphId}</p>
      )}
      <p className="mt-2 max-h-12 overflow-hidden text-sm leading-6 text-slate-700">{record.contentPreview || record.content}</p>
    </button>
  )
}

function VectorRecordDetail({ record }: { record: KnowledgeVectorRecord }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        <VectorDebugField label="chunk_id" value={record.chunkId} mono />
        <VectorDebugField label="paragraph_id" value={record.paragraphId || "-"} mono />
        <VectorDebugField label="document_id" value={record.documentId} mono />
        <VectorDebugField label="source" value={formatSourceType(record.sourceType)} />
        <VectorDebugField label="path" value={record.path || record.url || "-"} mono />
        <VectorDebugField label="vector" value={`${record.vectorDims} 维 · ${formatVectorPreview(record.vectorPreview)}`} mono />
      </div>

      <div className="rounded-md border border-border p-3">
        <div className="mb-2 text-xs font-semibold text-slate-900">Chunk 内容</div>
        <p className="max-h-52 overflow-auto whitespace-pre-wrap text-sm leading-6 text-slate-700">
          {record.content || "无内容"}
        </p>
      </div>

      <div className="rounded-md border border-border p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-xs font-semibold text-slate-900">对应 Paragraph</span>
          {record.paragraphCharLen !== null && record.paragraphCharLen !== undefined && (
            <span className="tk-badge">{record.paragraphCharLen} chars</span>
          )}
        </div>
        <div className="mb-2 text-sm font-medium text-slate-900">
          {record.paragraphTitle || record.documentTitle || record.title || "未关联 paragraph"}
        </div>
        <p className="max-h-64 overflow-auto whitespace-pre-wrap text-sm leading-6 text-slate-700">
          {record.paragraphContentPreview || "SQLite 中没有找到对应 paragraph，可能是旧向量记录或尚未重建索引。"}
        </p>
      </div>
    </div>
  )
}

function VectorDebugField({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="rounded-md bg-slate-50 px-3 py-2">
      <div className="mb-1 text-[11px] font-semibold uppercase text-muted-foreground">
        {label}
      </div>
      <div className={`break-all text-sm text-slate-800 ${mono ? "font-mono" : ""}`}>{value}</div>
    </div>
  )
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
  if (value === "tabkeep_note") return "TabKeep"
  if (value === "markdown") return "Markdown"
  if (value === "siyuan") return "SiYuan"
  return value || "未知"
}

function formatRetrievalSource(value: string): string {
  if (value === "source") return "来源"
  if (value === "fts") return "FTS"
  if (value === "vector") return "Vector"
  if (value === "rerank") return "Rerank"
  return value || "来源"
}

function formatDebugScore(value?: number | null): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "-"
  if (Math.abs(value) >= 100) return value.toFixed(1)
  if (Math.abs(value) >= 1) return value.toFixed(3)
  return value.toFixed(4)
}

function formatIndexHealthStatus(health: KnowledgeIndexHealthResponse): string {
  if (health.issues.length === 0) {
    return `索引健康：SQLite ${health.documents} 文档 / ${health.paragraphs} 段落，FTS ${health.ftsRows} 行，LanceDB ${health.vectorRows} 行`
  }
  const repairableText = health.repairableIssues.length > 0
    ? `，${health.repairableIssues.length} 项可自动修复`
    : ""
  return `索引需要关注：发现 ${health.issues.length} 项问题${repairableText}`
}

function formatIndexRepairStatus(result: KnowledgeIndexRepairResponse): string {
  const errorText = result.errors.length > 0 ? `；${result.errors.slice(0, 2).join("；")}` : ""
  if (!result.ok) return `索引修复失败${errorText}`
  if (!result.repaired) return `索引健康：没有发现需要轻量修复的问题${errorText}`
  return `索引修复完成：清理 ${result.orphanFtsRowsDeleted} 条孤儿 FTS，补建 ${result.missingFtsRowsInserted} 条 FTS${errorText}`
}

function summarizeDocuments(items: KnowledgeDocumentIndexStatus[]) {
  return items.reduce(
    (summary, item) => {
      if (item.indexStatus !== "ready" || item.lastError) summary.errors += 1
      if (item.embeddingStatus === "ready") summary.embeddingReady += 1
      if (item.embeddingStatus === "error") summary.embeddingErrors += 1
      return summary
    },
    { errors: 0, embeddingReady: 0, embeddingErrors: 0 },
  )
}

function formatIndexStatus(value: string): string {
  if (value === "ready") return "索引 ready"
  if (value === "warning") return "索引 warning"
  if (value === "error") return "索引 error"
  return value || "索引未知"
}

function formatEmbeddingStatus(value: string): string {
  if (value === "ready") return "Embedding ready"
  if (value === "disabled") return "Embedding disabled"
  if (value === "error") return "Embedding error"
  if (value === "vector_unavailable") return "Vector unavailable"
  return value || "Embedding unknown"
}

function statusBadgeClass(status: string, lastError: string): string {
  if (status === "ready" && !lastError) return "tk-badge-success"
  return "border-amber-200 bg-amber-50 text-amber-800"
}

function embeddingBadgeClass(status: string): string {
  if (status === "ready") return "tk-badge-success"
  if (status === "disabled") return ""
  return "border-amber-200 bg-amber-50 text-amber-800"
}

function shortHash(value: string): string {
  if (!value) return "hash -"
  return `hash ${value.slice(0, 8)}`
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B"
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(2)} MB`
}

function formatCompactDate(value: string): string {
  if (!value) return "-"
  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}

function formatVectorPreview(values: number[]): string {
  if (!values.length) return "-"
  return values.map((value) => Number(value).toFixed(4)).join(", ")
}
