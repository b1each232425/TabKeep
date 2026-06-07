"""
标签页分类 prompt 构造 + 响应解析。

按职能三段:
  1. build_messages()        — 拼 system / user 两条消息
  2. parse_classification()  — 解析 LLM 返回的 JSON
  3. classify_tabs()         — 顶层入口:build → chat → parse 串起来
"""
import json
import re

from logger import logger
from schemas.config import ModelConfig, TabCategory
from schemas.tab import TabData
from services.llm import chat_completion


# ─────────────────────────────────────────────────────────────
# 1. Prompt 构造
# ─────────────────────────────────────────────────────────────
def build_messages(categories: list[TabCategory], tabs: list[TabData]) -> list[dict[str, str]]:
    """
    拼 system + user 两条消息。
    - system:告诉模型只输出 JSON 对象(不要其他文字)
    - user:列出所有分类和所有待分类标签
    """
    category_lines = "\n".join(
        f"- {c.name}" + (f":{c.description}" if c.description else "")
        for c in categories
    )
    tab_lines = "\n".join(
        f"[{i}] id={t.id}, title={t.title or '(无标题)'}, url={t.url}"
        for i, t in enumerate(tabs)
    )
    return [
        {
            "role": "system",
            "content": (
                "你是一个浏览器标签页分类助手。给定一组分类(名称+可选描述)和一组标签页(id+标题+URL),"
                "请把每个标签页归到最符合的分类。\n"
                '严格输出 JSON 对象:key 是标签页的 id(数字),value 是分类名称(字符串)。'
                '若都不符合,value 用 "未分类"。只输出 JSON,不要其他文字。'
            ),
        },
        {
            "role": "user",
            "content": f"分类列表:\n{category_lines}\n\n标签页列表:\n{tab_lines}",
        },
    ]


# ─────────────────────────────────────────────────────────────
# 2. 响应解析
# ─────────────────────────────────────────────────────────────
# 清洗用的两个正则:
# - 去 <think>...</think> 块(thinking 模式产物,不是用户想要的答案)
# - 去 ```json ... ``` 这种 markdown code fence(防止 LLM 把 JSON 包起来)
_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)
_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)


def parse_classification(raw: str) -> dict[int, str]:
    """
    把 LLM 原始响应清洗 + 解析成 {tab_id(int): category_name(str)}。
    出错时 raise(调用方 /classify 会 catch 并返回 error 字段)。
    """
    cleaned = _THINK_RE.sub("", raw)
    cleaned = _FENCE_RE.sub("", cleaned).strip()
    try:
        obj = json.loads(cleaned)
    except json.JSONDecodeError as e:
        logger.exception(f"LLM 响应不是合法 JSON: {e}\n原始前 300 字: {raw[:300]}")
        raise
    if not isinstance(obj, dict):
        logger.error(f"LLM 响应不是 JSON 对象,而是 {type(obj).__name__}: {raw[:200]}")
        raise ValueError("LLM 响应不是 JSON 对象")
    # key 转 int(LLM 可能返回字符串 key),value 转 str
    return {int(k): str(v) for k, v in obj.items()}


# ─────────────────────────────────────────────────────────────
# 3. 顶层入口
# ─────────────────────────────────────────────────────────────
async def classify_tabs(
    model_config: ModelConfig,
    categories: list[TabCategory],
    tabs: list[TabData],
) -> tuple[dict[int, str], str]:
    """
    端到端跑一次分类:
    1. 构造 prompt
    2. 调 LLM
    3. 解析响应
    返回 (分类结果, LLM 原始响应 raw)。raw 一并返回方便前端 debug。
    """
    messages = build_messages(categories, tabs)
    raw = await chat_completion(model_config, messages)
    return parse_classification(raw), raw
