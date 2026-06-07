from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from logger import logger
from schemas.config import NoteAdapterConfig
from services import storage
from services.note import build_note_adapter
from services.note.base import DocNode, NotebookInfo, SaveRequest, SaveResult

router = APIRouter(prefix="/notes", tags=["笔记集成"])


@router.get("/adapters", summary="列出可用的笔记适配器 provider")
def list_adapters() -> list[dict[str, str]]:
    return [
        {"id": "local", "name": "本地 Markdown", "description": "写到 data/notes/ 目录，纯本地，零依赖"},
        {"id": "siyuan", "name": "思源笔记", "description": "HTTP API @ :6806，需 Token"},
        {"id": "obsidian", "name": "Obsidian", "description": "即将推出（占位 stub）"},
    ]


@router.get("/config", summary="获取当前笔记适配器配置")
def get_config() -> NoteAdapterConfig | None:
    return storage.get_note_adapter()


@router.post("/test", summary="测试当前 adapter 连通性")
async def test_connection() -> dict[str, Any]:
    logger.info("POST /notes/test")
    config = storage.get_note_adapter()
    if not config:
        logger.warning("/notes/test: 未配置 noteAdapter")
        return {"ok": False, "provider": None, "error": "未配置 noteAdapter"}
    logger.info(f"/notes/test: provider={config.provider} endpoint={config.endpoint}")
    adapter = build_note_adapter(config)
    ok, err = await adapter.test_connection()
    return {"ok": ok, "provider": adapter.name, "error": err}


@router.get("/notebooks", summary="列出笔记本（仅 SiYuan 真实返回，local 返回占位）")
async def get_notebooks() -> list[NotebookInfo]:
    config = storage.get_note_adapter()
    if not config:
        logger.warning("/notes/notebooks: 未配置 noteAdapter")
        return []
    adapter = build_note_adapter(config)
    logger.info(f"GET /notes/notebooks: provider={adapter.name}")
    try:
        return await adapter.list_notebooks()
    except Exception as e:
        logger.exception(f"/notes/notebooks 失败: {e}")
        raise


@router.get("/notebooks/{notebook_id}/docs", summary="列出笔记本内的文档树（仅 SiYuan 真实返回）")
async def get_notebook_docs(notebook_id: str) -> list[DocNode]:
    config = storage.get_note_adapter()
    if not config:
        logger.warning(f"/notes/notebooks/{notebook_id}/docs: 未配置 noteAdapter")
        return []
    adapter = build_note_adapter(config)
    if not hasattr(adapter, "list_docs"):
        logger.info(
            f"/notes/notebooks/{notebook_id}/docs: provider={adapter.name} 不支持文档树，返回空"
        )
        return []
    logger.info(f"GET /notes/notebooks/{notebook_id}/docs: provider={adapter.name}")
    try:
        return await adapter.list_docs(notebook_id)
    except Exception as e:
        logger.exception(f"/notes/notebooks/{notebook_id}/docs 失败: {e}")
        return []


@router.post("/save", summary="保存单条标签到笔记系统", response_model=SaveResult)
async def save_tab(req: SaveRequest) -> SaveResult:
    content_len = len(req.content) if req.content else 0
    logger.info(
        f"POST /notes/save title={req.title!r} url={req.url!r} "
        f"content_len={content_len} notebook_id={req.notebook_id!r} target_doc={req.target_doc!r}"
    )
    config = storage.get_note_adapter()
    if not config:
        logger.warning("/notes/save: 未配置 noteAdapter")
        return SaveResult(ok=False, error="未配置 noteAdapter，请先在「笔记集成」里设置")

    effective_notebook = req.notebook_id or config.defaultNotebook or ""
    effective_target = req.target_doc or config.defaultTargetDoc
    effective_req = SaveRequest(
        title=req.title,
        url=req.url,
        excerpt=req.excerpt,
        content=req.content,
        notebook_id=effective_notebook,
        target_doc=effective_target,
    )
    logger.info(
        f"/notes/save effective: provider={config.provider} notebook={effective_notebook!r} "
        f"target_doc={effective_target!r} content_len={content_len}"
    )

    adapter = build_note_adapter(config)
    result = await adapter.save(effective_req)
    if result.ok:
        logger.info(f"/notes/save ok provider={adapter.name} doc={result.note_id}")
    else:
        logger.warning(f"/notes/save fail provider={adapter.name} error={result.error}")
    return result


class ProviderInfo(BaseModel):
    id: str
    name: str
    description: str


class SummarizeRequest(BaseModel):
    title: str
    url: str
    content: str


class SummarizeResponse(BaseModel):
    ok: bool
    summary_markdown: str | None = None
    error: str | None = None


@router.post("/summarize", response_model=SummarizeResponse, summary="用 LLM 把网页正文总结成 markdown 摘要")
async def summarize(req: SummarizeRequest) -> SummarizeResponse:
    logger.info(
        f"POST /notes/summarize title={req.title!r} url={req.url!r} content_len={len(req.content)}"
    )
    from services.summarizer import summarize_content

    cfg = storage.get_model_config()
    if not cfg or not cfg.model or not cfg.baseURL or not cfg.apiKey:
        logger.warning("/notes/summarize: modelConfig 不完整")
        return SummarizeResponse(ok=False, error="modelConfig 不完整,先在仪表盘配置 LLM")
    if not req.content.strip():
        logger.warning("/notes/summarize: content 为空")
        return SummarizeResponse(ok=False, error="content 为空,无法摘要")
    try:
        md, _ = await summarize_content(cfg, req.title, req.url, req.content)
        return SummarizeResponse(ok=True, summary_markdown=md)
    except Exception as e:
        logger.exception(f"/notes/summarize 失败: {e}")
        return SummarizeResponse(ok=False, error=f"LLM 调用失败: {type(e).__name__}: {e}")
