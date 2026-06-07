"""
笔记适配器模块的对外门面。

上层 (routers/notes.py) 只 `from services.note import build_note_adapter` 就能拿到,
不用关心具体哪个 provider 走哪个文件。
"""
from services.note.base import (
    NoteAdapter,
    NotebookInfo,
    SaveRequest,
    SaveResult,
)
from services.note.factory import build_note_adapter

__all__ = [
    "NoteAdapter",
    "NotebookInfo",
    "SaveRequest",
    "SaveResult",
    "build_note_adapter",
]
