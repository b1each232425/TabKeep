import re

DEFAULT_CHUNK_CHARS = 1200
DEFAULT_OVERLAP_CHARS = 160


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


def _best_break(text: str, start: int, hard_end: int) -> int:
    window = text[start:hard_end]
    for marker in ("\n\n", "\n# ", "\n## ", "。", ".", "！", "？", "!", "?"):
        idx = window.rfind(marker)
        if idx > chunk_chars_floor(len(window)):
            return start + idx + len(marker)
    return hard_end


def chunk_chars_floor(length: int) -> int:
    return max(200, int(length * 0.58))

