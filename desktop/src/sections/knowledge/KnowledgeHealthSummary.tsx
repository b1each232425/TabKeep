import { RefreshCw, RotateCcw } from "lucide-react"

import { Button, StatusCard } from "../../components/primitives"
import type { KnowledgeIndexHealthResponse, KnowledgeStats } from "../../types"
import { formatCompactDate } from "./knowledgeFormat"

export function KnowledgeHealthSummary({
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
