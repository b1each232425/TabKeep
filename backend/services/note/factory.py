"""
笔记适配器工厂:根据 NoteAdapterConfig.provider 选具体实现。

新加一个 provider:在这里加一个 if 分支。
未知 provider 兜底返回 LocalFileAdapter(避免崩溃)。
"""
from logger import logger
from schemas.config import NoteAdapterConfig
from services.note.base import NoteAdapter
from services.note.local import LocalFileAdapter
from services.note.obsidian import ObsidianAdapter
from services.note.siyuan import SiYuanAdapter


def build_note_adapter(config: NoteAdapterConfig) -> NoteAdapter:
    """根据 config.provider 字符串选适配器实例,大小写不敏感。"""
    provider = (config.provider or "").lower()
    if provider == "siyuan":
        return SiYuanAdapter(config)
    if provider == "obsidian":
        return ObsidianAdapter(config)
    if provider == "local":
        return LocalFileAdapter(config)
    logger.warning(f"未知 noteAdapter provider: {config.provider!r},回退到 local")
    return LocalFileAdapter(config)
