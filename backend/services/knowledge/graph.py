from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable
from urllib.parse import unquote

from schemas.knowledge import (
    KnowledgeGraphEdge,
    KnowledgeGraphNode,
    KnowledgeGraphRebuildResponse,
    KnowledgeGraphResponse,
    KnowledgeGraphStats,
)
from services.knowledge import db, vector_store

VALID_LAYERS = {"all", "documents", "concepts"}
DOCUMENT_NODE_PREFIX = "document:"
SOURCE_NODE_PREFIX = "source:"
TAG_NODE_PREFIX = "tag:"
HEADING_NODE_PREFIX = "heading:"
CONCEPT_NODE_PREFIX = "concept:"
SEMANTIC_EDGE_KIND = "semantic_similar"
SEMANTIC_SIMILARITY_THRESHOLD = 0.72
SEMANTIC_TOP_K_PER_DOCUMENT = 3
SEMANTIC_EDGE_LIMIT = 800
SEMANTIC_VECTOR_RECORD_LIMIT = 10000
TITLE_MENTION_MIN_LENGTH = 4
DOCUMENT_REFERENCE_LIMIT = 120


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


@dataclass(frozen=True)
class GraphMentionCandidate:
    document_id: str
    label: str


@dataclass(frozen=True)
class GraphDocumentReference:
    label: str
    target_doc_id: str | None
    weight: float
    allow_concept: bool = False


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
        documents = _load_documents(conn)
        if not any(item.id == document.id for item in documents):
            documents.append(document)
        lookup = _build_document_lookup(documents)
        mention_candidates = _build_document_mention_candidates(documents)
        nodes, edges = _build_document_graph(document, lookup, mention_candidates)
        _replace_document_edges(conn, document_id, nodes, edges)


def rebuild_graph() -> KnowledgeGraphRebuildResponse:
    db.init_db()
    with db.connection() as conn:
        documents = _load_documents(conn)
        lookup = _build_document_lookup(documents)
        mention_candidates = _build_document_mention_candidates(documents)
        conn.execute("DELETE FROM graph_edges")
        conn.execute("DELETE FROM graph_nodes")

        node_count = 0
        edge_count = 0
        for document in documents:
            nodes, edges = _build_document_graph(document, lookup, mention_candidates)
            node_count += _upsert_nodes(conn, nodes)
            edge_count += _upsert_edges(conn, edges)

        edge_count += _upsert_edges(conn, _build_semantic_edges(documents))

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
    mention_candidates: list[GraphMentionCandidate],
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

    for reference in _extract_document_references(document, lookup, mention_candidates):
        if reference.target_doc_id and reference.target_doc_id != document.id:
            edges.append(
                GraphEdgeDraft(
                    doc_node_id,
                    _document_node_id(reference.target_doc_id),
                    "links_to_document",
                    reference.weight,
                )
            )
            continue
        if not reference.allow_concept:
            continue
        concept_node_id = _concept_node_id(reference.label)
        nodes.append(GraphNodeDraft(concept_node_id, "concept", reference.label))
        edges.append(GraphEdgeDraft(doc_node_id, concept_node_id, "mentions_concept", 1.8))

    return _dedupe_nodes(nodes), _dedupe_edges(edges)


def _build_semantic_edges(documents: Iterable[GraphDocument]) -> list[GraphEdgeDraft]:
    document_ids = {document.id for document in documents}
    if len(document_ids) < 2:
        return []

    try:
        records = vector_store.list_records(limit=SEMANTIC_VECTOR_RECORD_LIMIT)
    except Exception:
        return []

    vectors = _aggregate_document_vectors(records, document_ids)
    if len(vectors) < 2:
        return []

    candidates: list[tuple[float, str, str]] = []
    ordered_ids = sorted(vectors)
    for left_index, left_id in enumerate(ordered_ids):
        left_vector = vectors[left_id]
        for right_id in ordered_ids[left_index + 1 :]:
            score = _cosine_similarity(left_vector, vectors[right_id])
            if score >= SEMANTIC_SIMILARITY_THRESHOLD:
                candidates.append((score, left_id, right_id))

    candidates.sort(key=lambda item: (-item[0], item[1], item[2]))
    per_document_counts = {document_id: 0 for document_id in vectors}
    edges: list[GraphEdgeDraft] = []
    for score, left_id, right_id in candidates:
        if len(edges) >= SEMANTIC_EDGE_LIMIT:
            break
        if per_document_counts[left_id] >= SEMANTIC_TOP_K_PER_DOCUMENT:
            continue
        if per_document_counts[right_id] >= SEMANTIC_TOP_K_PER_DOCUMENT:
            continue
        edges.append(
            GraphEdgeDraft(
                _document_node_id(left_id),
                _document_node_id(right_id),
                SEMANTIC_EDGE_KIND,
                round(score, 6),
            )
        )
        per_document_counts[left_id] += 1
        per_document_counts[right_id] += 1
    return edges


