use std::{fs, path::PathBuf};

use screenshots::{Compression, Screen};
use serde::{Deserialize, Serialize};
use tauri::{
    window::Color, AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Size,
    WebviewUrl, WebviewWindowBuilder,
};

const REGION_CONFIG_FILE: &str = "region-box-config.json";
const REGION_SCREENSHOT_FILE: &str = "tabkeep_region.png";
const DEFAULT_REGION_PANEL_WIDTH: u32 = 420;
const DEFAULT_REGION_PANEL_HEIGHT: u32 = 150;
const MIN_REGION_PANEL_WIDTH: u32 = 280;
const MIN_REGION_PANEL_HEIGHT: u32 = 140;
const REGION_PANEL_GAP: i32 = 10;
const MIN_REGION_WIDTH: u32 = 120;
const MIN_REGION_HEIGHT: u32 = 60;
const SCREEN_PADDING: i32 = 12;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TranslationDisplayMode {
    Panel,
    Inline,
    Both,
}

impl Default for TranslationDisplayMode {
    fn default() -> Self {
        Self::Both
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RegionBoxConfig {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[serde(rename = "passThrough")]
    pub pass_through: bool,
    #[serde(rename = "sourceLang")]
    pub source_lang: String,
    #[serde(rename = "targetLang")]
    pub target_lang: String,
    #[serde(rename = "translationDisplayMode", default)]
    pub translation_display_mode: TranslationDisplayMode,
    #[serde(rename = "panelX", default, skip_serializing_if = "Option::is_none")]
    pub panel_x: Option<i32>,
    #[serde(rename = "panelY", default, skip_serializing_if = "Option::is_none")]
    pub panel_y: Option<i32>,
    #[serde(rename = "panelWidth", default = "default_panel_width")]
    pub panel_width: u32,
    #[serde(rename = "panelHeight", default = "default_panel_height")]
    pub panel_height: u32,
}

impl Default for RegionBoxConfig {
    fn default() -> Self {
        Self {
            x: 160,
            y: 160,
            width: 640,
            height: 180,
            pass_through: false,
            source_lang: "auto".to_string(),
            target_lang: "简体中文".to_string(),
            translation_display_mode: TranslationDisplayMode::Both,
            panel_x: None,
            panel_y: None,
            panel_width: default_panel_width(),
            panel_height: default_panel_height(),
        }
    }
}

pub fn load_config(app: &AppHandle) -> RegionBoxConfig {
    let Ok(path) = config_path(app) else {
        return RegionBoxConfig::default();
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return RegionBoxConfig::default();
    };
    fit_config_to_visible_area(sanitize_config(
        serde_json::from_str(&raw).unwrap_or_default(),
    ))
}

pub fn save_config(app: &AppHandle, config: &RegionBoxConfig) -> Result<RegionBoxConfig, String> {
    let config = fit_config_to_visible_area(sanitize_config(config.clone()));
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("创建区域框配置目录失败: {err}"))?;
    }
    let raw = serde_json::to_string_pretty(&config)
        .map_err(|err| format!("序列化区域框配置失败: {err}"))?;
    fs::write(path, raw).map_err(|err| format!("写入区域框配置失败: {err}"))?;
    Ok(config)
}

pub fn open_windows(app: &AppHandle) -> Result<RegionBoxConfig, String> {
    let mut config = sync_from_box_window(app).unwrap_or_else(|_| load_config(app));
    config.pass_through = false;
    let config = save_config(app, &config)?;
    destroy_existing_windows(app)?;

    let box_window = WebviewWindowBuilder::new(
        app,
        "region-box",
        WebviewUrl::App("index.html?view=region-box".into()),
    )
    .title("TabKeep Region Box")
    .inner_size(config.width as f64, config.height as f64)
    .min_inner_size(MIN_REGION_WIDTH as f64, MIN_REGION_HEIGHT as f64)
    .position(config.x as f64, config.y as f64)
    .decorations(false)
    .transparent(true)
    .background_color(Color(0, 0, 0, 0))
    .always_on_top(true)
    .resizable(true)
    .visible(true)
    .build()
    .map_err(|err| format!("打开区域框失败: {err}"))?;

    let panel_position = panel_position(&config);
    let _panel_window = WebviewWindowBuilder::new(
        app,
        "region-panel",
        WebviewUrl::App("index.html?view=region-panel".into()),
    )
    .title("TabKeep Region Translator")
    .inner_size(config.panel_width as f64, config.panel_height as f64)
    .min_inner_size(
        MIN_REGION_PANEL_WIDTH as f64,
        MIN_REGION_PANEL_HEIGHT as f64,
    )
    .position(panel_position.0 as f64, panel_position.1 as f64)
    .decorations(false)
    .transparent(true)
    .background_color(Color(0, 0, 0, 0))
    .always_on_top(true)
    .resizable(true)
    .visible(true)
    .build()
    .map_err(|err| format!("打开区域翻译面板失败: {err}"))?;

    let _ = box_window.show();
    apply_window_config(app, &config)?;
    emit_config(app, &config);
    Ok(config)
}

