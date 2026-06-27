import { Search } from "lucide-react"

import { Button } from "../../components/primitives"
import type { KnowledgeSearchResponse } from "../../types"
import { CitationList } from "./CitationList"

export function KnowledgeSearchPanel({
  searchQuery,
  searchResult,
  searching,
  onQueryChange,
  onSearch,
  onStatus,
}: {
  searchQuery: string
  searchResult: KnowledgeSearchResponse | null
  searching: boolean
  onQueryChange: (value: string) => void
  onSearch: () => void
  onStatus: (message: string) => void
}) {
  return (
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
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onSearch()
            }}
            placeholder="搜索项目方案、错误信息、笔记主题"
          />
          <Button onClick={onSearch} disabled={searching || !searchQuery.trim()}>
            <Search className="h-4 w-4" />
            {searching ? "搜索中..." : "搜索"}
          </Button>
        </div>
        <CitationList
          items={searchResult?.items ?? []}
          emptyText="暂无搜索结果"
          onStatus={onStatus}
        />
        {searchResult?.rerankMessage && <div className="tk-muted-box">{searchResult.rerankMessage}</div>}
      </div>
    </section>
  )
}
