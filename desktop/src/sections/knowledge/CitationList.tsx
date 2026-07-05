import { Copy, Folder } from "lucide-react"

import { openExternalTarget } from "../../api"
import { errorMessage } from "../../lib/errors"
import type { KnowledgeCitation } from "../../types"
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
