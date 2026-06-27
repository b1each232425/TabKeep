import {
  Background,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
} from "@xyflow/react"

import type { KnowledgeGraphNode } from "../../types"
import {
  type GraphDepth,
  type GraphFlowEdge,
  type GraphFlowNode,
} from "./graphModel"
import { graphMiniMapNodeColor, KnowledgeMapNode } from "./GraphNodes"

const nodeTypes = { knowledgeMap: KnowledgeMapNode }

export function KnowledgeGraphCanvas({
  graphData,
  graphDepth,
  selectedGraphNode,
  onSelectNode,
  onSelectEdge,
}: {
  graphData: { nodes: GraphFlowNode[]; edges: GraphFlowEdge[] }
  graphDepth: GraphDepth
  selectedGraphNode: KnowledgeGraphNode | null
  onSelectNode: (node: KnowledgeGraphNode) => void
  onSelectEdge: (edge: GraphFlowEdge) => void
}) {
  return (
    <div className="h-[620px] overflow-hidden rounded-md border border-slate-200 bg-[#f8fafc]">
      {graphData.nodes.length > 0 ? (
        <ReactFlow<GraphFlowNode, GraphFlowEdge>
          key={`${graphData.nodes.length}:${graphData.edges.length}:${graphDepth}:${selectedGraphNode?.id ?? ""}`}
          nodes={graphData.nodes}
          edges={graphData.edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.22 }}
          minZoom={0.35}
          maxZoom={1.4}
          nodesDraggable
          nodesConnectable={false}
          elementsSelectable
          onlyRenderVisibleElements
          proOptions={{ hideAttribution: true }}
          onNodeClick={(_, node) => onSelectNode(node.data.graphNode)}
          onEdgeClick={(_, edge) => onSelectEdge(edge)}>
          <Background color="#cbd5e1" gap={24} />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            nodeColor={(node) => graphMiniMapNodeColor(node)}
            nodeStrokeWidth={2}
          />
          <Panel position="top-left">
            <div className="rounded-md border border-slate-200 bg-white/90 px-3 py-2 text-xs text-slate-600 shadow-sm">
              {selectedGraphNode
                ? `中心：${selectedGraphNode.label.length > 18 ? `${selectedGraphNode.label.slice(0, 17)}...` : selectedGraphNode.label} · ${graphDepth} 跳`
                : "选择一个笔记作为中心"}
            </div>
          </Panel>
        </ReactFlow>
      ) : (
        <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
          暂无图谱数据。先重建知识库索引，或点击“重建”从已有索引生成关系。
        </div>
      )}
    </div>
  )
}
