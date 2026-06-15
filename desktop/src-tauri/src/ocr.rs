use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use base64::{engine::general_purpose, Engine};
use image::GenericImageView;
use screenshots::{Compression, Screen};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

const OCR_CONFIG_FILE: &str = "ocr-config.json";
const FULL_SCREENSHOT_FILE: &str = "tabkeep_screenshot.png";
const CUT_SCREENSHOT_FILE: &str = "tabkeep_screenshot_cut.png";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OcrProvider {
    WindowsOcr,
    PaddleocrJson,
}

impl Default for OcrProvider {
    fn default() -> Self {
        Self::WindowsOcr
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
}

impl Default for OcrConfig {
    fn default() -> Self {
        Self {
            provider: OcrProvider::WindowsOcr,
            paddle_exe_path: String::new(),
            paddle_models_path: String::new(),
            paddle_config_path: String::new(),
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

pub fn recognize(
    app: &AppHandle,
    config: &OcrConfig,
    provider: OcrProvider,
    image_path: &Path,
    lang: &str,
) -> Result<String, String> {
    match provider {
        OcrProvider::WindowsOcr => recognize_windows(image_path, lang),
        OcrProvider::PaddleocrJson => recognize_paddle(app, config, image_path),
    }
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
        provider,
        image_path: path_to_string(image_path),
        image_data_url: image_data_url(image_path),
        translated_text,
        model,
        error: None,
        phase: Some("done".to_string()),
        message: None,
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
        provider,
        image_path: path_to_string(image_path),
        image_data_url: None,
        translated_text,
        model,
        error: None,
        phase: Some("done".to_string()),
        message: None,
    }
}

pub fn error_result(
    error: String,
    provider: OcrProvider,
    image_path: Option<&Path>,
) -> OcrFlowResult {
    OcrFlowResult {
        ok: false,
        text: String::new(),
        provider,
        image_path: image_path.map(path_to_string).unwrap_or_default(),
        image_data_url: image_path.and_then(image_data_url),
        translated_text: None,
        model: None,
        error: Some(error),
        phase: Some("error".to_string()),
        message: None,
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
        provider,
        image_path: image_path.map(path_to_string).unwrap_or_default(),
        image_data_url: None,
        translated_text: None,
        model: None,
        error: Some(error),
        phase: Some("error".to_string()),
        message: None,
    }
}

fn default_screenshot() -> bool {
    true
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|err| format!("获取应用数据目录失败: {err}"))?
        .join(OCR_CONFIG_FILE))
}

fn cache_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|err| format!("获取应用缓存目录失败: {err}"))?;
    fs::create_dir_all(&dir).map_err(|err| format!("创建应用缓存目录失败: {err}"))?;
    Ok(dir.join(name))
}

fn recognize_paddle(
    _app: &AppHandle,
    config: &OcrConfig,
    image_path: &Path,
) -> Result<String, String> {
    if config.paddle_exe_path.trim().is_empty() {
        return Err("未配置 PaddleOCR-json.exe 路径".to_string());
    }
    let exe = PathBuf::from(config.paddle_exe_path.trim());
    if !exe.exists() {
        return Err(format!("PaddleOCR-json.exe 不存在: {}", exe.display()));
    }

    let mut command = Command::new(&exe);
    command.arg(format!("-image_path={}", image_path.display()));
    if !config.paddle_models_path.trim().is_empty() {
        command.arg(format!("-models_path={}", config.paddle_models_path.trim()));
    }
    if !config.paddle_config_path.trim().is_empty() {
        command.arg(format!("-config_path={}", config.paddle_config_path.trim()));
    }

    let output = command
        .output()
        .map_err(|err| format!("启动 PaddleOCR-json 失败: {err}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        return Err(if stderr.trim().is_empty() {
            format!("PaddleOCR-json 退出失败: {}", output.status)
        } else {
            stderr
        });
    }

    parse_paddle_output(&stdout)
}

fn parse_paddle_output(stdout: &str) -> Result<String, String> {
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
            let lines = value
                .get("data")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.get("text").and_then(Value::as_str))
                        .map(str::trim)
                        .filter(|text| !text.is_empty())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            Ok(lines.join("\n").trim().to_string())
        }
        101 => Ok(String::new()),
        _ => Err(value
            .get("data")
            .map(Value::to_string)
            .unwrap_or_else(|| json!(value).to_string())),
    }
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

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().replace("\\\\?\\", "")
}
