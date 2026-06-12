"""
Obsidian / Markdown 文件夹适配器。

不依赖 Obsidian 插件,直接把收藏写成 Markdown 文件。这样同一套输出也能给
Logseq、VS Code、Typora、Git 仓库等普通 Markdown 工作流使用。
"""
import threading
from pathlib import Path

from logger import logger
from schemas.config import NoteAdapterConfig
from services.note.base import DocNode, NotebookInfo, SaveRequest, SaveResult
from services.note.formatting import markdown_note, safe_filename

_lock = threading.Lock()


class ObsidianAdapter:
    name = "obsidian"

    def __init__(self, config: NoteAdapterConfig) -> None:
        self.config = config
        self.vault = Path(config.vault).expanduser() if config.vault else None
        self.default_folder = (config.defaultFolder or "TabKeep Inbox").strip() or "TabKeep Inbox"
        self.write_mode = config.writeMode or "new_file"
        logger.info(
            f"obsidian adapter init vault={self.vault} defaultFolder={self.default_folder!r} "
            f"writeMode={self.write_mode}"
        )

    async def test_connection(self) -> tuple[bool, str | None]:
        """验证 vault 路径存在且默认目录可写。"""
        if not self.vault:
            return False, "请先填写 Obsidian vault 或 Markdown 文件夹路径"
        try:
            self.vault.mkdir(parents=True, exist_ok=True)
            if not self.vault.is_dir():
                return False, f"路径不是文件夹:{self.vault}"
            folder = self._default_dir()
            folder.mkdir(parents=True, exist_ok=True)
            test_file = folder / ".tabkeep-test"
            test_file.write_text("ok", encoding="utf-8")
            test_file.unlink()
            return True, None
        except OSError as e:
            logger.exception(f"obsidian test fail: {e}")
            return False, f"无法写入 Markdown 文件夹:{e}"

    async def list_notebooks(self) -> list[NotebookInfo]:
        """Obsidian 模式把整个 vault 当成一个 notebook。"""
        if not self.vault:
            return []
        return [NotebookInfo(id="obsidian", name=f"Obsidian Vault: {self.vault}")]

    async def list_docs(self, _notebook_id: str) -> list[DocNode]:
        """列出默认目录下已有 Markdown 文件,供弹窗选择追加目标。"""
        if not self.vault:
            return []
        base = self._default_dir()
        if not base.exists():
            return []
        return self._build_tree(base)

    async def save(self, req: SaveRequest) -> SaveResult:
        if not self.vault:
            return SaveResult(ok=False, error="请先配置 Obsidian vault 或 Markdown 文件夹路径")
        try:
            self.vault.mkdir(parents=True, exist_ok=True)
            if req.target_doc:
                path = self._resolve_target(req.target_doc)
                body = markdown_note(req.title, req.url, req.content, req.mode, include_frontmatter=False)
                with _lock:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    with path.open("a", encoding="utf-8") as f:
                        f.write("\n\n---\n\n")
                        f.write(body)
                return SaveResult(ok=True, note_id=self._relative(path))

            path = self._new_note_path(req.title)
            body = markdown_note(req.title, req.url, req.content, req.mode, include_frontmatter=True)
            with _lock:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(body, encoding="utf-8")
            logger.info(f"obsidian save ok: {path}")
            return SaveResult(ok=True, note_id=self._relative(path))
        except OSError as e:
            logger.exception(f"obsidian save fail: {e}")
            return SaveResult(ok=False, error=f"Obsidian/Markdown 写入失败:{e}")

    def _default_dir(self) -> Path:
        assert self.vault is not None
        return self.vault / self.default_folder

    def _new_note_path(self, title: str) -> Path:
        from datetime import date

        base = self._default_dir() / date.today().isoformat()
        stem = safe_filename(title)
        candidate = base / f"{stem}.md"
        idx = 2
        while candidate.exists():
            candidate = base / f"{stem}-{idx}.md"
            idx += 1
        return candidate

    def _resolve_target(self, target_doc: str) -> Path:
        assert self.vault is not None
        raw = Path(target_doc)
        if raw.is_absolute():
            return raw
        if raw.suffix.lower() != ".md":
            raw = raw.with_suffix(".md")
        return self.vault / raw

    def _relative(self, path: Path) -> str:
        assert self.vault is not None
        try:
            return path.relative_to(self.vault).as_posix()
        except ValueError:
            return str(path)

    def _build_tree(self, base: Path) -> list[DocNode]:
        nodes: list[DocNode] = []
        for child in sorted(base.iterdir(), key=lambda p: (p.is_file(), p.name.lower())):
            if child.name.startswith("."):
                continue
            rel = self._relative(child)
            if child.is_dir():
                nodes.append(DocNode(id=rel, name=child.name, path=rel, type="Container", children=self._build_tree(child)))
            elif child.suffix.lower() == ".md":
                nodes.append(DocNode(id=rel, name=child.stem, path=rel, type="Page", children=[]))
        return nodes
