"""
Pydantic 数据模型 — /classify 请求 / 响应。

ClassifyRequest:  携带一组待分类的 tab
ClassifyResponse: result 是 {tabId: category} 映射,raw 是 LLM 原始响应(前端 debug 用)
                  error 字段非空时表示失败(此时 result 为空 dict)
"""
from pydantic import BaseModel
from schemas.tab import TabData


class ClassifyRequest(BaseModel):
    tabs: list[TabData]


class ClassifyResponse(BaseModel):
    result: dict[int, str] = {}      # tabId(int) → 分类名(str)
    raw: str | None = None           # LLM 原始响应,前端 console.log 看
    error: str | None = None         # 失败时填错误信息
