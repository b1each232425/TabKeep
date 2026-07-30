"""Local OCR model endpoints used by the Tauri desktop process."""

import asyncio

from fastapi import APIRouter, Depends

from schemas.ocr import (
    ComicDetectionRequest,
    ComicDetectionResponse,
    MangaOcrRequest,
    MangaOcrResponse,
)
from services.auth import require_api_token
from services.comic_detector import ComicDetectorError, detect_regions
from services.manga_ocr import MangaOcrError, recognize_regions

router = APIRouter(
    prefix="/ocr",
    tags=["OCR"],
    dependencies=[Depends(require_api_token)],
)


@router.post("/manga", response_model=MangaOcrResponse, summary="识别日语漫画文本区域")
async def recognize_manga(request: MangaOcrRequest) -> MangaOcrResponse:
    """Run the blocking local model in a worker thread and keep FastAPI responsive."""
    try:
        regions = await asyncio.to_thread(
            recognize_regions,
            request.image_base64,
            request.regions,
        )
        return MangaOcrResponse(ok=True, regions=regions)
    except MangaOcrError as exc:
        return MangaOcrResponse(ok=False, error=str(exc))


@router.post(
    "/comic/detect",
    response_model=ComicDetectionResponse,
    summary="检测漫画文字与气泡区域",
)
async def detect_comic_regions(request: ComicDetectionRequest) -> ComicDetectionResponse:
    """Run RT-DETR in a worker thread because ONNX inference is blocking."""
    try:
        regions = await asyncio.to_thread(
            detect_regions,
            request.image_base64,
            request.source_lang,
        )
        return ComicDetectionResponse(ok=True, regions=regions)
    except ComicDetectorError as exc:
        return ComicDetectionResponse(ok=False, error=str(exc))
