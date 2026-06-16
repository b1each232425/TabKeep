from __future__ import annotations

import re
from pathlib import Path

from logger import logger
from schemas.knowledge import (
    KnowledgeAskRequest,
    KnowledgeAskResponse,
    KnowledgeCitation,
    KnowledgeConfig,
    KnowledgeReindexResponse,
    KnowledgeSearchResponse,
    KnowledgeSiyuanSyncRequest,
    KnowledgeSiyuanSyncResponse,
)
from services import storage
from services.knowledge import db, vector_store
from services.knowledge.chunking import guess_title, normalize_text
from services.knowledge.embeddings import embed_texts, embedding_config_ready
from services.llm import chat_completion
from services.note.base import DocNode, NotebookInfo, SaveRequest, SaveResult
from services.note.formatting import markdown_note
from services.note.siyuan import SiYuanAdapter

SKIP_DIRS = {".git", ".obsidian", ".trash", ".tmp", "node_modules", "__pycache__"}
MAX_CONTEXT_CHARS = 14_000
_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)


async def index_saved_note(req: SaveRequest, result: SaveResult) -> None:
    """笔记保存成功后，尽力把这条内容写入本地知识库。失败不影响收藏。"""
    if not result.ok:
        return
    config = storage.get_knowledge_config()
    if not config.enabled:
        return

    content = markdown_note(
        title=req.title,
        url=req.url,
        content=req.content or req.excerpt,
        mode=req.mode or "link",
        include_frontmatter=True,
    )
    try:
        await index_document(
            config=config,
            source_type="tabkeep_note",
            title=req.title,
            content=content,
            url=req.url,
            note_id=result.note_id,
        )
    except Exception as exc:
        logger.warning(f"知识库索引收藏失败: {type(exc).__name__}: {exc}")


async def reindex_all(config: KnowledgeConfig | None = None) -> KnowledgeReindexResponse:
    config = config or storage.get_knowledge_config()
    db.init_db()
    vector_ok, vector_message = vector_store.availability()
    if not config.enabled:
        return KnowledgeReindexResponse(
            ok=True,
            errors=["知识库已关闭"],
            stats=db.get_stats(vector_ok, vector_message),
        )

    documents_indexed = 0
    documents_skipped = 0
    chunks_indexed = 0
    errors: list[str] = []

    for md_path in discover_markdown_files(config):
        try:
            content = md_path.read_text(encoding="utf-8", errors="ignore")
            title = guess_title(md_path.stem, content)
            result, vector_error = await index_document(
                config=config,
                source_type="markdown",
                title=title,
                content=content,
                path=str(md_path),
            )
            if result.indexed:
                documents_indexed += 1
                chunks_indexed += result.chunk_count
            else:
                documents_skipped += 1
            if vector_error:
                errors.append(f"{md_path.name}: {vector_error}")
        except Exception as exc:
            errors.append(f"{md_path}: {type(exc).__name__}: {exc}")

    return KnowledgeReindexResponse(
        ok=len(errors) == 0,
        documentsIndexed=documents_indexed,
        documentsSkipped=documents_skipped,
        chunksIndexed=chunks_indexed,
        errors=errors[:20],
        stats=db.get_stats(vector_ok, vector_message),
    )


