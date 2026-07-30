import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient

from main import app
from schemas.ocr import ComicDetectionBounds, ComicDetectionRegion
from services.comic_detector import build_regions


class ComicDetectorGroupingTestCase(unittest.TestCase):
    def test_groups_multiple_text_boxes_inside_one_bubble(self) -> None:
        regions = build_regions(
            labels=[0, 1, 1, 0, 1],
            boxes=[
                [0, 0, 120, 100],
                [20, 20, 90, 42],
                [24, 48, 95, 72],
                [200, 10, 300, 120],
                [220, 30, 280, 90],
            ],
            scores=[0.95, 0.91, 0.89, 0.94, 0.88],
            source_lang="en-US",
        )

        self.assertEqual(len(regions), 2)
        self.assertEqual(regions[0].id, "region_01")
        self.assertEqual(regions[0].text_bounds.x, 20)
        self.assertEqual(regions[0].text_bounds.width, 75)
        self.assertEqual(regions[0].bubble_bounds, ComicDetectionBounds(x=0, y=0, width=120, height=100))
        self.assertEqual(regions[1].bubble_bounds, ComicDetectionBounds(x=200, y=10, width=100, height=110))

    def test_sorts_vertical_japanese_regions_right_to_left(self) -> None:
        regions = build_regions(
            labels=[1, 1],
            boxes=[[20, 10, 40, 100], [100, 20, 125, 120]],
            scores=[0.9, 0.92],
            source_lang="ja-JP",
        )

        self.assertEqual([region.text_bounds.x for region in regions], [100, 20])
        self.assertTrue(all(region.direction == "vertical" for region in regions))

    def test_suppresses_duplicate_detections(self) -> None:
        regions = build_regions(
            labels=[1, 1],
            boxes=[[10, 10, 100, 60], [12, 11, 99, 59]],
            scores=[0.93, 0.85],
            source_lang="en-US",
        )

        self.assertEqual(len(regions), 1)


class ComicDetectorApiTestCase(unittest.TestCase):
    def test_endpoint_returns_structured_regions(self) -> None:
        region = ComicDetectionRegion(
            id="region_01",
            textBounds=ComicDetectionBounds(x=10, y=20, width=100, height=50),
            bubbleBounds=ComicDetectionBounds(x=5, y=10, width=120, height=80),
            direction="horizontal",
            readingOrder=0,
            confidence=0.91,
        )
        with (
            patch.dict(os.environ, {"TABKEEP_DISABLE_AUTH": "1"}),
            patch("routers.ocr.detect_regions", return_value=[region]),
        ):
            response = TestClient(app).post(
                "/ocr/comic/detect",
                json={"imageBase64": "ignored", "sourceLang": "en-US"},
            )

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["engine"], "RT-DETR-v2 INT8 ONNX")
        self.assertEqual(payload["regions"][0]["id"], "region_01")
        self.assertEqual(payload["regions"][0]["bubbleBounds"]["width"], 120)


if __name__ == "__main__":
    unittest.main()
