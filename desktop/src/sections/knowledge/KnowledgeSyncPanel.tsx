import type { KnowledgeSyncAllResponse, KnowledgeSyncSourceResult } from "../../types"
import {
  formatCompactDate,
  formatDuration,
  formatSyncCountSummary,
  formatSyncRunStatus,
  formatSyncSourceSummary,
  syncStatusBadgeClass,
} from "./knowledgeFormat"

export function KnowledgeSyncPanel({
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
