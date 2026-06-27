import {
  MarkerType,
  Position,
  type Edge,
  type Node,
} from "@xyflow/react"

import { openExternalTarget } from "../../api"
import { errorMessage } from "../../lib/errors"
import type {
  KnowledgeGraphEdge,
  KnowledgeGraphNode,
  KnowledgeGraphResponse,
  NoteAdapterConfig,
} from "../../types"

export type GraphCanvasNode = KnowledgeGraphNode

export type GraphRelation = {
  childMap: Map<string, string[]>
  parentMap: Map<string, string[]>
  neighborMap: Map<string, string[]>
  edgeKindMap: Map<string, string>
  roots: string[]
}

export type GraphNodeRelation = {
  node: KnowledgeGraphNode
  kind: string
}

export type GraphSelectedRelation = {
  source: KnowledgeGraphNode
  target: KnowledgeGraphNode
  kind: string
}

export type GraphFlowNodeData = Record<string, unknown> & {
  graphNode: GraphCanvasNode
  relationCount: number
  distance: number
  center: boolean
  selected: boolean
  relatedToSelected: boolean
  onSelect: (node: GraphCanvasNode) => void
}

export type GraphFlowNode = Node<GraphFlowNodeData, "knowledgeMap">
export type GraphFlowEdge = Edge<{ kind: string }, "smoothstep">

export type GraphDepth = 1 | 2

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

export function buildGraphRelation(
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

export function buildVisibleGraphData({
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

export function graphFocusCandidates(nodes: KnowledgeGraphNode[], limit = 18): KnowledgeGraphNode[] {
  const documents = nodes.filter((node) => node.kind === "document")
  const candidates = documents.length > 0 ? documents : nodes
  return [...candidates].sort(compareLocalGraphNodes).slice(0, limit)
}

export function graphNodeRelations(
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

export function graphNodeKindStats(nodes: KnowledgeGraphNode[]): Record<string, number> {
  return nodes.reduce<Record<string, number>>((acc, node) => {
    acc[node.kind] = (acc[node.kind] ?? 0) + 1
    return acc
  }, {})
}

export function graphEdgeKindStats(edges: KnowledgeGraphEdge[]): Record<string, number> {
  return edges.reduce<Record<string, number>>((acc, edge) => {
    acc[edge.kind] = (acc[edge.kind] ?? 0) + 1
    return acc
  }, {})
}

export function graphNodeColor(kind: string): string {
  if (kind === "document") return "#2563eb"
  if (kind === "source") return "#0f766e"
  if (kind === "tag") return "#7c3aed"
  if (kind === "heading") return "#d97706"
  if (kind === "concept") return "#dc2626"
  return "#64748b"
}

export function graphEdgeColor(kind: string): string {
  if (kind === "belongs_to_source") return "rgba(15, 118, 110, 0.42)"
  if (kind === "links_to_document") return "rgba(37, 99, 235, 0.5)"
  if (kind === "semantic_similar") return "rgba(14, 165, 233, 0.52)"
  if (kind === "has_tag") return "rgba(124, 58, 237, 0.42)"
  if (kind === "has_heading") return "rgba(217, 119, 6, 0.36)"
  if (kind === "mentions_concept") return "rgba(220, 38, 38, 0.36)"
  return "rgba(100, 116, 139, 0.35)"
}

export function formatGraphEdgeKind(kind: string): string {
  if (kind === "belongs_to_source") return "来源"
  if (kind === "links_to_document") return "双链"
  if (kind === "semantic_similar") return "语义相似"
  if (kind === "has_tag") return "标签"
  if (kind === "has_heading") return "标题"
  if (kind === "mentions_concept") return "提及"
  return "关联"
}

export function formatGraphNodeKind(kind: string): string {
  if (kind === "document") return "文档"
  if (kind === "source") return "来源"
  if (kind === "tag") return "标签"
  if (kind === "heading") return "标题"
  if (kind === "concept") return "概念"
  return kind || "节点"
}

export function graphNodeOpenTarget(item: KnowledgeGraphNode, noteAdapter?: NoteAdapterConfig): string {
  if (item.sourceType === "markdown" && item.path && noteAdapter?.provider === "obsidian" && noteAdapter.vault) {
    const obsidianTarget = obsidianOpenUri(item.path, noteAdapter.vault)
    if (obsidianTarget) return obsidianTarget
  }
  return graphNodeTarget(item)
}

export async function openGraphNodeSource(
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

export async function copyGraphNodeSource(
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

export function formatSourceType(value: string): string {
  if (value === "source") return "来源"
  if (value === "siyuan") return "SiYuan"
  if (value === "markdown") return "Markdown"
  if (value === "tabkeep_note") return "TabKeep"
  return value || "来源"
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

function graphNodeTarget(item: KnowledgeGraphNode): string {
  return item.url || item.path || ""
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
