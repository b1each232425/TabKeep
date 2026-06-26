import re
from dataclasses import dataclass

DEFAULT_PARAGRAPH_CHARS = 3200
DEFAULT_CHUNK_CHARS = 1200
DEFAULT_OVERLAP_CHARS = 160
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")


@dataclass(frozen=True)
class TextParagraph:
    title: str
    content: str


def chunk_text(
    text: str,
    chunk_chars: int = DEFAULT_CHUNK_CHARS,
    overlap_chars: int = DEFAULT_OVERLAP_CHARS,
) -> list[str]:
    """把 Markdown 文本切成带少量重叠的块，尽量在段落边界切开。"""
    cleaned = normalize_text(text)
    if not cleaned:
        return []
    if len(cleaned) <= chunk_chars:
        return [cleaned]

    chunks: list[str] = []
    start = 0
    while start < len(cleaned):
        hard_end = min(start + chunk_chars, len(cleaned))
        end = _best_break(cleaned, start, hard_end)
        part = cleaned[start:end].strip()
        if part:
            chunks.append(part)
        if end >= len(cleaned):
            break
        start = max(0, end - overlap_chars)
    return chunks


def split_paragraphs(
    text: str,
    default_title: str = "未命名文档",
    max_chars: int = DEFAULT_PARAGRAPH_CHARS,
) -> list[TextParagraph]:
    """先切出用户可读段落，再交给 chunk_text 做检索粒度切块。"""
    cleaned = normalize_text(text)
    if not cleaned:
        return []

    fallback_title = (default_title.strip() or "未命名文档")[:120]
    sections = _split_markdown_sections(cleaned, fallback_title)
    if not sections:
        sections = _split_plain_sections(cleaned, fallback_title, max_chars)

    paragraphs: list[TextParagraph] = []
    for section in sections:
        parts = (
            chunk_text(section.content, chunk_chars=max_chars, overlap_chars=0)
            if len(section.content) > max_chars
            else [section.content]
        )
        for index, part in enumerate(parts):
            content = part.strip()
            if not content:
                continue
            title = section.title
            if len(parts) > 1:
                title = f"{title} · {index + 1}"
            paragraphs.append(TextParagraph(title=title[:180], content=content))
    return paragraphs


def normalize_text(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"\n{4,}", "\n\n\n", text)
    return text.strip()


def guess_title(path_name: str, content: str) -> str:
    """优先取第一个 H1/H2，否则用文件名。"""
    for line in content.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            title = stripped.lstrip("#").strip()
            if title:
                return title[:120]
    return path_name[:120] or "未命名文档"


def _split_markdown_sections(text: str, default_title: str) -> list[TextParagraph]:
    sections: list[TextParagraph] = []
    current_lines: list[str] = []
    current_title = default_title
    heading_stack: list[str] = []
    seen_heading = False

    def flush() -> None:
        nonlocal current_lines
        content = "\n".join(current_lines).strip()
        if content:
            sections.append(TextParagraph(title=current_title, content=content))
        current_lines = []

    for line in text.splitlines():
        match = _HEADING_RE.match(line.strip())
        if match:
            if current_lines:
                flush()
            seen_heading = True
            level = len(match.group(1))
            heading = match.group(2).strip().strip("#").strip() or default_title
            heading_stack = heading_stack[: level - 1]
            while len(heading_stack) < level - 1:
                heading_stack.append("")
            heading_stack.append(heading)
            current_title = " / ".join(part for part in heading_stack if part).strip() or heading
            current_lines = [line]
        else:
            current_lines.append(line)

    if current_lines:
        flush()
    return sections if seen_heading else []


def _split_plain_sections(
    text: str,
    default_title: str,
    max_chars: int,
) -> list[TextParagraph]:
    blocks = [block.strip() for block in re.split(r"\n\s*\n", text) if block.strip()]
    if not blocks:
        return [TextParagraph(title=default_title, content=text)]

    sections: list[TextParagraph] = []
    current: list[str] = []
    current_len = 0

    def flush() -> None:
        nonlocal current, current_len
        if current:
            sections.append(TextParagraph(title=default_title, content="\n\n".join(current).strip()))
        current = []
        current_len = 0

    for block in blocks:
        if len(block) > max_chars:
            flush()
            for part in chunk_text(block, chunk_chars=max_chars, overlap_chars=0):
                sections.append(TextParagraph(title=default_title, content=part))
            continue

        next_len = len(block) + (2 if current else 0)
        if current and current_len + next_len > max_chars:
            flush()
        current.append(block)
        current_len += next_len

    flush()
    return sections


def _best_break(text: str, start: int, hard_end: int) -> int:
    window = text[start:hard_end]
    for marker in ("\n\n", "\n# ", "\n## ", "。", ".", "！", "？", "!", "?"):
        idx = window.rfind(marker)
        if idx > chunk_chars_floor(len(window)):
            return start + idx + len(marker)
    return hard_end


def chunk_chars_floor(length: int) -> int:
    return max(200, int(length * 0.58))