def _aggregate_document_vectors(
    records: Iterable[dict],
    document_ids: set[str],
) -> dict[str, list[float]]:
    sums: dict[str, list[float]] = {}
    counts: dict[str, int] = {}
    for record in records:
        document_id = str(record.get("document_id") or "")
        if document_id not in document_ids:
            continue
        vector = _vector_values(record.get("vector"))
        if not vector:
            continue
        current = sums.get(document_id)
        if current is None:
            sums[document_id] = list(vector)
            counts[document_id] = 1
            continue
        if len(current) != len(vector):
            continue
        for index, value in enumerate(vector):
            current[index] += value
        counts[document_id] += 1

    return {
        document_id: [value / counts[document_id] for value in vector]
        for document_id, vector in sums.items()
        if counts.get(document_id, 0) > 0
    }


def _cosine_similarity(left: list[float], right: list[float]) -> float:
    if len(left) != len(right) or not left:
        return 0
    dot = sum(left_value * right_value for left_value, right_value in zip(left, right, strict=True))
    left_norm = sum(value * value for value in left) ** 0.5
    right_norm = sum(value * value for value in right) ** 0.5
    if left_norm == 0 or right_norm == 0:
        return 0
    return dot / (left_norm * right_norm)


def _vector_values(value) -> list[float]:
    if value is None:
        return []
    if hasattr(value, "tolist"):
        value = value.tolist()
    try:
        return [float(item) for item in value]
    except (TypeError, ValueError):
        return []


def _replace_document_edges(
    conn,
    document_id: str,
    nodes: list[GraphNodeDraft],
    edges: list[GraphEdgeDraft],
) -> None:
    doc_node_id = _document_node_id(document_id)
    conn.execute(
        """
        DELETE FROM graph_edges
        WHERE source_id = ?
           OR (kind = ? AND target_id = ?)
        """,
        (doc_node_id, SEMANTIC_EDGE_KIND, doc_node_id),
    )
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
                parts = [part for part in path.split("/") if part]
                for start in range(max(0, len(parts) - 4), len(parts)):
                    suffix = "/".join(parts[start:])
                    candidates.extend([suffix, suffix.rsplit(".", 1)[0]])
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
        return {"belongs_to_source", "links_to_document", SEMANTIC_EDGE_KIND}
    if layer == "concepts":
        return {"has_tag", "has_heading", "mentions_concept", "links_to_document"}
    return {
        "belongs_to_source",
        "has_tag",
        "has_heading",
        "mentions_concept",
        "links_to_document",
        SEMANTIC_EDGE_KIND,
    }


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


def _extract_document_references(
    document: GraphDocument,
    lookup: dict[str, str],
    mention_candidates: list[GraphMentionCandidate],
) -> list[GraphDocumentReference]:
    references: list[GraphDocumentReference] = []

    for link in _extract_wikilinks(document.content):
        target_doc_id = lookup.get(_normalize_lookup_key(link))
        references.append(GraphDocumentReference(link, target_doc_id, 2.5, allow_concept=True))

    for label, target in _extract_markdown_note_links(document.content):
        target_doc_id = lookup.get(_normalize_lookup_key(target)) or lookup.get(_normalize_lookup_key(label))
        if target_doc_id:
            references.append(GraphDocumentReference(label or target, target_doc_id, 2.3))
        elif _looks_like_local_markdown_target(target):
            references.append(GraphDocumentReference(label or target, None, 1.8, allow_concept=True))

    for candidate in _extract_title_mentions(document, mention_candidates):
        references.append(GraphDocumentReference(candidate.label, candidate.document_id, 1.2))

    return _dedupe_references(references)


def _extract_wikilinks(content: str) -> list[str]:
    links: list[str] = []
    for match in re.finditer(r"\[\[([^\]]+)\]\]", content):
        target = match.group(1).split("|", 1)[0].split("#", 1)[0].strip()
        if target:
            links.append(_clean_label(target))
    return _unique_clean(links, limit=80)


