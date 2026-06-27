from __future__ import annotations

from pathlib import Path

from logger import logger
from schemas.knowledge import KnowledgeConfig, KnowledgeReindexResponse
from services import storage
from services.knowledge import db, graph, topics, vector_store
from services.knowledge.chunking import guess_title, normalize_text
from services.knowledge.embeddings import embed_texts, embedding_config_ready
from services.note.base import SaveRequest, SaveResult
from services.note.formatting import markdown_note

SKIP_DIRS = {".git", ".obsidian", ".trash", ".tmp", "node_modules", "__pycache__"}


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
        topics.rebuild_topics()
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
    documents_deleted = 0
    chunks_indexed = 0
    errors: list[str] = []

    markdown_files = discover_markdown_files(config)
    for md_path in markdown_files:
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

    try:
        documents_deleted = cleanup_stale_markdown_indexes(config, markdown_files)
    except Exception as exc:
        errors.append(f"清理失效 Markdown 索引失败: {type(exc).__name__}: {exc}")

    try:
        graph.rebuild_graph()
    except Exception as exc:
        errors.append(f"知识图谱重建失败: {type(exc).__name__}: {exc}")

    try:
        topics.rebuild_topics()
    except Exception as exc:
        errors.append(f"主题知识地图重建失败: {type(exc).__name__}: {exc}")

    return KnowledgeReindexResponse(
        ok=len(errors) == 0,
        documentsIndexed=documents_indexed,
        documentsSkipped=documents_skipped,
        documentsDeleted=documents_deleted,
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
    if not result.indexed and result.embedding_status == "ready":
        return result, None

    graph_error = None
    if result.indexed:
        try:
            graph.index_document_graph(
                document_id=result.document_id,
                source_type=source_type,
                title=title.strip() or "未命名文档",
                content=normalized,
                url=url,
                path=path,
                note_id=note_id,
            )
        except Exception as exc:
            graph_error = f"知识图谱更新失败: {type(exc).__name__}: {exc}"
            db.mark_document_error(result.document_id, graph_error)
            logger.warning(graph_error)

    if not chunks or not embedding_config_ready(config.embedding):
        return result, graph_error

    vector_ok, vector_message = vector_store.availability()
    if not vector_ok:
        db.mark_embedding_status([chunk.id for chunk in chunks], "vector_unavailable")
        if vector_message:
            db.mark_document_error(result.document_id, vector_message)
        return result, graph_error or vector_message

    try:
        vectors = await embed_texts(config.embedding, [chunk.content for chunk in chunks])
        vector_store.replace_document(chunks, vectors)
        db.mark_embedding_status([chunk.id for chunk in chunks], "ready")
        if not graph_error:
            db.clear_document_error(result.document_id)
        return result, graph_error
    except Exception as exc:
        error = f"embedding 失败: {type(exc).__name__}: {exc}"
        db.mark_embedding_status([chunk.id for chunk in chunks], "error")
        db.mark_document_error(result.document_id, error)
        return result, graph_error or error


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
    try:
        return path.stat().st_size > max_file_bytes
    except OSError:
        return True


def cleanup_stale_markdown_indexes(config: KnowledgeConfig, discovered_files: list[Path]) -> int:
    roots = [resolve_path(root) for root in collect_roots(config)]
    discovered = {str(resolve_path(path)) for path in discovered_files}
    stale_ids: list[str] = []
    for status in db.list_document_index_statuses(source_type="markdown", limit=10000):
        if not status.path:
            continue
        indexed_path = resolve_path(Path(status.path).expanduser())
        indexed_key = str(indexed_path)
        if indexed_key not in discovered or not path_belongs_to_roots(indexed_path, roots):
            stale_ids.append(status.id)

    if not stale_ids:
        return 0

    vector_ok, _ = vector_store.availability()
    if vector_ok:
        vector_store.delete_documents(stale_ids)
    return db.delete_documents(stale_ids)


def resolve_path(path: Path) -> Path:
    try:
        return path.resolve()
    except OSError:
        return path.absolute()


def path_belongs_to_roots(path: Path, roots: list[Path]) -> bool:
    if not roots:
        return False
    for root in roots:
        try:
            if path == root or path.is_relative_to(root):
                return True
        except ValueError:
            continue
    return False
