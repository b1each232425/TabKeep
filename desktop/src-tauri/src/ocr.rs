use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::Instant,
};

use base64::{engine::general_purpose, Engine};
use chrono::Utc;
use image::{imageops::FilterType, DynamicImage, GenericImageView};
use screenshots::{Compression, Screen};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

const OCR_CONFIG_FILE: &str = "ocr-config.json";
const FULL_SCREENSHOT_FILE: &str = "tabkeep_screenshot.png";
const CUT_SCREENSHOT_FILE: &str = "tabkeep_screenshot_cut.png";
const PREPROCESSED_OCR_FILE: &str = "tabkeep_ocr_preprocessed.png";
const OCR_DEBUG_RECORDS_FILE: &str = "ocr-debug-records.json";
const OCR_DEBUG_RECORD_LIMIT: usize = 20;
const MAX_PADDLE_PREPROCESS_EDGE: u32 = 1600;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OcrProvider {
    WindowsOcr,
    PaddleocrJson,
}

impl Default for OcrProvider {
    fn default() -> Self {
        Self::PaddleocrJson
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OcrTextLayoutMode {
    Auto,
    Preserve,
    Conservative,
    Paragraph,
    Manga,
}

impl Default for OcrTextLayoutMode {
    fn default() -> Self {
        Self::Auto
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OcrConfig {
    #[serde(default)]
    pub provider: OcrProvider,
    #[serde(rename = "paddleExePath", default)]
    pub paddle_exe_path: String,
    #[serde(rename = "paddleModelsPath", default)]
    pub paddle_models_path: String,
    #[serde(rename = "paddleConfigPath", default)]
    pub paddle_config_path: String,
    #[serde(rename = "paddleMinScore", default = "default_paddle_min_score")]
    pub paddle_min_score: f32,
    #[serde(rename = "preprocessEnabled", default = "default_true")]
    pub preprocess_enabled: bool,
    #[serde(rename = "preprocessScale", default = "default_preprocess_scale")]
    pub preprocess_scale: u32,
    #[serde(rename = "preprocessGrayscale", default = "default_true")]
    pub preprocess_grayscale: bool,
    #[serde(rename = "preprocessContrast", default = "default_preprocess_contrast")]
    pub preprocess_contrast: f32,
    #[serde(rename = "preprocessSharpen", default = "default_true")]
    pub preprocess_sharpen: bool,
    #[serde(rename = "preprocessThreshold", default)]
    pub preprocess_threshold: bool,
    #[serde(rename = "textPostprocessEnabled", default = "default_true")]
    pub text_postprocess_enabled: bool,
    #[serde(rename = "textMergeLines", default)]
    pub text_merge_lines: bool,
    #[serde(rename = "textLayoutMode", default)]
    pub text_layout_mode: OcrTextLayoutMode,
}

struct PreprocessedOcrImage {
    path: PathBuf,
    scale: f32,
}

impl Default for OcrConfig {
    fn default() -> Self {
        Self {
            provider: OcrProvider::PaddleocrJson,
            paddle_exe_path: String::new(),
            paddle_models_path: String::new(),
            paddle_config_path: String::new(),
            paddle_min_score: default_paddle_min_score(),
            preprocess_enabled: true,
            preprocess_scale: default_preprocess_scale(),
            preprocess_grayscale: true,
            preprocess_contrast: default_preprocess_contrast(),
            preprocess_sharpen: true,
            preprocess_threshold: false,
            text_postprocess_enabled: true,
            text_merge_lines: false,
            text_layout_mode: OcrTextLayoutMode::Auto,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OcrRequest {
    #[serde(default = "default_screenshot")]
    pub screenshot: bool,
    #[serde(default)]
    pub provider: Option<OcrProvider>,
    #[serde(rename = "sourceLang")]
    pub source_lang: Option<String>,
    #[serde(rename = "targetLang")]
    pub target_lang: Option<String>,
}

impl Default for OcrRequest {
    fn default() -> Self {
        Self {
            screenshot: true,
            provider: None,
            source_lang: None,
            target_lang: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ScreenSelection {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(rename = "viewportWidth")]
    pub viewport_width: f64,
    #[serde(rename = "viewportHeight")]
    pub viewport_height: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScreenshotInfo {
    pub path: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct OcrFlowResult {
    pub ok: bool,
    pub text: String,
    pub provider: OcrProvider,
    #[serde(rename = "ocrEngine")]
    pub ocr_engine: String,
    #[serde(rename = "ocrFallbackReason")]
    pub ocr_fallback_reason: Option<String>,
    #[serde(rename = "imagePath")]
    pub image_path: String,
    #[serde(rename = "imageDataUrl")]
    pub image_data_url: Option<String>,
    #[serde(rename = "translatedText")]
    pub translated_text: Option<String>,
    pub model: Option<String>,
    pub error: Option<String>,
    pub phase: Option<String>,
    pub message: Option<String>,
    #[serde(rename = "textBoxes", default)]
    pub text_boxes: Vec<OcrTextBox>,
    #[serde(rename = "translatedRegions", default)]
    pub translated_regions: Vec<ComicTextRegion>,
    #[serde(rename = "imageWidth")]
    pub image_width: Option<u32>,
    #[serde(rename = "imageHeight")]
    pub image_height: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OcrTextBox {
    pub text: String,
    pub score: Option<f32>,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
pub struct OcrBounds {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ComicTextDirection {
    Horizontal,
    Vertical,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ComicTextRegion {
    pub id: String,
    #[serde(rename = "textBounds")]
    pub text_bounds: OcrBounds,
    #[serde(rename = "bubbleBounds")]
    pub bubble_bounds: Option<OcrBounds>,
    #[serde(rename = "sourceText")]
    pub source_text: String,
    #[serde(rename = "translatedText")]
    pub translated_text: Option<String>,
    pub direction: ComicTextDirection,
    #[serde(rename = "readingOrder")]
    pub reading_order: usize,
    pub confidence: Option<f32>,
    #[serde(rename = "lineBoxes")]
    pub line_boxes: Vec<OcrTextBox>,
}

#[derive(Debug, Clone, Serialize)]
struct OcrRawResult {
    text: String,
    boxes: Vec<OcrTextBox>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OcrRecognitionDebug {
    #[serde(rename = "rawText")]
    pub raw_text: String,
    pub text: String,
    #[serde(rename = "textBoxes")]
    pub text_boxes: Vec<OcrTextBox>,
    #[serde(rename = "preprocessedImagePath")]
    pub preprocessed_image_path: Option<String>,
    #[serde(rename = "elapsedMs")]
    pub elapsed_ms: u128,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OcrDebugRecord {
    pub id: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    pub mode: String,
    #[serde(rename = "sourceLang")]
    pub source_lang: String,
    #[serde(rename = "targetLang")]
    pub target_lang: String,
    pub provider: OcrProvider,
    #[serde(rename = "ocrEngine", default)]
    pub ocr_engine: String,
    #[serde(rename = "ocrFallbackReason", default)]
    pub ocr_fallback_reason: Option<String>,
    #[serde(rename = "imagePath")]
    pub image_path: String,
    #[serde(rename = "preprocessedImagePath")]
    pub preprocessed_image_path: Option<String>,
    #[serde(rename = "rawText")]
    pub raw_text: String,
    pub text: String,
    #[serde(rename = "textBoxes", default)]
    pub text_boxes: Vec<OcrTextBox>,
    #[serde(rename = "translatedRegions", default)]
    pub translated_regions: Vec<ComicTextRegion>,
    #[serde(rename = "translatedText")]
    pub translated_text: Option<String>,
    pub model: Option<String>,
    pub ok: bool,
    pub error: Option<String>,
    #[serde(rename = "elapsedMs")]
    pub elapsed_ms: u128,
}

pub fn load_config(app: &AppHandle) -> OcrConfig {
    let Ok(path) = config_path(app) else {
        return OcrConfig::default();
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return OcrConfig::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

pub fn save_config(app: &AppHandle, config: &OcrConfig) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("创建 OCR 配置目录失败: {err}"))?;
    }
    let raw = serde_json::to_string_pretty(config)
        .map_err(|err| format!("序列化 OCR 配置失败: {err}"))?;
    fs::write(path, raw).map_err(|err| format!("写入 OCR 配置失败: {err}"))
}

pub fn capture_primary_screen(app: &AppHandle) -> Result<ScreenshotInfo, String> {
    let screens = Screen::all().map_err(|err| format!("枚举屏幕失败: {err}"))?;
    let screen = screens
        .into_iter()
        .next()
        .ok_or_else(|| "未找到可截图的屏幕".to_string())?;
    let image = screen
        .capture()
        .map_err(|err| format!("屏幕截图失败: {err}"))?;
    let width = image.width();
    let height = image.height();
    let bytes = image
        .to_png(Compression::Fast)
        .map_err(|err| format!("编码屏幕截图失败: {err}"))?;

    let path = cache_file(app, FULL_SCREENSHOT_FILE)?;
    fs::write(&path, bytes).map_err(|err| format!("保存屏幕截图失败: {err}"))?;
    Ok(ScreenshotInfo {
        path: path_to_string(&path),
        width,
        height,
    })
}

pub fn crop_selection(
    app: &AppHandle,
    screenshot: &ScreenshotInfo,
    selection: &ScreenSelection,
) -> Result<PathBuf, String> {
    if selection.width < 8.0 || selection.height < 8.0 {
        return Err("选区太小,请重新框选".to_string());
    }
    if selection.viewport_width <= 0.0 || selection.viewport_height <= 0.0 {
        return Err("截图窗口尺寸无效".to_string());
    }

    let source = image::open(&screenshot.path).map_err(|err| format!("读取截图失败: {err}"))?;
    let (image_width, image_height) = source.dimensions();
    let scale_x = image_width as f64 / selection.viewport_width;
    let scale_y = image_height as f64 / selection.viewport_height;
    let x = (selection.x.max(0.0) * scale_x).floor() as u32;
    let y = (selection.y.max(0.0) * scale_y).floor() as u32;
    let width = (selection.width * scale_x).ceil() as u32;
    let height = (selection.height * scale_y).ceil() as u32;
    let width = width.min(image_width.saturating_sub(x));
    let height = height.min(image_height.saturating_sub(y));
    if width == 0 || height == 0 {
        return Err("选区无效,请重新框选".to_string());
    }

    let cut = source.crop_imm(x, y, width, height);
    let path = cache_file(app, CUT_SCREENSHOT_FILE)?;
    cut.save(&path)
        .map_err(|err| format!("保存裁剪截图失败: {err}"))?;
    Ok(path)
}

pub fn recognize_with_debug(
    app: &AppHandle,
    config: &OcrConfig,
    provider: OcrProvider,
    image_path: &Path,
    lang: &str,
) -> Result<OcrRecognitionDebug, String> {
    let started = Instant::now();
    let preprocessed = if config.preprocess_enabled {
        Some(preprocess_image(app, config, image_path)?)
    } else {
        None
    };
    let ocr_image_path = preprocessed
        .as_ref()
        .map(|image| image.path.as_path())
        .unwrap_or(image_path);
    let raw_result = match provider {
        OcrProvider::WindowsOcr => OcrRawResult {
            text: recognize_windows(ocr_image_path, lang)?,
            boxes: Vec::new(),
        },
        OcrProvider::PaddleocrJson => recognize_paddle(config, ocr_image_path, lang)?,
    };
    let scale = preprocessed.as_ref().map_or(1.0, |image| image.scale);
    let mut text_boxes = normalize_ocr_boxes(raw_result.boxes, lang, scale);
    if config.text_layout_mode == OcrTextLayoutMode::Manga {
        sort_boxes_for_manga(&mut text_boxes);
    }
    let raw_text = if text_boxes.is_empty() {
        raw_result.text
    } else {
        text_boxes
            .iter()
            .map(|item| item.text.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    };
    let text = postprocess_ocr_text(&raw_text, lang, config);
    Ok(OcrRecognitionDebug {
        raw_text,
        text,
        text_boxes,
        preprocessed_image_path: preprocessed
            .as_ref()
            .map(|image| path_to_string(&image.path)),
        elapsed_ms: started.elapsed().as_millis(),
    })
}

pub fn load_debug_records(app: &AppHandle) -> Result<Vec<OcrDebugRecord>, String> {
    let path = debug_records_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path).map_err(|err| format!("读取 OCR 调试记录失败: {err}"))?;
    serde_json::from_str(&raw).map_err(|err| format!("解析 OCR 调试记录失败: {err}"))
}

pub fn save_region_debug_record(
    app: &AppHandle,
    mode: &str,
    source_lang: &str,
    target_lang: &str,
    provider: OcrProvider,
    image_path: &Path,
    recognition: &OcrRecognitionDebug,
    result: &OcrFlowResult,
) -> Result<(), String> {
    let now = Utc::now();
    let record = OcrDebugRecord {
        id: format!("{}-{mode}", now.timestamp_millis()),
        created_at: now.to_rfc3339(),
        mode: mode.to_string(),
        source_lang: source_lang.to_string(),
        target_lang: target_lang.to_string(),
        provider,
        ocr_engine: result.ocr_engine.clone(),
        ocr_fallback_reason: result.ocr_fallback_reason.clone(),
        image_path: path_to_string(image_path),
        preprocessed_image_path: recognition.preprocessed_image_path.clone(),
        raw_text: recognition.raw_text.clone(),
        text: result.text.clone(),
        text_boxes: recognition.text_boxes.clone(),
        translated_regions: result.translated_regions.clone(),
        translated_text: result.translated_text.clone(),
        model: result.model.clone(),
        ok: result.ok,
        error: result.error.clone(),
        elapsed_ms: recognition.elapsed_ms,
    };
    append_debug_record(app, record)
}

pub fn image_data_url(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    Some(format!(
        "data:image/png;base64,{}",
        general_purpose::STANDARD.encode(bytes)
    ))
}

pub fn success_result(
    text: String,
    provider: OcrProvider,
    image_path: &Path,
    translated_text: Option<String>,
    model: Option<String>,
) -> OcrFlowResult {
    OcrFlowResult {
        ok: true,
        text,
        ocr_engine: provider_engine_name(&provider).to_string(),
        ocr_fallback_reason: None,
        provider,
        image_path: path_to_string(image_path),
        image_data_url: image_data_url(image_path),
        translated_text,
        model,
        error: None,
        phase: Some("done".to_string()),
        message: None,
        text_boxes: Vec::new(),
        translated_regions: Vec::new(),
        image_width: None,
        image_height: None,
    }
}

pub fn success_result_without_image(
    text: String,
    provider: OcrProvider,
    image_path: &Path,
    translated_text: Option<String>,
    model: Option<String>,
) -> OcrFlowResult {
    OcrFlowResult {
        ok: true,
        text,
        ocr_engine: provider_engine_name(&provider).to_string(),
        ocr_fallback_reason: None,
        provider,
        image_path: path_to_string(image_path),
        image_data_url: None,
        translated_text,
        model,
        error: None,
        phase: Some("done".to_string()),
        message: None,
        text_boxes: Vec::new(),
        translated_regions: Vec::new(),
        image_width: None,
        image_height: None,
    }
}

pub fn with_comic_layout(
    mut result: OcrFlowResult,
    text_boxes: &[OcrTextBox],
    regions: &[ComicTextRegion],
    image_dimensions: Option<(u32, u32)>,
) -> OcrFlowResult {
    result.text_boxes = text_boxes.to_vec();
    result.translated_regions = regions.to_vec();
    result.image_width = image_dimensions.map(|value| value.0);
    result.image_height = image_dimensions.map(|value| value.1);
    result
}

pub fn with_ocr_engine(
    mut result: OcrFlowResult,
    engine: &str,
    fallback_reason: Option<String>,
) -> OcrFlowResult {
    result.ocr_engine = engine.to_string();
    result.ocr_fallback_reason = fallback_reason;
    result
}

pub fn should_use_comic_detector(config: &OcrConfig) -> bool {
    config.text_layout_mode == OcrTextLayoutMode::Manga
}

pub fn should_use_manga_ocr(config: &OcrConfig, source_lang: &str, text: &str) -> bool {
    let _ = (source_lang, text);
    should_use_comic_detector(config)
}

pub fn join_region_source_text(regions: &[ComicTextRegion]) -> String {
    regions
        .iter()
        .map(|region| region.source_text.trim())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn provider_engine_name(provider: &OcrProvider) -> &'static str {
    match provider {
        OcrProvider::WindowsOcr => "Windows OCR",
        OcrProvider::PaddleocrJson => "PaddleOCR-json",
    }
}

pub fn build_comic_text_regions(
    text_boxes: &[OcrTextBox],
    source_lang: &str,
) -> Vec<ComicTextRegion> {
    let candidates = text_boxes
        .iter()
        .filter(|item| item.width > 8.0 && item.height > 8.0 && !item.text.trim().is_empty())
        .cloned()
        .take(64)
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return Vec::new();
    }

    let mut groups: Vec<Vec<OcrTextBox>> = Vec::new();
    for candidate in candidates {
        let candidate_direction = infer_box_direction(&candidate, source_lang);
        let mut best_group: Option<(usize, f32)> = None;
        for (index, group) in groups.iter().enumerate() {
            let group_direction = infer_group_direction(group, source_lang);
            if group_direction != candidate_direction {
                continue;
            }
            let score = group_merge_score(group, &candidate, group_direction);
            if score > 0.0 && best_group.is_none_or(|value| score > value.1) {
                best_group = Some((index, score));
            }
        }

        if let Some((index, _)) = best_group {
            groups[index].push(candidate);
        } else {
            groups.push(vec![candidate]);
        }
    }

    let page_vertical = source_lang_is_japanese(source_lang)
        && groups
            .iter()
            .filter(|group| {
                infer_group_direction(group, source_lang) == ComicTextDirection::Vertical
            })
            .count()
            * 2
            >= groups.len();

    let mut regions = groups
        .into_iter()
        .filter_map(|mut group| {
            let direction = infer_group_direction(&group, source_lang);
            sort_region_lines(&mut group, direction);
            let bounds = bounds_for_boxes(&group)?;
            let source_text = join_region_text(&group, source_lang);
            if source_text.is_empty() {
                return None;
            }
            let scores = group
                .iter()
                .filter_map(|item| item.score)
                .collect::<Vec<_>>();
            let confidence =
                (!scores.is_empty()).then(|| scores.iter().sum::<f32>() / scores.len() as f32);
            Some(ComicTextRegion {
                id: String::new(),
                text_bounds: bounds,
                bubble_bounds: None,
                source_text,
                translated_text: None,
                direction,
                reading_order: 0,
                confidence,
                line_boxes: group,
            })
        })
        .collect::<Vec<_>>();

    regions.sort_by(|a, b| compare_region_order(a, b, page_vertical));
    for (index, region) in regions.iter_mut().enumerate() {
        region.reading_order = index;
        region.id = format!("region_{:02}", index + 1);
    }
    regions
}

fn infer_box_direction(item: &OcrTextBox, source_lang: &str) -> ComicTextDirection {
    if item.height > item.width * 1.35
        && (source_lang_is_japanese(source_lang) || item.height > item.width * 2.0)
    {
        ComicTextDirection::Vertical
    } else {
        ComicTextDirection::Horizontal
    }
}

fn infer_group_direction(group: &[OcrTextBox], source_lang: &str) -> ComicTextDirection {
    let vertical = group
        .iter()
        .filter(|item| infer_box_direction(item, source_lang) == ComicTextDirection::Vertical)
        .count();
    if vertical * 2 > group.len() {
        ComicTextDirection::Vertical
    } else {
        ComicTextDirection::Horizontal
    }
}

fn group_merge_score(
    group: &[OcrTextBox],
    candidate: &OcrTextBox,
    direction: ComicTextDirection,
) -> f32 {
    group
        .iter()
        .filter_map(|item| box_merge_score(item, candidate, direction))
        .fold(0.0, f32::max)
}

fn box_merge_score(
    first: &OcrTextBox,
    second: &OcrTextBox,
    direction: ComicTextDirection,
) -> Option<f32> {
    let first_right = first.x + first.width;
    let second_right = second.x + second.width;
    let first_bottom = first.y + first.height;
    let second_bottom = second.y + second.height;
    let gap_x = (first.x - second_right)
        .max(second.x - first_right)
        .max(0.0);
    let gap_y = (first.y - second_bottom)
        .max(second.y - first_bottom)
        .max(0.0);
    let overlap_x = (first_right.min(second_right) - first.x.max(second.x)).max(0.0);
    let overlap_y = (first_bottom.min(second_bottom) - first.y.max(second.y)).max(0.0);
    let overlap_x_ratio = overlap_x / first.width.min(second.width).max(1.0);
    let overlap_y_ratio = overlap_y / first.height.min(second.height).max(1.0);
    let typical_height = first.height.max(second.height).max(12.0);
    let typical_width = first.width.max(second.width).max(12.0);

    let related = match direction {
        ComicTextDirection::Horizontal => {
            let stacked = overlap_x_ratio >= 0.22 && gap_y <= typical_height * 1.45;
            let same_line = overlap_y_ratio >= 0.45 && gap_x <= typical_height * 2.4;
            stacked || same_line
        }
        ComicTextDirection::Vertical => {
            let same_column = overlap_x_ratio >= 0.4 && gap_y <= typical_width * 1.8;
            let adjacent_columns = overlap_y_ratio >= 0.24 && gap_x <= typical_width * 1.45;
            same_column || adjacent_columns
        }
    };
    related.then(|| overlap_x_ratio + overlap_y_ratio + 1.0 / (1.0 + gap_x + gap_y))
}

fn bounds_for_boxes(boxes: &[OcrTextBox]) -> Option<OcrBounds> {
    let first = boxes.first()?;
    let mut left = first.x;
    let mut top = first.y;
    let mut right = first.x + first.width;
    let mut bottom = first.y + first.height;
    for item in &boxes[1..] {
        left = left.min(item.x);
        top = top.min(item.y);
        right = right.max(item.x + item.width);
        bottom = bottom.max(item.y + item.height);
    }
    Some(OcrBounds {
        x: left,
        y: top,
        width: (right - left).max(0.0),
        height: (bottom - top).max(0.0),
    })
}

fn sort_region_lines(boxes: &mut [OcrTextBox], direction: ComicTextDirection) {
    boxes.sort_by(|a, b| match direction {
        ComicTextDirection::Horizontal => {
            a.y.partial_cmp(&b.y)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal))
        }
        ComicTextDirection::Vertical => {
            b.x.partial_cmp(&a.x)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.y.partial_cmp(&b.y).unwrap_or(std::cmp::Ordering::Equal))
        }
    });
}

fn join_region_text(boxes: &[OcrTextBox], source_lang: &str) -> String {
    let separator = if source_lang_is_cjk(source_lang) {
        ""
    } else {
        " "
    };
    boxes
        .iter()
        .map(|item| item.text.trim())
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>()
        .join(separator)
}

fn compare_region_order(
    first: &ComicTextRegion,
    second: &ComicTextRegion,
    page_vertical: bool,
) -> std::cmp::Ordering {
    if page_vertical {
        return second
            .text_bounds
            .x
            .partial_cmp(&first.text_bounds.x)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                first
                    .text_bounds
                    .y
                    .partial_cmp(&second.text_bounds.y)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
    }
    first
        .text_bounds
        .y
        .partial_cmp(&second.text_bounds.y)
        .unwrap_or(std::cmp::Ordering::Equal)
        .then_with(|| {
            first
                .text_bounds
                .x
                .partial_cmp(&second.text_bounds.x)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
}

fn source_lang_is_japanese(source_lang: &str) -> bool {
    matches!(source_lang, "ja" | "ja-JP" | "jp" | "日本語" | "日语")
}

fn source_lang_is_cjk(source_lang: &str) -> bool {
    source_lang_is_japanese(source_lang)
        || matches!(
            source_lang,
            "zh" | "zh-CN"
                | "zh-TW"
                | "zh-Hans"
                | "zh-Hant"
                | "中文"
                | "简体中文"
                | "繁體中文"
                | "繁体中文"
                | "ko"
                | "ko-KR"
                | "한국어"
                | "韩语"
        )
}

pub fn error_result(
    error: String,
    provider: OcrProvider,
    image_path: Option<&Path>,
) -> OcrFlowResult {
    OcrFlowResult {
        ok: false,
        text: String::new(),
        ocr_engine: provider_engine_name(&provider).to_string(),
        ocr_fallback_reason: None,
        provider,
        image_path: image_path.map(path_to_string).unwrap_or_default(),
        image_data_url: image_path.and_then(image_data_url),
        translated_text: None,
        model: None,
        error: Some(error),
        phase: Some("error".to_string()),
        message: None,
        text_boxes: Vec::new(),
        translated_regions: Vec::new(),
        image_width: None,
        image_height: None,
    }
}

pub fn error_result_without_image(
    error: String,
    provider: OcrProvider,
    image_path: Option<&Path>,
) -> OcrFlowResult {
    OcrFlowResult {
        ok: false,
        text: String::new(),
        ocr_engine: provider_engine_name(&provider).to_string(),
        ocr_fallback_reason: None,
        provider,
        image_path: image_path.map(path_to_string).unwrap_or_default(),
        image_data_url: None,
        translated_text: None,
        model: None,
        error: Some(error),
        phase: Some("error".to_string()),
        message: None,
        text_boxes: Vec::new(),
        translated_regions: Vec::new(),
        image_width: None,
        image_height: None,
    }
}

fn default_screenshot() -> bool {
    true
}

fn default_true() -> bool {
    true
}

fn default_preprocess_scale() -> u32 {
    2
}

fn default_preprocess_contrast() -> f32 {
    18.0
}

fn default_paddle_min_score() -> f32 {
    0.45
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|err| format!("获取应用数据目录失败: {err}"))?
        .join(OCR_CONFIG_FILE))
}

fn debug_records_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|err| format!("获取应用数据目录失败: {err}"))?
        .join(OCR_DEBUG_RECORDS_FILE))
}

fn cache_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|err| format!("获取应用缓存目录失败: {err}"))?;
    fs::create_dir_all(&dir).map_err(|err| format!("创建应用缓存目录失败: {err}"))?;
    Ok(dir.join(name))
}

fn append_debug_record(app: &AppHandle, record: OcrDebugRecord) -> Result<(), String> {
    let path = debug_records_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("创建 OCR 调试目录失败: {err}"))?;
    }

    let mut records = if path.exists() {
        let raw = fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str::<Vec<OcrDebugRecord>>(&raw).unwrap_or_default()
    } else {
        Vec::new()
    };
    records.insert(0, record);
    records.truncate(OCR_DEBUG_RECORD_LIMIT);

    let raw = serde_json::to_string_pretty(&records)
        .map_err(|err| format!("序列化 OCR 调试记录失败: {err}"))?;
    fs::write(&path, raw).map_err(|err| format!("写入 OCR 调试记录失败: {err}"))
}

fn preprocess_image(
    app: &AppHandle,
    config: &OcrConfig,
    image_path: &Path,
) -> Result<PreprocessedOcrImage, String> {
    let mut image = image::open(image_path).map_err(|err| format!("读取 OCR 图片失败: {err}"))?;
    let (width, height, scale) = bounded_preprocess_dimensions(
        image.width(),
        image.height(),
        config.preprocess_scale.clamp(1, 4),
    );
    if width != image.width() || height != image.height() {
        image = image.resize_exact(width, height, FilterType::CatmullRom);
    }
    if config.preprocess_grayscale {
        image = image.grayscale();
    }
    let contrast = config.preprocess_contrast.clamp(-60.0, 80.0);
    if contrast.abs() > f32::EPSILON {
        image = image.adjust_contrast(contrast);
    }
    if config.preprocess_sharpen {
        image = image.unsharpen(1.0, 1);
    }
    if config.preprocess_threshold {
        image = threshold_image(image);
    }

    let path = cache_file(app, PREPROCESSED_OCR_FILE)?;
    image
        .save(&path)
        .map_err(|err| format!("保存 OCR 预处理图片失败: {err}"))?;
    Ok(PreprocessedOcrImage { path, scale })
}

fn bounded_preprocess_dimensions(width: u32, height: u32, requested_scale: u32) -> (u32, u32, f32) {
    let width = width.max(1);
    let height = height.max(1);
    let requested_scale = requested_scale.clamp(1, 4) as f32;
    let max_edge = width.max(height) as f32;
    let scale = requested_scale
        .min(MAX_PADDLE_PREPROCESS_EDGE as f32 / max_edge)
        .max(1.0 / max_edge);
    let output_width = ((width as f32 * scale).round() as u32).max(1);
    let output_height = ((height as f32 * scale).round() as u32).max(1);
    let actual_scale = output_width as f32 / width as f32;
    (output_width, output_height, actual_scale)
}

fn threshold_image(image: DynamicImage) -> DynamicImage {
    let mut gray = image.to_luma8();
    for pixel in gray.pixels_mut() {
        pixel.0[0] = if pixel.0[0] >= 168 { 255 } else { 0 };
    }
    DynamicImage::ImageLuma8(gray)
}

fn recognize_paddle(
    config: &OcrConfig,
    image_path: &Path,
    lang: &str,
) -> Result<OcrRawResult, String> {
    if config.paddle_exe_path.trim().is_empty() {
        return Err("未配置 PaddleOCR-json.exe 路径".to_string());
    }
    let exe = PathBuf::from(config.paddle_exe_path.trim());
    if !exe.exists() {
        return Err(format!("PaddleOCR-json.exe 不存在: {}", exe.display()));
    }

    let mut command = Command::new(&exe);
    if let Some(parent) = exe.parent() {
        command.current_dir(parent);
    }
    command.arg(format!("-image_path={}", image_path.display()));
    if !config.paddle_models_path.trim().is_empty() {
        command.arg(format!("-models_path={}", config.paddle_models_path.trim()));
    }
    let config_path = paddle_config_path_for_lang(config, lang, &exe)?;
    command.arg(format!("-config_path={}", config_path.display()));

    let output = command
        .output()
        .map_err(|err| format!("启动 PaddleOCR-json 失败: {err}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        return Err(compact_paddle_error(
            &stdout,
            &stderr,
            &format!("PaddleOCR-json 退出失败: {}", output.status),
        ));
    }

    parse_paddle_output(&stdout, config.paddle_min_score).map_err(|err| {
        let detail = compact_paddle_error(&stdout, &stderr, "");
        if detail.is_empty() || detail == err {
            err
        } else {
            format!("{err}: {detail}")
        }
    })
}

fn paddle_config_path_for_lang(
    config: &OcrConfig,
    lang: &str,
    exe_path: &Path,
) -> Result<PathBuf, String> {
    let manual = config.paddle_config_path.trim();
    if !manual.is_empty() {
        let path = PathBuf::from(manual);
        return if path.is_file() {
            Ok(path)
        } else {
            Err(format!("PaddleOCR 配置文件不存在: {}", path.display()))
        };
    }

    let models_path = config.paddle_models_path.trim();
    let models_path = if models_path.is_empty() {
        exe_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("models")
    } else {
        PathBuf::from(models_path)
    };

    let config_file = match lang {
        "ja-JP" | "ja" | "日本語" | "日语" => "config_japan.txt",
        "zh-TW" | "zh-Hant" | "zh-HK" | "繁體中文" | "繁体中文" => "config_chinese_cht.txt",
        "zh-CN" | "zh-Hans" | "简体中文" | "中文" => "config_chinese.txt",
        "en-US" | "en" | "English" | "英语" => "config_en.txt",
        "ko-KR" | "ko" | "한국어" | "韩语" => "config_korean.txt",
        // PaddleOCR-json does not auto-select recognition models. Its Chinese
        // model is the broadest bundled fallback and also recognizes Latin text.
        "auto" | "自动识别" => "config_chinese.txt",
        _ => "config_chinese.txt",
    };
    let path = models_path.join(config_file);
    if path.is_file() {
        Ok(path)
    } else {
        Err(format!(
            "未找到 PaddleOCR {} 模型配置: {}",
            lang,
            path.display()
        ))
    }
}

fn compact_paddle_error(stdout: &str, stderr: &str, fallback: &str) -> String {
    let messages = stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| !line.chars().all(|value| value == '-'))
        .filter(|line| !line.contains("fused 0 elementwise_"))
        .filter(|line| !line.contains(" activation"))
        .filter(|line| !line.starts_with("PaddleOCR-json v"))
        .filter(|line| !line.starts_with("OCR single image mode"))
        .filter(|line| !line.starts_with("OCR init completed"))
        .filter(|line| !line.starts_with("Load config from"))
        .filter(|line| *line != "C++ Traceback (most recent call last):")
        .filter(|line| *line != "Error Message Summary:")
        .filter(|line| *line != "Not support stack backtrace yet.")
        .map(|line| {
            line.trim_start_matches('\u{1b}')
                .trim_start_matches("e[37m")
                .trim_end_matches("e[0m")
                .trim()
                .to_string()
        })
        .collect::<Vec<_>>();
    let mut actionable = messages
        .iter()
        .filter(|line| {
            let lower = line.to_lowercase();
            lower.contains("error")
                || lower.contains("fail")
                || lower.contains("does not exist")
                || lower.contains("not found")
        })
        .cloned()
        .collect::<Vec<_>>();
    if actionable.is_empty() {
        actionable = messages;
    }
    actionable.dedup();
    actionable.truncate(3);
    if actionable.is_empty() {
        fallback.to_string()
    } else {
        actionable.join("；")
    }
}

fn parse_paddle_output(stdout: &str, min_score: f32) -> Result<OcrRawResult, String> {
    let Some(line) = stdout
        .lines()
        .rev()
        .find(|line| line.trim_start().starts_with('{'))
    else {
        return Err("PaddleOCR-json 未返回 JSON".to_string());
    };
    let value: Value =
        serde_json::from_str(line).map_err(|err| format!("解析 PaddleOCR-json 输出失败: {err}"))?;
    let code = value
        .get("code")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    match code {
        100 => {
            let boxes = value
                .get("data")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter(|item| match item.get("score").and_then(Value::as_f64) {
                            Some(score) => score >= min_score.clamp(0.0, 1.0) as f64,
                            None => true,
                        })
                        .filter_map(parse_paddle_text_box)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let text = boxes
                .iter()
                .map(|item| item.text.as_str())
                .collect::<Vec<_>>()
                .join("\n")
                .trim()
                .to_string();
            Ok(OcrRawResult { text, boxes })
        }
        101 => Ok(OcrRawResult {
            text: String::new(),
            boxes: Vec::new(),
        }),
        _ => Err(value
            .get("data")
            .map(Value::to_string)
            .unwrap_or_else(|| json!(value).to_string())),
    }
}

fn parse_paddle_text_box(item: &Value) -> Option<OcrTextBox> {
    let text = item.get("text").and_then(Value::as_str)?.trim().to_string();
    if text.is_empty() {
        return None;
    }
    let score = item
        .get("score")
        .and_then(Value::as_f64)
        .map(|value| value as f32);
    let (x, y, width, height) = item
        .get("box")
        .and_then(parse_paddle_box_bounds)
        .unwrap_or((0.0, 0.0, 0.0, 0.0));
    Some(OcrTextBox {
        text,
        score,
        x,
        y,
        width,
        height,
    })
}

fn parse_paddle_box_bounds(value: &Value) -> Option<(f32, f32, f32, f32)> {
    let points = value.as_array()?;
    let mut xs = Vec::new();
    let mut ys = Vec::new();

    for point in points {
        if let Some(pair) = point.as_array() {
            if pair.len() >= 2 {
                if let (Some(x), Some(y)) = (pair[0].as_f64(), pair[1].as_f64()) {
                    xs.push(x as f32);
                    ys.push(y as f32);
                }
            }
        }
    }

    if xs.is_empty() && points.len() >= 8 {
        for chunk in points.chunks(2) {
            if chunk.len() == 2 {
                if let (Some(x), Some(y)) = (chunk[0].as_f64(), chunk[1].as_f64()) {
                    xs.push(x as f32);
                    ys.push(y as f32);
                }
            }
        }
    }

    if xs.is_empty() || ys.is_empty() {
        return None;
    }

    let min_x = xs.iter().copied().fold(f32::INFINITY, f32::min);
    let max_x = xs.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let min_y = ys.iter().copied().fold(f32::INFINITY, f32::min);
    let max_y = ys.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    Some((
        min_x,
        min_y,
        (max_x - min_x).max(0.0),
        (max_y - min_y).max(0.0),
    ))
}

fn normalize_ocr_boxes(mut boxes: Vec<OcrTextBox>, lang: &str, scale: f32) -> Vec<OcrTextBox> {
    let scale = scale.max(1.0);
    boxes
        .drain(..)
        .filter_map(|mut item| {
            item.text = normalize_ocr_line(&clean_ocr_text(&item.text, lang));
            if item.text.is_empty() || looks_like_noise_line(&item.text) {
                return None;
            }
            item.x /= scale;
            item.y /= scale;
            item.width /= scale;
            item.height /= scale;
            Some(item)
        })
        .collect()
}

fn sort_boxes_for_manga(boxes: &mut [OcrTextBox]) {
    boxes.sort_by(|a, b| {
        let right_to_left = b.x.partial_cmp(&a.x).unwrap_or(std::cmp::Ordering::Equal);
        if (a.x - b.x).abs() > a.width.max(b.width).max(24.0) * 0.6 {
            return right_to_left;
        }
        a.y.partial_cmp(&b.y).unwrap_or(std::cmp::Ordering::Equal)
    });
}

#[cfg(windows)]
fn recognize_windows(image_path: &Path, lang: &str) -> Result<String, String> {
    use windows::core::HSTRING;
    use windows::Globalization::Language;
    use windows::Graphics::Imaging::BitmapDecoder;
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::{FileAccessMode, StorageFile};

    let path = image_path.to_string_lossy().replace("\\\\?\\", "");
    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path))
        .map_err(|err| err.to_string())?
        .get()
        .map_err(|err| err.to_string())?;
    let stream = file
        .OpenAsync(FileAccessMode::Read)
        .map_err(|err| err.to_string())?
        .get()
        .map_err(|err| err.to_string())?;
    let decoder = BitmapDecoder::CreateWithIdAsync(
        BitmapDecoder::PngDecoderId().map_err(|err| err.to_string())?,
        &stream,
    )
    .map_err(|err| err.to_string())?
    .get()
    .map_err(|err| err.to_string())?;
    let bitmap = decoder
        .GetSoftwareBitmapAsync()
        .map_err(|err| err.to_string())?
        .get()
        .map_err(|err| err.to_string())?;

    let engine = if lang == "auto" {
        OcrEngine::TryCreateFromUserProfileLanguages()
    } else {
        let language = Language::CreateLanguage(&HSTRING::from(lang))
            .map_err(|_| "OCR 语言代码无效".to_string())?;
        OcrEngine::TryCreateFromLanguage(&language)
    }
    .map_err(|err| {
        let message = err.to_string();
        if message.contains("0x00000000") {
            "Windows OCR 语言包未安装,请在系统语言设置里安装对应 OCR 语言包".to_string()
        } else {
            message
        }
    })?;

    let text = engine
        .RecognizeAsync(&bitmap)
        .map_err(|err| err.to_string())?
        .get()
        .map_err(|err| err.to_string())?
        .Text()
        .map_err(|err| err.to_string())?
        .to_string_lossy();
    Ok(clean_ocr_text(&text, lang))
}

#[cfg(not(windows))]
fn recognize_windows(_image_path: &Path, _lang: &str) -> Result<String, String> {
    Err("Windows OCR 只在 Windows 上可用".to_string())
}

fn clean_ocr_text(text: &str, lang: &str) -> String {
    let text = text.trim();
    if matches!(lang, "zh-CN" | "zh-TW" | "zh-HK" | "ja-JP") {
        text.replace(' ', "")
    } else {
        text.to_string()
    }
}

fn postprocess_ocr_text(text: &str, lang: &str, config: &OcrConfig) -> String {
    let basic = clean_ocr_text(text, lang);
    if !config.text_postprocess_enabled {
        return basic;
    }

    let mut seen_adjacent = String::new();
    let mut lines = Vec::new();
    for raw_line in basic.replace("\r\n", "\n").replace('\r', "\n").lines() {
        let line = normalize_ocr_line(raw_line);
        if line.is_empty() || looks_like_noise_line(&line) {
            continue;
        }
        let key = line.to_lowercase();
        if key == seen_adjacent {
            continue;
        }
        seen_adjacent = key;
        lines.push(line);
    }

    match resolve_text_layout_mode(&lines, config) {
        OcrTextLayoutMode::Preserve => lines.join("\n"),
        OcrTextLayoutMode::Manga => lines.join("\n"),
        OcrTextLayoutMode::Conservative => merge_ocr_lines(&lines, MergeProfile::Conservative),
        OcrTextLayoutMode::Paragraph => merge_ocr_lines(&lines, MergeProfile::Paragraph),
        OcrTextLayoutMode::Auto => merge_ocr_lines(&lines, MergeProfile::Conservative),
    }
}

fn normalize_ocr_line(line: &str) -> String {
    let collapsed = line.split_whitespace().collect::<Vec<_>>().join(" ");
    remove_cjk_spacing(&collapsed).trim().to_string()
}

fn remove_cjk_spacing(value: &str) -> String {
    let chars = value.chars().collect::<Vec<_>>();
    let mut output = String::new();
    for (index, ch) in chars.iter().enumerate() {
        if ch.is_whitespace() {
            let previous = index.checked_sub(1).and_then(|idx| chars.get(idx)).copied();
            let next = chars.get(index + 1).copied();
            if previous.is_some_and(is_cjk_like) && next.is_some_and(is_cjk_like) {
                continue;
            }
        }
        output.push(*ch);
    }
    output
}

fn looks_like_noise_line(line: &str) -> bool {
    let mut meaningful = 0;
    for ch in line.chars() {
        if ch.is_alphanumeric() || is_cjk_like(ch) {
            meaningful += 1;
        }
    }
    meaningful == 0 || (meaningful == 1 && line.chars().count() <= 2)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MergeProfile {
    Conservative,
    Paragraph,
}

fn resolve_text_layout_mode(lines: &[String], config: &OcrConfig) -> OcrTextLayoutMode {
    match config.text_layout_mode {
        OcrTextLayoutMode::Auto => auto_text_layout_mode(lines),
        OcrTextLayoutMode::Preserve => OcrTextLayoutMode::Preserve,
        OcrTextLayoutMode::Conservative => OcrTextLayoutMode::Conservative,
        OcrTextLayoutMode::Paragraph => OcrTextLayoutMode::Paragraph,
        OcrTextLayoutMode::Manga => OcrTextLayoutMode::Manga,
    }
}

fn auto_text_layout_mode(lines: &[String]) -> OcrTextLayoutMode {
    if lines.len() <= 1 {
        return OcrTextLayoutMode::Preserve;
    }

    let mut structural = 0usize;
    let mut short = 0usize;
    let mut long = 0usize;
    let mut wrapped_pairs = 0usize;
    let mut total_chars = 0usize;

    for line in lines {
        let count = line.chars().count();
        total_chars += count;
        if is_structural_line(line) {
            structural += 1;
        }
        if count <= 18 {
            short += 1;
        }
        if count >= 42 {
            long += 1;
        }
    }

    for pair in lines.windows(2) {
        if should_join_lines(&pair[0], &pair[1], MergeProfile::Conservative) {
            wrapped_pairs += 1;
        }
    }

    let line_count = lines.len();
    let average_len = total_chars / line_count.max(1);
    if structural >= 2 && structural * 3 >= line_count {
        return OcrTextLayoutMode::Preserve;
    }
    if short * 2 > line_count && long == 0 {
        return OcrTextLayoutMode::Preserve;
    }
    if long >= 2 && average_len >= 34 {
        return OcrTextLayoutMode::Paragraph;
    }
    if line_count >= 4 && average_len >= 48 && wrapped_pairs >= 2 {
        return OcrTextLayoutMode::Paragraph;
    }
    OcrTextLayoutMode::Conservative
}

fn merge_ocr_lines(lines: &[String], profile: MergeProfile) -> String {
    let mut merged = String::new();
    let mut previous_line: Option<&str> = None;
    for line in lines {
        if merged.is_empty() {
            merged.push_str(line);
            previous_line = Some(line);
            continue;
        }
        let previous = previous_line.unwrap_or_default();
        if should_join_lines(previous, line, profile) {
            let separator = join_separator(previous, line);
            merged.push_str(separator);
        } else {
            merged.push('\n');
        }
        merged.push_str(line);
        previous_line = Some(line);
    }
    merged
}

fn should_join_lines(previous: &str, current: &str, profile: MergeProfile) -> bool {
    let previous = previous.trim();
    let current = current.trim();
    if previous.is_empty() || current.is_empty() {
        return false;
    }
    if is_structural_line(previous) || is_structural_line(current) {
        return false;
    }

    let previous_end = previous.chars().rev().find(|ch| !ch.is_whitespace());
    let current_start = current.chars().find(|ch| !ch.is_whitespace());
    if current_start.is_some_and(|ch| ch.is_lowercase()) {
        return true;
    }
    if looks_like_standalone_label(previous) || looks_like_standalone_label(current) {
        return false;
    }
    if previous_end.is_some_and(is_sentence_end) {
        return profile == MergeProfile::Paragraph && !starts_like_new_block(current);
    }
    if previous_end == Some('-') {
        return true;
    }
    if previous_end.is_some_and(is_cjk_like) && current_start.is_some_and(is_cjk_like) {
        return true;
    }
    let previous_len = previous.chars().count();
    let current_len = current.chars().count();
    match profile {
        MergeProfile::Conservative => {
            previous_len >= 24 && current_len >= 24 && !looks_like_title_case(current)
        }
        MergeProfile::Paragraph => previous_len >= 12 && current_len >= 12,
    }
}

fn join_separator(previous: &str, current: &str) -> &'static str {
    let previous_end = previous.chars().rev().find(|ch| !ch.is_whitespace());
    let current_start = current.chars().find(|ch| !ch.is_whitespace());
    if previous_end == Some('-') {
        return "";
    }
    if previous_end.is_some_and(is_cjk_like) && current_start.is_some_and(is_cjk_like) {
        return "";
    }
    " "
}

fn is_structural_line(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return true;
    }
    if trimmed.starts_with('#')
        || trimmed.starts_with('>')
        || trimmed.starts_with("|")
        || trimmed.ends_with('|')
    {
        return true;
    }
    if ["- ", "* ", "+ ", "• ", "· "]
        .iter()
        .any(|prefix| trimmed.starts_with(prefix))
    {
        return true;
    }
    is_ordered_list_item(trimmed)
}

