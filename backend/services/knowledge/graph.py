from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable

from schemas.knowledge import (
    KnowledgeGraphEdge,
    KnowledgeGraphNode,
    KnowledgeGraphRebuildResponse,
    KnowledgeGraphResponse,
    KnowledgeGraphStats,
)
from services.knowledge import db

VALID_LAYERS = {"all", "documents", "concepts"}
DOCUMENT_NODE_PREFIX = "document:"
SOURCE_NODE_PREFIX = "source:"
TAG_NODE_PREFIX = "tag:"
HEADING_NODE_PREFIX = "heading:"
CONCEPT_NODE_PREFIX = "concept:"


@dataclass
class GraphDocument:
    id: str
    source_type: str
    title: str
    url: str | None
    path: str | None
    note_id: str | None
    content: str


@dataclass
class GraphNodeDraft:
    id: str
    kind: str
    label: str
    document_id: str | None = None


@dataclass
class GraphEdgeDraft:
    source_id: str
    target_id: str
    kind: str
    weight: float = 1


def index_document_graph(
    *,
    document_id: str,
    source_type: str,
    title: str,
    content: str,
    url: str | None = None,
    path: str | None = None,
    note_id: str | None = None,
) -> None:
    """Build graph nodes/edges for one indexed document."""
    db.init_db()
    document = GraphDocument(
        id=document_id,
        source_type=source_type,
        title=title,
        url=url,
        path=path,
        note_id=note_id,
        content=content,
    )
    with db.connection() as conn:
        lookup = _load_document_lookup(conn)
        nodes, edges = _build_document_graph(document, lookup)
        _replace_document_edges(conn, document_id, nodes, edges)


def rebuild_graph() -> KnowledgeGraphRebuildResponse:
    db.init_db()
    with db.connection() as conn:
        documents = _load_documents(conn)
        lookup = _build_document_lookup(documents)
        conn.execute("DELETE FROM graph_edges")
        conn.execute("DELETE FROM graph_nodes")

        node_count = 0
        edge_count = 0
        for document in documents:
            nodes, edges = _build_document_graph(document, lookup)
            node_count += _upsert_nodes(conn, nodes)
            edge_count += _upsert_edges(conn, edges)

        totals = _graph_totals(conn)
        return KnowledgeGraphRebuildResponse(
            ok=True,
            nodes=totals["nodes"] or node_count,
            edges=totals["edges"] or edge_count,
        )


def get_graph(
    *,
    layer: str = "all",
    query: str | None = None,
    source_type: str | None = None,
    limit: int = 300,
) -> KnowledgeGraphResponse:
    db.init_db()
    normalized_layer = layer if layer in VALID_LAYERS else "all"
    safe_limit = min(max(limit, 20), 600)
    with db.connection() as conn:
        node_map = _load_graph_nodes(conn)
        edge_map = _load_graph_edges(conn)
        total_nodes = len(node_map)
        total_edges = len(edge_map)

    allowed_node_ids = _node_ids_for_layer(node_map, edge_map.values(), normalized_layer)
    allowed_edges = {
        edge_id: edge
        for edge_id, edge in edge_map.items()
        if edge.kind in _edge_kinds_for_layer(normalized_layer)
        and edge.source in allowed_node_ids
        and edge.target in allowed_node_ids
    }

    selected_ids = set(allowed_node_ids)
    seed_ids: set[str] = set()
    if source_type:
        source_type_value = source_type.lower()
        seed_ids |= {
            node_id
            for node_id, node in node_map.items()
            if node_id in allowed_node_ids
            and node.kind == "document"
            and (node.sourceType or "").lower() == source_type_value
        }
    if query:
        needle = query.strip().lower()
        if needle:
            seed_ids |= {
                node_id
                for node_id, node in node_map.items()
                if node_id in allowed_node_ids and _node_matches_query(node, needle)
            }

    if source_type or query:
        selected_ids = _expand_neighbors(seed_ids, allowed_edges.values())

    degrees = _degree_map(allowed_edges.values(), selected_ids)
    if len(selected_ids) > safe_limit:
        selected_ids = _limit_nodes(selected_ids, seed_ids, degrees, node_map, safe_limit)

    visible_edges = [
        edge
        for edge in allowed_edges.values()
        if edge.source in selected_ids and edge.target in selected_ids
    ]
    degrees = _degree_map(visible_edges, selected_ids)
    visible_nodes = [
        _with_degree(node_map[node_id], degrees.get(node_id, 0))
        for node_id in selected_ids
        if node_id in node_map
    ]
    visible_nodes.sort(key=lambda node: (-node.degree, node.kind, node.label.lower()))
    visible_edges.sort(key=lambda edge: (edge.kind, edge.source, edge.target))

    return KnowledgeGraphResponse(
        ok=True,
        layer=normalized_layer,
        nodes=visible_nodes,
        edges=visible_edges,
        stats=KnowledgeGraphStats(
            nodes=len(visible_nodes),
            edges=len(visible_edges),
            totalNodes=total_nodes,
            totalEdges=total_edges,
        ),
    )


