"""
本地 Markdown 适配器(零依赖,纯文件系统)。

把每条收藏 append 到 backend/data/notes/ 下的某个 .md 文件:
  - 默认目标 inbox.md(自动建)
  - 收 _lock 串行化写,避免并发撕文件

按职能:
  1. 路径常量 + 锁
  2. _ensure_dir 工具
  3. LocalFileAdapter 类
  4. _sanitize 字符串辅助
"""
import json
import threading
from datetime import date
from pathlib import Path

from logger import logger
from schemas.config import NoteAdapterConfig
from services.note.base import NotebookInfo, SaveRequest, SaveResult


# ─────────────────────────────────────────────────────────────
# 1. 路径 + 锁
# ─────────────────────────────────────────────────────────────
# 写到 backend/data/notes/,不存在会建
DATA_DIR = Path(__file__).parent.parent.parent / "data" / "notes"
# 并发写同一文件要串行化(append 模式 OS 自身也保证原子,但我们再加锁保险)
_lock = threading.Lock()


# ─────────────────────────────────────────────────────────────
# 2. 工具
# ─────────────────────────────────────────────────────────────
def _ensure_dir() -> None:
    """确保 DATA_DIR 存在(可能在 init 前就被调用)。"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)


# ─────────────────────────────────────────────────────────────
# 3. 适配器主体
# ─────────────────────────────────────────────────────────────
class LocalFileAdapter:
    name = "local"

    def __init__(self, config: NoteAdapterConfig) -> None:
        self.config = config
        logger.info(f"local adapter init: data_dir={DATA_DIR}")

    async def test_connection(self) -> tuple[bool, str | None]:
        """试着在 DATA_DIR 写一个临时文件再删,验证可写性。"""
        try:
            _ensure_dir()
            test_file = DATA_DIR / ".test"
            test_file.write_text("ok", encoding="utf-8")
            test_file.unlink()
            logger.info(f"local test ok: {DATA_DIR} 可写")
            return True, None
        except OSError as e:
            err = f"无法写入 {DATA_DIR}:{e}"
            logger.warning(f"local test fail: {err}")
            return False, err

    async def list_notebooks(self) -> list[NotebookInfo]:
        """Local 只有一个"笔记本"(就是 DATA_DIR 本身),返回占位。"""
        return [NotebookInfo(id="local", name="本地 Markdown(data/notes/)")]

    async def save(self, req: SaveRequest) -> SaveResult:
        """
        把一条收藏 append 到 markdown 文件。
        - 有 content:写 `- [title](url)\\n\\ncontent` 块
        - 无 content:只写一行链接
        - target_doc 是文件名(无 .md 后缀自动补);缺省走 inbox.md
        """
        _ensure_dir()
        link_line = f"- [{_sanitize(req.title)}]({req.url})\n"
        has_full = bool(req.content and req.content.strip())
        body = (link_line + "\n" + req.content) if has_full else link_line
        target = req.target_doc or req.notebook_id or "inbox.md"
        if not target.endswith(".md"):
            target = f"{target}.md"
        path = DATA_DIR / target
        try:
            with _lock:
                # 文件不存在就先建一个带表头的
                if not path.exists():
                    path.write_text("# TabKeep 收藏\n\n", encoding="utf-8")
                with path.open("a", encoding="utf-8") as f:
                    f.write(body)
                    if not body.endswith("\n"):
                        f.write("\n")
            logger.info(f"local save ok: {path} chars={len(body)} full={has_full}")
            return SaveResult(ok=True, note_id=target)
        except OSError as e:
            logger.exception(f"local save 失败: {e}")
            return SaveResult(ok=False, error=str(e))


# ─────────────────────────────────────────────────────────────
# 4. 字符串辅助
# ─────────────────────────────────────────────────────────────
def _sanitize(text: str) -> str:
    """去掉 markdown 链接语法冲突字符(`[`/`]`/`\\n`),保证链接行不破。"""
    return text.replace("[", "").replace("]", "").replace("\n", " ").strip() or "(无标题)"
