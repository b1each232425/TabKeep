"""
网页重点摘录:用 LLM 把网页正文转成结构化学习笔记。

按职能三段:
  1. build_messages()        — 要求 LLM 输出 JSON
  2. parse_summary_markdown  — 清洗 / 解析 JSON,再稳定渲染 markdown
  3. summarize_content()     — 顶层入口,返回 (cleaned_markdown, raw)

设计取舍:
  - LLM 只负责抽取结构化字段,后端统一渲染 markdown,减少格式漂移
  - prompt 固定生成"解决什么 / 可回看摘要 / 原文摘录 / 可复用点 / 复习问题 / 配图"
  - 16K 字符上限:超过部分截断 + 末尾加注记;平衡 token 数和保留信息
  - 原文摘录仍用 blockquote 保存,让用户日后回看能看到证据
"""
import json
import re

from loguru import logger
from pydantic import BaseModel, Field, ValidationError, field_validator

from schemas.config import ModelConfig
from services.llm import chat_completion

# 16K 字符 ≈ 8K token,适合主流模型;再大会爆 token
MAX_INPUT_CHARS = 16_000
PLACEHOLDER_IMAGE = "> (无有意义的配图)"


class StructuredSummary(BaseModel):
    """LLM 输出的网页摘录结构。"""

    problem: str = Field(min_length=1)
    summary: str = Field(min_length=1)
    key_excerpts: list[str] = []
    reusable_points: list[str] = []
    review_questions: list[str] = []
    images: list[str] = []

    @field_validator("problem", "summary")
    @classmethod
    def clean_required_text(cls, value: str) -> str:
        cleaned = _clean_text(value)
        if not cleaned:
            raise ValueError("字段不能为空")
        return cleaned

    @field_validator("key_excerpts", "reusable_points", "review_questions", "images", mode="before")
    @classmethod
    def normalize_string_list(cls, value: object) -> list[str]:
        if value is None:
            return []
        if isinstance(value, str):
            return [_clean_text(value)] if _clean_text(value) else []
        if not isinstance(value, list):
            return []
        cleaned: list[str] = []
        for item in value:
            text = _clean_text(str(item))
            if text:
                cleaned.append(text)
        return cleaned


# ─────────────────────────────────────────────────────────────
# 1. Prompt 构造
# ─────────────────────────────────────────────────────────────
def build_messages(title: str, url: str, content: str) -> list[dict[str, str]]:
    """
    拼 system + user 两条消息。content 超 MAX_INPUT_CHARS 会截断并加注记。
    """
    truncated = content[:MAX_INPUT_CHARS]
    note = "\n\n(注: 内容超过 16K 字符已截断)" if len(content) > MAX_INPUT_CHARS else ""
    return [
        {
            "role": "system",
            "content": (
                "你是 TabKeep 的中文网页精读摘录助手。给定网页标题、URL 和正文 markdown, "
                "请把它整理成以后可复习、可检索、可复用的学习笔记素材。\n\n"
                "只输出一个 JSON object,不要 markdown code fence,不要解释文字。JSON 字段必须为:\n"
                "{\n"
                '  "problem": "这篇文章主要解决什么问题,1-3 句话",\n'
                '  "summary": "可回看的摘要,保留关键背景、方案、结论和限制",\n'
                '  "key_excerpts": ["值得保留的原文摘录,按原文顺序,尽量保留数字/术语/代码/结论"],\n'
                '  "reusable_points": ["以后可以怎么用这篇文章,每条一个可复用点"],\n'
                '  "review_questions": ["复习或追问问题,3-6 条,问题本身要可被搜索召回"],\n'
                '  "images": ["从正文中挑选的信息量图片 markdown,例如 ![alt](url)"]\n'
                "}\n\n"
                "要求:\n"
                "- 必须是合法 JSON,不要输出 ```json code fence```\n"
                "- 来源链接必须保留用户提供的原始 URL\n"
                "- key_excerpts 必须尽量使用原文,不要改写成评论\n"
                "- 技术文章要优先保留问题背景、方案、代码、命令、配置、错误信息、适用场景和坑点\n"
                "- 观点文章要优先保留论点、论据、反例、关键数据和结论\n"
                "- review_questions 要便于以后搜索,避免空泛问题\n"
                "- 没有有意义的图片时 images 输出 []\n"
            ),
        },
        {
            "role": "user",
            "content": f"标题: {title}\nURL: {url}\n\n正文 markdown:\n{truncated}{note}",
        },
    ]


