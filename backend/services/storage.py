import json
import os
import threading
from pathlib import Path

from logger import logger
from schemas.config import ModelConfig, SyncConfigRequest, TabCategory

DATA_DIR = Path(__file__).parent / "data"
CONFIG_FILE = DATA_DIR / "config.json"

_lock = threading.Lock()
_state: dict = {"modelConfig": None, "tabCategories": []}


def init() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not CONFIG_FILE.exists():
        return
    try:
        with CONFIG_FILE.open("r", encoding="utf-8") as f:
            data = json.load(f)
        _state["modelConfig"] = data.get("modelConfig")
        _state["tabCategories"] = data.get("tabCategories", [])
    except (json.JSONDecodeError, OSError) as e:
        logger.warning(f"config.json 损坏或读取失败 ({e})，回退到空状态")
        _state["modelConfig"] = None
        _state["tabCategories"] = []


def _persist() -> None:
    with CONFIG_FILE.open("w", encoding="utf-8") as f:
        json.dump(_state, f, ensure_ascii=False, indent=2)


def get_model_config() -> ModelConfig | None:
    data = _state.get("modelConfig")
    return ModelConfig(**data) if data else None


def get_tab_categories() -> list[TabCategory]:
    return [TabCategory(**c) for c in _state.get("tabCategories", [])]


def sync_config(req: SyncConfigRequest) -> None:
    with _lock:
        if req.modelConfig is not None:
            _state["modelConfig"] = req.modelConfig.model_dump()
        _state["tabCategories"] = [c.model_dump() for c in req.tabCategories]
        _persist()
