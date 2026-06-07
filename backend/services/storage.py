import json
import os
import threading
from pathlib import Path

from logger import logger
from schemas.config import ModelConfig, NoteAdapterConfig, SyncConfigRequest, TabCategory

DATA_DIR = Path(__file__).parent.parent / "data"
CONFIG_FILE = DATA_DIR / "config.json"

_lock = threading.Lock()
_state: dict = {"modelConfig": None, "tabCategories": [], "noteAdapter": None}


def init() -> None:
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
        logger.warning(f"config.json 损坏或读取失败 ({e})，回退到空状态")
        _state["modelConfig"] = None
        _state["tabCategories"] = []
        _state["noteAdapter"] = None


def _persist() -> None:
    with CONFIG_FILE.open("w", encoding="utf-8") as f:
        json.dump(_state, f, ensure_ascii=False, indent=2)


def get_model_config() -> ModelConfig | None:
    data = _state.get("modelConfig")
    return ModelConfig(**data) if data else None


def get_tab_categories() -> list[TabCategory]:
    return [TabCategory(**c) for c in _state.get("tabCategories", [])]


def get_note_adapter() -> NoteAdapterConfig | None:
    data = _state.get("noteAdapter")
    return NoteAdapterConfig(**data) if data else None


def sync_config(req: SyncConfigRequest) -> None:
    """合并式同步：前端每次只发它修改过的字段,未发送的字段保持后端原值。

    用 Pydantic 的 `model_fields_set` 区分"未传"和"传了空"——前端不传某个字段
    时,即使 schema 有默认值也不会出现在 fields_set 里,后端就不覆盖。
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
