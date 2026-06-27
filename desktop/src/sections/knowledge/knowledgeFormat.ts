import type {
  KnowledgeCitation,
  KnowledgeIndexHealthResponse,
  KnowledgeIndexRepairResponse,
  KnowledgeSyncAllResponse,
} from "../../types"

export function formatCompactDate(value: string): string {
  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}

export function formatDuration(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 ms"
  if (value < 1000) return `${value} ms`
  return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)} s`
}

export function formatSyncRunStatus(value: string): string {
  if (value === "success") return "完成"
  if (value === "partial") return "部分完成"
  if (value === "failed") return "失败"
  if (value === "skipped") return "全部跳过"
  if (value === "running") return "同步中"
  return value || "未知"
}

export function syncStatusBadgeClass(value: string): string {
  if (value === "success") return "tk-badge-success"
  if (value === "partial" || value === "skipped" || value === "running") return "tk-badge-warning"
  if (value === "failed" || value === "error") return "tk-badge-warning"
  return ""
}

export function formatSyncSourceSummary(result: KnowledgeSyncAllResponse): string {
  const active = result.sources.filter((source) => !source.skipped)
  if (active.length === 0) return "没有可同步来源"
  return active.map((source) => source.label).join("、")
}

export function formatSyncCountSummary(
  result: Pick<KnowledgeSyncAllResponse, "documentsIndexed" | "documentsSkipped" | "documentsDeleted" | "chunksIndexed">,
): string {
  const deleted = result.documentsDeleted ?? 0
  const deletedText = deleted > 0 ? `，清理 ${deleted} 篇` : ""
  return `更新 ${result.documentsIndexed} 篇，跳过 ${result.documentsSkipped} 篇${deletedText}，生成 ${result.chunksIndexed} 个检索片段`
}

export function formatKnowledgeSyncStatus(result: KnowledgeSyncAllResponse): string {
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

export function formatIndexHealthStatus(health: KnowledgeIndexHealthResponse): string {
  if (health.issues.length === 0) {
    return `索引健康：${health.documents} 篇文档，${health.paragraphs} 个段落，${health.chunks} 个检索片段`
  }
  const repairableText = health.repairableIssues.length > 0
    ? `，${health.repairableIssues.length} 项可轻量修复`
    : ""
  return `索引需要关注：发现 ${health.issues.length} 项问题${repairableText}`
}

export function formatIndexRepairStatus(result: KnowledgeIndexRepairResponse): string {
  const errorText = result.errors.length > 0 ? `；${result.errors.slice(0, 2).join("；")}` : ""
  if (!result.ok) return `索引修复失败${errorText}`
  if (!result.repaired) return `索引健康：没有发现需要轻量修复的问题${errorText}`
  return `索引修复完成：已处理 ${result.orphanFtsRowsDeleted + result.missingFtsRowsInserted} 项索引问题${errorText}`
}

export function sourceTarget(item: KnowledgeCitation): string {
  return item.url || item.path || ""
}

export function formatSourceType(value: string): string {
  if (value === "source") return "来源"
  if (value === "siyuan") return "SiYuan"
  if (value === "markdown") return "Markdown"
  if (value === "tabkeep_note") return "TabKeep"
  return value || "来源"
}
