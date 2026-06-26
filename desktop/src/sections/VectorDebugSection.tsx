import { useEffect, useMemo, useState } from "react"
import { RefreshCw, Search } from "lucide-react"

import { inspectKnowledgeVector, migrateKnowledgeVectorSchema } from "../api"
import type { KnowledgeVectorInspectResponse, KnowledgeVectorRecord } from "../types"
import { Button, Notice, StatusCard } from "../components/primitives"
import { errorMessage } from "../lib/errors"

export function VectorDebugSection() {
  const [query, setQuery] = useState("")
  const [limit, setLimit] = useState("100")
  const [result, setResult] = useState<KnowledgeVectorInspectResponse | null>(null)
  const [selectedChunkId, setSelectedChunkId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [migrating, setMigrating] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  const selected = useMemo(
    () => result?.records.find((record) => record.chunkId === selectedChunkId) ?? result?.records[0] ?? null,
    [result, selectedChunkId],
  )

  const refresh = async (clearStatus = true) => {
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

  const migrateSchema = async () => {
    setMigrating(true)
    setStatus(null)
    try {
      const migrated = await migrateKnowledgeVectorSchema()
      setResult(migrated)
      setStatus(migrated.schemaReady ? "LanceDB schema 已迁移" : "迁移完成，但仍有缺失字段")
      await refresh(false)
    } catch (err) {
      setStatus(errorMessage(err))
    } finally {
      setMigrating(false)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  const statusTone = status?.includes("已迁移") || status?.includes("完成") ? "success" : "warning"

  return (
    <div className="space-y-5">
      <header className="tk-topbar">
        <div>
          <h1 className="tk-page-title">向量库</h1>
          <p className="tk-page-subtitle">查看 LanceDB chunks 表，并对照 SQLite 里的 paragraph</p>
        </div>
        <Button variant="secondary" onClick={() => refresh()} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          刷新
        </Button>
      </header>

      {status && <Notice tone={statusTone}>{status}</Notice>}

      <section className="tk-status-grid">
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
                if (event.key === "Enter") refresh()
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
            <Button onClick={() => refresh()} disabled={loading}>
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

function formatSourceType(value: string): string {
  if (value === "tabkeep_note") return "TabKeep"
  if (value === "markdown") return "Markdown"
  if (value === "siyuan") return "SiYuan"
  return value || "未知"
}

function formatVectorPreview(values: number[]): string {
  if (!values.length) return "-"
  return values.map((value) => Number(value).toFixed(4)).join(", ")
}