async def sync_siyuan_notes(req: KnowledgeSiyuanSyncRequest) -> KnowledgeSiyuanSyncResponse:
    """
    通过 SiYuan API 导出已有文档 Markdown,并写入 TabKeep 知识库。

    默认同步当前 noteAdapter 配置下的所有笔记本。若传 notebookId,只同步该笔记本。
    """
    config = storage.get_knowledge_config()
    vector_ok, vector_message = vector_store.availability()
    if not config.enabled:
        return KnowledgeSiyuanSyncResponse(
            ok=False,
            errors=["知识库已关闭"],
            stats=db.get_stats(vector_ok, vector_message),
        )

    note_config = storage.get_note_adapter()
    if not note_config or note_config.provider != "siyuan":
        return KnowledgeSiyuanSyncResponse(
            ok=False,
            errors=["当前笔记集成不是 SiYuan,请先在「笔记集成」里配置思源笔记"],
            stats=db.get_stats(vector_ok, vector_message),
        )

    adapter = SiYuanAdapter(note_config)
    errors: list[str] = []
    documents_found = 0
    documents_indexed = 0
    documents_skipped = 0
    chunks_indexed = 0

    try:
        notebooks = await adapter.list_notebooks()
    except Exception as exc:
        return KnowledgeSiyuanSyncResponse(
            ok=False,
            errors=[f"读取 SiYuan 笔记本失败: {type(exc).__name__}: {exc}"],
            stats=db.get_stats(vector_ok, vector_message),
        )

    if req.notebookId:
        notebooks = [item for item in notebooks if item.id == req.notebookId]
        if not notebooks:
            return KnowledgeSiyuanSyncResponse(
                ok=False,
                errors=[f"找不到 SiYuan 笔记本: {req.notebookId}"],
                stats=db.get_stats(vector_ok, vector_message),
            )

    limit = req.limit if req.limit and req.limit > 0 else None
    for notebook in notebooks:
        try:
            doc_tree = await adapter.list_docs(notebook.id)
            docs = flatten_doc_nodes(doc_tree)
        except Exception as exc:
            errors.append(f"{notebook.name}: 读取文档树失败: {type(exc).__name__}: {exc}")
            continue

        for doc in docs:
            if limit is not None and documents_found >= limit:
                break
            documents_found += 1
            try:
                h_path, content = await adapter.export_markdown(doc.id)
                if not content.strip():
                    documents_skipped += 1
                    continue
                title = title_from_siyuan_path(h_path, doc.name)
                indexed_content = build_siyuan_index_markdown(notebook, doc, h_path, content)
                result, vector_error = await index_document(
                    config=config,
                    source_type="siyuan",
                    title=title,
                    content=indexed_content,
                    path=f"siyuan://blocks/{doc.id}",
                    note_id=doc.id,
                )
                if result.indexed:
                    documents_indexed += 1
                    chunks_indexed += result.chunk_count
                else:
                    documents_skipped += 1
                if vector_error:
                    errors.append(f"{title}: {vector_error}")
            except Exception as exc:
                label = doc.path or doc.name or doc.id
                errors.append(f"{label}: {type(exc).__name__}: {exc}")
                if len(errors) >= 20:
                    break

        if limit is not None and documents_found >= limit:
            break
        if len(errors) >= 20:
            break

    return KnowledgeSiyuanSyncResponse(
        ok=len(errors) == 0,
        notebooksScanned=len(notebooks),
        documentsFound=documents_found,
        documentsIndexed=documents_indexed,
        documentsSkipped=documents_skipped,
        chunksIndexed=chunks_indexed,
        errors=errors[:20],
        stats=db.get_stats(vector_ok, vector_message),
    )


async def index_document(
    *,
    config: KnowledgeConfig,
    source_type: str,
    title: str,
    content: str,
    url: str | None = None,
    path: str | None = None,
    note_id: str | None = None,
) -> tuple[db.IndexResult, str | None]:
    normalized = normalize_text(content)
    result, chunks = db.upsert_document(
        source_type=source_type,
        title=title.strip() or "未命名文档",
        content=normalized,
        url=url,
        path=path,
        note_id=note_id,
    )
    if not chunks or not embedding_config_ready(config.embedding):
        return result, None

    vector_ok, vector_message = vector_store.availability()
    if not vector_ok:
        db.mark_embedding_status([chunk.id for chunk in chunks], "vector_unavailable")
        return result, vector_message

    try:
        vectors = await embed_texts(config.embedding, [chunk.content for chunk in chunks])
        vector_store.replace_document(chunks, vectors)
        db.mark_embedding_status([chunk.id for chunk in chunks], "ready")
        return result, None
    except Exception as exc:
        db.mark_embedding_status([chunk.id for chunk in chunks], "error")
        return result, f"embedding 失败: {type(exc).__name__}: {exc}"


