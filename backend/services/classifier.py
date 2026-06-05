import json
import re

from logger import logger
from schemas.config import ModelConfig, TabCategory
from schemas.tab import TabData
from services.llm import chat_completion


def build_messages(categories: list[TabCategory], tabs: list[TabData]) -> list[dict[str, str]]:
    category_lines = "\n".join(
        f"- {c.name}" + (f"：{c.description}" if c.description else "")
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
                "你是一个浏览器标签页分类助手。给定一组分类（名称+可选描述）和一组标签页（id+标题+URL），"
                "请把每个标签页归到最符合的分类。\n"
                "严格输出 JSON 对象：key 是标签页的 id（数字），value 是分类名称（字符串）。"
                "若都不符合，value 用 \"未分类\"。只输出 JSON，不要其他文字。"
            ),
        },
        {
            "role": "user",
            "content": f"分类列表：\n{category_lines}\n\n标签页列表：\n{tab_lines}",
        },
    ]


_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)
_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)


def parse_classification(raw: str) -> dict[int, str]:
    cleaned = _THINK_RE.sub("", raw)
    cleaned = _FENCE_RE.sub("", cleaned).strip()
    try:
        obj = json.loads(cleaned)
    except json.JSONDecodeError as e:
        logger.exception(f"LLM 响应不是合法 JSON: {e}\n原始前 300 字: {raw[:300]}")
        raise
    if not isinstance(obj, dict):
        logger.error(f"LLM 响应不是 JSON 对象，而是 {type(obj).__name__}: {raw[:200]}")
        raise ValueError("LLM 响应不是 JSON 对象")
    return {int(k): str(v) for k, v in obj.items()}


async def classify_tabs(
    model_config: ModelConfig,
    categories: list[TabCategory],
    tabs: list[TabData],
) -> tuple[dict[int, str], str]:
    messages = build_messages(categories, tabs)
    raw = await chat_completion(model_config, messages)
    return parse_classification(raw), raw
