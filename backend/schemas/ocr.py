"""OCR service request and response models."""

from pydantic import BaseModel, Field


class MangaOcrRegionRequest(BaseModel):
    """One image-space region to recognize with MangaOCR."""

    id: str
    x: float
    y: float
    width: float
    height: float


class MangaOcrRequest(BaseModel):
    """A source image and PaddleOCR-detected regions."""

    image_base64: str = Field(alias="imageBase64")
    regions: list[MangaOcrRegionRequest]


class MangaOcrRegionResult(BaseModel):
    id: str
    text: str


class MangaOcrResponse(BaseModel):
    ok: bool
    engine: str = "MangaOCR"
    regions: list[MangaOcrRegionResult] = Field(default_factory=list)
    error: str | None = None


class ComicDetectionRequest(BaseModel):
    """An image to inspect with the comic text and bubble detector."""

    image_base64: str = Field(alias="imageBase64")
    source_lang: str = Field(default="auto", alias="sourceLang")


class ComicDetectionBounds(BaseModel):
    x: float
    y: float
    width: float
    height: float


class ComicDetectionRegion(BaseModel):
    """One text block, optionally associated with a containing speech bubble."""

    id: str
    text_bounds: ComicDetectionBounds = Field(alias="textBounds")
    bubble_bounds: ComicDetectionBounds | None = Field(default=None, alias="bubbleBounds")
    direction: str
    reading_order: int = Field(alias="readingOrder")
    confidence: float


class ComicDetectionResponse(BaseModel):
    ok: bool
    engine: str = "RT-DETR-v2 INT8 ONNX"
    regions: list[ComicDetectionRegion] = Field(default_factory=list)
    error: str | None = None