def _build_document_graph(
    document: GraphDocument,
    lookup: dict[str, str],
) -> tuple[list[GraphNodeDraft], list[GraphEdgeDraft]]:
    doc_node_id = _document_node_id(document.id)
    source_node_id = _source_node_id(document.source_type)
    nodes = [
        GraphNodeDraft(doc_node_id, "document", document.title, document.id),
        GraphNodeDraft(source_node_id, "source", _format_source_label(document.source_type)),
    ]
    edges = [GraphEdgeDraft(doc_node_id, source_node_id, "belongs_to_source", 1)]

    for tag in _extract_tags(document.content):
        tag_node_id = _tag_node_id(tag)
        nodes.append(GraphNodeDraft(tag_node_id, "tag", tag))
        edges.append(GraphEdgeDraft(doc_node_id, tag_node_id, "has_tag", 2))

    for heading in _extract_headings(document.content):
        heading_node_id = _heading_node_id(heading)
        nodes.append(GraphNodeDraft(heading_node_id, "heading", heading))
        edges.append(GraphEdgeDraft(doc_node_id, heading_node_id, "has_heading", 1.4))

    for link in _extract_wikilinks(document.content):
        target_doc_id = lookup.get(_normalize_lookup_key(link))
        if target_doc_id and target_doc_id != document.id:
            edges.append(GraphEdgeDraft(doc_node_id, _document_node_id(target_doc_id), "links_to_document", 2.5))
            continue
        concept_node_id = _concept_node_id(link)
        nodes.append(GraphNodeDraft(concept_node_id, "concept", link))
        edges.append(GraphEdgeDraft(doc_node_id, concept_node_id, "mentions_concept", 1.8))

    return _dedupe_nodes(nodes), _dedupe_edges(edges)


def _replace_document_edges(
    conn,
    document_id: str,
    nodes: list[GraphNodeDraft],
    edges: list[GraphEdgeDraft],
) -> None:
    doc_node_id = _document_node_id(document_id)
    conn.execute("DELETE FROM graph_edges WHERE source_id = ?", (doc_node_id,))
    _upsert_nodes(conn, nodes)
    _upsert_edges(conn, edges)


def _upsert_nodes(conn, nodes: Iterable[GraphNodeDraft]) -> int:
    now = db.now_iso()
    count = 0
    for node in nodes:
        conn.execute(
            """
            INSERT INTO graph_nodes (id, kind, label, document_id, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                kind = excluded.kind,
                label = excluded.label,
                document_id = excluded.document_id
            """,
            (node.id, node.kind, node.label, node.document_id, now),
        )
        count += 1
    return count


def _upsert_edges(conn, edges: Iterable[GraphEdgeDraft]) -> int:
    now = db.now_iso()
    count = 0
    for edge in edges:
        edge_id = _edge_id(edge.source_id, edge.target_id, edge.kind)
        conn.execute(
            """
            INSERT INTO graph_edges (id, source_id, target_id, kind, weight, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                source_id = excluded.source_id,
                target_id = excluded.target_id,
                kind = excluded.kind,
                weight = excluded.weight
            """,
            (edge_id, edge.source_id, edge.target_id, edge.kind, edge.weight, now),
        )
        count += 1
    return count


def _load_documents(conn) -> list[GraphDocument]:
    rows = conn.execute(
        """
        SELECT id, source_type, title, url, path, note_id
        FROM documents
        ORDER BY title COLLATE NOCASE, id
        """
    ).fetchall()
    documents: list[GraphDocument] = []
    for row in rows:
        chunks = conn.execute(
            "SELECT content FROM chunks WHERE document_id = ? ORDER BY chunk_index",
            (row["id"],),
        ).fetchall()
        documents.append(
            GraphDocument(
                id=row["id"],
                source_type=row["source_type"],
                title=row["title"],
                url=row["url"],
                path=row["path"],
                note_id=row["note_id"],
                content="\n\n".join(chunk["content"] for chunk in chunks),
            )
        )
    return documents


