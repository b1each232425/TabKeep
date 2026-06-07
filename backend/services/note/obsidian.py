"""
Obsidian 适配器(占位 stub,尚未实现)。

留接口形状让前端 /notes/adapters 能列出来,但所有方法都返回"未实现"。
后续接入 Obsidian 时,仿照 siyuan.py 实现 test_connection / list_notebooks / save 即可。
"""
from schemas.config import NoteAdapterConfig
from services.note.base import NotebookInfo, SaveRequest, SaveResult

_NOT_IMPLEMENTED = "obsidian 适配器尚未实现(占位 stub)"


class ObsidianAdapter:
    name = "obsidian"

    def __init__(self, config: NoteAdapterConfig) -> None:
        self.config = config
        logger.info("obsidian adapter init (stub)")

    async def test_connection(self) -> tuple[bool, str | None]:
        err = _NOT_IMPLEMENTED
        logger.warning(f"obsidian test fail: {err}")
        return False, err

    async def list_notebooks(self) -> list[NotebookInfo]:
        raise NotImplementedError(_NOT_IMPLEMENTED)

    async def save(self, req: SaveRequest) -> SaveResult:
        raise NotImplementedError(_NOT_IMPLEMENTED)
