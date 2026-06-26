import shutil
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services import storage
from services.knowledge import db, vector_store
from services.note import local as local_note


class IsolatedBackendState:
    """Patch backend runtime paths so tests never touch real user data."""

    def __init__(self, name: str) -> None:
        self.tmp_dir = ROOT.parent / "tmp" / name
        self._originals: dict[str, Any] = {}

    def setup(self) -> Path:
        if self.tmp_dir.exists():
            shutil.rmtree(self.tmp_dir)
        self.tmp_dir.mkdir(parents=True)

        self._originals = {
            "storage_data_dir": storage.DATA_DIR,
            "storage_config_file": storage.CONFIG_FILE,
            "storage_state": dict(storage._state),
            "db_path": db.DB_PATH,
            "vector_lance_dir": vector_store.LANCE_DIR,
            "local_data_dir": local_note.DATA_DIR,
        }

        storage.DATA_DIR = self.tmp_dir / "data"
        storage.CONFIG_FILE = storage.DATA_DIR / "config.json"
        db.DB_PATH = storage.DATA_DIR / "knowledge.db"
        vector_store.LANCE_DIR = storage.DATA_DIR / "knowledge.lance"
        local_note.DATA_DIR = storage.DATA_DIR / "notes"
        storage.DATA_DIR.mkdir(parents=True, exist_ok=True)
        reset_storage_state()
        return self.tmp_dir

    def teardown(self) -> None:
        storage.DATA_DIR = self._originals["storage_data_dir"]
        storage.CONFIG_FILE = self._originals["storage_config_file"]
        db.DB_PATH = self._originals["db_path"]
        vector_store.LANCE_DIR = self._originals["vector_lance_dir"]
        local_note.DATA_DIR = self._originals["local_data_dir"]
        storage._state.clear()
        storage._state.update(self._originals["storage_state"])
        if self.tmp_dir.exists():
            shutil.rmtree(self.tmp_dir)


def reset_storage_state() -> None:
    storage._state.clear()
    storage._state.update(
        {
            "modelConfig": None,
            "tabCategories": [],
            "noteAdapter": None,
            "knowledgeConfig": None,
            "apiToken": None,
        }
    )
