"""Lazy RT-DETR-v2 ONNX inference for comic text and speech bubbles."""

import base64
import binascii
import hashlib
import os
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from threading import Lock
from typing import Any

import httpx

from schemas.ocr import ComicDetectionBounds, ComicDetectionRegion

MODEL_URL = (
    "https://huggingface.co/ogkalu/comic-text-and-bubble-detector/"
    "resolve/main/detector-v4-s_int8.onnx"
)
MODEL_SHA256 = "5fe9e4f576e49d4e7e8b0e029d6d3cdc252abd4694113e1cae120e62c931ea79"
MODEL_FILENAME = "detector-v4-s_int8.onnx"
MAX_IMAGE_BYTES = 16 * 1024 * 1024
MAX_IMAGE_PIXELS = 40_000_000
MAX_REGIONS = 64
CONFIDENCE_THRESHOLD = 0.3

_SESSION: Any | None = None
_SESSION_LOCK = Lock()
_INFERENCE_LOCK = Lock()
_DOWNLOAD_LOCK = Lock()


class ComicDetectorError(RuntimeError):
    """An error safe to expose to the local desktop process."""


class ComicDetectorUnavailableError(ComicDetectorError):
    """The model or ONNX runtime could not be prepared."""


@dataclass(frozen=True)
class _Box:
    x1: float
    y1: float
    x2: float
    y2: float
    score: float

    @property
    def width(self) -> float:
        return max(0.0, self.x2 - self.x1)

    @property
    def height(self) -> float:
        return max(0.0, self.y2 - self.y1)

    @property
    def area(self) -> float:
        return self.width * self.height


def detect_regions(image_base64: str, source_lang: str) -> list[ComicDetectionRegion]:
    """Detect comic text blocks and associate them with speech bubbles."""
    image = _decode_image(image_base64)
    session = _get_session()
    labels, boxes, scores = _run_inference(session, image)
    return build_regions(labels, boxes, scores, source_lang)


def build_regions(
    labels: Any,
    boxes: Any,
    scores: Any,
    source_lang: str,
) -> list[ComicDetectionRegion]:
    """Convert RT-DETR output into stable bubble-level regions."""
    bubble_boxes: list[_Box] = []
    text_boxes: list[_Box] = []
    for label, coordinates, score in zip(
        _flatten_values(labels),
        _flatten_boxes(boxes),
        _flatten_values(scores),
    ):
        confidence = float(score)
        if confidence < CONFIDENCE_THRESHOLD or len(coordinates) < 4:
            continue
        box = _Box(
            x1=float(coordinates[0]),
            y1=float(coordinates[1]),
            x2=float(coordinates[2]),
            y2=float(coordinates[3]),
            score=confidence,
        )
        if box.width < 4 or box.height < 4:
            continue
        if int(label) == 0:
            bubble_boxes.append(box)
        elif int(label) in (1, 2):
            text_boxes.append(box)

    bubble_boxes = _suppress_duplicates(bubble_boxes)
    text_boxes = _suppress_duplicates(text_boxes)
    grouped: dict[str, tuple[list[_Box], _Box | None]] = {}
    for index, text_box in enumerate(text_boxes[:MAX_REGIONS]):
        bubble_index = _best_bubble_index(text_box, bubble_boxes)
        key = f"bubble:{bubble_index}" if bubble_index is not None else f"text:{index}"
        if key not in grouped:
            grouped[key] = ([], bubble_boxes[bubble_index] if bubble_index is not None else None)
        grouped[key][0].append(text_box)

    candidates: list[tuple[_Box, _Box | None, float, str]] = []
    for group, bubble in grouped.values():
        text_bounds = _union_boxes(group)
        confidence = sum(item.score for item in group) / len(group)
        direction = _infer_direction(text_bounds, source_lang)
        candidates.append((text_bounds, bubble, confidence, direction))

    page_vertical = _is_japanese(source_lang) and sum(
        direction == "vertical" for _, _, _, direction in candidates
    ) * 2 >= max(1, len(candidates))
    candidates.sort(
        key=lambda item: (
            -item[0].x1 if page_vertical else item[0].y1,
            item[0].y1 if page_vertical else item[0].x1,
        )
    )

    regions: list[ComicDetectionRegion] = []
    for index, (text_bounds, bubble, confidence, direction) in enumerate(candidates[:MAX_REGIONS]):
        regions.append(
            ComicDetectionRegion(
                id=f"region_{index + 1:02}",
                textBounds=_to_bounds(text_bounds),
                bubbleBounds=_to_bounds(bubble) if bubble is not None else None,
                direction=direction,
                readingOrder=index,
                confidence=confidence,
            )
        )
    return regions