pub fn close_windows(app: &AppHandle) -> Result<(), String> {
    destroy_existing_windows(app)
}

fn destroy_existing_windows(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("region-box") {
        let _ = window.set_ignore_cursor_events(false);
        window
            .destroy()
            .map_err(|err| format!("关闭区域框失败: {err}"))?;
    }
    if let Some(window) = app.get_webview_window("region-panel") {
        window
            .destroy()
            .map_err(|err| format!("关闭区域翻译面板失败: {err}"))?;
    }
    Ok(())
}

pub fn apply_window_config(app: &AppHandle, config: &RegionBoxConfig) -> Result<(), String> {
    let config = sanitize_config(config.clone());
    if let Some(window) = app.get_webview_window("region-box") {
        window
            .set_position(Position::Physical(PhysicalPosition::new(
                config.x, config.y,
            )))
            .map_err(|err| format!("移动区域框失败: {err}"))?;
        window
            .set_size(Size::Physical(PhysicalSize::new(
                config.width,
                config.height,
            )))
            .map_err(|err| format!("调整区域框尺寸失败: {err}"))?;
        window
            .set_always_on_top(true)
            .map_err(|err| format!("设置区域框置顶失败: {err}"))?;
        window
            .set_ignore_cursor_events(config.pass_through)
            .map_err(|err| format!("设置区域框鼠标穿透失败: {err}"))?;
    }

    if let Some(window) = app.get_webview_window("region-panel") {
        let position = panel_position(&config);
        window
            .set_position(Position::Physical(PhysicalPosition::new(
                position.0, position.1,
            )))
            .map_err(|err| format!("移动区域翻译面板失败: {err}"))?;
        set_panel_size_if_needed(&window, config.panel_width, config.panel_height)?;
        window
            .set_always_on_top(true)
            .map_err(|err| format!("设置区域翻译面板置顶失败: {err}"))?;
        window
            .show()
            .map_err(|err| format!("显示区域翻译面板失败: {err}"))?;
    }
    Ok(())
}

pub fn sync_from_box_window(app: &AppHandle) -> Result<RegionBoxConfig, String> {
    let mut config = load_config(app);
    if let Some(window) = app.get_webview_window("region-box") {
        let position = window
            .outer_position()
            .map_err(|err| format!("读取区域框位置失败: {err}"))?;
        let size = window
            .outer_size()
            .map_err(|err| format!("读取区域框尺寸失败: {err}"))?;
        config.x = position.x;
        config.y = position.y;
        config.width = size.width;
        config.height = size.height;
    }
    sync_panel_from_window(app, &mut config);
    let config = save_config(app, &config)?;
    apply_window_config(app, &config)?;
    emit_config(app, &config);
    Ok(config)
}

pub fn set_passthrough(app: &AppHandle, pass_through: bool) -> Result<RegionBoxConfig, String> {
    let mut config = load_config(app);
    if let Some(window) = app.get_webview_window("region-box") {
        if let Ok(position) = window.outer_position() {
            config.x = position.x;
            config.y = position.y;
        }
        if let Ok(size) = window.outer_size() {
            config.width = size.width;
            config.height = size.height;
        }
    }
    sync_panel_from_window(app, &mut config);
    config.pass_through = pass_through;
    let config = save_config(app, &config)?;
    apply_box_passthrough(app, config.pass_through)?;
    emit_config(app, &config);
    Ok(config)
}

fn apply_box_passthrough(app: &AppHandle, pass_through: bool) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("region-box") {
        window
            .set_always_on_top(true)
            .map_err(|err| format!("设置区域框置顶失败: {err}"))?;
        window
            .set_ignore_cursor_events(pass_through)
            .map_err(|err| format!("设置区域框鼠标穿透失败: {err}"))?;
    }
    if let Some(window) = app.get_webview_window("region-panel") {
        window
            .set_always_on_top(true)
            .map_err(|err| format!("设置区域翻译面板置顶失败: {err}"))?;
        window
            .show()
            .map_err(|err| format!("显示区域翻译面板失败: {err}"))?;
    }
    Ok(())
}

pub fn save_live_box_config(
    app: &AppHandle,
    config: &RegionBoxConfig,
) -> Result<RegionBoxConfig, String> {
    let config = save_config(app, config)?;
    if let Some(window) = app.get_webview_window("region-panel") {
        let position = panel_position(&config);
        window
            .set_position(Position::Physical(PhysicalPosition::new(
                position.0, position.1,
            )))
            .map_err(|err| format!("移动区域翻译面板失败: {err}"))?;
        set_panel_size_if_needed(&window, config.panel_width, config.panel_height)?;
        window
            .set_always_on_top(true)
            .map_err(|err| format!("设置区域翻译面板置顶失败: {err}"))?;
    }
    emit_config(app, &config);
    Ok(config)
}

