import { useEffect, useMemo, useState } from "react"
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { Copy, Folder, RefreshCw, Search } from "lucide-react"

import {
  getKnowledgeGraph,
  openExternalTarget,
  rebuildKnowledgeGraph,
} from "../api"
import type {
  KnowledgeGraphEdge,
  KnowledgeGraphLayer,
  KnowledgeGraphNode,
  KnowledgeGraphResponse,
  NoteAdapterConfig,
} from "../types"
import { Button } from "../components/primitives"
import { errorMessage } from "../lib/errors"

type GraphCanvasNode = KnowledgeGraphNode
type GraphRelation = {
  childMap: Map<string, string[]>
  parentMap: Map<string, string[]>
  neighborMap: Map<string, string[]>
  edgeKindMap: Map<string, string>
  roots: string[]
}

type GraphNodeRelation = {
  node: KnowledgeGraphNode
  kind: string
}

type GraphSelectedRelation = {
  source: KnowledgeGraphNode
  target: KnowledgeGraphNode
  kind: string
}

type GraphFlowNodeData = Record<string, unknown> & {
  graphNode: GraphCanvasNode
  relationCount: number
  distance: number
  center: boolean
  selected: boolean
  relatedToSelected: boolean
  onSelect: (node: GraphCanvasNode) => void
}
type GraphFlowNode = Node<GraphFlowNodeData, "knowledgeMap">
type GraphFlowEdge = Edge<{ kind: string }, "smoothstep">

type GraphDepth = 1 | 2

