import { Copy, Folder } from "lucide-react"

import { openExternalTarget } from "../../api"
import { errorMessage } from "../../lib/errors"
import type { KnowledgeCitation, KnowledgeCitationSource } from "../../types"
import { formatSourceType, sourceTarget } from "./knowledgeFormat"

export function CitationList({
  items,
  emptyText,
  sourceIndexes,
  compact = false,
  onStatus,
}: {
  items: KnowledgeCitation[]
  emptyText: string
  sourceIndexes?: number[]
  compact?: boolean
  onStatus?: (message: string) => void
}) {
  if (items.length === 0) {
    return <div className="tk-muted-box">{emptyText}</div>
  }
  return (
    <div className="tk-citation-list">
      {items.map((item, index) => (
        <div
          key={`${item.paragraphId ?? item.chunkId}:${index}`}
          className={`tk-citation-card ${compact ? "tk-citation-card-compact" : ""}`}>
          <div className="tk-citation-heading">
            <div className="tk-citation-badges">
              <span className="tk-badge">来源 {sourceIndexes?.[index] ?? index + 1}</span>
              <span className="tk-badge">段落</span>
              <span className="tk-badge">{formatSourceType(item.sourceType)}</span>
            </div>
            <h3 className="tk-citation-title">{item.title}</h3>
          </div>
          <div className="tk-citation-source-row">
            <p className="tk-citation-source">
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
          {(item.duplicateSources?.length ?? 0) > 0 && (
            <details className="mt-2 rounded-md border border-slate-200/70 bg-slate-50/70 px-2.5 py-2 text-xs text-slate-600">
              <summary className="cursor-pointer select-none font-medium">
                相同内容另有 {item.duplicateSources?.length} 个来源
              </summary>
              <ul className="mt-2 grid gap-1.5">
                {item.duplicateSources?.map((source) => (
                  <AlternateSource key={`${source.documentId}:${source.paragraphId ?? ""}:${source.chunkId}`} source={source} onStatus={onStatus} />
                ))}
              </ul>
            </details>
          )}
          {!compact && (
            <p className="tk-citation-content">
              {item.content}
            </p>
          )}
        </div>
      ))}
    </div>
  )
}

function AlternateSource({
  source,
  onStatus,
}: {
  source: KnowledgeCitationSource
  onStatus?: (message: string) => void
}) {
  const target = source.url || source.path || ""
  return (
    <li className="flex min-w-0 items-center gap-2">
      <span className="min-w-0 flex-1 break-all">
        {formatSourceType(source.sourceType)} · {source.title} · {target || source.documentId}
      </span>
      <button
        className="tk-icon-button"
        title="打开其他来源"
        aria-label="打开其他来源"
        disabled={!target}
        onClick={() => openCitationTarget(target, onStatus)}>
        <Folder className="h-4 w-4" />
      </button>
      <button
        className="tk-icon-button"
        title="复制其他来源"
        aria-label="复制其他来源"
        onClick={() => copyCitationTarget(target || source.documentId, onStatus)}>
        <Copy className="h-4 w-4" />
      </button>
    </li>
  )
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
  await openCitationTarget(target, onStatus)
}

async function openCitationTarget(target: string, onStatus?: (message: string) => void): Promise<void> {
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
  await copyCitationTarget(target, onStatus)
}

async function copyCitationTarget(target: string, onStatus?: (message: string) => void): Promise<void> {
  try {
    await navigator.clipboard.writeText(target)
    onStatus?.("来源已复制")
  } catch (err) {
    onStatus?.(`复制来源失败: ${errorMessage(err)}`)
  }
}