def _load_document_lookup(conn) -> dict[str, str]:
    return _build_document_lookup(_load_documents(conn))


def _build_document_lookup(documents: Iterable[GraphDocument]) -> dict[str, str]:
    lookup: dict[str, str] = {}
    for document in documents:
        candidates = [document.title]
        if document.path:
            path = document.path.replace("\\", "/")
            filename = path.rsplit("/", 1)[-1]
            candidates.extend([path, filename, filename.rsplit(".", 1)[0]])
            if "/" in path:
                candidates.append(path.rsplit(".", 1)[0])
        for candidate in candidates:
            key = _normalize_lookup_key(candidate)
            if key:
                lookup[key] = document.id
    return lookup


def _load_graph_nodes(conn) -> dict[str, KnowledgeGraphNode]:
    rows = conn.execute(
        """
        SELECT
            n.id,
            n.kind,
            n.label,
            n.document_id,
            d.source_type,
            d.url,
            d.path,
            d.note_id
        FROM graph_nodes n
        LEFT JOIN documents d ON d.id = n.document_id
        """
    ).fetchall()
    return {
        row["id"]: KnowledgeGraphNode(
            id=row["id"],
            kind=row["kind"],
            label=row["label"],
            documentId=row["document_id"],
            sourceType=row["source_type"],
            url=row["url"],
            path=row["path"],
            noteId=row["note_id"],
        )
        for row in rows
    }


def _load_graph_edges(conn) -> dict[str, KnowledgeGraphEdge]:
    rows = conn.execute(
        """
        SELECT id, source_id, target_id, kind, weight
        FROM graph_edges
        """
    ).fetchall()
    return {
        row["id"]: KnowledgeGraphEdge(
            id=row["id"],
            source=row["source_id"],
            target=row["target_id"],
            kind=row["kind"],
            weight=row["weight"],
        )
        for row in rows
    }


def _node_ids_for_layer(
    nodes: dict[str, KnowledgeGraphNode],
    edges: Iterable[KnowledgeGraphEdge],
    layer: str,
) -> set[str]:
    if layer == "documents":
        ids = {node_id for node_id, node in nodes.items() if node.kind in {"document", "source"}}
        for edge in edges:
            if edge.kind == "links_to_document":
                ids.add(edge.source)
                ids.add(edge.target)
        return ids
    if layer == "concepts":
        return {
            node_id
            for node_id, node in nodes.items()
            if node.kind in {"document", "tag", "heading", "concept"}
        }
    return set(nodes.keys())


def _edge_kinds_for_layer(layer: str) -> set[str]:
    if layer == "documents":
        return {"belongs_to_source", "links_to_document"}
    if layer == "concepts":
        return {"has_tag", "has_heading", "mentions_concept", "links_to_document"}
    return {"belongs_to_source", "has_tag", "has_heading", "mentions_concept", "links_to_document"}


def _expand_neighbors(seed_ids: set[str], edges: Iterable[KnowledgeGraphEdge]) -> set[str]:
    if not seed_ids:
        return set()
    selected = set(seed_ids)
    for edge in edges:
        if edge.source in seed_ids or edge.target in seed_ids:
            selected.add(edge.source)
            selected.add(edge.target)
    return selected


def _degree_map(edges: Iterable[KnowledgeGraphEdge], node_ids: set[str]) -> dict[str, int]:
    degrees = {node_id: 0 for node_id in node_ids}
    for edge in edges:
        if edge.source in degrees:
            degrees[edge.source] += 1
        if edge.target in degrees:
            degrees[edge.target] += 1
    return degrees


def _limit_nodes(
    node_ids: set[str],
    seed_ids: set[str],
    degrees: dict[str, int],
    nodes: dict[str, KnowledgeGraphNode],
    limit: int,
) -> set[str]:
    ordered = sorted(
        node_ids,
        key=lambda node_id: (
            0 if node_id in seed_ids else 1,
            -degrees.get(node_id, 0),
            nodes[node_id].kind,
            nodes[node_id].label.lower(),
        ),
    )
    return set(ordered[:limit])


def _with_degree(node: KnowledgeGraphNode, degree: int) -> KnowledgeGraphNode:
    return KnowledgeGraphNode(
        id=node.id,
        kind=node.kind,
        label=node.label,
        documentId=node.documentId,
        sourceType=node.sourceType,
        url=node.url,
        path=node.path,
        noteId=node.noteId,
        degree=degree,
    )


def _node_matches_query(node: KnowledgeGraphNode, needle: str) -> bool:
    values = [node.label, node.sourceType or "", node.path or "", node.url or ""]
    return any(needle in value.lower() for value in values)