pub fn capture_region(app: &AppHandle, config: &RegionBoxConfig) -> Result<PathBuf, String> {
    let config = sanitize_config(config.clone());
    if config.width < MIN_REGION_WIDTH || config.height < MIN_REGION_HEIGHT {
        return Err("区域框太小,请放大后再识别".to_string());
    }

    let center_x = config.x.saturating_add((config.width / 2) as i32);
    let center_y = config.y.saturating_add((config.height / 2) as i32);
    let screen = Screen::from_point(center_x, center_y)
        .or_else(|_| Screen::from_point(config.x, config.y))
        .map_err(|err| format!("定位区域所在屏幕失败: {err}"))?;
    let relative_x = config.x - screen.display_info.x;
    let relative_y = config.y - screen.display_info.y;
    let image = screen
        .capture_area(relative_x, relative_y, config.width, config.height)
        .map_err(|err| format!("捕获区域失败: {err}"))?;
    let bytes = image
        .to_png(Compression::Fast)
        .map_err(|err| format!("编码区域截图失败: {err}"))?;
    let path = cache_file(app, REGION_SCREENSHOT_FILE)?;
    fs::write(&path, bytes).map_err(|err| format!("保存区域截图失败: {err}"))?;
    Ok(path)
}

pub fn emit_config(app: &AppHandle, config: &RegionBoxConfig) {
    let _ = app.emit_to("region-box", "region-config-updated", config.clone());
    let _ = app.emit_to("region-panel", "region-config-updated", config.clone());
}

fn sanitize_config(mut config: RegionBoxConfig) -> RegionBoxConfig {
    config.width = config.width.max(MIN_REGION_WIDTH);
    config.height = config.height.max(MIN_REGION_HEIGHT);
    config.panel_width = config.panel_width.max(MIN_REGION_PANEL_WIDTH);
    config.panel_height = config.panel_height.max(MIN_REGION_PANEL_HEIGHT);
    if config.source_lang.trim().is_empty() {
        config.source_lang = "auto".to_string();
    }
    if config.target_lang.trim().is_empty() {
        config.target_lang = "简体中文".to_string();
    }
    config
}

fn fit_config_to_visible_area(mut config: RegionBoxConfig) -> RegionBoxConfig {
    let Some(screen) = screen_for_config(&config) else {
        return config;
    };
    let info = screen.display_info;
    let screen_left = info.x;
    let screen_top = info.y;
    let screen_right = info.x.saturating_add(info.width as i32);
    let screen_bottom = info.y.saturating_add(info.height as i32);

    let usable_width = screen_right
        .saturating_sub(screen_left)
        .saturating_sub(SCREEN_PADDING * 2)
        .max(MIN_REGION_WIDTH as i32) as u32;
    let usable_height = screen_bottom
        .saturating_sub(screen_top)
        .saturating_sub(SCREEN_PADDING * 2)
        .max(MIN_REGION_HEIGHT as i32) as u32;
    let usable_panel_width = screen_right
        .saturating_sub(screen_left)
        .saturating_sub(SCREEN_PADDING * 2)
        .max(MIN_REGION_PANEL_WIDTH as i32) as u32;
    let usable_panel_height = screen_bottom
        .saturating_sub(screen_top)
        .saturating_sub(SCREEN_PADDING * 2)
        .max(MIN_REGION_PANEL_HEIGHT as i32) as u32;
    config.width = config.width.min(usable_width);
    config.height = config.height.min(usable_height);
    config.panel_width = config.panel_width.min(usable_panel_width);
    config.panel_height = config.panel_height.min(usable_panel_height);

    let min_x = screen_left.saturating_add(SCREEN_PADDING);
    let max_x = screen_right
        .saturating_sub(SCREEN_PADDING)
        .saturating_sub(config.width as i32)
        .max(min_x);
    let min_y = screen_top.saturating_add(SCREEN_PADDING);
    let max_y = screen_bottom
        .saturating_sub(SCREEN_PADDING)
        .saturating_sub(config.height as i32)
        .max(min_y);
    config.x = config.x.clamp(min_x, max_x);
    config.y = config.y.clamp(min_y, max_y);

    if let (Some(panel_x), Some(panel_y)) = (config.panel_x, config.panel_y) {
        let panel_width = config.panel_width as i32;
        let panel_height = config.panel_height as i32;
        let max_panel_x = screen_right
            .saturating_sub(SCREEN_PADDING)
            .saturating_sub(panel_width)
            .max(min_x);
        let max_panel_y = screen_bottom
            .saturating_sub(SCREEN_PADDING)
            .saturating_sub(panel_height)
            .max(min_y);
        config.panel_x = Some(panel_x.clamp(min_x, max_panel_x));
        config.panel_y = Some(panel_y.clamp(min_y, max_panel_y));
    }
    config
}

