import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services import storage
from main import backend_port


class RuntimePathTestCase(unittest.TestCase):
    def test_data_dir_defaults_to_backend_data(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(storage.resolve_data_dir(), ROOT / "data")

    def test_data_dir_uses_environment_override(self) -> None:
        configured = ROOT.parent / "tmp" / "packaged-backend-data"
        with patch.dict(os.environ, {"TABKEEP_DATA_DIR": str(configured)}, clear=True):
            self.assertEqual(storage.resolve_data_dir(), configured)

    def test_backend_port_uses_environment_override(self) -> None:
        with patch.dict(os.environ, {"TABKEEP_BACKEND_PORT": "39471"}, clear=True):
            self.assertEqual(backend_port(), 39471)

    def test_backend_port_rejects_invalid_value(self) -> None:
        with patch.dict(os.environ, {"TABKEEP_BACKEND_PORT": "70000"}, clear=True):
            with self.assertRaisesRegex(ValueError, "Invalid TABKEEP_BACKEND_PORT"):
                backend_port()


if __name__ == "__main__":
    unittest.main()
