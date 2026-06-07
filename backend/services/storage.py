"""
全局配置 + 内存状态的中心。

按职能:
  1. 路径常量
  2. 内存状态 + 文件锁
  3. 初始化 init():从 data/config.json 读
  4. 私有 _persist():把内存状态写回 config.json
  5. 三个 getter:get_model_config / get_tab_categories / get_note_adapter
  6. sync_config():合并式同步,只覆盖前端实际传的字段

并发:用 threading.Lock 保护 _state 读写;uvicorn 单进程下也够用。
"""
import json
import os
import threading
from pathlib import Path

from logger import logger
from schemas.config import ModelConfig, NoteAdapterConfig, SyncConfigRequest, TabCategory

# ─────────────────────────────────────────────────────────────
# 路径常量
# ─────────────────────────────────────────────────────────────
DATA_DIR = Path(__file__).parent.parent / "data"
CONFIG_FILE = DATA_DIR / "config.json"


# ─────────────────────────────────────────────────────────────
# 模块级内存状态(单例)
# ─────────────────────────────────────────────────────────────
_lock = threading.Lock()
_state: dict = {"modelConfig": None, "tabCategories": [], "noteAdapter": None}


# ─────────────────────────────────────────────────────────────
# 启动初始化
# ─────────────────────────────────────────────────────────────
def init() -> None:
    """
    启动时调用:确保 data/ 目录存在,然后尝试从 config.json 恢复状态。

    - 文件不存在 → 静默退出(全新部署,等前端第一次 POST /config/sync)
    - JSON 损坏 / OSError → 打 warning,state 保持空
    """
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not CONFIG_FILE.exists():
        return
    try:
        with CONFIG_FILE.open("r", encoding="utf-8") as f:
            data = json.load(f)
        _state["modelConfig"] = data.get("modelConfig")
        _state["tabCategories"] = data.get("tabCategories", [])
        _state["noteAdapter"] = data.get("noteAdapter")
    except (json.JSONDecodeError, OSError) as e:
        logger.warning(f"config.json 损坏或读取失败 ({e}),回退到空状态")
        _state["modelConfig"] = None
        _state["tabCategories"] = []
        _state["noteAdapter"] = None


# ─────────────────────────────────────────────────────────────
# 私有:落盘
# ─────────────────────────────────────────────────────────────
def _persist() -> None:
    """把当前 _state 写回 config.json。调用方需已持有 _lock。"""
    with CONFIG_FILE.open("w", encoding="utf-8") as f:
        json.dump(_state, f, ensure_ascii=False, indent=2)


# ─────────────────────────────────────────────────────────────
# Getter
# ─────────────────────────────────────────────────────────────
def get_model_config() -> ModelConfig | None:
    """返回当前生效的 LLM 配置(供 /classify 和 /notes/summarize 使用)。"""
    data = _state.get("modelConfig")
    return ModelConfig(**data) if data else None


def get_tab_categories() -> list[TabCategory]:
    """返回当前用户自定义的标签分类列表(供 /classify 使用)。"""
    return [TabCategory(**c) for c in _state.get("tabCategories", [])]


def get_note_adapter() -> NoteAdapterConfig | None:
    """返回当前笔记适配器配置(供 /notes/* 路由使用)。"""
    data = _state.get("noteAdapter")
    return NoteAdapterConfig(**data) if data else None


# ─────────────────────────────────────────────────────────────
# 同步入口
# ─────────────────────────────────────────────────────────────
def sync_config(req: SyncConfigRequest) -> None:
    """
    合并式同步:前端每次只发它修改过的字段,未发送的字段保持后端原值。

    用 Pydantic 的 `model_fields_set` 区分"未传"vs"传了空"——
    前端不传某个字段时,即使 schema 有默认值也不会出现在 fields_set 里,后端就不覆盖。
    解决"保存 modelConfig 时把 tabCategories 清空"的 bug。
    """
    with _lock:
        sent = req.model_fields_set
        if "modelConfig" in sent:
            _state["modelConfig"] = req.modelConfig.model_dump() if req.modelConfig else None
        if "tabCategories" in sent:
            _state["tabCategories"] = [c.model_dump() for c in (req.tabCategories or [])]
        if "noteAdapter" in sent:
            _state["noteAdapter"] = req.noteAdapter.model_dump() if req.noteAdapter else None
        _persist()
