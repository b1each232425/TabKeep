import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.summarizer import parse_summary_markdown


class SummarizerTestCase(unittest.TestCase):
    def test_parse_fenced_json_and_render_required_sections(self) -> None:
        raw = (
            "<think>hidden reasoning</think>\n"
            "```json\n"
            + json.dumps(
                {
                    "problem": "解释为什么 RAG 需要 rerank。",
                    "summary": "文章说明向量召回重语义, rerank 负责把真正相关的材料排到前面。",
                    "key_excerpts": [
                        "Rerank 会重新评估 query 与候选段落的相关性。",
                        "TopK 召回只解决找得到,不保证排得准。",
                    ],
                    "reusable_points": ["调参时先看 Recall,再看 MRR。"],
                    "review_questions": ["为什么 rerank 能提升 MRR?"],
                    "images": ["![pipeline](https://example.test/rag.png)"],
                },
                ensure_ascii=False,
            )
            + "\n```"
        )

        markdown = parse_summary_markdown(raw)

        self.assertIn("## 这篇解决什么", markdown)
        self.assertIn("解释为什么 RAG 需要 rerank。", markdown)
        self.assertIn("## 关键原文摘录", markdown)
        self.assertIn("> Rerank 会重新评估 query 与候选段落的相关性。", markdown)
        self.assertIn("## 以后可复用点", markdown)
        self.assertIn("- 调参时先看 Recall,再看 MRR。", markdown)
        self.assertIn("## 复习问题", markdown)
        self.assertIn("- 为什么 rerank 能提升 MRR?", markdown)
        self.assertIn("![pipeline](https://example.test/rag.png)", markdown)

    def test_empty_optional_lists_render_placeholders(self) -> None:
        raw = json.dumps(
            {
                "problem": "说明一个问题。",
                "summary": "保留一段摘要。",
                "key_excerpts": [],
                "reusable_points": [],
                "review_questions": [],
                "images": [],
            },
            ensure_ascii=False,
        )

        markdown = parse_summary_markdown(raw)

        self.assertIn("> (未提取到关键原文摘录)", markdown)
        self.assertIn("> (未提取到可复用点)", markdown)
        self.assertIn("> (未生成复习问题)", markdown)
        self.assertIn("> (无有意义的配图)", markdown)

    def test_invalid_json_raises_readable_error(self) -> None:
        with self.assertRaisesRegex(ValueError, "合法 JSON"):
            parse_summary_markdown("not-json")

    def test_missing_core_fields_raise_readable_error(self) -> None:
        with self.assertRaisesRegex(ValueError, "缺少必要摘要字段"):
            parse_summary_markdown(json.dumps({"problem": "只有问题"}, ensure_ascii=False))


if __name__ == "__main__":
    unittest.main()
