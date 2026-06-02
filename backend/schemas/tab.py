from pydantic import BaseModel


# Tab 数据模型
class TabData(BaseModel):
    id: int
    title: str
    url: str
    favIconUrl: str | None = None
    active: bool = False
    pinned: bool = False