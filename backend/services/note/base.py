from typing import Protocol

from pydantic import BaseModel

from schemas.config import NoteAdapterConfig


class NotebookInfo(BaseModel):
    id: str
    name: str


class SaveRequest(BaseModel):
    title: str
    url: str
    excerpt: str | None = None
    content: str | None = None
    notebook_id: str
    target_doc: str | None = None


class SaveResult(BaseModel):
    ok: bool
    note_id: str | None = None
    error: str | None = None


class NoteAdapter(Protocol):
    name: str

    async def test_connection(self) -> tuple[bool, str | None]: ...
    async def list_notebooks(self) -> list[NotebookInfo]: ...
    async def save(self, req: SaveRequest) -> SaveResult: ...