def _decode_image(image_base64: str) -> Any:
    try:
        raw = base64.b64decode(image_base64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ComicDetectorError("图片 Base64 数据无效") from exc
    if not raw:
        raise ComicDetectorError("图片内容为空")
    if len(raw) > MAX_IMAGE_BYTES:
        raise ComicDetectorError("图片过大，无法进行漫画区域检测")

    try:
        from PIL import Image

        image = Image.open(BytesIO(raw))
        image.load()
        if image.width * image.height > MAX_IMAGE_PIXELS:
            raise ComicDetectorError("图片像素尺寸过大，无法进行漫画区域检测")
        return image.convert("RGB")
    except ComicDetectorError:
        raise
    except ImportError as exc:
        raise ComicDetectorUnavailableError("漫画区域检测依赖 Pillow 未安装") from exc
    except Exception as exc:
        raise ComicDetectorError("无法解析漫画区域检测图片") from exc


def _get_session() -> Any:
    global _SESSION
    if _SESSION is not None:
        return _SESSION
    with _SESSION_LOCK:
        if _SESSION is not None:
            return _SESSION
        try:
            import onnxruntime as ort

            options = ort.SessionOptions()
            options.intra_op_num_threads = min(4, os.cpu_count() or 1)
            options.inter_op_num_threads = 1
            options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
            options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            _SESSION = ort.InferenceSession(
                str(_ensure_model()),
                sess_options=options,
                providers=["CPUExecutionProvider"],
            )
        except ImportError as exc:
            raise ComicDetectorUnavailableError("漫画区域检测依赖 onnxruntime 未安装") from exc
        except ComicDetectorError:
            raise
        except Exception as exc:
            raise ComicDetectorUnavailableError(f"漫画区域检测模型加载失败: {exc}") from exc
    return _SESSION


def _run_inference(session: Any, image: Any) -> tuple[Any, Any, Any]:
    try:
        import numpy as np

        resized = image.resize((640, 640))
        image_data = np.asarray(resized, dtype=np.float32) / 255.0
        image_data = np.transpose(image_data, (2, 0, 1))[np.newaxis, ...]
        original_size = np.array([[image.width, image.height]], dtype=np.int64)
        with _INFERENCE_LOCK:
            outputs = session.run(
                None,
                {"images": image_data, "orig_target_sizes": original_size},
            )
        if len(outputs) < 3:
            raise ComicDetectorError("漫画区域检测模型输出字段不足")
        return outputs[0], outputs[1], outputs[2]
    except ComicDetectorError:
        raise
    except ImportError as exc:
        raise ComicDetectorUnavailableError("漫画区域检测依赖 numpy 未安装") from exc
    except Exception as exc:
        raise ComicDetectorError(f"漫画区域检测推理失败: {exc}") from exc


def _model_path() -> Path:
    override = os.getenv("TABKEEP_COMIC_DETECTOR_MODEL", "").strip()
    if override:
        return Path(override).expanduser()
    backend_root = Path(__file__).resolve().parents[1]
    return backend_root / "data" / "models" / "detection" / MODEL_FILENAME


def _ensure_model() -> Path:
    path = _model_path()
    if path.is_file() and _sha256(path) == MODEL_SHA256:
        return path
    with _DOWNLOAD_LOCK:
        if path.is_file() and _sha256(path) == MODEL_SHA256:
            return path
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".download")
        try:
            with httpx.stream("GET", MODEL_URL, follow_redirects=True, timeout=300.0) as response:
                response.raise_for_status()
                with temporary.open("wb") as output:
                    for chunk in response.iter_bytes():
                        output.write(chunk)
            if _sha256(temporary) != MODEL_SHA256:
                raise ComicDetectorUnavailableError("漫画区域检测模型校验失败")
            temporary.replace(path)
        except ComicDetectorError:
            temporary.unlink(missing_ok=True)
            raise
        except Exception as exc:
            temporary.unlink(missing_ok=True)
            raise ComicDetectorUnavailableError(f"漫画区域检测模型下载失败: {exc}") from exc
    return path


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _flatten_values(values: Any) -> list[Any]:
    result = values.tolist() if hasattr(values, "tolist") else list(values)
    while len(result) == 1 and isinstance(result[0], list):
        result = result[0]
    return result