async def search_knowledge(query: str, limit: int = 8) -> KnowledgeSearchResponse:
    clean_query = query.strip()
    if not clean_query:
        return KnowledgeSearchResponse(ok=False, query=query, sourceMode="fts", error="请输入搜索内容")

    limit = max(1, min(limit, 20))
    config = storage.get_knowledge_config()
    fts_items = db.search_fts(clean_query, limit * 2)
    vector_items: list[KnowledgeCitation] = []
    vector_used = False

    if embedding_config_ready(config.embedding) and vector_store.availability()[0]:
        try:
            vectors = await embed_texts(config.embedding, [clean_query])
            vector_rows = vector_store.search(vectors[0], limit * 2)
            vector_items = vector_rows_to_citations(vector_rows)
            vector_used = bool(vector_items)
        except Exception as exc:
            logger.warning(f"向量检索失败,回退 FTS: {type(exc).__name__}: {exc}")

    merged = rrf_merge(fts_items, vector_items, limit)
    source_mode = "hybrid" if vector_used and fts_items else "vector" if vector_used else "fts"
    return KnowledgeSearchResponse(ok=True, query=clean_query, sourceMode=source_mode, items=merged)


async def ask_knowledge(req: KnowledgeAskRequest) -> KnowledgeAskResponse:
    question = req.question.strip()
    if not question:
        return KnowledgeAskResponse(ok=False, error="请输入问题")

    model_config = storage.get_model_config()
    if not model_config or not model_config.model or not model_config.baseURL or not model_config.apiKey:
        return KnowledgeAskResponse(ok=False, error="modelConfig 不完整,先在「模型 API」配置 LLM")

    search_result = await search_knowledge(question, req.limit)
    if not search_result.items:
        return KnowledgeAskResponse(
            ok=False,
            error=search_result.error or "知识库里没有检索到相关内容",
            sourceMode=search_result.sourceMode,
        )

    session_id = db.ensure_session(req.sessionId, question)
    db.add_message(session_id, "user", question)
    messages = build_rag_messages(question, search_result.items)
    try:
        raw = await chat_completion(model_config, messages)
        answer = clean_llm_output(raw)
        db.add_message(session_id, "assistant", answer)
        return KnowledgeAskResponse(
            ok=True,
            answer=answer,
            citations=search_result.items,
            sessionId=session_id,
            sourceMode=search_result.sourceMode,
        )
    except Exception as exc:
        error = f"LLM 调用失败: {type(exc).__name__}: {exc}"
        db.add_message(session_id, "assistant", error)
        return KnowledgeAskResponse(
            ok=False,
            citations=search_result.items,
            sessionId=session_id,
            sourceMode=search_result.sourceMode,
            error=error,
        )


def discover_markdown_files(config: KnowledgeConfig) -> list[Path]:
    roots = collect_roots(config)
    files: list[Path] = []
    for root in roots:
        if not root.exists():
            continue
        if root.is_file() and root.suffix.lower() == ".md":
            files.append(root)
            continue
        if not root.is_dir():
            continue
        for path in root.rglob("*.md"):
            if should_skip(path, config.maxFileBytes):
                continue
            files.append(path)
    return sorted(set(files))


def collect_roots(config: KnowledgeConfig) -> list[Path]:
    roots = [Path(item).expanduser() for item in config.markdownPaths if item.strip()]
    note_adapter = storage.get_note_adapter()
    if note_adapter and note_adapter.provider == "obsidian" and note_adapter.vault:
        roots.append(Path(note_adapter.vault).expanduser())
    local_notes = storage.DATA_DIR / "notes"
    if local_notes.exists():
        roots.append(local_notes)
    return roots


