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
import { Clipboard, Copy, Folder, RefreshCw, Search, X } from "lucide-react"

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
  KnowledgeTopicDocument,
  NoteAdapterConfig,
} from "../types"
import { Button } from "../components/primitives"
import { errorMessage } from "../lib/errors"

type GraphCanvasNode = KnowledgeGraphNode
type GraphRelation = {
  childMap: Map<string, string[]>
  parentMap: Map<string, string[]>
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
  childCount: number
  expanded: boolean
  selected: boolean
  relatedToSelected: boolean
  isLeaf: boolean
  onSelect: (node: GraphCanvasNode) => void
  onToggle: (node: GraphCanvasNode) => void
}
type GraphFlowNode = Node<GraphFlowNodeData, "knowledgeMap">
type GraphFlowEdge = Edge<{ kind: string }, "smoothstep">

const GRAPH_COLUMN_WIDTH = 360
const GRAPH_ROW_HEIGHT = 184
const GRAPH_NODE_X = 48
const GRAPH_NODE_Y = 52
const GRAPH_EDGE_LABEL_LIMIT = 80

export function KnowledgeGraphPanel({ onStatus }: { onStatus: (message: string) => void }) {
  const [graphLayer, setGraphLayer] = useState<KnowledgeGraphLayer>("all")
  const [graphQuery, setGraphQuery] = useState("")
  const [graphSourceType, setGraphSourceType] = useState("")
  const [graphResult, setGraphResult] = useState<KnowledgeGraphResponse | null>(null)
  const [selectedGraphNode, setSelectedGraphNode] = useState<KnowledgeGraphNode | null>(null)
  const [selectedGraphRelation, setSelectedGraphRelation] = useState<GraphSelectedRelation | null>(null)
  const [expandedGraphNodeIds, setExpandedGraphNodeIds] = useState<Set<string>>(() => new Set())
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

  const toggleGraphNode = (node: KnowledgeGraphNode) => {
    const children = graphRelation.childMap.get(node.id) ?? []
    selectGraphNode(node)
    if (children.length === 0) return
    setExpandedGraphNodeIds((current) => {
      const next = new Set(current)
      if (next.has(node.id)) {
        collapseGraphBranch(node.id, next, graphRelation.childMap)
      } else {
        next.add(node.id)
      }
      return next
    })
  }

  const graphData = useMemo(
    () =>
      buildVisibleGraphData({
        graphResult,
        relation: graphRelation,
        expandedNodeIds: expandedGraphNodeIds,
        selectedNodeId: selectedGraphNode?.id ?? null,
        selectedRelationKey,
        onSelect: selectGraphNode,
        onToggle: toggleGraphNode,
      }),
    // toggleGraphNode intentionally closes over the current relation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [expandedGraphNodeIds, graphRelation, graphResult, selectedGraphNode?.id, selectedRelationKey],
  )

  const rootNodes = useMemo(() => {
    const nodeMap = new Map((graphResult?.nodes ?? []).map((node) => [node.id, node]))
    return graphRelation.roots
      .map((rootId) => nodeMap.get(rootId))
      .filter((node): node is KnowledgeGraphNode => Boolean(node))
  }, [graphRelation.roots, graphResult])

  const selectedChildren = useMemo(() => {
    if (!selectedGraphNode || !graphResult) return []
    const nodeMap = new Map(graphResult.nodes.map((node) => [node.id, node]))
    return (graphRelation.childMap.get(selectedGraphNode.id) ?? [])
      .map((nodeId) => nodeMap.get(nodeId))
      .filter((node): node is KnowledgeGraphNode => Boolean(node))
  }, [graphRelation.childMap, graphResult, selectedGraphNode])

  const selectedOutgoing = useMemo(
    () => graphNodeRelations(selectedGraphNode?.id ?? null, graphResult, graphRelation, "out"),
    [graphRelation, graphResult, selectedGraphNode],
  )
  const selectedIncoming = useMemo(
    () => graphNodeRelations(selectedGraphNode?.id ?? null, graphResult, graphRelation, "in"),
    [graphRelation, graphResult, selectedGraphNode],
  )
  const selectedGraphPath = useMemo(
    () => graphNodePath(selectedGraphNode?.id ?? null, graphResult, graphRelation),
    [graphRelation, graphResult, selectedGraphNode],
  )
  const graphKindStats = useMemo(() => graphNodeKindStats(graphResult?.nodes ?? []), [graphResult])
  const graphEdgeStats = useMemo(() => graphEdgeKindStats(graphResult?.edges ?? []), [graphResult])
  const visibleLevelCount = useMemo(
    () =>
      new Set(graphData.nodes.map((node) => Math.round((node.position.x - GRAPH_NODE_X) / GRAPH_COLUMN_WIDTH))).size,
    [graphData.nodes],
  )
  const selectedDirectRelationCount = selectedOutgoing.length + selectedIncoming.length
  const hasCollapsedVisibleBranch = graphData.nodes.some(
    (node) => graphRelation.childMap.has(node.id) && !expandedGraphNodeIds.has(node.id),
  )
  const expandableNodeCount = graphRelation.childMap.size

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
      const relation = buildGraphRelation(result.nodes, result.edges)
      setExpandedGraphNodeIds(new Set())
      setSelectedGraphRelation(null)
      setSelectedGraphNode(result.nodes.find((node) => node.id === relation.roots[0]) ?? null)
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

  const expandAllGraph = () => {
    const allExpandable = new Set(graphRelation.childMap.keys())
    setExpandedGraphNodeIds(allExpandable)
    setSelectedGraphNode((current) => current ?? rootNodes[0] ?? null)
  }

  const expandNextGraphLevel = () => {
    setExpandedGraphNodeIds((current) => {
      const next = new Set(current)
      for (const node of graphData.nodes) {
        if (graphRelation.childMap.has(node.id)) next.add(node.id)
      }
      return next
    })
    setSelectedGraphNode((current) => current ?? rootNodes[0] ?? null)
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

  const copySelectedGraphPath = async () => {
    if (selectedGraphPath.length === 0) return
    const text = selectedGraphPath.map((node) => node.label).join(" > ")
    try {
      await navigator.clipboard.writeText(text)
      onStatus("路径已复制")
    } catch (err) {
      onStatus(`复制路径失败: ${errorMessage(err)}`)
    }
  }

  return (
    <section className="tk-panel">
      <div className="tk-panel-header">
        <div>
          <h2 className="tk-panel-title">知识地图</h2>
          <p className="text-xs text-muted-foreground">
            {graphResult
              ? `当前显示 ${graphData.nodes.length}/${graphResult.stats.totalNodes} 个节点`
              : "等待载入"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="tk-badge">{graphData.nodes.length} 个可见节点</span>
          <span className="tk-badge">{graphData.edges.length} 条可见关系</span>
          <span className="tk-badge">{visibleLevelCount} 层</span>
          <span className="tk-badge">{expandedGraphNodeIds.size}/{expandableNodeCount} 已展开</span>
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
                  <option value="all">全部</option>
                  <option value="documents">文档关系</option>
                  <option value="concepts">显式概念</option>
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
                  variant="ghost"
                  onClick={expandNextGraphLevel}
                  disabled={!hasCollapsedVisibleBranch}>
                  展开一层
                </Button>
                <Button
                  variant="ghost"
                  onClick={expandAllGraph}
                  disabled={expandableNodeCount === 0 || expandedGraphNodeIds.size === expandableNodeCount}>
                  展开全部
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setExpandedGraphNodeIds(new Set())
                    setSelectedGraphRelation(null)
                    setSelectedGraphNode(rootNodes[0] ?? null)
                  }}
                  disabled={expandedGraphNodeIds.size === 0}>
                  收起全部
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
                {["belongs_to_source", "links_to_document", "has_tag", "has_heading", "mentions_concept"].map((kind) => (
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
                <h3 className="text-sm font-semibold text-slate-900">根节点</h3>
                <span className="tk-badge">{rootNodes.length}</span>
              </div>
              <div className="grid max-h-[430px] gap-2 overflow-auto pr-1">
                {rootNodes.length > 0 ? (
                  rootNodes.map((node) => {
                    const active = selectedGraphNode?.id === node.id
                    const childCount = graphRelation.childMap.get(node.id)?.length ?? 0
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
                          {formatGraphNodeKind(node.kind)} · {childCount} 个子节点
                        </div>
                      </button>
                    )
                  })
                ) : (
                  <div className="tk-muted-box">暂无根节点</div>
                )}
              </div>
            </div>
          </aside>

          <div className="h-[620px] overflow-hidden rounded-md border border-slate-200 bg-[#f8fafc]">
            {graphData.nodes.length > 0 ? (
              <ReactFlow<GraphFlowNode, GraphFlowEdge>
                key={`${graphData.nodes.length}:${graphData.edges.length}:${expandedGraphNodeIds.size}:${selectedGraphNode?.id ?? ""}`}
                nodes={graphData.nodes}
                edges={graphData.edges}
                nodeTypes={nodeTypes}
                fitView
                fitViewOptions={{ padding: 0.22 }}
                minZoom={0.35}
                maxZoom={1.4}
                nodesDraggable={false}
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
                    {expandedGraphNodeIds.size === 0
                      ? "根节点已收起"
                      : selectedGraphNode
                        ? `高亮：${selectedGraphNode.label.length > 18 ? `${selectedGraphNode.label.slice(0, 17)}...` : selectedGraphNode.label}`
                        : expandedGraphNodeIds.size === expandableNodeCount
                          ? "已全部展开"
                          : `已展开 ${expandedGraphNodeIds.size} 个分支`}
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
                    连接度 {selectedGraphNode.degree} · 子级 {(graphRelation.childMap.get(selectedGraphNode.id) ?? []).length}
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
                {selectedGraphPath.length > 1 && (
                  <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <h4 className="text-xs font-semibold text-slate-700">路径</h4>
                      <button
                        className="tk-icon-button h-7 w-7"
                        onClick={copySelectedGraphPath}
                        title="复制路径">
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                      {selectedGraphPath.map((node, index) => (
                        <div key={node.id} className="flex items-center gap-1.5">
                          {index > 0 && <span className="text-slate-400">&gt;</span>}
                          <button
                            className="rounded-md bg-white px-2 py-1 font-medium text-slate-700 ring-1 ring-slate-200 hover:ring-blue-200"
                            onClick={() => selectGraphNode(node)}>
                            {node.label.length > 16 ? `${node.label.slice(0, 15)}...` : node.label}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {selectedGraphNode.sourceType && (
                  <div className="tk-muted-box">
                    <div className="mb-1 text-xs font-medium text-slate-700">
                      {formatSourceType(selectedGraphNode.sourceType)}
                    </div>
                    <div className="break-all text-xs">
                      {graphNodeTarget(selectedGraphNode) || selectedGraphNode.documentId}
                    </div>
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  {(graphRelation.childMap.get(selectedGraphNode.id) ?? []).length > 0 && (
                    <Button variant="secondary" onClick={() => toggleGraphNode(selectedGraphNode)}>
                      {expandedGraphNodeIds.has(selectedGraphNode.id) ? "收起节点" : "展开节点"}
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    onClick={() => openGraphNodeSource(selectedGraphNode, onStatus)}
                    disabled={!graphNodeTarget(selectedGraphNode)}>
                    <Folder className="h-4 w-4" />
                    打开来源
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => copyGraphNodeSource(selectedGraphNode, onStatus)}>
                    <Copy className="h-4 w-4" />
                    复制
                  </Button>
                </div>
                {selectedChildren.length > 0 && (
                  <div>
                    <h4 className="mb-2 text-xs font-semibold text-slate-700">下一层</h4>
                    <div className="grid max-h-64 gap-2 overflow-auto pr-1">
                      {selectedChildren.map((child) => (
                        <button
                          key={child.id}
                          className="rounded-md border border-slate-200 px-3 py-2 text-left text-sm transition-colors hover:border-blue-200 hover:bg-blue-50/40"
                          onClick={() => {
                            setExpandedGraphNodeIds((current) => new Set(current).add(selectedGraphNode.id))
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
                            {formatGraphEdgeKind(graphRelation.edgeKindMap.get(`${selectedGraphNode.id}->${child.id}`) ?? "related")} · {formatGraphNodeKind(child.kind)} · {(graphRelation.childMap.get(child.id) ?? []).length} 个子节点
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
  const edgeKindMap = new Map<string, string>()

  const addChild = (parentId: string, childId: string, kind: string) => {
    if (!nodeIds.has(parentId) || !nodeIds.has(childId) || parentId === childId) return
    const children = childMap.get(parentId) ?? []
    if (!children.includes(childId)) childMap.set(parentId, [...children, childId])
    const parents = parentMap.get(childId) ?? []
    if (!parents.includes(parentId)) parentMap.set(childId, [...parents, parentId])
    edgeKindMap.set(`${parentId}->${childId}`, kind)
  }

  for (const edge of edges) {
    if (edge.kind === "belongs_to_source") {
      addChild(edge.target, edge.source, edge.kind)
    } else {
      addChild(edge.source, edge.target, edge.kind)
    }
  }

  for (const [parentId, children] of childMap.entries()) {
    childMap.set(parentId, sortGraphNodeIds(children, nodes))
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

  return { childMap, parentMap, edgeKindMap, roots }
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
  expandedNodeIds,
  selectedNodeId,
  selectedRelationKey,
  onSelect,
  onToggle,
}: {
  graphResult: KnowledgeGraphResponse | null
  relation: GraphRelation
  expandedNodeIds: Set<string>
  selectedNodeId: string | null
  selectedRelationKey: string | null
  onSelect: (node: KnowledgeGraphNode) => void
  onToggle: (node: KnowledgeGraphNode) => void
}): { nodes: GraphFlowNode[]; edges: GraphFlowEdge[] } {
  if (!graphResult) return { nodes: [], edges: [] }
  const nodeMap = new Map(graphResult.nodes.map((node) => [node.id, node]))

  const visibleIds = new Set<string>()
  const levels = new Map<string, number>()
  const visit = (nodeId: string, depth: number, visiting = new Set<string>()) => {
    if (!nodeMap.has(nodeId)) return
    if (visiting.has(nodeId)) return
    const previousDepth = levels.get(nodeId)
    if (visibleIds.has(nodeId)) {
      if (previousDepth !== undefined && depth <= previousDepth) return
    } else {
      visibleIds.add(nodeId)
    }
    levels.set(nodeId, depth)
    if (!expandedNodeIds.has(nodeId)) return
    const nextVisiting = new Set(visiting)
    nextVisiting.add(nodeId)
    const children = relation.childMap.get(nodeId) ?? []
    for (const childId of children) visit(childId, depth + 1, nextVisiting)
  }

  for (const rootId of relation.roots) visit(rootId, 0)

  const byLevel = new Map<number, KnowledgeGraphNode[]>()
  for (const nodeId of visibleIds) {
    const node = nodeMap.get(nodeId)
    if (!node) continue
    const level = levels.get(nodeId) ?? 0
    byLevel.set(level, [...(byLevel.get(level) ?? []), node])
  }

  const visibleChildren = new Map<string, string[]>()
  for (const [parentId, children] of relation.childMap.entries()) {
    if (!visibleIds.has(parentId)) continue
    const parentLevel = levels.get(parentId) ?? 0
    const forwardChildren = children.filter((childId) => {
      if (!visibleIds.has(childId)) return false
      return (levels.get(childId) ?? 0) > parentLevel
    })
    if (forwardChildren.length > 0) {
      visibleChildren.set(parentId, sortGraphNodeIds(forwardChildren, graphResult.nodes))
    }
  }

  const rawSlots = new Map<string, number>()
  let slotCursor = 0
  const assignSlot = (nodeId: string, visiting = new Set<string>()): number => {
    const existing = rawSlots.get(nodeId)
    if (existing !== undefined) return existing
    if (visiting.has(nodeId)) {
      const cycleSlot = slotCursor
      slotCursor += 1
      rawSlots.set(nodeId, cycleSlot)
      return cycleSlot
    }

    const children = visibleChildren.get(nodeId) ?? []
    if (!expandedNodeIds.has(nodeId) || children.length === 0) {
      const leafSlot = slotCursor
      slotCursor += 1
      rawSlots.set(nodeId, leafSlot)
      return leafSlot
    }

    const nextVisiting = new Set(visiting)
    nextVisiting.add(nodeId)
    const childSlots = children.map((childId) => assignSlot(childId, nextVisiting))
    const branchSlot = childSlots.reduce((sum, slot) => sum + slot, 0) / childSlots.length
    rawSlots.set(nodeId, branchSlot)
    return branchSlot
  }

  const orderedRoots = sortGraphNodeIds(relation.roots.filter((rootId) => visibleIds.has(rootId)), graphResult.nodes)
  for (const rootId of orderedRoots) assignSlot(rootId)
  for (const nodeId of visibleIds) assignSlot(nodeId)

  const selectedNeighborhood = new Set<string>()
  if (selectedNodeId) {
    selectedNeighborhood.add(selectedNodeId)
    for (const childId of relation.childMap.get(selectedNodeId) ?? []) selectedNeighborhood.add(childId)
    for (const parentId of relation.parentMap.get(selectedNodeId) ?? []) selectedNeighborhood.add(parentId)
  }

  const adjustedSlots = new Map<string, number>()
  for (const [, levelNodes] of [...byLevel.entries()].sort(([left], [right]) => left - right)) {
    const ordered = sortGraphNodeIds(levelNodes.map((node) => node.id), graphResult.nodes)
      .map((nodeId) => nodeMap.get(nodeId))
      .filter((node): node is KnowledgeGraphNode => Boolean(node))
      .sort((left, right) => {
        const slotDelta = (rawSlots.get(left.id) ?? 0) - (rawSlots.get(right.id) ?? 0)
        if (slotDelta !== 0) return slotDelta
        return graphKindSort(left.kind) - graphKindSort(right.kind) || left.label.localeCompare(right.label, "zh-Hans-CN")
      })

    let previousSlot = -1
    for (const node of ordered) {
      const slot = Math.max(rawSlots.get(node.id) ?? 0, previousSlot + 1)
      adjustedSlots.set(node.id, slot)
      previousSlot = slot
    }
  }
  const minSlot = adjustedSlots.size > 0 ? Math.min(...adjustedSlots.values()) : 0

  const nodes: GraphFlowNode[] = []
  for (const [level, levelNodes] of [...byLevel.entries()].sort(([left], [right]) => left - right)) {
    const ordered = sortGraphNodeIds(levelNodes.map((node) => node.id), graphResult.nodes)
      .map((nodeId) => nodeMap.get(nodeId))
      .filter((node): node is KnowledgeGraphNode => Boolean(node))
      .sort((left, right) => (adjustedSlots.get(left.id) ?? 0) - (adjustedSlots.get(right.id) ?? 0))
    ordered.forEach((node, index) => {
      const childCount = relation.childMap.get(node.id)?.length ?? 0
      const ySlot = adjustedSlots.get(node.id) ?? index
      nodes.push({
        id: node.id,
        type: "knowledgeMap",
        position: {
          x: GRAPH_NODE_X + level * GRAPH_COLUMN_WIDTH,
          y: GRAPH_NODE_Y + (ySlot - minSlot) * GRAPH_ROW_HEIGHT,
        },
        data: {
          graphNode: node,
          childCount,
          expanded: expandedNodeIds.has(node.id),
          selected: selectedNodeId === node.id,
          relatedToSelected: !selectedNodeId || selectedNeighborhood.has(node.id),
          isLeaf: childCount === 0,
          onSelect,
          onToggle,
        },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        draggable: false,
        selectable: true,
      })
    })
  }

  let visibleEdgeCount = 0
  for (const [parentId, children] of relation.childMap.entries()) {
    if (!visibleIds.has(parentId)) continue
    visibleEdgeCount += children.filter((childId) => visibleIds.has(childId)).length
  }
  const showAllEdgeLabels = visibleEdgeCount <= GRAPH_EDGE_LABEL_LIMIT

  const edges: GraphFlowEdge[] = []
  for (const [parentId, children] of relation.childMap.entries()) {
    if (!visibleIds.has(parentId)) continue
    for (const childId of children) {
      if (!visibleIds.has(childId)) continue
      const kind = relation.edgeKindMap.get(`${parentId}->${childId}`) ?? "related"
      const color = graphEdgeColor(kind)
      const connectsSelected = selectedNodeId === parentId || selectedNodeId === childId
      const edgeKey = `${parentId}->${childId}:${kind}`
      const selectedEdge = selectedRelationKey === edgeKey
      const dimmed = Boolean(selectedNodeId && !connectsSelected)
      const showLabel = showAllEdgeLabels || connectsSelected || selectedEdge
      edges.push({
        id: `flow:${parentId}->${childId}:${kind}`,
        source: parentId,
        target: childId,
        type: "smoothstep",
        data: { kind },
        label: showLabel ? formatGraphEdgeKind(kind) : undefined,
        labelStyle: { fill: dimmed ? "#94a3b8" : "#475569", fontSize: 11, fontWeight: 600 },
        labelBgPadding: [6, 4],
        labelBgBorderRadius: 4,
        labelBgStyle: { fill: "#ffffff", fillOpacity: 0.88 },
        animated: selectedEdge || connectsSelected || expandedNodeIds.has(parentId),
        selected: selectedEdge,
        style: {
          stroke: color,
          strokeWidth: selectedEdge ? 3.4 : connectsSelected ? 2.6 : 1.6,
          opacity: selectedEdge ? 1 : dimmed ? 0.28 : 0.9,
        },
        markerEnd: { type: MarkerType.ArrowClosed, color },
      })
    }
  }

  return { nodes, edges }
}

function collapseGraphBranch(
  nodeId: string,
  expandedNodeIds: Set<string>,
  childMap: Map<string, string[]>,
  visited = new Set<string>(),
) {
  if (visited.has(nodeId)) return
  visited.add(nodeId)
  expandedNodeIds.delete(nodeId)
  for (const childId of childMap.get(nodeId) ?? []) {
    collapseGraphBranch(childId, expandedNodeIds, childMap, visited)
  }
}

function KnowledgeMapNode({ data }: NodeProps<GraphFlowNode>) {
  const node = data.graphNode
  const color = graphNodeColor(node.kind)
  const label = node.label.length > 42 ? `${node.label.slice(0, 41)}...` : node.label

  if (data.isLeaf) {
    return (
      <button
        className={`relative flex h-24 w-24 items-center justify-center rounded-full border-2 bg-white px-3 text-center text-xs font-semibold leading-4 shadow-sm transition-colors ${
          data.selected ? "ring-4 ring-blue-100" : "hover:bg-slate-50"
        } ${data.relatedToSelected ? "" : "opacity-40"}`}
        style={{ borderColor: color, color }}
        title={node.label}
        onClick={() => data.onSelect(node)}>
        <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-0 !bg-slate-300" />
        <span className="line-clamp-3">{label}</span>
      </button>
    )
  }

  return (
    <div
      className={`relative w-56 rounded-md border bg-white p-3 shadow-sm transition-colors ${
        data.selected ? "ring-4 ring-blue-100" : "hover:bg-slate-50"
      } ${data.relatedToSelected ? "" : "opacity-40"}`}
      style={{ borderColor: data.selected ? color : "#e2e8f0" }}>
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-0 !bg-slate-300" />
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-0 !bg-slate-300" />
      <button className="block w-full text-left" title={node.label} onClick={() => data.onSelect(node)}>
        <div className="mb-2 flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
          <span className="tk-badge">{formatGraphNodeKind(node.kind)}</span>
        </div>
        <div className="line-clamp-2 text-sm font-semibold leading-5 text-slate-900">{label}</div>
        <div className="mt-2 text-xs text-muted-foreground">
          {data.childCount} 个子节点 · 连接度 {node.degree}
        </div>
      </button>
      <button
        className="nodrag nopan mt-3 inline-flex h-7 items-center rounded-md border border-slate-200 px-2 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100"
        onClick={(event) => {
          event.stopPropagation()
          data.onToggle(node)
        }}>
        {data.expanded ? "收起" : "展开"}
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
  if (kind === "has_tag") return "rgba(124, 58, 237, 0.42)"
  if (kind === "has_heading") return "rgba(217, 119, 6, 0.36)"
  if (kind === "mentions_concept") return "rgba(220, 38, 38, 0.36)"
  return "rgba(100, 116, 139, 0.35)"
}

function formatGraphEdgeKind(kind: string): string {
  if (kind === "belongs_to_source") return "来源"
  if (kind === "links_to_document") return "双链"
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

function topicDocumentTarget(item: KnowledgeTopicDocument): string {
  return item.url || item.path || ""
}

function topicDocumentOpenTarget(item: KnowledgeTopicDocument, noteAdapter?: NoteAdapterConfig): string {
  if (item.sourceType === "markdown" && item.path && noteAdapter?.provider === "obsidian" && noteAdapter.vault) {
    const obsidianTarget = obsidianOpenUri(item.path, noteAdapter.vault, item.anchor)
    if (obsidianTarget) return obsidianTarget
  }
  return topicDocumentTarget(item)
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

function formatTopicOpenTitle(item: KnowledgeTopicDocument, noteAdapter?: NoteAdapterConfig): string {
  if (item.sourceType === "siyuan") return "在 SiYuan 中打开"
  if (item.sourceType === "markdown" && noteAdapter?.provider === "obsidian") {
    return item.anchor ? `在 Obsidian 中打开到标题：${item.anchor}` : "在 Obsidian 中打开"
  }
  if (item.url) return "打开网页来源"
  return "打开笔记来源"
}

async function openGraphNodeSource(
  item: KnowledgeGraphNode,
  onStatus?: (message: string) => void,
): Promise<void> {
  const target = graphNodeTarget(item)
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

async function openTopicDocumentSource(
  item: KnowledgeTopicDocument,
  onStatus?: (message: string) => void,
  noteAdapter?: NoteAdapterConfig,
): Promise<void> {
  const target = topicDocumentOpenTarget(item, noteAdapter)
  if (!target) {
    onStatus?.("这篇笔记没有可打开的来源")
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
  const target = graphNodeTarget(item) || item.label || item.id
  try {
    await navigator.clipboard.writeText(target)
    onStatus?.("节点信息已复制")
  } catch (err) {
    onStatus?.(`复制失败: ${errorMessage(err)}`)
  }
}

async function copyTopicDocumentSource(
  item: KnowledgeTopicDocument,
  onStatus?: (message: string) => void,
): Promise<void> {
  const target = topicDocumentTarget(item) || item.title || item.documentId
  try {
    await navigator.clipboard.writeText(target)
    onStatus?.("来源已复制")
  } catch (err) {
    onStatus?.(`复制来源失败: ${errorMessage(err)}`)
  }
}

function formatSourceType(value: string): string {
  if (value === "source") return "来源"
  if (value === "siyuan") return "SiYuan"
  if (value === "markdown") return "Markdown"
  if (value === "tabkeep_note") return "TabKeep"
  return value || "来源"
}

function formatDebugScore(value?: number | null): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "-"
  if (Math.abs(value) >= 100) return value.toFixed(1)
  if (Math.abs(value) >= 1) return value.toFixed(3)
  return value.toFixed(4)
}

function formatVectorPreview(values: number[]): string {
  if (values.length === 0) return "-"
  return values.map((value) => formatDebugScore(value)).join(", ")
}

function formatTopicEvidenceKind(value: string): string {
  if (value === "tag") return "标签"
  if (value === "wikilink") return "双链"
  if (value === "heading") return "标题"
  if (value === "path") return "路径"
  if (value === "embedding") return "语义相似"
  if (value === "fallback") return "兜底"
  return value || "证据"
}