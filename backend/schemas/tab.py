"""
Pydantic 数据模型 — 标签页。

整个后端只此一个 Tab 模型,出现在:
- POST /tabs 请求体(extension 推送标签数据)
- /classify 请求体里的 tabs 字段
- 响应里 echo 回去
"""
from pydantic import BaseModel


class TabData(BaseModel):
    """单个浏览器标签页的元数据。"""
    id: int                          # Chrome tabs API 分配的 tab id(主键)
    title: str                       # 页面 title
    url: str                         # 完整 URL
    favIconUrl: str | None = None    # 站点 favicon
    active: bool = False             # 是否当前激活 tab
    pinned: bool = False             # 是否固定在标签栏