def should_skip(path: Path, max_file_bytes: int) -> bool:
    parts = set(path.parts)
    if parts & SKIP_DIRS:
        return True


def flatten_doc_nodes(nodes: list[DocNode]) -> list[DocNode]:
    result: list[DocNode] = []
    for node in nodes:
        if node.type.lower() != "container":
            result.append(node)
        result.extend(flatten_doc_nodes(node.children))
    return result


def title_from_siyuan_path(h_path: str, fallback: str) -> str:
    parts = [part.strip() for part in h_path.split("/") if part.strip()]
    return (parts[-1] if parts else fallback).strip() or "未命名 SiYuan 文档"


def build_siyuan_index_markdown(
    notebook: NotebookInfo,
    doc: DocNode,
    h_path: str,
    content: str,
) -> str:
    escaped_h_path = h_path.replace('"', '\\"')
    escaped_notebook = notebook.name.replace('"', '\\"')
    return (
        "---\n"
        "source: siyuan\n"
        f"notebook: \"{escaped_notebook}\"\n"
        f"notebook_id: \"{notebook.id}\"\n"
        f"doc_id: \"{doc.id}\"\n"
        f"h_path: \"{escaped_h_path}\"\n"
        "---\n\n"
        f"{content.strip()}\n"
    )
    try:
        return path.stat().st_size > max_file_bytes
    except OSError:
        return True


def vector_rows_to_citations(rows: list[dict]) -> list[KnowledgeCitation]:
    chunk_ids = [str(row.get("chunk_id", "")) for row in rows if row.get("chunk_id")]
    details = db.get_chunks_by_ids(chunk_ids)
    items: list[KnowledgeCitation] = []
    for index, row in enumerate(rows):
        chunk_id = str(row.get("chunk_id", ""))
        item = details.get(chunk_id)
        if not item:
            continue
        distance = row.get("_distance")
        item.score = 1 / (1 + float(distance)) if distance is not None else 1 / (1 + index)
        items.append(item)
    return items


def rrf_merge(
    fts_items: list[KnowledgeCitation],
    vector_items: list[KnowledgeCitation],
    limit: int,
) -> list[KnowledgeCitation]:
    by_id: dict[str, KnowledgeCitation] = {}
    scores: dict[str, float] = {}
    for source in (fts_items, vector_items):
        for rank, item in enumerate(source, start=1):
            by_id.setdefault(item.chunkId, item)
            scores[item.chunkId] = scores.get(item.chunkId, 0) + 1 / (60 + rank)
    ranked = sorted(by_id.values(), key=lambda item: scores.get(item.chunkId, 0), reverse=True)
    for item in ranked:
        item.score = round(scores.get(item.chunkId, 0), 6)
    return ranked[:limit]


def build_rag_messages(question: str, citations: list[KnowledgeCitation]) -> list[dict[str, str]]:
    source_blocks: list[str] = []
    used = 0
    for index, item in enumerate(citations, start=1):
        content = item.content.strip()
        remaining = MAX_CONTEXT_CHARS - used
        if remaining <= 0:
            break
        clipped = content[:remaining]
        used += len(clipped)
        location = item.url or item.path or item.documentId
        source_blocks.append(
            f"[来源 {index}]\n标题: {item.title}\n位置: {location}\n内容:\n{clipped}"
        )

    return [
        {
            "role": "system",
            "content": (
                "你是 TabKeep 本地知识库助手。只能基于用户提供的来源片段回答。"
                "如果来源片段不足以回答,请明确说没有足够依据。"
                "回答要用中文,条理清晰,并在关键结论后用 [来源 1] 这样的形式标注来源。"
            ),
        },
        {
            "role": "user",
            "content": f"问题:\n{question}\n\n可用来源:\n\n" + "\n\n".join(source_blocks),
        },
    ]


def clean_llm_output(raw: str) -> str:
    cleaned = _THINK_RE.sub("", raw or "").strip()
    return cleaned or "没有生成有效回答。"