fn screen_for_config(config: &RegionBoxConfig) -> Option<Screen> {
    let screens = Screen::all().ok()?;
    let center_x = config.x.saturating_add((config.width / 2) as i32);
    let center_y = config.y.saturating_add((config.height / 2) as i32);

    screens
        .iter()
        .find(|screen| point_in_screen(screen, center_x, center_y))
        .or_else(|| {
            screens
                .iter()
                .find(|screen| point_in_screen(screen, config.x, config.y))
        })
        .or_else(|| screens.iter().find(|screen| screen.display_info.is_primary))
        .or_else(|| screens.first())
        .cloned()
}

fn point_in_screen(screen: &Screen, x: i32, y: i32) -> bool {
    let info = screen.display_info;
    x >= info.x
        && y >= info.y
        && x < info.x.saturating_add(info.width as i32)
        && y < info.y.saturating_add(info.height as i32)
}

fn panel_position(config: &RegionBoxConfig) -> (i32, i32) {
    if let (Some(x), Some(y)) = (config.panel_x, config.panel_y) {
        return (x, y);
    }

    let panel_width = config.panel_width as i32;
    let panel_height = config.panel_height as i32;
    let default_x = config
        .x
        .saturating_add(config.width as i32)
        .saturating_sub(panel_width)
        .saturating_sub(REGION_PANEL_GAP);
    let default_y = config
        .y
        .saturating_add(config.height as i32)
        .saturating_sub(panel_height)
        .saturating_sub(REGION_PANEL_GAP);
    let Ok(screen) = Screen::from_point(
        config.x.saturating_add((config.width / 2) as i32),
        config.y.saturating_add((config.height / 2) as i32),
    )
    .or_else(|_| Screen::from_point(config.x, config.y)) else {
        return (
            default_x.max(config.x.saturating_add(REGION_PANEL_GAP)),
            default_y.max(config.y.saturating_add(REGION_PANEL_GAP)),
        );
    };

    let info = screen.display_info;
    let screen_left = info.x;
    let screen_top = info.y;
    let screen_right = info.x.saturating_add(info.width as i32);
    let screen_bottom = info.y.saturating_add(info.height as i32);
    let max_x = screen_right
        .saturating_sub(SCREEN_PADDING)
        .saturating_sub(panel_width)
        .max(screen_left.saturating_add(SCREEN_PADDING));
    let max_y = screen_bottom
        .saturating_sub(SCREEN_PADDING)
        .saturating_sub(panel_height)
        .max(screen_top.saturating_add(SCREEN_PADDING));
    let min_x = screen_left.saturating_add(SCREEN_PADDING);
    let min_y = screen_top.saturating_add(SCREEN_PADDING);
    let x = default_x
        .max(config.x.saturating_add(REGION_PANEL_GAP))
        .clamp(min_x, max_x);
    let y = default_y
        .max(config.y.saturating_add(REGION_PANEL_GAP))
        .clamp(min_y, max_y);

    (x, y)
}

fn sync_panel_from_window(app: &AppHandle, config: &mut RegionBoxConfig) {
    if let Some(window) = app.get_webview_window("region-panel") {
        if let Ok(position) = window.outer_position() {
            config.panel_x = Some(position.x);
            config.panel_y = Some(position.y);
        }
        if let Ok(size) = window.inner_size() {
            config.panel_width = size.width.max(MIN_REGION_PANEL_WIDTH);
            config.panel_height = size.height.max(MIN_REGION_PANEL_HEIGHT);
        }
    }
}

fn set_panel_size_if_needed(
    window: &tauri::WebviewWindow,
    width: u32,
    height: u32,
) -> Result<(), String> {
    if let Ok(size) = window.inner_size() {
        if size.width == width && size.height == height {
            return Ok(());
        }
    }
    window
        .set_size(Size::Physical(PhysicalSize::new(width, height)))
        .map_err(|err| format!("调整区域翻译面板尺寸失败: {err}"))
}

fn default_panel_width() -> u32 {
    DEFAULT_REGION_PANEL_WIDTH
}

fn default_panel_height() -> u32 {
    DEFAULT_REGION_PANEL_HEIGHT
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|err| format!("获取应用数据目录失败: {err}"))?
        .join(REGION_CONFIG_FILE))
}

fn cache_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|err| format!("获取应用缓存目录失败: {err}"))?;
    fs::create_dir_all(&dir).map_err(|err| format!("创建应用缓存目录失败: {err}"))?;
    Ok(dir.join(name))
}