const GRAPH_CENTER_X = 520
const GRAPH_CENTER_Y = 330
const GRAPH_RING_RADIUS: Record<GraphDepth, number> = {
  1: 280,
  2: 500,
}
const GRAPH_LOCAL_NODE_LIMIT: Record<GraphDepth, number> = {
  1: 48,
  2: 90,
}
const GRAPH_EDGE_LABEL_LIMIT = 80

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

  const nodeTypes = useMemo(() => ({ knowledgeMap: KnowledgeMapNode }), [])

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
          <aside className="space-y-4 rounded-md border border-slate-200 bg-slate-50 p-3">
            <div className="grid gap-3">
              <label className="tk-field">
                <span className="tk-label">层级</span>
                <select
                  className="tk-select"
                  value={graphLayer}
                  onChange={(event) => setGraphLayer(event.target.value as KnowledgeGraphLayer)}>
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
                  onChange={(event) => setGraphSourceType(event.target.value)}>
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
                  onChange={(event) => setGraphQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") loadGraph()
                  }}
                  placeholder="标题、标签、概念或路径"
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={loadGraph} disabled={graphLoading}>
                  <Search className="h-4 w-4" />
                  {graphLoading ? "加载中..." : "应用"}
                </Button>
                <Button variant="secondary" onClick={rebuildGraph} disabled={graphRebuilding}>
                  <RefreshCw className={`h-4 w-4 ${graphRebuilding ? "animate-spin" : ""}`} />
                  {graphRebuilding ? "重建中..." : "重建"}
                </Button>
                <Button
                  variant={graphDepth === 1 ? "secondary" : "ghost"}
                  onClick={() => setGraphDepth(1)}>
                  一跳
                </Button>
                <Button
                  variant={graphDepth === 2 ? "secondary" : "ghost"}
                  onClick={() => setGraphDepth(2)}>
                  二跳
                </Button>
              </div>
            </div>

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
                    <span className="font-medium text-slate-900">{graphKindStats[kind] ?? 0}</span>
                  </div>
                ))}
              </div>
            </div>

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
                    <span className="font-medium text-slate-900">{graphEdgeStats[kind] ?? 0}</span>
                  </div>
                ))}
              </div>
            </div>

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
                        onClick={() => selectGraphNode(node)}>
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
          </aside>

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
                onNodeClick={(_, node) => selectGraphNode(node.data.graphNode)}
                onEdgeClick={(_, edge) => selectGraphEdge(edge)}>
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
                          onClick={copySelectedGraphRelation}
                          title="复制关系">
                          <Copy className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                    <div className="grid gap-2 text-xs">
                      <button
                        className="rounded-md border border-blue-100 bg-white px-2 py-1.5 text-left hover:border-blue-200"
                        onClick={() => selectGraphNode(selectedGraphRelation.source)}>
                        <span className="text-muted-foreground">从：</span>
                        <span className="font-medium text-slate-900">{selectedGraphRelation.source.label}</span>
                      </button>
                      <button
                        className="rounded-md border border-blue-100 bg-white px-2 py-1.5 text-left hover:border-blue-200"
                        onClick={() => selectGraphNode(selectedGraphRelation.target)}>
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
                  <div>
                    <h4 className="mb-2 text-xs font-semibold text-slate-700">直接关联</h4>
                    <div className="grid max-h-64 gap-2 overflow-auto pr-1">
                      {selectedNeighbors.map((child) => (
                        <button
                          key={child.id}
                          className="rounded-md border border-slate-200 px-3 py-2 text-left text-sm transition-colors hover:border-blue-200 hover:bg-blue-50/40"
                          onClick={() => {
                            selectGraphNode(child)
                          }}>
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
                )}
                {(selectedOutgoing.length > 0 || selectedIncoming.length > 0) && (
                  <div className="space-y-3">
                    {selectedOutgoing.length > 0 && (
                      <GraphRelationList
                        title="指向"
                        items={selectedOutgoing}
                        onSelect={selectGraphNode}
                      />
                    )}
                    {selectedIncoming.length > 0 && (
                      <GraphRelationList
                        title="来自"
                        items={selectedIncoming}
                        onSelect={selectGraphNode}
                      />
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="tk-muted-box">点击图谱节点后，这里会显示来源和关系信息。</div>
            )}
          </aside>

        </div>
      </div>
    </section>
  )
}

function buildGraphRelation(
  nodes: KnowledgeGraphNode[],
  edges: KnowledgeGraphEdge[],
): GraphRelation {
  const nodeIds = new Set(nodes.map((node) => node.id))
  const childMap = new Map<string, string[]>()
  const parentMap = new Map<string, string[]>()
  const neighborMap = new Map<string, string[]>()
  const edgeKindMap = new Map<string, string>()

  const addNeighbor = (leftId: string, rightId: string) => {
    if (!nodeIds.has(leftId) || !nodeIds.has(rightId) || leftId === rightId) return
    const left = neighborMap.get(leftId) ?? []
    if (!left.includes(rightId)) neighborMap.set(leftId, [...left, rightId])
    const right = neighborMap.get(rightId) ?? []
    if (!right.includes(leftId)) neighborMap.set(rightId, [...right, leftId])
  }

  const addChild = (parentId: string, childId: string, kind: string) => {
    if (!nodeIds.has(parentId) || !nodeIds.has(childId) || parentId === childId) return
    const children = childMap.get(parentId) ?? []
    if (!children.includes(childId)) childMap.set(parentId, [...children, childId])
    const parents = parentMap.get(childId) ?? []
    if (!parents.includes(parentId)) parentMap.set(childId, [...parents, parentId])
    edgeKindMap.set(`${parentId}->${childId}`, kind)
  }

  for (const edge of edges) {
    addNeighbor(edge.source, edge.target)
    if (edge.kind === "belongs_to_source") {
      addChild(edge.target, edge.source, edge.kind)
    } else {
      addChild(edge.source, edge.target, edge.kind)
    }
  }

  for (const [parentId, children] of childMap.entries()) {
    childMap.set(parentId, sortGraphNodeIds(children, nodes))
  }
  for (const [nodeId, neighbors] of neighborMap.entries()) {
    neighborMap.set(nodeId, sortGraphNodeIds(neighbors, nodes))
  }

  const sourceRoots = sortGraphNodeIds(
    nodes.filter((node) => node.kind === "source").map((node) => node.id),
    nodes,
  )
  const documentRoots = sortGraphNodeIds(
    nodes
      .filter((node) => node.kind === "document" && !(parentMap.get(node.id) ?? []).some(Boolean))
      .map((node) => node.id),
    nodes,
  )
  const fallbackDocuments = sortGraphNodeIds(
    nodes.filter((node) => node.kind === "document").map((node) => node.id),
    nodes,
  )
  const fallbackAny = sortGraphNodeIds(nodes.map((node) => node.id), nodes)
  const roots = sourceRoots.length
    ? sourceRoots
    : documentRoots.length
      ? documentRoots
      : fallbackDocuments.length
        ? fallbackDocuments
        : fallbackAny.slice(0, 12)

  return { childMap, parentMap, neighborMap, edgeKindMap, roots }
}

function sortGraphNodeIds(nodeIds: string[], nodes: KnowledgeGraphNode[]): string[] {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]))
  return [...nodeIds].sort((a, b) => {
    const left = nodeMap.get(a)
    const right = nodeMap.get(b)
    if (!left || !right) return a.localeCompare(b)
    return (
      graphKindSort(left.kind) - graphKindSort(right.kind) ||
      right.degree - left.degree ||
      left.label.localeCompare(right.label)
    )
  })
}

