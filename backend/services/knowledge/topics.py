from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from itertools import combinations
from typing import Any, Iterable

from schemas.knowledge import (
    KnowledgeTopic,
    KnowledgeTopicDetailResponse,
    KnowledgeTopicDocument,
    KnowledgeTopicEnrichResponse,
    KnowledgeTopicEvidence,
    KnowledgeTopicListResponse,
    KnowledgeTopicRebuildResponse,
    KnowledgeTopicRelation,
    KnowledgeTopicStats,
)
from services import storage
from services.knowledge import db, graph, vector_store
from services.llm import chat_completion

MAX_TOPICS = 120
MAX_TOPIC_DOCUMENTS = 30
MAX_EVIDENCE_PER_TOPIC = 80
MAX_RELATIONS = 240


@dataclass
class TopicDocument:
    id: str
    source_type: str
    title: str
    url: str | None
    path: str | None
    note_id: str | None
    content: str


@dataclass
class TopicDraft:
    id: str
    title: str
    kind: str
    keywords: set[str] = field(default_factory=set)
    source_types: set[str] = field(default_factory=set)
    document_scores: dict[str, float] = field(default_factory=dict)
    document_reasons: dict[str, set[str]] = field(default_factory=dict)
    document_snippets: dict[str, str] = field(default_factory=dict)
    evidence: list[tuple[str, str, str, float]] = field(default_factory=list)

    def add_document(
        self,
        document: TopicDocument,
        *,
        score: float,
        reason: str,
        evidence_kind: str,
        evidence_label: str,
    ) -> None:
        self.source_types.add(document.source_type)
        self.document_scores[document.id] = self.document_scores.get(document.id, 0) + score
        self.document_reasons.setdefault(document.id, set()).add(reason)
        self.document_snippets.setdefault(document.id, _snippet(document.content, evidence_label))
        self.evidence.append((evidence_kind, evidence_label, document.id, score))


