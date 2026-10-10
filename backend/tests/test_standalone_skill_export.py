import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from scripts.export_standalone_skill import choose_documents, extract_keywords, write_skill


class StandaloneSkillExportTestCase(unittest.TestCase):
    def test_keyword_extraction_ignores_body_urls_and_encoding_fragments(self) -> None:
        keywords = extract_keywords(
            "MySQL 锁",
            "next-key lock",
            "参考 https://example.com/%E7%B4%A2%E5%BC%95，InnoDB 会使用 next-key lock。",
        )

        self.assertIn("MySQL", keywords)
        self.assertIn("InnoDB", keywords)
        self.assertNotIn("https", [keyword.lower() for keyword in keywords])
        self.assertNotIn("e7", [keyword.lower() for keyword in keywords])

    def test_export_deduplicates_sources_and_keeps_relative_references(self) -> None:
        connection = sqlite3.connect(":memory:")
        connection.row_factory = sqlite3.Row
        connection.executescript(
            """
            CREATE TABLE documents (
                id TEXT PRIMARY KEY,
                source_type TEXT NOT NULL,
                title TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                paragraph_count INTEGER NOT NULL,
                updated_at TEXT,
                indexed_at TEXT
            );
            CREATE TABLE paragraphs (
                id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL,
                paragraph_index INTEGER NOT NULL,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                char_len INTEGER NOT NULL
            );
            """
        )
        connection.executemany(
            "INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, ?)",
            [
                ("siyuan-id", "siyuan", "MySQL 锁", "same-hash", 1, "2026-09-16", "2026-09-16"),
                ("markdown-id", "markdown", "MySQL 锁", "same-hash", 1, "2026-09-16", "2026-09-16"),
            ],
        )
        connection.execute(
            "INSERT INTO paragraphs VALUES (?, ?, ?, ?, ?, ?)",
            ("markdown-id:p0", "markdown-id", 0, "next-key lock", "InnoDB 的锁范围。", 10),
        )

        rows = connection.execute("SELECT * FROM documents ORDER BY source_type").fetchall()
        selected = choose_documents(rows, 10)
        self.assertEqual([row["id"] for row in selected], ["markdown-id"])

        with tempfile.TemporaryDirectory() as temp_dir:
            result = write_skill(
                connection,
                output=Path(temp_dir) / "skill",
                skill_name="mysql-knowledge",
                display_name="MySQL 知识 Skill",
                description="基于个人 MySQL 笔记回答问题。",
                skill_version="0.1.0",
                documents=selected,
                min_content_chars=1,
            )
            output = Path(temp_dir) / "skill"
            manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
            index = json.loads((output / "index.json").read_text(encoding="utf-8"))
            self.assertEqual(result["sourceCount"], 1)
            self.assertEqual(result["blockCount"], 1)
            self.assertEqual(manifest["runtimeDependencies"], [])
            self.assertEqual(index["blocks"][0]["file"], "references/mysql.md")
            self.assertFalse(Path(index["blocks"][0]["file"]).is_absolute())
            self.assertIn("Evidence", (output / "references/mysql.md").read_text(encoding="utf-8"))

        connection.close()


if __name__ == "__main__":
    unittest.main()
