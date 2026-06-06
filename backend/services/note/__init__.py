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
