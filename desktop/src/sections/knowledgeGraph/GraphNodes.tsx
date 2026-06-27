import {
  Handle,
  Position,
  type Node,
  type NodeProps,
} from "@xyflow/react"

import type { KnowledgeGraphNode } from "../../types"
import {
  formatGraphEdgeKind,
  formatGraphNodeKind,
  graphEdgeColor,
  graphNodeColor,
  type GraphFlowNode,
  type GraphFlowNodeData,
  type GraphNodeRelation,
} from "./graphModel"

export function KnowledgeMapNode({ data }: NodeProps<GraphFlowNode>) {
  const node = data.graphNode
  const color = graphNodeColor(node.kind)
  const label = node.label.length > 42 ? `${node.label.slice(0, 41)}...` : node.label

  if (node.kind !== "document") {
    return (
      <button
        className={`relative flex min-h-12 min-w-28 max-w-36 items-center justify-center rounded-full border bg-white px-3 py-2 text-center text-xs font-semibold leading-4 shadow-sm transition-colors ${
          data.selected ? "ring-4 ring-blue-100" : "hover:bg-slate-50"
        } ${data.relatedToSelected ? "" : "opacity-40"}`}
        style={{ borderColor: color, color }}
        title={node.label}
        onClick={() => data.onSelect(node)}>
        <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-0 !bg-slate-300" />
        <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-0 !bg-slate-300" />
        <span className="line-clamp-2">{label}</span>
      </button>
    )
  }

  return (
    <div
      className={`relative w-60 rounded-md border bg-white p-3 shadow-sm transition-colors ${
        data.center ? "shadow-md ring-4 ring-blue-100" : data.selected ? "ring-4 ring-blue-100" : "hover:bg-slate-50"
      } ${data.relatedToSelected ? "" : "opacity-40"}`}
      style={{ borderColor: data.center || data.selected ? color : "#e2e8f0" }}>
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-0 !bg-slate-300" />
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-0 !bg-slate-300" />
      <button className="block w-full text-left" title={node.label} onClick={() => data.onSelect(node)}>
        <div className="mb-2 flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
          <span className="tk-badge">{formatGraphNodeKind(node.kind)}</span>
          {data.center && <span className="tk-badge">中心</span>}
          {data.distance > 0 && <span className="tk-badge">{data.distance} 跳</span>}
        </div>
        <div className="line-clamp-2 text-sm font-semibold leading-5 text-slate-900">{label}</div>
        <div className="mt-2 text-xs text-muted-foreground">
          {data.relationCount} 个关联 · 连接度 {node.degree}
        </div>
      </button>
    </div>
  )
}

export function GraphRelationList({
  title,
  items,
  onSelect,
}: {
  title: string
  items: GraphNodeRelation[]
  onSelect: (node: KnowledgeGraphNode) => void
}) {
  return (
    <div>
      <h4 className="mb-2 text-xs font-semibold text-slate-700">{title}</h4>
      <div className="grid max-h-44 gap-2 overflow-auto pr-1">
        {items.map((item) => (
          <button
            key={`${item.kind}:${item.node.id}`}
            className="rounded-md border border-slate-200 px-3 py-2 text-left text-sm transition-colors hover:border-blue-200 hover:bg-blue-50/40"
            onClick={() => onSelect(item.node)}>
            <div className="flex items-center gap-2">
              <span
                className="h-2 w-4 rounded-full"
                style={{ backgroundColor: graphEdgeColor(item.kind) }}
              />
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: graphNodeColor(item.node.kind) }}
              />
              <span className="min-w-0 flex-1 truncate font-medium text-slate-900">
                {item.node.label}
              </span>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {formatGraphEdgeKind(item.kind)} · {formatGraphNodeKind(item.node.kind)}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

export function graphMiniMapNodeColor(node: Node): string {
  const graphNode = (node.data as Partial<GraphFlowNodeData> | undefined)?.graphNode
  return graphNode ? graphNodeColor(graphNode.kind) : "#64748b"
}
