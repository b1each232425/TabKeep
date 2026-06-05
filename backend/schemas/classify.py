from pydantic import BaseModel
from schemas.tab import TabData


class ClassifyRequest(BaseModel):
    tabs: list[TabData]


class ClassifyResponse(BaseModel):
    result: dict[int, str] = {}
    raw: str | None = None
    error: str | None = None
