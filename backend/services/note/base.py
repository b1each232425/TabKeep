"""
笔记适配器抽象层。

按职能:
  1. 4 个 Pydantic 数据模型(NotebookInfo / DocNode / SaveRequest / SaveResult)
  2. NoteAdapter Protocol — 任何笔记系统(SiYuan / Local / Obsidian)都要实现这个接口

新加一个笔记系统的步骤:实现 NoteAdapter 的 3 个方法 + 在 factory.py 注册。
"""
from typing import Protocol

from pydantic import BaseModel

from schemas.config import NoteAdapterConfig


# ─────────────────────────────────────────────────────────────
# 数据模型
# ─────────────────────────────────────────────────────────────
class NotebookInfo(BaseModel):
    """笔记本信息(只暴露 id + name,不暴露路径 / 排序等内部字段)。"""
    id: str
    name: str


class DocNode(BaseModel):
    """思源笔记内的一个文档节点(容器文件夹 / 文档页)。

    children 递归,后端 list_docs 时把扁平列表按 path 拼成嵌套树。
    """
    id: str                          # 块 id(给 SiYuan insertBlock 用)
    name: str                        # 文档名(不含 .sy)
    path: str                        # 人类可读路径,显示用
    type: str                        # "Container" 文件夹 | "Page" 文档
    children: list["DocNode"] = []   # 递归子节点


class SaveRequest(BaseModel):
    """保存一条标签到笔记的请求体。"""
    title: str
    url: str
    excerpt: str | None = None        # 短摘要(给 SiYuan 当 alias)
    content: str | None = None       # markdown 正文(全文或 LLM 摘录都走这个字段)
    notebook_id: str                 # 必填,目标笔记本
    target_doc: str | None = None    # 目标文档 id;None = 在笔记本根新建 doc


class SaveResult(BaseModel):
    ok: bool
    note_id: str | None = None       # 成功时返回新建/追加的 doc id
    error: str | None = None


# ─────────────────────────────────────────────────────────────
# 适配器接口
# ─────────────────────────────────────────────────────────────
class NoteAdapter(Protocol):
    """所有笔记适配器必须实现的 3 个方法 + name 属性。"""
    name: str

    async def test_connection(self) -> tuple[bool, str | None]:
        """测试连通性,返回 (ok, 错误信息)。"""
        ...

    async def list_notebooks(self) -> list[NotebookInfo]:
        """列出所有笔记本。仅 SiYuan 真实返回,Local 返回占位。"""
        ...

    async def save(self, req: SaveRequest) -> SaveResult:
        """保存一条 tab 到笔记。target_doc 缺省 = 在 notebook 根新建 doc。"""
        ...
