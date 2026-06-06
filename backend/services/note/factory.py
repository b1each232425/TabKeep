from logger import logger
from schemas.config import NoteAdapterConfig
from services.note.base import NoteAdapter
from services.note.local import LocalFileAdapter
from services.note.obsidian import ObsidianAdapter
from services.note.siyuan import SiYuanAdapter


def build_note_adapter(config: NoteAdapterConfig) -> NoteAdapter:
    provider = (config.provider or "").lower()
    if provider == "siyuan":
        return SiYuanAdapter(config)
    if provider == "obsidian":
        return ObsidianAdapter(config)
    if provider == "local":
        return LocalFileAdapter(config)
    logger.warning(f"未知 noteAdapter provider: {config.provider!r}，回退到 local")
    return LocalFileAdapter(config)
