import re

from loguru import logger

from schemas.config import ModelConfig
from services.llm import chat_completion

MAX_INPUT_CHARS = 16_000

_FENCE_RE = re.compile(r"^```(?:markdown|md)?\s*|\s*```$", re.MULTILINE)
_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)


def build_messages(title: str, url: str, content: str) -> list[dict[str, str]]:
    truncated = content[:MAX_INPUT_CHARS]
    note = "\n\n(注: 内容超过 16K 字符已截断)" if len(content) > MAX_INPUT_CHARS else ""
    return [
        {
            "role": "system",
            "content": (
                "你是一个中文网页重点摘录助手。给定网页标题、URL 和正文 markdown, "
                "你的任务是**把文章中所有值得回看的关键信息原文抄录到用户笔记**——"
                "不是简化 / 概括 / 综述,而是**大段大段保留原文**让用户日后回看能直接读到核心信息。\n\n"
                "严格遵循以下结构输出纯 markdown:\n\n"
                "## 重点摘录\n"
                "按文章原文章节顺序,把**所有你认为包含关键信息的段落 / 句子 / 列表 / 数据**全部直接抄录,"
                "每段用 blockquote `> ...` 包裹(可跨行)。\n"
                "**不要省略任何你认为关键的内容**——金句 / 数据 / 论证 / 步骤 / 例子 / 反直觉结论全部都要保留,字数不限,几段都行,文章里有 10 段关键就抄 10 段。\n"
                "挑选标准: 核心观点 / 反直觉结论 / 关键数据 / 论证依据 / 步骤 / 例子 / 表格 / 代码 / 值得回看的金句。\n\n"
                "## 关键要点\n"
                "- 3-5 条要点列表,每条 < 80 字,提炼自上方的摘录\n\n"
                "## 配图\n"
                "从正文中出现的 `![alt](url)` 图片里挑出 3-5 张**最有信息量 / 最能代表文章内容**的图片,直接用 `![alt](url)` 格式保留下来。"
                "如果正文没有图片或图片明显是广告 / icon / 占位图,这一节输出 `> (无有意义的配图)`。\n\n"
                "要求:\n"
                "- 直接输出 markdown, 不要 ```markdown code fence``` 包裹\n"
                "- 不要任何开场白 (如 '这是摘录...'), 直接从 ## 重点摘录 开始\n"
                "- 引用用 `> ...` blockquote, 严格保留原文(可微调标点 / 去多余换行)\n"
                "- **绝对不要**用你自己的话重写 / 概述 / 点评引用段, 用户要的是原文\n"
                "- 链接 / 章节标题里的 URL 不用保留(用户已有原网页)\n"
                "- 关键数据 / 数字 / 专有名词 务必保留\n"
            ),
        },
        {
            "role": "user",
            "content": f"标题: {title}\nURL: {url}\n\n正文 markdown:\n{truncated}{note}",
        },
    ]


def parse_summary_markdown(raw: str) -> str:
    """清洗 LLM 响应, 提取纯 markdown 摘要。"""
    cleaned = _THINK_RE.sub("", raw)
    cleaned = _FENCE_RE.sub("", cleaned).strip()
    return cleaned


async def summarize_content(
    cfg: ModelConfig, title: str, url: str, content: str
) -> tuple[str, str]:
    """返回 (cleaned_markdown, raw_response)。"""
    raw = await chat_completion(cfg, build_messages(title, url, content))
    md = parse_summary_markdown(raw)
    logger.info(f"摘要生成 ok title={title!r} md_chars={len(md)}")
    return md, raw