function graphKindSort(kind: string): number {
  if (kind === "source") return 0
  if (kind === "document") return 1
  if (kind === "tag") return 2
  if (kind === "heading") return 3
  if (kind === "concept") return 4
  return 5
}

function buildVisibleGraphData({
  graphResult,
  relation,
  selectedNodeId,
  selectedRelationKey,
  depth,
  onSelect,
}: {
  graphResult: KnowledgeGraphResponse | null
  relation: GraphRelation
  selectedNodeId: string | null
  selectedRelationKey: string | null
  depth: GraphDepth
  onSelect: (node: KnowledgeGraphNode) => void
}): { nodes: GraphFlowNode[]; edges: GraphFlowEdge[] } {
  if (!graphResult) return { nodes: [], edges: [] }
  const nodeMap = new Map(graphResult.nodes.map((node) => [node.id, node]))
  const centerNode = (selectedNodeId && nodeMap.get(selectedNodeId)) || graphFocusCandidates(graphResult.nodes)[0]
  if (!centerNode) return { nodes: [], edges: [] }
  const distances = localGraphDistances(centerNode.id, relation, nodeMap, depth)
  const visibleIds = new Set(distances.keys())
  const selectedNeighborhood = new Set([centerNode.id, ...(relation.neighborMap.get(centerNode.id) ?? [])])

  const nodes: GraphFlowNode[] = []
  for (const distance of [0, 1, 2]) {
    const ringNodes = [...distances.entries()]
      .filter(([, nodeDistance]) => nodeDistance === distance)
      .map(([nodeId]) => nodeMap.get(nodeId))
      .filter((node): node is KnowledgeGraphNode => Boolean(node))
      .sort(compareLocalGraphNodes)

    ringNodes.forEach((node, index) => {
      const relationCount = relation.neighborMap.get(node.id)?.length ?? 0
      const position = localGraphPosition(distance, index, ringNodes.length)
      nodes.push({
        id: node.id,
        type: "knowledgeMap",
        position,
        data: {
          graphNode: node,
          relationCount,
          distance,
          center: distance === 0,
          selected: centerNode.id === node.id,
          relatedToSelected: !selectedNodeId || selectedNeighborhood.has(node.id),
          onSelect,
        },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        selectable: true,
      })
    })
  }

  const visibleEdgeCount = graphResult.edges.filter(
    (edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target),
  ).length
  const showAllEdgeLabels = visibleEdgeCount <= GRAPH_EDGE_LABEL_LIMIT

  const edges: GraphFlowEdge[] = []
  for (const edge of graphResult.edges) {
    if (!visibleIds.has(edge.source) || !visibleIds.has(edge.target)) continue
    const kind = edge.kind ?? "related"
    const color = graphEdgeColor(kind)
    const connectsCenter = centerNode.id === edge.source || centerNode.id === edge.target
    const edgeKey = `${edge.source}->${edge.target}:${kind}`
    const selectedEdge = selectedRelationKey === edgeKey
    const dimmed = Boolean(selectedNodeId && !connectsCenter && !selectedEdge)
    const showLabel = showAllEdgeLabels || connectsCenter || selectedEdge
    edges.push({
      id: `flow:${edge.source}->${edge.target}:${kind}`,
      source: edge.source,
      target: edge.target,
      type: "smoothstep",
      data: { kind },
      label: showLabel ? formatGraphEdgeKind(kind) : undefined,
      labelStyle: { fill: dimmed ? "#94a3b8" : "#475569", fontSize: 11, fontWeight: 600 },
      labelBgPadding: [6, 4],
      labelBgBorderRadius: 4,
      labelBgStyle: { fill: "#ffffff", fillOpacity: 0.88 },
      animated: selectedEdge || connectsCenter,
      selected: selectedEdge,
      style: {
        stroke: color,
        strokeWidth: selectedEdge ? 3.4 : connectsCenter ? 2.6 : 1.5,
        opacity: selectedEdge ? 1 : dimmed ? 0.28 : 0.88,
        strokeDasharray: kind === "semantic_similar" ? "7 5" : undefined,
      },
      markerEnd: { type: MarkerType.ArrowClosed, color },
    })
  }

  return { nodes, edges }
}