def _flatten_boxes(values: Any) -> list[list[float]]:
    result = values.tolist() if hasattr(values, "tolist") else list(values)
    while len(result) == 1 and isinstance(result[0], list) and result[0] and isinstance(result[0][0], list):
        result = result[0]
    return [list(item) for item in result]


def _suppress_duplicates(boxes: list[_Box], threshold: float = 0.65) -> list[_Box]:
    kept: list[_Box] = []
    for box in sorted(boxes, key=lambda item: item.score, reverse=True):
        if all(_intersection_over_union(box, existing) < threshold for existing in kept):
            kept.append(box)
    return kept


def _best_bubble_index(text: _Box, bubbles: list[_Box]) -> int | None:
    best: tuple[int, float] | None = None
    center_x = (text.x1 + text.x2) / 2
    center_y = (text.y1 + text.y2) / 2
    for index, bubble in enumerate(bubbles):
        overlap = _intersection_area(text, bubble) / max(1.0, text.area)
        contains_center = (
            bubble.x1 <= center_x <= bubble.x2 and bubble.y1 <= center_y <= bubble.y2
        )
        if not contains_center and overlap < 0.15:
            continue
        score = overlap + (1.0 if contains_center else 0.0) - bubble.area * 1e-10
        if best is None or score > best[1]:
            best = (index, score)
    return best[0] if best is not None else None


def _union_boxes(boxes: list[_Box]) -> _Box:
    return _Box(
        x1=min(item.x1 for item in boxes),
        y1=min(item.y1 for item in boxes),
        x2=max(item.x2 for item in boxes),
        y2=max(item.y2 for item in boxes),
        score=max(item.score for item in boxes),
    )


def _intersection_area(first: _Box, second: _Box) -> float:
    width = max(0.0, min(first.x2, second.x2) - max(first.x1, second.x1))
    height = max(0.0, min(first.y2, second.y2) - max(first.y1, second.y1))
    return width * height


def _intersection_over_union(first: _Box, second: _Box) -> float:
    intersection = _intersection_area(first, second)
    union = first.area + second.area - intersection
    return intersection / union if union > 0 else 0.0


def _to_bounds(box: _Box) -> ComicDetectionBounds:
    return ComicDetectionBounds(x=box.x1, y=box.y1, width=box.width, height=box.height)


def _infer_direction(box: _Box, source_lang: str) -> str:
    if _is_japanese(source_lang) and box.height > box.width * 1.2:
        return "vertical"
    return "horizontal"


def _is_japanese(source_lang: str) -> bool:
    return source_lang.strip().lower() in {"ja", "ja-jp", "jp", "日本語", "日语"}


def reset_session_for_tests() -> None:
    """Clear the singleton without exposing model lifecycle as a public API."""
    global _SESSION
    with _SESSION_LOCK:
        _SESSION = None
