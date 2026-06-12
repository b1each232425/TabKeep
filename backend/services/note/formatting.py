"""
笔记输出格式工具。

所有 adapter 尽量复用同一套 Markdown 结构,方便用户之后从不同笔记软件迁移。
"""
from datetime import datetime
import re


def now_iso() -> str:
    """返回本地时区 ISO 时间,精确到秒。"""
    return datetime.now().astimezone().isoformat(timespec="seconds")


def markdown_note(
    title: str,
    url: str,
    content: str | None,
    mode: str,
    include_frontmatter: bool = True,
) -> str:
    """生成统一 Markdown 笔记内容。"""
    safe_title = title.strip() or "无标题"
    saved_at = now_iso()
    body = (content or "").strip()
    if not body:
        body = f"- [{_escape_link_text(safe_title)}]({url})"

    frontmatter = ""
    if include_frontmatter:
        frontmatter = (
            "---\n"
            "source: tabkeep\n"
            f"title: {_yaml_string(safe_title)}\n"
            f"url: {_yaml_string(url)}\n"
            f"saved_at: {_yaml_string(saved_at)}\n"
            f"mode: {_yaml_string(mode or 'link')}\n"
            "---\n\n"
        )

    return (
        f"{frontmatter}"
        f"# {safe_title}\n\n"
        f"- 来源：{url}\n"
        f"- 收藏时间：{saved_at}\n\n"
        "---\n\n"
        f"{body}\n"
    )


def safe_filename(title: str, fallback: str = "tabkeep") -> str:
    """把标题转换成适合 Windows/macOS 文件名的短名称,保留中文。"""
    raw = (title or fallback).strip()
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", raw)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" .")
    return (cleaned or fallback)[:80]


def _yaml_string(value: str) -> str:
    cleaned = value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")
    return f'"{cleaned}"'


def _escape_link_text(value: str) -> str:
    return value.replace("[", "").replace("]", "").replace("\n", " ").strip() or "无标题"
