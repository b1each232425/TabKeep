"""Lazy MangaOCR model loading and in-memory region recognition."""

import base64
import binascii
from io import BytesIO
from threading import Lock
from typing import Any

from schemas.ocr import MangaOcrRegionRequest, MangaOcrRegionResult

MAX_IMAGE_BYTES = 16 * 1024 * 1024
MAX_IMAGE_PIXELS = 40_000_000
MAX_REGIONS = 64

_MODEL: Any | None = None
_MODEL_LOCK = Lock()
_INFERENCE_LOCK = Lock()


class MangaOcrError(RuntimeError):
    """Base error safe to expose to the local desktop client."""


class MangaOcrUnavailableError(MangaOcrError):
    """Raised when the optional MangaOCR runtime cannot be loaded."""


def recognize_regions(
    image_base64: str,
    regions: list[MangaOcrRegionRequest],
) -> list[MangaOcrRegionResult]:
    """Recognize PaddleOCR-located image regions with one reusable MangaOCR model."""
    if not regions:
        return []
    if len(regions) > MAX_REGIONS:
        raise MangaOcrError(f"区域数量超过限制（最多 {MAX_REGIONS} 个）")

    image = _decode_image(image_base64)
    model = _get_model()
    results: list[MangaOcrRegionResult] = []
    with _INFERENCE_LOCK:
        for region in regions:
            crop = _crop_region(image, region)
            text = str(model(crop)).strip()
            results.append(MangaOcrRegionResult(id=region.id, text=text))
    return results


def _decode_image(image_base64: str) -> Any:
    try:
        raw = base64.b64decode(image_base64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise MangaOcrError("图片 Base64 数据无效") from exc
    if not raw:
        raise MangaOcrError("图片内容为空")
    if len(raw) > MAX_IMAGE_BYTES:
        raise MangaOcrError("图片过大，无法进行 MangaOCR")

    try:
        from PIL import Image

        image = Image.open(BytesIO(raw))
        image.load()
        if image.width * image.height > MAX_IMAGE_PIXELS:
            raise MangaOcrError("图片像素尺寸过大，无法进行 MangaOCR")
        return image.convert("RGB")
    except MangaOcrError:
        raise
    except ImportError as exc:
        raise MangaOcrUnavailableError("MangaOCR 依赖 Pillow 未安装") from exc
    except Exception as exc:
        raise MangaOcrError("无法解析 MangaOCR 输入图片") from exc


def _get_model() -> Any:
    global _MODEL
    if _MODEL is not None:
        return _MODEL
    with _MODEL_LOCK:
        if _MODEL is not None:
            return _MODEL
        try:
            from manga_ocr import MangaOcr

            _MODEL = MangaOcr()
        except ImportError as exc:
            raise MangaOcrUnavailableError("MangaOCR 运行依赖未安装") from exc
        except Exception as exc:
            raise MangaOcrUnavailableError(f"MangaOCR 模型加载失败: {exc}") from exc
    return _MODEL


def _crop_region(image: Any, region: MangaOcrRegionRequest) -> Any:
    image_width, image_height = image.size
    if region.width <= 0 or region.height <= 0:
        raise MangaOcrError(f"区域 {region.id} 的尺寸无效")

    padding_x = max(4.0, region.width * 0.08)
    padding_y = max(4.0, region.height * 0.12)
    left = max(0, int(region.x - padding_x))
    top = max(0, int(region.y - padding_y))
    right = min(image_width, int(region.x + region.width + padding_x + 0.999))
    bottom = min(image_height, int(region.y + region.height + padding_y + 0.999))
    if right <= left or bottom <= top:
        raise MangaOcrError(f"区域 {region.id} 超出图片范围")
    return image.crop((left, top, right, bottom))


def reset_model_for_tests() -> None:
    """Clear the singleton without exposing model lifecycle as a public API."""
    global _MODEL
    with _MODEL_LOCK:
        _MODEL = None
