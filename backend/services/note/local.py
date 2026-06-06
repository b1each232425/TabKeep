import json
import threading
from datetime import date
from pathlib import Path

from logger import logger
from schemas.config import NoteAdapterConfig
from services.note.base import NotebookInfo, SaveRequest, SaveResult


DATA_DIR = Path(__file__).parent.parent.parent / "data" / "notes"
_lock = threading.Lock()


def _ensure_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)


class LocalFileAdapter:
    name = "local"

    def __init__(self, config: NoteAdapterConfig) -> None:
        self.config = config
        logger.info(f"local adapter init: data_dir={DATA_DIR}")

    async def test_connection(self) -> tuple[bool, str | None]:
        try:
            _ensure_dir()
            test_file = DATA_DIR / ".test"
            test_file.write_text("ok", encoding="utf-8")
            test_file.unlink()
            logger.info(f"local test ok: {DATA_DIR} 可写")
            return True, None
        except OSError as e:
            err = f"无法写入 {DATA_DIR}: {e}"
            logger.warning(f"local test fail: {err}")
            return False, err

    async def list_notebooks(self) -> list[NotebookInfo]:
        return [NotebookInfo(id="local", name="本地 Markdown（data/notes/）")]

    async def save(self, req: SaveRequest) -> SaveResult:
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


def _sanitize(text: str) -> str:
    return text.replace("[", "").replace("]", "").replace("\n", " ").strip() or "(无标题)"