fn is_ordered_list_item(line: &str) -> bool {
    let mut chars = line.chars().peekable();
    let mut digits = 0usize;
    while chars.peek().is_some_and(|ch| ch.is_ascii_digit()) {
        digits += 1;
        chars.next();
    }
    if digits == 0 || digits > 3 {
        return false;
    }
    let Some(marker) = chars.next() else {
        return false;
    };
    if !matches!(marker, '.' | ')' | '、') {
        return false;
    }
    chars.peek().is_none_or(|ch| ch.is_whitespace())
}

fn looks_like_standalone_label(line: &str) -> bool {
    let trimmed = line.trim();
    let count = trimmed.chars().count();
    if count <= 2 {
        return true;
    }
    if count <= 18 && !trimmed.chars().any(is_sentence_end) {
        return true;
    }
    false
}

fn starts_like_new_block(line: &str) -> bool {
    is_structural_line(line) || looks_like_title_case(line) || looks_like_standalone_label(line)
}

fn looks_like_title_case(line: &str) -> bool {
    let words = line
        .split_whitespace()
        .filter(|word| word.chars().any(|ch| ch.is_alphabetic()))
        .take(6)
        .collect::<Vec<_>>();
    if words.is_empty() || words.len() > 5 {
        return false;
    }
    let uppercase_words = words
        .iter()
        .filter(|word| word.chars().next().is_some_and(|ch| ch.is_uppercase()))
        .count();
    uppercase_words >= words.len().saturating_sub(1)
}

