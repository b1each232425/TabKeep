import re

_CJK_RE = re.compile(r"([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])")
_TOKEN_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]|[A-Za-z0-9_][A-Za-z0-9_.:-]*")


def segment_for_fts(text: str) -> str:
    """给 SQLite FTS5 使用的轻量 CJK 预处理。"""
    return _CJK_RE.sub(r" \1 ", text or "")


def build_fts_query(query: str) -> str:
    tokens = _TOKEN_RE.findall(query or "")
    if not tokens:
        return ""
    return " ".join(f'"{token}"' for token in tokens[:24])

