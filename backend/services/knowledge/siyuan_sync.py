from __future__ import annotations

from schemas.knowledge import (
    KnowledgeConfig,
    KnowledgeSiyuanPrecheckResponse,
    KnowledgeSiyuanSyncRequest,
    KnowledgeSiyuanSyncResponse,
)
from services import storage
from services.knowledge import db, vector_store
from services.knowledge.indexing import index_document
from services.note.base import DocNode, NotebookInfo
from services.note.siyuan import SiYuanAdapter


async def precheck_siyuan_sync() -> KnowledgeSiyuanPrecheckResponse:
    """检查当前配置是否足够执行 SiYuan 同步。"""
    config = storage.get_knowledge_config()
    if not config.enabled:
        return KnowledgeSiyuanPrecheckResponse(ok=False, error="知识库已关闭")

    note_config = storage.get_note_adapter()
    if not note_config or note_config.provider != "siyuan":
        return KnowledgeSiyuanPrecheckResponse(
            ok=False,
            error="当前笔记集成不是 SiYuan,请先在「笔记集成」里配置思源笔记",
        )

    adapter = SiYuanAdapter(note_config)
    try:
        notebooks = await adapter.list_notebooks()
    except Exception as exc:
        return KnowledgeSiyuanPrecheckResponse(
            ok=False,
            provider="siyuan",
            endpoint=adapter.endpoint,
            error=f"连接 SiYuan 失败: {type(exc).__name__}: {exc}",
        )

    return KnowledgeSiyuanPrecheckResponse(
        ok=True,
        provider="siyuan",
        endpoint=adapter.endpoint,
        notebooks=[notebook.model_dump() for notebook in notebooks],
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

    precheck = await precheck_siyuan_sync()
    if not precheck.ok:
        return KnowledgeSiyuanSyncResponse(
            ok=False,
            errors=[precheck.error or "SiYuan 预检查失败"],
            stats=db.get_stats(vector_ok, vector_message),
        )

    note_config = storage.get_note_adapter()
    if not note_config:
        return KnowledgeSiyuanSyncResponse(
            ok=False,
            errors=["未配置 SiYuan"],
            stats=db.get_stats(vector_ok, vector_message),
        )

    adapter = SiYuanAdapter(note_config)
    notebooks = [NotebookInfo(**item) for item in precheck.notebooks]

    if req.notebookId:
        notebooks = [item for item in notebooks if item.id == req.notebookId]
        if not notebooks:
            return KnowledgeSiyuanSyncResponse(
                ok=False,
                errors=[f"找不到 SiYuan 笔记本: {req.notebookId}"],
                stats=db.get_stats(vector_ok, vector_message),
            )

    return await export_notebooks_to_knowledge(adapter, config, notebooks, req.limit)


async def export_notebooks_to_knowledge(
    adapter: SiYuanAdapter,
    config: KnowledgeConfig,
    notebooks: list[NotebookInfo],
    limit: int | None,
) -> KnowledgeSiyuanSyncResponse:
    vector_ok, vector_message = vector_store.availability()
    errors: list[str] = []
    documents_found = 0
    documents_indexed = 0
    documents_skipped = 0
    chunks_indexed = 0
    max_docs = limit if limit and limit > 0 else None

    for notebook in notebooks:
        try:
            doc_tree = await adapter.list_docs(notebook.id)
            docs = flatten_doc_nodes(doc_tree)
        except Exception as exc:
            errors.append(f"{notebook.name}: 读取文档树失败: {type(exc).__name__}: {exc}")
            continue

        for doc in docs:
            if max_docs is not None and documents_found >= max_docs:
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

        if max_docs is not None and documents_found >= max_docs:
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