fn is_sentence_end(ch: char) -> bool {
    matches!(
        ch,
        '.' | '!' | '?' | ':' | ';' | '。' | '！' | '？' | '：' | '；' | '」' | '』' | '）' | ')'
    )
}

fn is_cjk_like(ch: char) -> bool {
    matches!(
        ch,
        '\u{3040}'..='\u{30ff}'
            | '\u{3400}'..='\u{4dbf}'
            | '\u{4e00}'..='\u{9fff}'
            | '\u{ac00}'..='\u{d7af}'
            | '\u{f900}'..='\u{faff}'
    )
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().replace("\\\\?\\", "")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    fn text_box(text: &str, x: f32, y: f32, width: f32, height: f32) -> OcrTextBox {
        OcrTextBox {
            text: text.to_string(),
            score: Some(0.95),
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn comic_regions_merge_lines_but_keep_distant_bubbles_separate() {
        let regions = build_comic_text_regions(
            &[
                text_box("I wonder if", 600.0, 120.0, 180.0, 30.0),
                text_box("there are rumors", 585.0, 158.0, 210.0, 30.0),
                text_box("about me", 620.0, 196.0, 140.0, 30.0),
                text_box("Maybe I should", 260.0, 430.0, 190.0, 30.0),
                text_box("go back home", 275.0, 468.0, 165.0, 30.0),
            ],
            "en-US",
        );

        assert_eq!(regions.len(), 2);
        assert_eq!(regions[0].id, "region_01");
        assert_eq!(
            regions[0].source_text,
            "I wonder if there are rumors about me"
        );
        assert_eq!(regions[0].line_boxes.len(), 3);
        assert_eq!(regions[1].source_text, "Maybe I should go back home");
    }

    #[test]
    fn comic_regions_sort_japanese_vertical_columns_right_to_left() {
        let regions = build_comic_text_regions(
            &[
                text_box("左", 120.0, 80.0, 28.0, 120.0),
                text_box("右", 220.0, 70.0, 28.0, 120.0),
            ],
            "ja-JP",
        );

        assert_eq!(regions.len(), 2);
        assert_eq!(regions[0].source_text, "右");
        assert_eq!(regions[1].source_text, "左");
        assert_eq!(regions[0].direction, ComicTextDirection::Vertical);
    }

    #[test]
    fn manga_ocr_dispatch_follows_explicit_manga_mode() {
        let mut config = OcrConfig {
            text_layout_mode: OcrTextLayoutMode::Manga,
            ..OcrConfig::default()
        };

        assert!(should_use_manga_ocr(&config, "ja-JP", "ignored"));
        assert!(should_use_manga_ocr(&config, "auto", ""));
        assert!(should_use_manga_ocr(&config, "en-US", "ignored"));

        config.text_layout_mode = OcrTextLayoutMode::Auto;
        assert!(!should_use_manga_ocr(&config, "ja-JP", "ignored"));
    }

    #[test]
    fn paddle_auto_language_uses_bundled_chinese_config() {
        let root =
            std::env::temp_dir().join(format!("tabkeep-paddle-config-{}", std::process::id()));
        let models = root.join("models");
        fs::create_dir_all(&models).expect("create test models directory");
        fs::write(models.join("config_chinese.txt"), "# test").expect("write test config");

        let config = OcrConfig::default();
        let resolved =
            paddle_config_path_for_lang(&config, "auto", &root.join("PaddleOCR-json.exe"))
                .expect("resolve auto config");

        assert_eq!(resolved, models.join("config_chinese.txt"));
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn paddle_manual_config_reports_missing_file_before_launch() {
        let config = OcrConfig {
            paddle_config_path: "Z:\\missing\\config_japan.txt".to_string(),
            ..OcrConfig::default()
        };

        let error = paddle_config_path_for_lang(&config, "ja-JP", Path::new("PaddleOCR-json.exe"))
            .expect_err("missing config should fail");

        assert!(error.contains("PaddleOCR 配置文件不存在"));
    }

    #[test]
    fn paddle_error_output_hides_fusion_noise() {
        let error = compact_paddle_error(
            "config_path [] does not exist.\ne[37m--- fused 0 elementwise_add with relu activatione[0m",
            "",
            "fallback",
        );

        assert_eq!(error, "config_path [] does not exist.");
    }

    #[test]
    fn paddle_error_output_keeps_resource_exhaustion_reason() {
        let error = compact_paddle_error(
            "",
            "--------------------------------------\nC++ Traceback (most recent call last):\n\
             ResourceExhaustedError: Fail to alloc memory of 524288000 size.\n\
             e[37m--- fused 0 elementwise_add with relu activatione[0m",
            "fallback",
        );

        assert!(error.contains("ResourceExhaustedError"));
        assert!(!error.contains("elementwise_add"));
    }

    #[test]
    fn preprocess_scale_is_bounded_for_large_manga_pages() {
        let (width, height, scale) = bounded_preprocess_dimensions(1380, 992, 2);

        assert_eq!(width, 1600);
        assert_eq!(height, 1150);
        assert!((scale - 1.1594).abs() < 0.001);
    }

    #[test]
    fn preprocess_can_downscale_oversized_regions() {
        let (width, height, scale) = bounded_preprocess_dimensions(3200, 2400, 1);

        assert_eq!((width, height), (1600, 1200));
        assert_eq!(scale, 0.5);
    }

    #[test]
    fn conservative_merges_obvious_visual_wraps() {
        let merged = merge_ocr_lines(
            &lines(&[
                "You will",
                "see references to RAG frequently in this documentation.",
            ]),
            MergeProfile::Conservative,
        );
        assert_eq!(
            merged,
            "You will see references to RAG frequently in this documentation."
        );
    }

    #[test]
    fn conservative_preserves_lists_and_short_labels() {
        let merged = merge_ocr_lines(
            &lines(&["Stages within RAG", "1. Indexing", "2. Retrieval"]),
            MergeProfile::Conservative,
        );
        assert_eq!(merged, "Stages within RAG\n1. Indexing\n2. Retrieval");
    }

    #[test]
    fn paragraph_mode_keeps_sentences_in_one_paragraph() {
        let merged = merge_ocr_lines(
            &lines(&[
                "LLMs are trained on enormous bodies of data.",
                "Retrieval-Augmented Generation solves this problem.",
            ]),
            MergeProfile::Paragraph,
        );
        assert_eq!(
            merged,
            "LLMs are trained on enormous bodies of data. Retrieval-Augmented Generation solves this problem."
        );
    }

    #[test]
    fn auto_uses_paragraph_for_document_like_text() {
        let mode = auto_text_layout_mode(&lines(&[
            "LLMs are trained on enormous bodies of data but they aren't trained on your data.",
            "Retrieval-Augmented Generation solves this problem by adding your data to the data LLMs already have access to.",
            "You will see references to RAG frequently in this documentation.",
        ]));
        assert_eq!(mode, OcrTextLayoutMode::Paragraph);
    }

    #[test]
    fn auto_preserves_menu_like_text() {
        let mode = auto_text_layout_mode(&lines(&[
            "Getting Started",
            "Learn",
            "Indexing",
            "Retrieval",
            "Use Cases",
        ]));
        assert_eq!(mode, OcrTextLayoutMode::Preserve);
    }
}
