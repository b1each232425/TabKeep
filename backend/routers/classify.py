"""
/config + /classify 路由。

- GET  /config         读 modelConfig + tabCategories
- POST /config/sync    合并式同步(只覆盖前端传的字段)
- POST /classify       用 LLM 把当前窗口标签归类
"""
from fastapi import APIRouter

from logger import logger
from schemas.classify import ClassifyRequest, ClassifyResponse
from schemas.config import ModelConfig, SyncConfigRequest, TabCategory
from services import storage
from services.classifier import classify_tabs

router = APIRouter(tags=["配置与分类"])


# ─────────────────────────────────────────────────────────────
# 配置读写
# ─────────────────────────────────────────────────────────────
@router.get("/config", summary="获取当前配置")
def get_config() -> dict[str, ModelConfig | list[TabCategory]]:
    """前端初始化时调用,一次拿全 model + categories。"""
    return {
        "modelConfig": storage.get_model_config(),
        "tabCategories": storage.get_tab_categories(),
    }


@router.post("/config/sync", summary="同步扩展配置到后端")
def sync_config(req: SyncConfigRequest) -> dict[str, bool]:
    """合并式同步。Storage 用 Pydantic model_fields_set 区分"未传"vs"传了空"。"""
    storage.sync_config(req)
    return {"ok": True}


# ─────────────────────────────────────────────────────────────
# LLM 分类
# ─────────────────────────────────────────────────────────────
@router.post("/classify", summary="用 LLM 分类当前窗口的标签页", response_model=ClassifyResponse)
async def classify(req: ClassifyRequest) -> ClassifyResponse:
    """
    给一组 tab,返回 {tabId: 分类名}。
    失败时把 error 字段填好(而不是 raise 500)——前端 UI 更友好。
    """
    model_config = storage.get_model_config()
    if not model_config or not model_config.model or not model_config.baseURL or not model_config.apiKey:
        logger.warning("classify: modelConfig 不完整")
        return ClassifyResponse(error="modelConfig 不完整,先在仪表盘配置")

    categories = storage.get_tab_categories()
    if not categories:
        logger.warning("classify: tabCategories 为空")
        return ClassifyResponse(error="tabCategories 为空,先在「分组」页添加分类")

    if not req.tabs:
        return ClassifyResponse(result={})

    try:
        result, raw = await classify_tabs(model_config, categories, req.tabs)
        logger.info(f"分类结果: {result}")
        return ClassifyResponse(result=result, raw=raw)
    except Exception as e:
        logger.exception(f"classify 调用失败: {e}")
        return ClassifyResponse(error=str(e))