def _extract_markdown_note_links(content: str) -> list[tuple[str, str]]:
    links: list[tuple[str, str]] = []
    for match in re.finditer(r"(?<!!)\[([^\]\n]+)\]\(([^)\n]+)\)", content):
        label = _clean_label(match.group(1))
        target = _clean_markdown_link_target(match.group(2))
        if not target or _is_external_markdown_target(target):
            continue
        links.append((label, target))
    return _unique_clean_pairs(links, limit=DOCUMENT_REFERENCE_LIMIT)


def _extract_title_mentions(
    document: GraphDocument,
    candidates: list[GraphMentionCandidate],
) -> list[GraphMentionCandidate]:
    mentions: list[GraphMentionCandidate] = []
    for candidate in candidates:
        if candidate.document_id == document.id:
            continue
        if _label_mentioned_in_content(candidate.label, document.content):
            mentions.append(candidate)
    return mentions[:DOCUMENT_REFERENCE_LIMIT]


def _build_document_mention_candidates(documents: Iterable[GraphDocument]) -> list[GraphMentionCandidate]:
    candidates: dict[tuple[str, str], GraphMentionCandidate] = {}
    for document in documents:
        for label in _document_reference_labels(document):
            cleaned = _clean_label(label)
            if not _valid_title_mention_label(cleaned):
                continue
            key = _normalize_lookup_key(cleaned)
            if not key:
                continue
            candidates[(document.id, key)] = GraphMentionCandidate(document.id, cleaned)
    return sorted(candidates.values(), key=lambda item: (-len(item.label), item.label.lower(), item.document_id))


def _document_reference_labels(document: GraphDocument) -> list[str]:
    labels = [document.title]
    if document.path:
        path = _normalize_path_text(document.path)
        filename = path.rsplit("/", 1)[-1]
        stem = filename.rsplit(".", 1)[0]
        labels.extend([filename, stem])
    return labels


def _clean_markdown_link_target(raw_target: str) -> str:
    target = raw_target.strip()
    if target.startswith("<") and ">" in target:
        target = target[1 : target.index(">")]
    else:
        target = re.sub(r"\s+['\"].*['\"]\s*$", "", target).strip()
    target = unquote(target).split("#", 1)[0].split("?", 1)[0].strip()
    return _clean_label(target)


def _is_external_markdown_target(target: str) -> bool:
    normalized = target.strip().lower()
    return normalized.startswith(("http://", "https://", "mailto:", "tel:", "#"))


def _looks_like_local_markdown_target(target: str) -> bool:
    normalized = target.replace("\\", "/").strip().lower()
    return normalized.endswith(".md") or "/" in normalized


def _valid_title_mention_label(label: str) -> bool:
    if len(label) < TITLE_MENTION_MIN_LENGTH:
        return False
    if re.fullmatch(r"[\W_]+", label):
        return False
    return True


def _label_mentioned_in_content(label: str, content: str) -> bool:
    if re.search(r"[\u4e00-\u9fff]", label):
        return label.lower() in content.lower()
    pattern = rf"(?<![A-Za-z0-9_]){re.escape(label)}(?![A-Za-z0-9_])"
    return re.search(pattern, content, flags=re.IGNORECASE) is not None


def _dedupe_references(references: Iterable[GraphDocumentReference]) -> list[GraphDocumentReference]:
    result: dict[tuple[str | None, str], GraphDocumentReference] = {}
    for reference in references:
        key = (reference.target_doc_id, _normalize_lookup_key(reference.label))
        existing = result.get(key)
        if existing is None or reference.weight > existing.weight:
            result[key] = reference
    return list(result.values())[:DOCUMENT_REFERENCE_LIMIT]


def _unique_clean_pairs(values: Iterable[tuple[str, str]], limit: int) -> list[tuple[str, str]]:
    seen: set[tuple[str, str]] = set()
    result: list[tuple[str, str]] = []
    for label, target in values:
        cleaned_label = _clean_label(label)
        cleaned_target = _clean_label(target)
        key = (cleaned_label.lower(), _normalize_lookup_key(cleaned_target))
        if not cleaned_target or key in seen:
            continue
        seen.add(key)
        result.append((cleaned_label[:120], cleaned_target[:240]))
        if len(result) >= limit:
            break
    return result


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
    normalized = _normalize_path_text(value).lower()
    normalized = normalized[:-3] if normalized.endswith(".md") else normalized
    normalized = normalized.strip("/")
    return re.sub(r"\s+", " ", normalized)


def _normalize_path_text(value: str) -> str:
    return unquote(value).replace("\\", "/").strip()


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
