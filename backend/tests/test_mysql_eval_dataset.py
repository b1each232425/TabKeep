"""Offline structural checks for the versioned personal-note evaluation set."""

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
EVAL_DIR = ROOT / "backend/evaluation/rag"


class MysqlEvalDatasetTests(unittest.TestCase):
    def test_v2_keeps_v1_and_covers_core_sources(self) -> None:
        old = json.loads((EVAL_DIR / "tabkeep_mysql_notes_20260906.json").read_text(encoding="utf-8"))
        cases = json.loads((EVAL_DIR / "tabkeep_mysql_notes_v2.json").read_text(encoding="utf-8"))
        self.assertEqual(len(old), 56)
        self.assertEqual(len(cases), 56)
        self.assertEqual(len({case["id"] for case in cases}), 56)
        self.assertFalse({case["id"] for case in old} & {case["id"] for case in cases})
        self.assertTrue(all(case["dataset"] == "tabkeep-mysql-notes-v2" for case in cases))

        core = [case for case in cases if case["isCore"]]
        answerable = [case for case in cases if not case["shouldRefuse"]]
        self.assertEqual(len(core), 20)
        self.assertEqual(len(answerable), 52)
        self.assertEqual(sum(case["shouldRefuse"] for case in core), 2)
        self.assertEqual(len({case["expectedDocumentId"] for case in answerable}), 14)
        self.assertEqual(len({case["expectedDocumentId"] for case in core if not case["shouldRefuse"]}), 14)
        for case in answerable:
            self.assertTrue(case["expectedParagraphId"])
            self.assertTrue(case["expectedAnswer"].strip())
            self.assertTrue(case["answerKeywords"].strip())
            self.assertTrue(case["additionalRelevantTargets"])
        for case in cases:
            if case["shouldRefuse"]:
                self.assertFalse(case["expectedParagraphId"])
                self.assertFalse(case["expectedAnswer"])


if __name__ == "__main__":
    unittest.main()