def _extract_tags(content: str) -> list[str]:
    frontmatter = _frontmatter(content)
    if not frontmatter:
        return []

    tags: list[str] = []
    lines = frontmatter.splitlines()
    collecting_block = False
    for line in lines:
        stripped = line.strip()
        if collecting_block and stripped.startswith("-"):
            tags.append(stripped[1:].strip().strip("'\""))
            continue
        if collecting_block and stripped and not line.startswith((" ", "\t", "-")):
            collecting_block = False
        if stripped.startswith("tags:"):
            value = stripped.split(":", 1)[1].strip()
            if value.startswith("[") and value.endswith("]"):
                tags.extend(part.strip().strip("'\"") for part in value[1:-1].split(","))
            elif value:
                tags.extend(part.strip().strip("'\"") for part in re.split(r"[, ]+", value))
            else:
                collecting_block = True
    return _unique_clean(tags, limit=24)


def _extract_headings(content: str) -> list[str]:
    headings: list[str] = []
    for line in content.splitlines():
        match = re.match(r"^\s{0,3}(#{1,4})\s+(.+?)\s*$", line)
        if not match:
            continue
        label = _clean_label(match.group(2))
        if label:
            headings.append(label)
    return _unique_clean(headings, limit=40)


def _extract_wikilinks(content: str) -> list[str]:
    links: list[str] = []
    for match in re.finditer(r"\[\[([^\]]+)\]\]", content):
        target = match.group(1).split("|", 1)[0].split("#", 1)[0].strip()
        if target:
            links.append(_clean_label(target))
    return _unique_clean(links, limit=80)


def _frontmatter(content: str) -> str:
    if not content.startswith("---"):
        return ""
    match = re.match(r"^---\s*\n(.*?)\n---\s*(?:\n|$)", content, flags=re.DOTALL)
    return match.group(1) if match else ""


def _dedupe_nodes(nodes: Iterable[GraphNodeDraft]) -> list[GraphNodeDraft]:
    result: dict[str, GraphNodeDraft] = {}
    for node in nodes:
        result[node.id] = node
    return list(result.values())


def _dedupe_edges(edges: Iterable[GraphEdgeDraft]) -> list[GraphEdgeDraft]:
    result: dict[str, GraphEdgeDraft] = {}
    for edge in edges:
        result[_edge_id(edge.source_id, edge.target_id, edge.kind)] = edge
    return list(result.values())


def _unique_clean(values: Iterable[str], limit: int) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        cleaned = _clean_label(value)
        key = cleaned.lower()
        if not cleaned or key in seen:
            continue
        seen.add(key)
        result.append(cleaned[:120])
        if len(result) >= limit:
            break
    return result


def _clean_label(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip().strip("#`*_")).strip()


def _normalize_lookup_key(value: str) -> str:
    normalized = value.replace("\\", "/").strip().lower()
    normalized = normalized[:-3] if normalized.endswith(".md") else normalized
    normalized = normalized.strip("/")
    return re.sub(r"\s+", " ", normalized)


def _document_node_id(document_id: str) -> str:
    return f"{DOCUMENT_NODE_PREFIX}{document_id}"


def _source_node_id(source_type: str) -> str:
    return f"{SOURCE_NODE_PREFIX}{source_type.lower()}"


def _tag_node_id(label: str) -> str:
    return f"{TAG_NODE_PREFIX}{db.sha1_text(label.lower())[:16]}"


def _heading_node_id(label: str) -> str:
    return f"{HEADING_NODE_PREFIX}{db.sha1_text(label.lower())[:16]}"


def _concept_node_id(label: str) -> str:
    return f"{CONCEPT_NODE_PREFIX}{db.sha1_text(_normalize_lookup_key(label))[:16]}"


def _edge_id(source_id: str, target_id: str, kind: str) -> str:
    return f"edge:{db.sha1_text(f'{kind}:{source_id}:{target_id}')[:24]}"


def _format_source_label(source_type: str) -> str:
    if source_type == "tabkeep_note":
        return "TabKeep"
    if source_type == "siyuan":
        return "SiYuan"
    if source_type == "markdown":
        return "Markdown / Obsidian"
    return source_type or "来源"


def _graph_totals(conn) -> dict[str, int]:
    nodes = conn.execute("SELECT COUNT(*) AS count FROM graph_nodes").fetchone()["count"]
    edges = conn.execute("SELECT COUNT(*) AS count FROM graph_edges").fetchone()["count"]
    return {"nodes": nodes, "edges": edges}
