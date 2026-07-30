import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.knowledge.ragas_evaluation import (
    build_ragas_result,
    metric_value,
)
from schemas.knowledge import KnowledgeCitation
from services.knowledge.qa import MAX_CONTEXT_CHARS, rag_contexts


class FakeMetricResult:
    def __init__(self, value: object) -> None:
        self.value = value


class RagasEvaluationTestCase(unittest.TestCase):
    def test_metric_value_normalizes_scores(self) -> None:
        self.assertEqual(metric_value(FakeMetricResult(0.7567894)), 0.756789)
        self.assertEqual(metric_value(FakeMetricResult(2)), 1)
        self.assertEqual(metric_value(FakeMetricResult(-1)), 0)
        self.assertIsNone(metric_value(FakeMetricResult("invalid")))

    def test_build_ragas_result_keeps_partial_scores_and_errors(self) -> None:
        result = build_ragas_result(
            {
                "ragasFaithfulness": FakeMetricResult(0.9),
                "ragasFactualCorrectness": RuntimeError("judge unavailable"),
                "ragasContextPrecision": FakeMetricResult(0.7),
            }
        )

        self.assertTrue(result.evaluated)
        self.assertEqual(result.faithfulness, 0.9)
        self.assertEqual(result.context_precision, 0.7)
        self.assertIsNone(result.factual_correctness)
        self.assertIn("Factual Correctness", result.error or "")
        self.assertIn("judge unavailable", result.error or "")

    def test_ragas_contexts_match_the_generation_context_budget(self) -> None:
        citations = [
            KnowledgeCitation(
                documentId="doc-1",
                paragraphId="paragraph-1",
                chunkId="chunk-1",
                title="第一段",
                sourceType="markdown",
                content="a" * 10_000,
            ),
            KnowledgeCitation(
                documentId="doc-2",
                paragraphId="paragraph-2",
                chunkId="chunk-2",
                title="第二段",
                sourceType="markdown",
                content="b" * 10_000,
            ),
        ]

        contexts = rag_contexts(citations)

        self.assertEqual(len(contexts), 2)
        self.assertEqual(len(contexts[0]), 10_000)
        self.assertEqual(len(contexts[1]), MAX_CONTEXT_CHARS - 10_000)
        self.assertEqual(sum(len(item) for item in contexts), MAX_CONTEXT_CHARS)


if __name__ == "__main__":
    unittest.main()
