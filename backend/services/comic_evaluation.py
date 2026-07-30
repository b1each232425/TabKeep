"""Metrics for the developer-only comic region detection evaluation set."""

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class DetectionMetrics:
    true_positive: int
    false_positive: int
    false_negative: int

    @property
    def precision(self) -> float:
        denominator = self.true_positive + self.false_positive
        return self.true_positive / denominator if denominator else 0.0

    @property
    def recall(self) -> float:
        denominator = self.true_positive + self.false_negative
        return self.true_positive / denominator if denominator else 0.0

    @property
    def f1(self) -> float:
        denominator = self.precision + self.recall
        return 2 * self.precision * self.recall / denominator if denominator else 0.0


def evaluate_detection(
    expected: list[dict[str, Any]],
    predicted: list[dict[str, Any]],
    iou_threshold: float = 0.5,
) -> DetectionMetrics:
    """Greedily match predicted text bounds to ground truth at an IoU threshold."""
    candidates: list[tuple[float, int, int]] = []
    for expected_index, expected_region in enumerate(expected):
        for predicted_index, predicted_region in enumerate(predicted):
            score = bounds_iou(
                expected_region["textBounds"],
                predicted_region["textBounds"],
            )
            if score >= iou_threshold:
                candidates.append((score, expected_index, predicted_index))

    matched_expected: set[int] = set()
    matched_predicted: set[int] = set()
    for _, expected_index, predicted_index in sorted(candidates, reverse=True):
        if expected_index in matched_expected or predicted_index in matched_predicted:
            continue
        matched_expected.add(expected_index)
        matched_predicted.add(predicted_index)

    true_positive = len(matched_expected)
    return DetectionMetrics(
        true_positive=true_positive,
        false_positive=len(predicted) - true_positive,
        false_negative=len(expected) - true_positive,
    )


def bounds_iou(first: dict[str, float], second: dict[str, float]) -> float:
    first_right = first["x"] + first["width"]
    first_bottom = first["y"] + first["height"]
    second_right = second["x"] + second["width"]
    second_bottom = second["y"] + second["height"]
    intersection_width = max(0.0, min(first_right, second_right) - max(first["x"], second["x"]))
    intersection_height = max(
        0.0,
        min(first_bottom, second_bottom) - max(first["y"], second["y"]),
    )
    intersection = intersection_width * intersection_height
    first_area = first["width"] * first["height"]
    second_area = second["width"] * second["height"]
    union = first_area + second_area - intersection
    return intersection / union if union > 0 else 0.0
