import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.comic_evaluation import bounds_iou, evaluate_detection


class ComicEvaluationTestCase(unittest.TestCase):
    def test_calculates_detection_precision_recall_and_f1(self) -> None:
        expected = [
            {"textBounds": {"x": 0, "y": 0, "width": 100, "height": 50}},
            {"textBounds": {"x": 200, "y": 0, "width": 80, "height": 50}},
        ]
        predicted = [
            {"textBounds": {"x": 2, "y": 1, "width": 98, "height": 49}},
            {"textBounds": {"x": 400, "y": 0, "width": 50, "height": 50}},
        ]

        metrics = evaluate_detection(expected, predicted)

        self.assertEqual(metrics.true_positive, 1)
        self.assertEqual(metrics.false_positive, 1)
        self.assertEqual(metrics.false_negative, 1)
        self.assertEqual(metrics.precision, 0.5)
        self.assertEqual(metrics.recall, 0.5)
        self.assertEqual(metrics.f1, 0.5)

    def test_iou_is_one_for_identical_bounds(self) -> None:
        bounds = {"x": 10, "y": 20, "width": 30, "height": 40}
        self.assertEqual(bounds_iou(bounds, bounds), 1.0)


if __name__ == "__main__":
    unittest.main()