# ─────────────────────────────────────────────────────────────
# 2. 响应解析
# ─────────────────────────────────────────────────────────────
# 清洗:和 classifier.py 共享同一思路(去 <think> 块和 ``` 围栏)
_OPENING_FENCE_RE = re.compile(r"^\s*```(?:json|markdown|md)?\s*", re.IGNORECASE)
_CLOSING_FENCE_RE = re.compile(r"\s*```\s*$")
_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)


def parse_summary_markdown(raw: str) -> str:
    """
    清洗 LLM 响应:去除 <think> 思考块 + code fence,解析 JSON 后返回 markdown。
    """
    summary = parse_structured_summary(raw)
    return render_summary_markdown(summary)


def parse_structured_summary(raw: str) -> StructuredSummary:
    """把 LLM JSON 输出解析成结构化摘要。"""
    cleaned = clean_llm_json(raw)
    if not cleaned:
        raise ValueError("LLM 返回为空,可以改为保存全文")
    try:
        payload = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        raise ValueError(f"LLM 返回不是合法 JSON: {exc.msg}") from exc
    if not isinstance(payload, dict):
        raise ValueError("LLM 返回 JSON 必须是 object")
    try:
        return StructuredSummary.model_validate(payload)
    except ValidationError as exc:
        raise ValueError(f"LLM 返回缺少必要摘要字段: {exc}") from exc


def clean_llm_json(raw: str) -> str:
    """清洗模型输出,兼容 <think> 和 json fence。"""
    cleaned = _THINK_RE.sub("", raw or "").strip()
    cleaned = _OPENING_FENCE_RE.sub("", cleaned)
    cleaned = _CLOSING_FENCE_RE.sub("", cleaned).strip()
    if cleaned.startswith("{") and cleaned.endswith("}"):
        return cleaned
    match = re.search(r"\{.*\}", cleaned, flags=re.DOTALL)
    return match.group(0).strip() if match else cleaned


def render_summary_markdown(summary: StructuredSummary) -> str:
    """把结构化摘要稳定渲染为用户笔记 markdown。"""
    sections = [
        ("## 这篇解决什么", summary.problem),
        ("## 可回看摘要", summary.summary),
        ("## 关键原文摘录", _render_blockquotes(summary.key_excerpts, "未提取到关键原文摘录")),
        ("## 以后可复用点", _render_list(summary.reusable_points, "未提取到可复用点")),
        ("## 复习问题", _render_list(summary.review_questions, "未生成复习问题")),
        ("## 配图", "\n".join(summary.images) if summary.images else PLACEHOLDER_IMAGE),
    ]
    return "\n\n".join(f"{title}\n\n{body.strip()}" for title, body in sections).strip()


def _render_list(items: list[str], empty_text: str) -> str:
    if not items:
        return f"> ({empty_text})"
    return "\n".join(f"- {item}" for item in items)


def _render_blockquotes(items: list[str], empty_text: str) -> str:
    if not items:
        return f"> ({empty_text})"
    return "\n\n".join(_blockquote(item) for item in items)


def _blockquote(value: str) -> str:
    lines = value.splitlines() or [value]
    return "\n".join(f"> {line.strip()}" if line.strip() else ">" for line in lines)


def _clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


# ─────────────────────────────────────────────────────────────
# 3. 顶层入口
# ─────────────────────────────────────────────────────────────
async def summarize_content(
    cfg: ModelConfig, title: str, url: str, content: str
) -> tuple[str, str]:
    """
    端到端跑一次摘录:
    1. 构造 prompt
    2. 调 LLM
    3. 清洗 / 解析 / 渲染输出
    返回 (cleaned_markdown, raw_response)。
    """
    raw = await chat_completion(cfg, build_messages(title, url, content))
    md = parse_summary_markdown(raw)
    logger.info(f"摘要生成 ok title={title!r} md_chars={len(md)}")
    return md, raw
