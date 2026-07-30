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
from schemas.ocr import MangaOcrRegionRequest, MangaOcrRegionResult
from services import manga_ocr


class FakeImage:
    size = (100, 80)

    def __init__(self) -> None:
        self.crops: list[tuple[int, int, int, int]] = []

    def crop(self, bounds: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
        self.crops.append(bounds)
        return bounds


class MangaOcrServiceTestCase(unittest.TestCase):
    def test_recognizes_regions_in_order_and_clamps_crop_bounds(self) -> None:
        image = FakeImage()
        model_calls: list[tuple[int, int, int, int]] = []

        def model(crop: tuple[int, int, int, int]) -> str:
            model_calls.append(crop)
            return f" text-{len(model_calls)} "

        regions = [
            MangaOcrRegionRequest(id="region_01", x=0, y=0, width=20, height=20),
            MangaOcrRegionRequest(id="region_02", x=70, y=50, width=30, height=30),
        ]
        with (
            patch.object(manga_ocr, "_decode_image", return_value=image),
            patch.object(manga_ocr, "_get_model", return_value=model),
        ):
            result = manga_ocr.recognize_regions("ignored", regions)

        self.assertEqual(
            result,
            [
                MangaOcrRegionResult(id="region_01", text="text-1"),
                MangaOcrRegionResult(id="region_02", text="text-2"),
            ],
        )
        self.assertEqual(image.crops[0][0:2], (0, 0))
        self.assertEqual(image.crops[1][2:4], (100, 80))

    def test_rejects_invalid_region_size(self) -> None:
        region = MangaOcrRegionRequest(id="bad", x=1, y=1, width=0, height=10)
        with (
            patch.object(manga_ocr, "_decode_image", return_value=FakeImage()),
            patch.object(manga_ocr, "_get_model", return_value=lambda _crop: "unused"),
        ):
            with self.assertRaisesRegex(manga_ocr.MangaOcrError, "尺寸无效"):
                manga_ocr.recognize_regions("ignored", [region])


class MangaOcrApiTestCase(unittest.TestCase):
    def test_endpoint_returns_structured_regions(self) -> None:
        with (
            patch.dict(os.environ, {"TABKEEP_DISABLE_AUTH": "1"}),
            patch(
                "routers.ocr.recognize_regions",
                return_value=[MangaOcrRegionResult(id="region_01", text="こんにちは")],
            ),
        ):
            response = TestClient(app).post(
                "/ocr/manga",
                json={
                    "imageBase64": "ignored",
                    "regions": [
                        {
                            "id": "region_01",
                            "x": 10,
                            "y": 20,
                            "width": 100,
                            "height": 50,
                        }
                    ],
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(
            response.json(),
            {
                "ok": True,
                "engine": "MangaOCR",
                "regions": [{"id": "region_01", "text": "こんにちは"}],
                "error": None,
            },
        )


if __name__ == "__main__":
    unittest.main()
