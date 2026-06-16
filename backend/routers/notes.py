"""
/notes/* 路由 —— 笔记集成全部接口。

- GET  /adapters                       列 provider 选项
- GET  /config                         读当前 noteAdapter
- POST /test                           连通性测试
- GET  /notebooks                      列笔记本
- GET  /notebooks/{id}/docs            笔记本内文档树
- POST /save                           保存一条 tab 到笔记
- POST /summarize                      LLM 摘录网页正文

按职能分两段:
  1. 基础配置 / 测试 / 列表(轻)
  2. save / summarize(走真实 adapter / LLM)
"""
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from logger import logger
from schemas.config import NoteAdapterConfig
from services import storage
from services.auth import require_api_token
from services.knowledge.service import index_saved_note
from services.note import build_note_adapter
from services.note.base import DocNode, NotebookInfo, SaveRequest, SaveResult

router = APIRouter(prefix="/notes", tags=["笔记集成"], dependencies=[Depends(require_api_token)])


# ─────────────────────────────────────────────────────────────
# 1. 基础信息 + 配置 + 测试 + 列表
# ─────────────────────────────────────────────────────────────
@router.get("/adapters", summary="列出可用的笔记适配器 provider")
def list_adapters() -> list[dict[str, str]]:
    """前端"笔记集成"section 用来渲染 provider 下拉。"""
    return [
        {"id": "local", "name": "本地 Markdown", "description": "写到 data/notes/ 目录,纯本地,零依赖"},
        {"id": "siyuan", "name": "思源笔记", "description": "HTTP API @ :6806,需 Token"},
        {"id": "obsidian", "name": "Obsidian / Markdown 文件夹", "description": "直接写入 vault 或普通 Markdown 文件夹"},
    ]


@router.get("/config", summary="获取当前笔记适配器配置")
def get_config() -> NoteAdapterConfig | None:
    return storage.get_note_adapter()


@router.post("/test", summary="测试当前 adapter 连通性")
async def test_connection() -> dict[str, Any]:
    """前端"测试连接"按钮直接调。返回 ok + provider + 可选 error。"""
    logger.info("POST /notes/test")
    config = storage.get_note_adapter()
    if not config:
        logger.warning("/notes/test: 未配置 noteAdapter")
        return {"ok": False, "provider": None, "error": "未配置 noteAdapter"}
    logger.info(f"/notes/test: provider={config.provider} endpoint={config.endpoint}")
    adapter = build_note_adapter(config)
    ok, err = await adapter.test_connection()
    return {"ok": ok, "provider": adapter.name, "error": err}


@router.get("/notebooks", summary="列出笔记本")
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


@router.get("/notebooks/{notebook_id}/docs", summary="列出笔记本内的文档树")
async def get_notebook_docs(notebook_id: str) -> list[DocNode]:
    """弹窗里展开笔记本时调一次。SiYuan / Obsidian 会返回文档树,Local 返回空。"""
    config = storage.get_note_adapter()
    if not config:
        logger.warning(f"/notes/notebooks/{notebook_id}/docs: 未配置 noteAdapter")
        return []
    adapter = build_note_adapter(config)
    if not hasattr(adapter, "list_docs"):
        logger.info(
            f"/notes/notebooks/{notebook_id}/docs: provider={adapter.name} 不支持文档树,返回空"
        )
        return []
    logger.info(f"GET /notes/notebooks/{notebook_id}/docs: provider={adapter.name}")
    try:
        return await adapter.list_docs(notebook_id)
    except Exception as e:
        logger.exception(f"/notes/notebooks/{notebook_id}/docs 失败: {e}")
        return []


# ─────────────────────────────────────────────────────────────
# 2. save: 走真实 adapter
# ─────────────────────────────────────────────────────────────
@router.post("/save", summary="保存单条标签到笔记系统", response_model=SaveResult)
async def save_tab(req: SaveRequest) -> SaveResult:
    """
    主入口。前端 popup / 弹窗的"确认收藏"按钮直接调这个。
    - effective_notebook: 优先用请求里的,缺省用 config.defaultNotebook
    - effective_target: 优先用请求里的,缺省用 config.defaultTargetDoc
    - content 字段复用:存全文 / 存 LLM 摘录(走同一条路径)
    """
    content_len = len(req.content) if req.content else 0
    logger.info(
        f"POST /notes/save title={req.title!r} url={req.url!r} mode={req.mode!r} "
        f"content_len={content_len} notebook_id={req.notebook_id!r} target_doc={req.target_doc!r}"
    )
    config = storage.get_note_adapter()
    if not config:
        logger.warning("/notes/save: 未配置 noteAdapter")
        return SaveResult(ok=False, error="未配置 noteAdapter,请先在「笔记集成」里设置")

    effective_notebook = req.notebook_id or config.defaultNotebook or ""
    effective_target = req.target_doc or config.defaultTargetDoc
    effective_mode = req.mode or ("full" if req.content else "link")
    effective_req = SaveRequest(
        title=req.title,
        url=req.url,
        excerpt=req.excerpt,
        content=req.content,
        notebook_id=effective_notebook,
        target_doc=effective_target,
        mode=effective_mode,
    )
    logger.info(
        f"/notes/save effective: provider={config.provider} notebook={effective_notebook!r} "
        f"target_doc={effective_target!r} mode={effective_mode!r} content_len={content_len}"
    )

    adapter = build_note_adapter(config)
    result = await adapter.save(effective_req)
    if result.ok:
        logger.info(f"/notes/save ok provider={adapter.name} doc={result.note_id}")
        await index_saved_note(effective_req, result)
    else:
        logger.warning(f"/notes/save fail provider={adapter.name} error={result.error}")
    return result


# ─────────────────────────────────────────────────────────────
# 3. summarize: LLM 摘录
# ─────────────────────────────────────────────────────────────
class SummarizeRequest(BaseModel):
    title: str
    url: str
    content: str                       # markdown 全文(由前端 content script 提取后传来)


class SummarizeResponse(BaseModel):
    ok: bool
    summary_markdown: str | None = None  # 清洗后的纯 markdown,可直接进笔记
    error: str | None = None


@router.post("/summarize", response_model=SummarizeResponse, summary="用 LLM 把网页正文总结成 markdown 摘录")
async def summarize(req: SummarizeRequest) -> SummarizeResponse:
    """
    端到端摘录:content 是前端 defuddle 提取的 markdown,这里送 LLM 拿 markdown 摘录。
    失败时 error 字段填好(不 raise 500),让前端可以回退保存全文。
    """
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
        return SummarizeResponse(ok=False, error="content 为空,无法摘录")
    try:
        md, _ = await summarize_content(cfg, req.title, req.url, req.content)
        return SummarizeResponse(ok=True, summary_markdown=md)
    except Exception as e:
        logger.exception(f"/notes/summarize 失败: {e}")
        return SummarizeResponse(ok=False, error=f"LLM 调用失败:{type(e).__name__}:{e}")
