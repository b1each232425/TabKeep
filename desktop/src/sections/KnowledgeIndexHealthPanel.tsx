import { RefreshCw, RotateCcw } from "lucide-react"

import type { KnowledgeIndexHealthIssue, KnowledgeIndexHealthResponse } from "../types"
import { Button, StatusCard } from "../components/primitives"

export function KnowledgeIndexHealthPanel({
  health,
  checking,
  repairing,
  onCheck,
  onRepair,
}: {
  health: KnowledgeIndexHealthResponse | null
  checking: boolean
  repairing: boolean
  onCheck: () => void
  onRepair: () => void
}) {
  const issueCount = health?.issues.length ?? 0
  const repairableCount = health?.repairableIssues.length ?? 0
  const healthy = Boolean(health && issueCount === 0)

  return (
    <section className="tk-panel">
      <div className="tk-panel-header">
        <div>
          <h2 className="tk-panel-title">索引健康</h2>
          <p className="text-xs text-muted-foreground">
            {health
              ? `检查于 ${formatCheckedAt(health.checkedAt)}`
              : "检查 SQLite、FTS 和 LanceDB 是否一致"}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className={`tk-badge ${healthy ? "tk-badge-success" : issueCount > 0 ? "tk-badge-warning" : ""}`}>
            {health ? formatHealthStatus(health) : "未检查"}
          </span>
          <Button variant="secondary" onClick={onCheck} disabled={checking || repairing}>
            <RefreshCw className={`h-4 w-4 ${checking ? "animate-spin" : ""}`} />
            {checking ? "检查中..." : "检查索引"}
          </Button>
          <Button
            variant="secondary"
            onClick={onRepair}
            disabled={checking || repairing || !health || repairableCount === 0}
            title={repairableCount > 0 ? "修复缺失或孤儿 FTS 行" : "当前没有可自动修复的问题"}>
            <RotateCcw className={`h-4 w-4 ${repairing ? "animate-spin" : ""}`} />
            {repairing ? "修复中..." : "修复轻量问题"}
          </Button>
        </div>
      </div>

      <div className="tk-panel-body space-y-4">
        <section className="tk-status-grid">
          <StatusCard
            title="SQLite"
            value={health ? `${health.documents} 文档 / ${health.paragraphs} 段落` : "待检查"}
            tone={health ? "success" : "neutral"}
          />
          <StatusCard
            title="Chunks"
            value={health ? `${health.chunks} 个` : "待检查"}
            tone={health ? "success" : "neutral"}
          />
          <StatusCard
            title="FTS"
            value={health ? `${health.ftsRows} 行` : "待检查"}
            tone={health?.missingFtsRows || health?.orphanFtsRows ? "warning" : health ? "success" : "neutral"}
          />
          <StatusCard
            title="向量"
            value={health ? `${health.vectorRows} 行` : "待检查"}
            tone={health?.vectorAvailable && health?.vectorSchemaReady ? "success" : health ? "warning" : "neutral"}
          />
          <StatusCard
            title="可修复"
            value={health ? `${repairableCount} 项` : "待检查"}
            tone={repairableCount > 0 ? "warning" : health ? "success" : "neutral"}
          />
        </section>

        {health && (
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(260px,0.45fr)]">
            <div className="rounded-md border border-border bg-white p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-slate-950">一致性检查</span>
                <span className="tk-badge">缺 FTS {health.missingFtsRows}</span>
                <span className="tk-badge">孤儿 FTS {health.orphanFtsRows}</span>
                <span className="tk-badge">向量孤儿 {health.vectorMissingSqlRows}</span>
                <span className="tk-badge">缺段落 {health.vectorMissingParagraphRows}</span>
              </div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                {formatHealthExplanation(health)}
              </p>
            </div>

            <div className="rounded-md border border-border bg-white p-3">
              <p className="text-sm font-semibold text-slate-950">Embedding 状态</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {Object.keys(health.embeddingStatusCounts).length > 0 ? (
                  Object.entries(health.embeddingStatusCounts).map(([key, value]) => (
                    <span key={key} className="tk-badge">
                      {formatEmbeddingStatus(key)} {value}
                    </span>
                  ))
                ) : (
                  <span className="text-xs text-muted-foreground">暂无 chunk 状态</span>
                )}
              </div>
              {health.vectorMessage && (
                <p className="mt-2 text-xs leading-5 text-muted-foreground">{health.vectorMessage}</p>
              )}
            </div>
          </div>
        )}

        {health && health.issues.length > 0 ? (
          <div className="grid gap-2">
            {health.issues.map((issue) => (
              <IndexHealthIssueCard key={issue.key} issue={issue} />
            ))}
          </div>
        ) : (
          <div className="tk-muted-box">
            {health ? "没有发现 SQLite、FTS 或向量索引漂移。" : "点击检查索引后，这里会显示可解释的问题和修复建议。"}
          </div>
        )}
      </div>
    </section>
  )
}

function IndexHealthIssueCard({ issue }: { issue: KnowledgeIndexHealthIssue }) {
  return (
    <div className={`rounded-md border px-3 py-2 text-sm ${issueToneClass(issue)}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-slate-950">{issue.label}</span>
        <span className="tk-badge">{severityLabel(issue)}</span>
        <span className="tk-badge">{issue.count} 条</span>
        {issue.repairable && <span className="tk-badge tk-badge-success">可自动修复</span>}
      </div>
      <p className="mt-1 text-xs leading-5">{issue.message}</p>
    </div>
  )
}

function formatHealthStatus(health: KnowledgeIndexHealthResponse): string {
  if (health.issues.length === 0) return "健康"
  if (!health.ok) return "需要重建"
  return "需要关注"
}

function formatCheckedAt(value: string): string {
  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}

function formatHealthExplanation(health: KnowledgeIndexHealthResponse): string {
  if (health.issues.length === 0) {
    return "当前 SQLite 文档、段落、chunk、FTS 记录和 LanceDB schema 看起来一致。"
  }
  if (health.repairableIssues.length > 0 && health.ok) {
    return "发现的主要是 FTS 漂移，可用轻量修复补建或清理；不需要立即重建整个知识库。"
  }
  return "发现了无法轻量修复的结构漂移，建议重新同步知识库，必要时重建语义索引。"
}

function formatEmbeddingStatus(value: string): string {
  if (value === "ready") return "已就绪"
  if (value === "indexed") return "已向量化"
  if (value === "pending") return "待处理"
  if (value === "disabled") return "未启用"
  if (value === "error") return "失败"
  if (value === "vector_unavailable") return "向量不可用"
  if (value === "failed") return "失败"
  return value || "未知"
}

function issueToneClass(issue: KnowledgeIndexHealthIssue): string {
  if (issue.severity === "error") return "border-rose-100 bg-rose-50 text-rose-800"
  if (issue.repairable) return "border-amber-100 bg-amber-50 text-amber-800"
  return "border-slate-200 bg-slate-50 text-slate-700"
}

function severityLabel(issue: KnowledgeIndexHealthIssue): string {
  if (issue.severity === "error") return "错误"
  return "提醒"
}
