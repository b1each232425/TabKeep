import { Copy, Folder } from "lucide-react"

import { Button } from "../../components/primitives"
import type { KnowledgeGraphNode, NoteAdapterConfig } from "../../types"
import { GraphRelationList } from "./GraphNodes"
import {
  copyGraphNodeSource,
  formatGraphEdgeKind,
  formatGraphNodeKind,
  formatSourceType,
  graphEdgeColor,
  graphNodeColor,
  graphNodeOpenTarget,
  openGraphNodeSource,
  type GraphNodeRelation,
  type GraphRelation,
  type GraphSelectedRelation,
} from "./graphModel"

export function KnowledgeGraphDetailsPanel({
  selectedGraphNode,
  selectedGraphRelation,
  selectedNeighbors,
  selectedOutgoing,
  selectedIncoming,
  graphRelation,
  noteAdapter,
  onStatus,
  onSelectNode,
  onCopyRelation,
}: {
  selectedGraphNode: KnowledgeGraphNode | null
  selectedGraphRelation: GraphSelectedRelation | null
  selectedNeighbors: KnowledgeGraphNode[]
  selectedOutgoing: GraphNodeRelation[]
  selectedIncoming: GraphNodeRelation[]
  graphRelation: GraphRelation
  noteAdapter?: NoteAdapterConfig
  onStatus: (message: string) => void
  onSelectNode: (node: KnowledgeGraphNode) => void
  onCopyRelation: () => void
}) {
  return (
    <aside className="rounded-md border border-slate-200 bg-white p-3">
      {selectedGraphNode ? (
        <div className="space-y-3">
          <div>
            <span className="tk-badge">{formatGraphNodeKind(selectedGraphNode.kind)}</span>
            <h3 className="mt-2 text-sm font-semibold leading-6 text-slate-900">
              {selectedGraphNode.label}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              连接度 {selectedGraphNode.degree} · 直接关联 {(graphRelation.neighborMap.get(selectedGraphNode.id) ?? []).length}
            </p>
          </div>
          {selectedGraphRelation && (
            <div className="rounded-md border border-blue-100 bg-blue-50/50 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h4 className="text-xs font-semibold text-blue-900">关系详情</h4>
                <div className="flex items-center gap-2">
                  <span
                    className="rounded-full px-2 py-0.5 text-xs font-medium text-slate-700"
                    style={{ backgroundColor: graphEdgeColor(selectedGraphRelation.kind) }}>
                    {formatGraphEdgeKind(selectedGraphRelation.kind)}
                  </span>
                  <button
                    className="tk-icon-button h-7 w-7"
                    onClick={onCopyRelation}
                    title="复制关系">
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <div className="grid gap-2 text-xs">
                <button
                  className="rounded-md border border-blue-100 bg-white px-2 py-1.5 text-left hover:border-blue-200"
                  onClick={() => onSelectNode(selectedGraphRelation.source)}>
                  <span className="text-muted-foreground">从：</span>
                  <span className="font-medium text-slate-900">{selectedGraphRelation.source.label}</span>
                </button>
                <button
                  className="rounded-md border border-blue-100 bg-white px-2 py-1.5 text-left hover:border-blue-200"
                  onClick={() => onSelectNode(selectedGraphRelation.target)}>
                  <span className="text-muted-foreground">到：</span>
                  <span className="font-medium text-slate-900">{selectedGraphRelation.target.label}</span>
                </button>
              </div>
            </div>
          )}
          {selectedGraphNode.sourceType && (
            <div className="tk-muted-box">
              <div className="mb-1 text-xs font-medium text-slate-700">
                {formatSourceType(selectedGraphNode.sourceType)}
              </div>
              <div className="text-xs">
                {graphNodeOpenTarget(selectedGraphNode, noteAdapter) ? "可以打开原笔记" : "暂无可打开来源"}
              </div>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => openGraphNodeSource(selectedGraphNode, onStatus, noteAdapter)}
              disabled={!graphNodeOpenTarget(selectedGraphNode, noteAdapter)}>
              <Folder className="h-4 w-4" />
              打开来源
            </Button>
            <Button
              variant="secondary"
              onClick={() => copyGraphNodeSource(selectedGraphNode, onStatus)}>
              <Copy className="h-4 w-4" />
              复制名称
            </Button>
          </div>
          {selectedNeighbors.length > 0 && (
            <DirectNeighborList
              selectedGraphNode={selectedGraphNode}
              selectedNeighbors={selectedNeighbors}
              graphRelation={graphRelation}
              onSelectNode={onSelectNode}
            />
          )}
          {(selectedOutgoing.length > 0 || selectedIncoming.length > 0) && (
            <div className="space-y-3">
              {selectedOutgoing.length > 0 && (
                <GraphRelationList
                  title="指向"
                  items={selectedOutgoing}
                  onSelect={onSelectNode}
                />
              )}
              {selectedIncoming.length > 0 && (
                <GraphRelationList
                  title="来自"
                  items={selectedIncoming}
                  onSelect={onSelectNode}
                />
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="tk-muted-box">点击图谱节点后，这里会显示来源和关系信息。</div>
      )}
    </aside>
  )
}

function DirectNeighborList({
  selectedGraphNode,
  selectedNeighbors,
  graphRelation,
  onSelectNode,
}: {
  selectedGraphNode: KnowledgeGraphNode
  selectedNeighbors: KnowledgeGraphNode[]
  graphRelation: GraphRelation
  onSelectNode: (node: KnowledgeGraphNode) => void
}) {
  return (
    <div>
      <h4 className="mb-2 text-xs font-semibold text-slate-700">直接关联</h4>
      <div className="grid max-h-64 gap-2 overflow-auto pr-1">
        {selectedNeighbors.map((child) => (
          <button
            key={child.id}
            className="rounded-md border border-slate-200 px-3 py-2 text-left text-sm transition-colors hover:border-blue-200 hover:bg-blue-50/40"
            onClick={() => onSelectNode(child)}>
            <div className="flex items-center gap-2">
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: graphNodeColor(child.kind) }}
              />
              <span className="min-w-0 flex-1 truncate font-medium text-slate-900">
                {child.label}
              </span>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {formatGraphEdgeKind(graphRelation.edgeKindMap.get(`${selectedGraphNode.id}->${child.id}`) ?? graphRelation.edgeKindMap.get(`${child.id}->${selectedGraphNode.id}`) ?? "related")} · {formatGraphNodeKind(child.kind)}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
