import { useEffect, useMemo, useState } from "react"
import "@xyflow/react/dist/style.css"

import {
  getKnowledgeGraph,
  rebuildKnowledgeGraph,
} from "../api"
import type {
  KnowledgeGraphLayer,
  KnowledgeGraphNode,
  KnowledgeGraphResponse,
  NoteAdapterConfig,
} from "../types"
import { errorMessage } from "../lib/errors"
import { KnowledgeGraphCanvas } from "./knowledgeGraph/KnowledgeGraphCanvas"
import { KnowledgeGraphDetailsPanel } from "./knowledgeGraph/KnowledgeGraphDetailsPanel"
import { KnowledgeGraphSidebar } from "./knowledgeGraph/KnowledgeGraphSidebar"
import {
  buildGraphRelation,
  buildVisibleGraphData,
  formatGraphEdgeKind,
  graphEdgeKindStats,
  graphFocusCandidates,
  graphNodeKindStats,
  graphNodeRelations,
  type GraphDepth,
  type GraphFlowEdge,
  type GraphSelectedRelation,
} from "./knowledgeGraph/graphModel"

export function KnowledgeGraphPanel({
  onStatus,
  noteAdapter,
}: {
  onStatus: (message: string) => void
  noteAdapter?: NoteAdapterConfig
}) {
  const [graphLayer, setGraphLayer] = useState<KnowledgeGraphLayer>("documents")
  const [graphQuery, setGraphQuery] = useState("")
  const [graphSourceType, setGraphSourceType] = useState("")
  const [graphResult, setGraphResult] = useState<KnowledgeGraphResponse | null>(null)
  const [selectedGraphNode, setSelectedGraphNode] = useState<KnowledgeGraphNode | null>(null)
  const [selectedGraphRelation, setSelectedGraphRelation] = useState<GraphSelectedRelation | null>(null)
  const [graphDepth, setGraphDepth] = useState<GraphDepth>(1)
  const [graphLoading, setGraphLoading] = useState(false)
  const [graphRebuilding, setGraphRebuilding] = useState(false)

  const graphRelation = useMemo(
    () => buildGraphRelation(graphResult?.nodes ?? [], graphResult?.edges ?? []),
    [graphResult],
  )
  const graphNodeMap = useMemo(
    () => new Map((graphResult?.nodes ?? []).map((node) => [node.id, node])),
    [graphResult],
  )

  const selectGraphNode = (node: KnowledgeGraphNode) => {
    setSelectedGraphRelation(null)
    setSelectedGraphNode(node)
  }

  const selectedRelationKey = useMemo(
    () =>
      selectedGraphRelation
        ? `${selectedGraphRelation.source.id}->${selectedGraphRelation.target.id}:${selectedGraphRelation.kind}`
        : null,
    [selectedGraphRelation],
  )

  const graphData = useMemo(
    () =>
      buildVisibleGraphData({
        graphResult,
        relation: graphRelation,
        selectedNodeId: selectedGraphNode?.id ?? null,
        selectedRelationKey,
        depth: graphDepth,
        onSelect: selectGraphNode,
      }),
    [graphDepth, graphRelation, graphResult, selectedGraphNode?.id, selectedRelationKey],
  )

  const focusNodes = useMemo(() => graphFocusCandidates(graphResult?.nodes ?? []), [graphResult])

  const selectedNeighbors = useMemo(() => {
    if (!selectedGraphNode || !graphResult) return []
    const nodeMap = new Map(graphResult.nodes.map((node) => [node.id, node]))
    return (graphRelation.neighborMap.get(selectedGraphNode.id) ?? [])
      .map((nodeId) => nodeMap.get(nodeId))
      .filter((node): node is KnowledgeGraphNode => Boolean(node))
  }, [graphRelation.neighborMap, graphResult, selectedGraphNode])

  const selectedOutgoing = useMemo(
    () => graphNodeRelations(selectedGraphNode?.id ?? null, graphResult, graphRelation, "out"),
    [graphRelation, graphResult, selectedGraphNode],
  )
  const selectedIncoming = useMemo(
    () => graphNodeRelations(selectedGraphNode?.id ?? null, graphResult, graphRelation, "in"),
    [graphRelation, graphResult, selectedGraphNode],
  )
  const graphKindStats = useMemo(() => graphNodeKindStats(graphResult?.nodes ?? []), [graphResult])
  const graphEdgeStats = useMemo(() => graphEdgeKindStats(graphResult?.edges ?? []), [graphResult])
  const selectedDirectRelationCount = selectedOutgoing.length + selectedIncoming.length

  const loadGraph = async () => {
    setGraphLoading(true)
    try {
      const result = await getKnowledgeGraph({
        layer: graphLayer,
        query: graphQuery,
        sourceType: graphSourceType,
        limit: 300,
      })
      setGraphResult(result)
      if (!result.ok) {
        onStatus(result.error ?? "知识图谱加载失败")
        return
      }
      setSelectedGraphRelation(null)
      setSelectedGraphNode(graphFocusCandidates(result.nodes)[0] ?? null)
    } catch (err) {
      onStatus(`知识图谱加载失败: ${errorMessage(err)}`)
    } finally {
      setGraphLoading(false)
    }
  }

  useEffect(() => {
    loadGraph()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const rebuildGraph = async () => {
    setGraphRebuilding(true)
    try {
      const result = await rebuildKnowledgeGraph()
      if (!result.ok) {
        onStatus(result.error ?? "知识图谱重建失败")
        return
      }
      onStatus(`知识图谱已重建：${result.nodes} 个节点，${result.edges} 条关系`)
      await loadGraph()
    } catch (err) {
      onStatus(`知识图谱重建失败: ${errorMessage(err)}`)
    } finally {
      setGraphRebuilding(false)
    }
  }

  const selectGraphEdge = (edge: GraphFlowEdge) => {
    const source = graphNodeMap.get(edge.source)
    const target = graphNodeMap.get(edge.target)
    if (!source || !target) return
    setSelectedGraphRelation({ source, target, kind: edge.data?.kind ?? "related" })
    setSelectedGraphNode(source)
  }

  const copySelectedGraphRelation = async () => {
    if (!selectedGraphRelation) return
    const text = `${selectedGraphRelation.source.label} --${formatGraphEdgeKind(selectedGraphRelation.kind)}--> ${selectedGraphRelation.target.label}`
    try {
      await navigator.clipboard.writeText(text)
      onStatus("关系已复制")
    } catch (err) {
      onStatus(`复制关系失败: ${errorMessage(err)}`)
    }
  }

  return (
    <section className="tk-panel">
      <div className="tk-panel-header">
        <div>
          <h2 className="tk-panel-title">笔记关系图谱</h2>
          <p className="text-xs text-muted-foreground">
            {graphResult
              ? `当前显示 ${graphData.nodes.length}/${graphResult.stats.totalNodes} 个节点`
              : "按双链、标签、标题和概念生成笔记关系"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="tk-badge">{graphData.nodes.length} 个可见节点</span>
          <span className="tk-badge">{graphData.edges.length} 条可见关系</span>
          <span className="tk-badge">{graphDepth} 跳关系</span>
          {selectedGraphNode && <span className="tk-badge">{selectedDirectRelationCount} 个直接关联</span>}
        </div>
      </div>
      <div className="tk-panel-body">
        <div className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)_320px]">
          <KnowledgeGraphSidebar
            graphLayer={graphLayer}
            graphSourceType={graphSourceType}
            graphQuery={graphQuery}
            graphDepth={graphDepth}
            graphResult={graphResult}
            graphData={graphData}
            graphLoading={graphLoading}
            graphRebuilding={graphRebuilding}
            focusNodes={focusNodes}
            selectedGraphNode={selectedGraphNode}
            graphRelation={graphRelation}
            graphKindStats={graphKindStats}
            graphEdgeStats={graphEdgeStats}
            onLayerChange={setGraphLayer}
            onSourceTypeChange={setGraphSourceType}
            onQueryChange={setGraphQuery}
            onLoadGraph={loadGraph}
            onRebuildGraph={rebuildGraph}
            onDepthChange={setGraphDepth}
            onSelectNode={selectGraphNode}
          />

          <KnowledgeGraphCanvas
            graphData={graphData}
            graphDepth={graphDepth}
            selectedGraphNode={selectedGraphNode}
            onSelectNode={selectGraphNode}
            onSelectEdge={selectGraphEdge}
          />

          <KnowledgeGraphDetailsPanel
            selectedGraphNode={selectedGraphNode}
            selectedGraphRelation={selectedGraphRelation}
            selectedNeighbors={selectedNeighbors}
            selectedOutgoing={selectedOutgoing}
            selectedIncoming={selectedIncoming}
            graphRelation={graphRelation}
            noteAdapter={noteAdapter}
            onStatus={onStatus}
            onSelectNode={selectGraphNode}
            onCopyRelation={copySelectedGraphRelation}
          />
        </div>
      </div>
    </section>
  )
}
