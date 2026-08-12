"""
本地 Markdown 适配器(零依赖,纯文件系统)。

把每条收藏 append 到 backend/data/notes/ 下的某个 .md 文件:
  - 默认目标 inbox.md(自动建)
  - 收 _lock 串行化写,避免并发撕文件
"""
import threading

from logger import logger
from schemas.config import NoteAdapterConfig
from services import storage
from services.note.base import NotebookInfo, SaveRequest, SaveResult
from services.note.formatting import markdown_note

# 源码运行默认写到 backend/data/notes；正式版由 TABKEEP_DATA_DIR 定位。
DATA_DIR = storage.DATA_DIR / "notes"
_lock = threading.Lock()


def _ensure_dir() -> None:
    """确保 DATA_DIR 存在(可能在 init 前就被调用)。"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)


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
        """Local 只有一个“笔记本”(就是 DATA_DIR 本身),返回占位。"""
        return [NotebookInfo(id="local", name="本地 Markdown(data/notes/)")]

    async def save(self, req: SaveRequest) -> SaveResult:
        """
        把一条收藏 append 到 markdown 文件。
        - target_doc 是文件名(无 .md 后缀自动补);缺省走 inbox.md
        - 多条内容放在同一文件时不重复写 YAML frontmatter
        """
        _ensure_dir()
        target = req.target_doc or req.notebook_id or "inbox.md"
        if not target.endswith(".md"):
            target = f"{target}.md"
        path = DATA_DIR / target
        body = markdown_note(req.title, req.url, req.content, req.mode, include_frontmatter=False)
        try:
            with _lock:
                if not path.exists():
                    path.write_text("# TabKeep 收藏\n\n", encoding="utf-8")
                with path.open("a", encoding="utf-8") as f:
                    f.write("\n---\n\n")
                    f.write(body)
                    if not body.endswith("\n"):
                        f.write("\n")
            logger.info(f"local save ok: {path} chars={len(body)} mode={req.mode}")
            return SaveResult(ok=True, note_id=target)
        except OSError as e:
            logger.exception(f"local save 失败: {e}")
            return SaveResult(ok=False, error=f"本地 Markdown 写入失败:{e}")
