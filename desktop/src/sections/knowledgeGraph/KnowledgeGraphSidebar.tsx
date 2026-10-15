import { RefreshCw, Search } from "lucide-react"

import { Button } from "../../components/primitives"
import type {
  KnowledgeGraphLayer,
  KnowledgeGraphNode,
  KnowledgeGraphResponse,
} from "../../types"
import {
  formatGraphEdgeKind,
  formatGraphNodeKind,
  graphEdgeColor,
  graphNodeColor,
  type GraphDepth,
  type GraphFlowEdge,
  type GraphFlowNode,
  type GraphRelation,
} from "./graphModel"

export function KnowledgeGraphSidebar({
  graphLayer,
  graphSourceType,
  graphQuery,
  graphDepth,
  graphResult,
  graphData,
  graphLoading,
  graphRebuilding,
  focusNodes,
  selectedGraphNode,
  graphRelation,
  graphKindStats,
  graphEdgeStats,
  onLayerChange,
  onSourceTypeChange,
  onQueryChange,
  onLoadGraph,
  onRebuildGraph,
  onDepthChange,
  onSelectNode,
}: {
  graphLayer: KnowledgeGraphLayer
  graphSourceType: string
  graphQuery: string
  graphDepth: GraphDepth
  graphResult: KnowledgeGraphResponse | null
  graphData: { nodes: GraphFlowNode[]; edges: GraphFlowEdge[] }
  graphLoading: boolean
  graphRebuilding: boolean
  focusNodes: KnowledgeGraphNode[]
  selectedGraphNode: KnowledgeGraphNode | null
  graphRelation: GraphRelation
  graphKindStats: Record<string, number>
  graphEdgeStats: Record<string, number>
  onLayerChange: (value: KnowledgeGraphLayer) => void
  onSourceTypeChange: (value: string) => void
  onQueryChange: (value: string) => void
  onLoadGraph: () => void
  onRebuildGraph: () => void
  onDepthChange: (value: GraphDepth) => void
  onSelectNode: (node: KnowledgeGraphNode) => void
}) {
  return (
    <aside className="space-y-4 rounded-md border border-slate-200 bg-slate-50 p-3">
      <div className="grid gap-3">
        <label className="tk-field">
          <span className="tk-label">层级</span>
          <select
            className="tk-select"
            value={graphLayer}
            onChange={(event) => onLayerChange(event.target.value as KnowledgeGraphLayer)}>
            <option value="documents">文档关系</option>
            <option value="concepts">概念关系</option>
            <option value="all">全部关系</option>
          </select>
        </label>
        <label className="tk-field">
          <span className="tk-label">来源</span>
          <select
            className="tk-select"
            value={graphSourceType}
            onChange={(event) => onSourceTypeChange(event.target.value)}>
            <option value="">全部来源</option>
            <option value="tabkeep_note">TabKeep</option>
            <option value="markdown">Markdown / Obsidian</option>
            <option value="siyuan">SiYuan</option>
          </select>
        </label>
        <label className="tk-field">
          <span className="tk-label">关键词</span>
          <input
            className="tk-input"
            value={graphQuery}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onLoadGraph()
            }}
            placeholder="标题、标签、概念或路径"
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={onLoadGraph} disabled={graphLoading}>
            <Search className="h-4 w-4" />
            {graphLoading ? "加载中..." : "应用"}
          </Button>
          <Button variant="secondary" onClick={onRebuildGraph} disabled={graphRebuilding}>
            <RefreshCw className={`h-4 w-4 ${graphRebuilding ? "animate-spin" : ""}`} />
            {graphRebuilding ? "重建中..." : "重建"}
          </Button>
          <Button
            variant={graphDepth === 1 ? "secondary" : "ghost"}
            onClick={() => onDepthChange(1)}>
            一跳
          </Button>
          <Button
            variant={graphDepth === 2 ? "secondary" : "ghost"}
            onClick={() => onDepthChange(2)}>
            二跳
          </Button>
        </div>
      </div>

      <GraphNodeStats stats={graphKindStats} />
      <GraphEdgeStats stats={graphEdgeStats} />

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900">中心笔记</h3>
          <span className="tk-badge">{focusNodes.length}</span>
        </div>
        <div className="grid max-h-[430px] gap-2 overflow-auto pr-1">
          {focusNodes.length > 0 ? (
            focusNodes.map((node) => {
              const active = selectedGraphNode?.id === node.id
              const relationCount = graphRelation.neighborMap.get(node.id)?.length ?? 0
              return (
                <button
                  key={node.id}
                  className={`rounded-md border bg-white px-3 py-2 text-left transition-colors ${
                    active ? "border-blue-300 ring-2 ring-blue-100" : "border-slate-200 hover:border-blue-200"
                  }`}
                  onClick={() => onSelectNode(node)}>
                  <div className="mb-1 flex items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: graphNodeColor(node.kind) }}
                    />
                    <span className="truncate text-sm font-medium text-slate-900">
                      {node.label}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {formatGraphNodeKind(node.kind)} · {relationCount} 个关联
                  </div>
                </button>
              )
            })
          ) : (
            <div className="tk-muted-box">暂无可作为中心的笔记</div>
          )}
        </div>
      </div>

      {!graphResult && graphData.nodes.length === 0 && (
        <div className="tk-muted-box">选择筛选条件后点击应用，或直接重建图谱。</div>
      )}
    </aside>
  )
}

function GraphNodeStats({ stats }: { stats: Record<string, number> }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-3">
      <h3 className="mb-2 text-sm font-semibold text-slate-900">关系摘要</h3>
      <div className="grid grid-cols-2 gap-2 text-xs">
        {["source", "document", "tag", "heading", "concept"].map((kind) => (
          <div key={kind} className="flex items-center justify-between rounded-md bg-slate-50 px-2 py-1.5">
            <span className="flex items-center gap-1.5 text-slate-600">
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: graphNodeColor(kind) }}
              />
              {formatGraphNodeKind(kind)}
            </span>
            <span className="font-medium text-slate-900">{stats[kind] ?? 0}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function GraphEdgeStats({ stats }: { stats: Record<string, number> }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-3">
      <h3 className="mb-2 text-sm font-semibold text-slate-900">关系类型</h3>
      <div className="grid gap-2 text-xs">
        {["belongs_to_source", "links_to_document", "semantic_similar", "has_tag", "has_heading", "mentions_concept"].map((kind) => (
          <div key={kind} className="flex items-center justify-between rounded-md bg-slate-50 px-2 py-1.5">
            <span className="flex min-w-0 items-center gap-1.5 text-slate-600">
              <span
                className="h-2 w-4 rounded-full"
                style={{ backgroundColor: graphEdgeColor(kind) }}
              />
              <span className="truncate">{formatGraphEdgeKind(kind)}</span>
            </span>
            <span className="font-medium text-slate-900">{stats[kind] ?? 0}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