function graphFocusCandidates(nodes: KnowledgeGraphNode[], limit = 18): KnowledgeGraphNode[] {
  const documents = nodes.filter((node) => node.kind === "document")
  const candidates = documents.length > 0 ? documents : nodes
  return [...candidates].sort(compareLocalGraphNodes).slice(0, limit)
}

function localGraphDistances(
  centerId: string,
  relation: GraphRelation,
  nodeMap: Map<string, KnowledgeGraphNode>,
  depth: GraphDepth,
): Map<string, number> {
  const maxNodes = GRAPH_LOCAL_NODE_LIMIT[depth]
  const distances = new Map<string, number>([[centerId, 0]])
  let frontier = [centerId]
  for (let distance = 1; distance <= depth; distance += 1) {
    const candidates = new Set<string>()
    for (const nodeId of frontier) {
      for (const neighborId of relation.neighborMap.get(nodeId) ?? []) {
        if (!distances.has(neighborId) && nodeMap.has(neighborId)) candidates.add(neighborId)
      }
    }
    const ordered = [...candidates]
      .map((nodeId) => nodeMap.get(nodeId))
      .filter((node): node is KnowledgeGraphNode => Boolean(node))
      .sort(compareLocalGraphNodes)

    const nextFrontier: string[] = []
    for (const node of ordered) {
      if (distances.size >= maxNodes) break
      distances.set(node.id, distance)
      nextFrontier.push(node.id)
    }
    frontier = nextFrontier
    if (frontier.length === 0 || distances.size >= maxNodes) break
  }
  return distances
}

function localGraphPosition(distance: number, index: number, count: number): { x: number; y: number } {
  if (distance === 0) return { x: GRAPH_CENTER_X, y: GRAPH_CENTER_Y }
  const radius = GRAPH_RING_RADIUS[distance as GraphDepth] + Math.max(0, count - 18) * 5
  const angleOffset = distance === 1 ? -Math.PI / 2 : -Math.PI / 2 + Math.PI / Math.max(count, 1)
  const angle = angleOffset + (index / Math.max(count, 1)) * Math.PI * 2
  return {
    x: GRAPH_CENTER_X + Math.cos(angle) * radius,
    y: GRAPH_CENTER_Y + Math.sin(angle) * radius,
  }
}

