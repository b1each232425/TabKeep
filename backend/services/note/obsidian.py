from schemas.config import NoteAdapterConfig
from services.note.base import NotebookInfo, SaveRequest, SaveResult

_NOT_IMPLEMENTED = "obsidian 适配器尚未实现（占位 stub）"


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