def rebuild_topics() -> KnowledgeTopicRebuildResponse:
    db.init_db()
    with db.connection() as conn:
        documents = _load_documents(conn)
        drafts = _build_topic_drafts(documents)
        relations = _build_topic_relations(drafts)
        now = db.now_iso()

        conn.execute("DELETE FROM knowledge_topic_relations")
        conn.execute("DELETE FROM knowledge_topic_evidence")
        conn.execute("DELETE FROM knowledge_topic_documents")
        conn.execute("DELETE FROM knowledge_topics")

        topic_document_count = 0
        evidence_count = 0
        relation_count_by_topic = _relation_counts(relations)

        for draft in drafts:
            document_count = len(draft.document_scores)
            topic_evidence = draft.evidence[:MAX_EVIDENCE_PER_TOPIC]
            summary = _default_summary(draft, document_count)
            conn.execute(
                """
                INSERT INTO knowledge_topics (
                    id, title, summary, keywords_json, source_types_json,
                    document_count, evidence_count, relation_count, confidence,
                    ai_enhanced, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
                """,
                (
                    draft.id,
                    draft.title,
                    summary,
                    json.dumps(sorted(draft.keywords), ensure_ascii=False),
                    json.dumps(sorted(draft.source_types), ensure_ascii=False),
                    document_count,
                    len(topic_evidence),
                    relation_count_by_topic.get(draft.id, 0),
                    _confidence(draft, document_count, len(topic_evidence)),
                    now,
                    now,
                ),
            )

            for document_id, score in sorted(
                draft.document_scores.items(),
                key=lambda item: (-item[1], item[0]),
            )[:MAX_TOPIC_DOCUMENTS]:
                conn.execute(
                    """
                    INSERT INTO knowledge_topic_documents (topic_id, document_id, score, reason, snippet)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        draft.id,
                        document_id,
                        score,
                        "、".join(sorted(draft.document_reasons.get(document_id, []))),
                        draft.document_snippets.get(document_id, ""),
                    ),
                )
                topic_document_count += 1

            for index, (kind, label, document_id, weight) in enumerate(topic_evidence):
                conn.execute(
                    """
                    INSERT INTO knowledge_topic_evidence (id, topic_id, kind, label, document_id, weight)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        f"evidence:{db.sha1_text(f'{draft.id}:{index}:{kind}:{label}:{document_id}')[:24]}",
                        draft.id,
                        kind,
                        label,
                        document_id,
                        weight,
                    ),
                )
                evidence_count += 1

        for relation in relations:
            conn.execute(
                """
                INSERT INTO knowledge_topic_relations (
                    id, source_topic_id, target_topic_id, kind, label, weight
                )
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    relation.id,
                    relation.sourceTopicId,
                    relation.targetTopicId,
                    relation.kind,
                    relation.label,
                    relation.weight,
                ),
            )

        return KnowledgeTopicRebuildResponse(
            ok=True,
            topics=len(drafts),
            topicDocuments=topic_document_count,
            evidence=evidence_count,
            relations=len(relations),
        )


def list_topics(
    *,
    query: str | None = None,
    source_type: str | None = None,
    limit: int = 80,
) -> KnowledgeTopicListResponse:
    db.init_db()
    safe_limit = max(1, min(limit, 200))
    needle = (query or "").strip().lower()
    source_filter = (source_type or "").strip().lower()
    with db.connection() as conn:
        rows = conn.execute(
            """
            SELECT *
            FROM knowledge_topics
            ORDER BY document_count DESC, confidence DESC, title COLLATE NOCASE
            """
        ).fetchall()

    topics = [_topic_from_row(row) for row in rows]
    if needle:
        topics = [
            topic
            for topic in topics
            if needle in topic.title.lower()
            or needle in topic.summary.lower()
            or any(needle in keyword.lower() for keyword in topic.keywords)
        ]
    if source_filter:
        topics = [
            topic
            for topic in topics
            if any(source_filter == source.lower() for source in topic.sourceTypes)
        ]
    total_topics = len(rows)
    visible_topics = topics[:safe_limit]
    return KnowledgeTopicListResponse(
        ok=True,
        topics=visible_topics,
        stats=KnowledgeTopicStats(
            topics=len(visible_topics),
            documents=sum(topic.documentCount for topic in visible_topics),
            relations=sum(topic.relationCount for topic in visible_topics),
            totalTopics=total_topics,
        ),
    )


def get_topic_detail(topic_id: str) -> KnowledgeTopicDetailResponse:
    db.init_db()
    with db.connection() as conn:
        topic_row = conn.execute("SELECT * FROM knowledge_topics WHERE id = ?", (topic_id,)).fetchone()
        if not topic_row:
            return KnowledgeTopicDetailResponse(ok=False, error="主题不存在")

        document_rows = conn.execute(
            """
            SELECT
                td.document_id,
                td.score,
                td.reason,
                td.snippet,
                d.title,
                d.source_type,
                d.url,
                d.path,
                d.note_id
            FROM knowledge_topic_documents td
            JOIN documents d ON d.id = td.document_id
            WHERE td.topic_id = ?
            ORDER BY td.score DESC, d.title COLLATE NOCASE
            """,
            (topic_id,),
        ).fetchall()
        evidence_rows = conn.execute(
            """
            SELECT id, kind, label, document_id, weight
            FROM knowledge_topic_evidence
            WHERE topic_id = ?
            ORDER BY weight DESC, label COLLATE NOCASE
            """,
            (topic_id,),
        ).fetchall()
        relation_rows = conn.execute(
            """
            SELECT id, source_topic_id, target_topic_id, kind, label, weight
            FROM knowledge_topic_relations
            WHERE source_topic_id = ? OR target_topic_id = ?
            ORDER BY weight DESC, label COLLATE NOCASE
            """,
            (topic_id, topic_id),
        ).fetchall()

    return KnowledgeTopicDetailResponse(
        ok=True,
        topic=_topic_from_row(topic_row),
        documents=[
            KnowledgeTopicDocument(
                documentId=row["document_id"],
                title=row["title"],
                sourceType=row["source_type"],
                url=row["url"],
                path=row["path"],
                noteId=row["note_id"],
                score=row["score"],
                reason=row["reason"],
                snippet=row["snippet"],
            )
            for row in document_rows
        ],
        evidence=[
            KnowledgeTopicEvidence(
                id=row["id"],
                kind=row["kind"],
                label=row["label"],
                documentId=row["document_id"],
                weight=row["weight"],
            )
            for row in evidence_rows
        ],
        relations=[
            KnowledgeTopicRelation(
                id=row["id"],
                sourceTopicId=row["source_topic_id"],
                targetTopicId=row["target_topic_id"],
                kind=row["kind"],
                label=row["label"],
                weight=row["weight"],
            )
            for row in relation_rows
        ],
    )


async def enrich_topics(topic_id: str | None = None) -> KnowledgeTopicEnrichResponse:
    model_config = storage.get_model_config()
    if not model_config or not model_config.model or not model_config.baseURL or not model_config.apiKey:
        return KnowledgeTopicEnrichResponse(ok=False, error="modelConfig 不完整,先在「模型 API」配置 LLM")

    topics = list_topics(limit=30).topics
    if topic_id:
        topics = [topic for topic in topics if topic.id == topic_id]
    if not topics:
        return KnowledgeTopicEnrichResponse(ok=False, error="没有可整理的主题")

    enriched_count = 0
    for topic in topics:
        detail = get_topic_detail(topic.id)
        if not detail.ok or not detail.topic:
            continue
        prompt = _build_enrich_prompt(detail)
        raw = await chat_completion(
            model_config,
            [
                {
                    "role": "system",
                    "content": "你是 TabKeep 知识库整理助手。只根据给定证据整理主题，不添加证据外的信息。",
                },
                {"role": "user", "content": prompt},
            ],
        )
        payload = _parse_enrich_payload(raw)
        if not payload:
            payload = {"summary": raw.strip()[:600]}
        _save_enrichment(topic.id, payload)
        enriched_count += 1

    return KnowledgeTopicEnrichResponse(ok=True, topics=enriched_count)


def _load_documents(conn) -> list[TopicDocument]:
    rows = conn.execute(
        """
        SELECT id, source_type, title, url, path, note_id
        FROM documents
        ORDER BY title COLLATE NOCASE, id
        """
    ).fetchall()
    documents: list[TopicDocument] = []
    for row in rows:
        chunks = conn.execute(
            "SELECT content FROM chunks WHERE document_id = ? ORDER BY chunk_index",
            (row["id"],),
        ).fetchall()
        documents.append(
            TopicDocument(
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


def _build_topic_drafts(documents: list[TopicDocument]) -> list[TopicDraft]:
    drafts: dict[str, TopicDraft] = {}

    def topic_for(kind: str, label: str) -> TopicDraft:
        clean = _clean_label(label)
        topic_id = f"{kind}:{db.sha1_text(clean.lower())[:16]}"
        if topic_id not in drafts:
            drafts[topic_id] = TopicDraft(
                id=topic_id,
                title=clean,
                kind=kind,
                keywords={clean},
            )
        return drafts[topic_id]

    for document in documents:
        signal_count = 0
        for tag in graph._extract_tags(document.content):
            topic_for("tag", tag).add_document(
                document,
                score=4,
                reason=f"共享标签：{tag}",
                evidence_kind="tag",
                evidence_label=tag,
            )
            signal_count += 1

        for link in graph._extract_wikilinks(document.content):
            topic_for("concept", link).add_document(
                document,
                score=3,
                reason=f"双链/概念：{link}",
                evidence_kind="wikilink",
                evidence_label=link,
            )
            signal_count += 1

        for heading in graph._extract_headings(document.content)[:8]:
            topic_for("heading", heading).add_document(
                document,
                score=1.4,
                reason=f"标题线索：{heading}",
                evidence_kind="heading",
                evidence_label=heading,
            )
            signal_count += 1

        for path_topic in _extract_path_topics(document.path):
            topic_for("path", path_topic).add_document(
                document,
                score=2,
                reason=f"路径分组：{path_topic}",
                evidence_kind="path",
                evidence_label=path_topic,
            )
            signal_count += 1

        if signal_count == 0:
            fallback = _fallback_topic_label(document)
            topic_for("fallback", fallback).add_document(
                document,
                score=1,
                reason="缺少显式标签，按标题/来源归类",
                evidence_kind="fallback",
                evidence_label=fallback,
            )

    for embedding_topic in _build_embedding_topics(documents):
        drafts[embedding_topic.id] = embedding_topic

    return _rank_topic_drafts(drafts.values())[:MAX_TOPICS]


def _build_embedding_topics(documents: list[TopicDocument]) -> list[TopicDraft]:
    try:
        available, _message = vector_store.availability()
        if not available:
            return []
        records = vector_store.list_records()
    except Exception:
        return []

    by_document: dict[str, list[list[float]]] = {}
    for record in records:
        document_id = str(record.get("document_id") or "")
        vector = record.get("vector")
        if document_id and isinstance(vector, list) and vector:
            by_document.setdefault(document_id, []).append([float(value) for value in vector])

    if len(by_document) < 2:
        return []

    document_map = {document.id: document for document in documents}
    vectors = {
        document_id: _average_vector(items)
        for document_id, items in by_document.items()
        if document_id in document_map and items
    }
    pairs: list[tuple[str, str, float]] = []
    for left_id, right_id in combinations(vectors.keys(), 2):
        score = _cosine(vectors[left_id], vectors[right_id])
        if score >= 0.82:
            pairs.append((left_id, right_id, score))

    components = _connected_components(pairs)
    topics: list[TopicDraft] = []
    for component in components:
        docs = [document_map[document_id] for document_id in component if document_id in document_map]
        if len(docs) < 2:
            continue
        label = f"相似内容：{docs[0].title}"
        draft = TopicDraft(
            id=f"similar:{db.sha1_text('|'.join(sorted(component)))[:16]}",
            title=label[:80],
            kind="similar",
            keywords={"相似内容"},
        )
        for document in docs:
            best_score = max(
                (score for left, right, score in pairs if document.id in {left, right}),
                default=0.82,
            )
            draft.add_document(
                document,
                score=2.2 + best_score,
                reason=f"embedding 相似度约 {best_score:.2f}",
                evidence_kind="embedding",
                evidence_label="语义相似",
            )
        topics.append(draft)
    return topics


def _build_topic_relations(drafts: list[TopicDraft]) -> list[KnowledgeTopicRelation]:
    relations: list[KnowledgeTopicRelation] = []
    for left, right in combinations(drafts, 2):
        overlap = set(left.document_scores) & set(right.document_scores)
        if not overlap:
            continue
        weight = float(len(overlap))
        relations.append(
            KnowledgeTopicRelation(
                id=f"topic-relation:{db.sha1_text(f'{left.id}:{right.id}')[:24]}",
                sourceTopicId=left.id,
                targetTopicId=right.id,
                kind="shared_documents",
                label=f"共享 {len(overlap)} 篇笔记",
                weight=weight,
            )
        )
    relations.sort(key=lambda relation: (-relation.weight, relation.sourceTopicId, relation.targetTopicId))
    return relations[:MAX_RELATIONS]


def _relation_counts(relations: Iterable[KnowledgeTopicRelation]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for relation in relations:
        counts[relation.sourceTopicId] = counts.get(relation.sourceTopicId, 0) + 1
        counts[relation.targetTopicId] = counts.get(relation.targetTopicId, 0) + 1
    return counts


def _rank_topic_drafts(drafts: Iterable[TopicDraft]) -> list[TopicDraft]:
    return sorted(
        drafts,
        key=lambda draft: (
            -len(draft.document_scores),
            -sum(draft.document_scores.values()),
            draft.kind,
            draft.title.lower(),
        ),
    )


def _topic_from_row(row) -> KnowledgeTopic:
    return KnowledgeTopic(
        id=row["id"],
        title=row["title"],
        summary=row["summary"],
        keywords=_json_list(row["keywords_json"]),
        sourceTypes=_json_list(row["source_types_json"]),
        documentCount=row["document_count"],
        evidenceCount=row["evidence_count"],
        relationCount=row["relation_count"],
        confidence=row["confidence"],
        aiEnhanced=bool(row["ai_enhanced"]),
        updatedAt=row["updated_at"],
    )


def _default_summary(draft: TopicDraft, document_count: int) -> str:
    keywords = "、".join(sorted(draft.keywords)[:5])
    source_types = "、".join(sorted(draft.source_types))
    return f"包含 {document_count} 篇笔记，主要线索：{keywords or draft.title}。来源：{source_types or '知识库'}。"


def _confidence(draft: TopicDraft, document_count: int, evidence_count: int) -> float:
    value = 0.32 + min(document_count, 8) * 0.07 + min(evidence_count, 12) * 0.025
    if draft.kind in {"tag", "concept", "similar"}:
        value += 0.12
    return round(min(value, 0.98), 3)


def _extract_path_topics(path: str | None) -> list[str]:
    if not path:
        return []
    normalized = path.replace("\\", "/")
    parts = [part.strip() for part in normalized.split("/") if part.strip()]
    if len(parts) <= 1:
        return []
    return [_clean_label(part) for part in parts[-3:-1] if part and not part.endswith(".md")]


def _fallback_topic_label(document: TopicDocument) -> str:
    title = _clean_label(document.title)
    if title:
        return title[:40]
    return _format_source_label(document.source_type)


def _snippet(content: str, label: str) -> str:
    clean = re.sub(r"\s+", " ", content).strip()
    if not clean:
        return ""
    index = clean.lower().find(label.lower())
    if index < 0:
        return clean[:240]
    start = max(0, index - 90)
    end = min(len(clean), index + len(label) + 140)
    return clean[start:end]


def _build_enrich_prompt(detail: KnowledgeTopicDetailResponse) -> str:
    topic = detail.topic
    if not topic:
        return ""
    documents = "\n".join(
        f"- {item.title} ({item.sourceType})：{item.reason}\n  片段：{item.snippet[:300]}"
        for item in detail.documents[:8]
    )
    evidence = "、".join(f"{item.kind}:{item.label}" for item in detail.evidence[:16])
    return (
        "请把下面主题整理成 JSON，字段为 title、summary、keywords、questions。"
        "title 不超过 18 个汉字，summary 不超过 160 个汉字，keywords 和 questions 都是字符串数组。"
        "\n\n"
        f"当前主题：{topic.title}\n证据：{evidence}\n文档：\n{documents}"
    )


def _parse_enrich_payload(raw: str) -> dict[str, Any] | None:
    text = raw.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    match = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if match:
        text = match.group(0)
    try:
        payload = json.loads(text)
    except Exception:
        return None
    return payload if isinstance(payload, dict) else None


def _save_enrichment(topic_id: str, payload: dict[str, Any]) -> None:
    title = str(payload.get("title") or "").strip()
    summary = str(payload.get("summary") or "").strip()
    keywords = payload.get("keywords") or []
    questions = payload.get("questions") or []
    merged_keywords = _clean_list([*keywords, *questions], limit=12)
    updates: list[str] = ["ai_enhanced = 1", "updated_at = ?"]
    values: list[Any] = [db.now_iso()]
    if title:
        updates.append("title = ?")
        values.append(title[:80])
    if summary:
        updates.append("summary = ?")
        values.append(summary[:800])
    if merged_keywords:
        updates.append("keywords_json = ?")
        values.append(json.dumps(merged_keywords, ensure_ascii=False))
    values.append(topic_id)
    with db.connection() as conn:
        conn.execute(
            f"UPDATE knowledge_topics SET {', '.join(updates)} WHERE id = ?",
            values,
        )


def _json_list(value: str | None) -> list[str]:
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except Exception:
        return []
    if not isinstance(parsed, list):
        return []
    return [str(item) for item in parsed if str(item).strip()]


def _clean_list(values: Iterable[Any], limit: int) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        item = _clean_label(str(value))
        key = item.lower()
        if not item or key in seen:
            continue
        seen.add(key)
        result.append(item[:80])
        if len(result) >= limit:
            break
    return result


def _clean_label(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip().strip("#`*_")).strip()


def _format_source_label(source_type: str) -> str:
    if source_type == "tabkeep_note":
        return "TabKeep"
    if source_type == "siyuan":
        return "SiYuan"
    if source_type == "markdown":
        return "Markdown / Obsidian"
    return source_type or "知识库"


def _average_vector(vectors: list[list[float]]) -> list[float]:
    width = min(len(vector) for vector in vectors)
    return [sum(vector[index] for vector in vectors) / len(vectors) for index in range(width)]


def _cosine(left: list[float], right: list[float]) -> float:
    width = min(len(left), len(right))
    if width == 0:
        return 0
    dot = sum(left[index] * right[index] for index in range(width))
    left_norm = math.sqrt(sum(left[index] * left[index] for index in range(width)))
    right_norm = math.sqrt(sum(right[index] * right[index] for index in range(width)))
    if not left_norm or not right_norm:
        return 0
    return dot / (left_norm * right_norm)


def _connected_components(pairs: list[tuple[str, str, float]]) -> list[set[str]]:
    neighbors: dict[str, set[str]] = {}
    for left, right, _score in pairs:
        neighbors.setdefault(left, set()).add(right)
        neighbors.setdefault(right, set()).add(left)

    components: list[set[str]] = []
    visited: set[str] = set()
    for node in neighbors:
        if node in visited:
            continue
        stack = [node]
        component: set[str] = set()
        while stack:
            current = stack.pop()
            if current in visited:
                continue
            visited.add(current)
            component.add(current)
            stack.extend(neighbors.get(current, set()) - visited)
        components.append(component)
    return components