function compareLocalGraphNodes(left: KnowledgeGraphNode, right: KnowledgeGraphNode): number {
  return (
    localGraphKindSort(left.kind) - localGraphKindSort(right.kind) ||
    right.degree - left.degree ||
    left.label.localeCompare(right.label, "zh-Hans-CN")
  )
}

function localGraphKindSort(kind: string): number {
  if (kind === "document") return 0
  if (kind === "source") return 1
  if (kind === "tag") return 2
  if (kind === "concept") return 3
  if (kind === "heading") return 4
  return 5
}

function KnowledgeMapNode({ data }: NodeProps<GraphFlowNode>) {
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

function GraphRelationList({
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

function graphMiniMapNodeColor(node: Node): string {
  const graphNode = (node.data as Partial<GraphFlowNodeData> | undefined)?.graphNode
  return graphNode ? graphNodeColor(graphNode.kind) : "#64748b"
}

function graphNodeRelations(
  nodeId: string | null,
  graphResult: KnowledgeGraphResponse | null,
  relation: GraphRelation,
  direction: "in" | "out",
): GraphNodeRelation[] {
  if (!nodeId || !graphResult) return []
  const nodeMap = new Map(graphResult.nodes.map((node) => [node.id, node]))
  const ids = direction === "out" ? relation.childMap.get(nodeId) ?? [] : relation.parentMap.get(nodeId) ?? []
  return ids
    .map((id) => {
      const node = nodeMap.get(id)
      if (!node) return null
      const kind =
        direction === "out"
          ? relation.edgeKindMap.get(`${nodeId}->${id}`) ?? "related"
          : relation.edgeKindMap.get(`${id}->${nodeId}`) ?? "related"
      return { node, kind }
    })
    .filter((item): item is GraphNodeRelation => Boolean(item))
}

function graphNodePath(
  nodeId: string | null,
  graphResult: KnowledgeGraphResponse | null,
  relation: GraphRelation,
): KnowledgeGraphNode[] {
  if (!nodeId || !graphResult) return []
  const nodeMap = new Map(graphResult.nodes.map((node) => [node.id, node]))
  const pathIds = [nodeId]
  const visited = new Set(pathIds)
  let currentId = nodeId

  for (let depth = 0; depth < 8; depth += 1) {
    const parents = sortGraphNodeIds(relation.parentMap.get(currentId) ?? [], graphResult.nodes)
    const nextParentId = parents.find((parentId) => !visited.has(parentId))
    if (!nextParentId) break
    pathIds.unshift(nextParentId)
    visited.add(nextParentId)
    currentId = nextParentId
  }

  return pathIds.map((id) => nodeMap.get(id)).filter((node): node is KnowledgeGraphNode => Boolean(node))
}

function graphNodeKindStats(nodes: KnowledgeGraphNode[]): Record<string, number> {
  return nodes.reduce<Record<string, number>>((acc, node) => {
    acc[node.kind] = (acc[node.kind] ?? 0) + 1
    return acc
  }, {})
}

function graphEdgeKindStats(edges: KnowledgeGraphEdge[]): Record<string, number> {
  return edges.reduce<Record<string, number>>((acc, edge) => {
    acc[edge.kind] = (acc[edge.kind] ?? 0) + 1
    return acc
  }, {})
}

function graphNodeColor(kind: string): string {
  if (kind === "document") return "#2563eb"
  if (kind === "source") return "#0f766e"
  if (kind === "tag") return "#7c3aed"
  if (kind === "heading") return "#d97706"
  if (kind === "concept") return "#dc2626"
  return "#64748b"
}

function graphEdgeColor(kind: string): string {
  if (kind === "belongs_to_source") return "rgba(15, 118, 110, 0.42)"
  if (kind === "links_to_document") return "rgba(37, 99, 235, 0.5)"
  if (kind === "semantic_similar") return "rgba(14, 165, 233, 0.52)"
  if (kind === "has_tag") return "rgba(124, 58, 237, 0.42)"
  if (kind === "has_heading") return "rgba(217, 119, 6, 0.36)"
  if (kind === "mentions_concept") return "rgba(220, 38, 38, 0.36)"
  return "rgba(100, 116, 139, 0.35)"
}

function formatGraphEdgeKind(kind: string): string {
  if (kind === "belongs_to_source") return "来源"
  if (kind === "links_to_document") return "双链"
  if (kind === "semantic_similar") return "语义相似"
  if (kind === "has_tag") return "标签"
  if (kind === "has_heading") return "标题"
  if (kind === "mentions_concept") return "提及"
  return "关联"
}

function formatGraphNodeKind(kind: string): string {
  if (kind === "document") return "文档"
  if (kind === "source") return "来源"
  if (kind === "tag") return "标签"
  if (kind === "heading") return "标题"
  if (kind === "concept") return "概念"
  return kind || "节点"
}

function formatCompactDate(value: string): string {
  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}

function graphNodeTarget(item: KnowledgeGraphNode): string {
  return item.url || item.path || ""
}

function graphNodeOpenTarget(item: KnowledgeGraphNode, noteAdapter?: NoteAdapterConfig): string {
  if (item.sourceType === "markdown" && item.path && noteAdapter?.provider === "obsidian" && noteAdapter.vault) {
    const obsidianTarget = obsidianOpenUri(item.path, noteAdapter.vault)
    if (obsidianTarget) return obsidianTarget
  }
  return graphNodeTarget(item)
}

function obsidianOpenUri(path: string, vault: string, anchor?: string | null): string {
  const normalizedPath = normalizeLocalPath(path)
  const normalizedVault = normalizeLocalPath(vault).replace(/\/+$/, "")
  if (!normalizedPath || !normalizedVault) return ""

  const lowerPath = normalizedPath.toLowerCase()
  const lowerVault = normalizedVault.toLowerCase()
  if (lowerPath !== lowerVault && !lowerPath.startsWith(`${lowerVault}/`)) return ""

  const vaultName = normalizedVault.split("/").filter(Boolean).pop()
  const relativeFile = normalizedPath.slice(normalizedVault.length).replace(/^\/+/, "").replace(/\.md$/i, "")
  if (!vaultName || !relativeFile) return ""
  const target = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(relativeFile)}`
  return anchor ? `${target}&heading=${encodeURIComponent(anchor)}` : target
}

function normalizeLocalPath(value: string): string {
  return value.trim().replace(/\\/g, "/")
}

async function openGraphNodeSource(
  item: KnowledgeGraphNode,
  onStatus?: (message: string) => void,
  noteAdapter?: NoteAdapterConfig,
): Promise<void> {
  const target = graphNodeOpenTarget(item, noteAdapter)
  if (!target) {
    onStatus?.("这个节点没有可打开的来源")
    return
  }
  try {
    await openExternalTarget(target)
    onStatus?.("已打开来源")
  } catch (err) {
    onStatus?.(`打开来源失败: ${errorMessage(err)}`)
  }
}

async function copyGraphNodeSource(
  item: KnowledgeGraphNode,
  onStatus?: (message: string) => void,
): Promise<void> {
  const target = `${item.label}（${formatGraphNodeKind(item.kind)}）`
  try {
    await navigator.clipboard.writeText(target)
    onStatus?.("节点名称已复制")
  } catch (err) {
    onStatus?.(`复制失败: ${errorMessage(err)}`)
  }
}

function formatSourceType(value: string): string {
  if (value === "source") return "来源"
  if (value === "siyuan") return "SiYuan"
  if (value === "markdown") return "Markdown"
  if (value === "tabkeep_note") return "TabKeep"
  return value || "来源"
}
