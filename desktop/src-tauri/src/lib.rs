use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Instant,
};

use axum::{
    extract::State as AxumState,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose, Engine};
use chrono::Local;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{window::Color, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
#[cfg(not(windows))]
use tauri_plugin_notification::NotificationExt;
use tokio::{
    sync::oneshot,
    time::{sleep, Duration},
};
use tower_http::cors::{Any, CorsLayer};

mod ocr;
mod region;
mod selection;
mod sticky_notes;
mod translation;

const BACKEND_URL: &str = "http://127.0.0.1:38471";
const DESKTOP_PORT: u16 = 38472;
const MAX_TRANSLATE_CHARS: usize = 12_000;
const STICKY_NOTE_WINDOW_DEFAULT_WIDTH: u32 = 380;
const STICKY_NOTE_WINDOW_DEFAULT_HEIGHT: u32 = 460;
const STICKY_NOTE_WINDOW_MIN_WIDTH: u32 = 280;
const STICKY_NOTE_WINDOW_MIN_HEIGHT: u32 = 260;
const STICKY_NOTE_WINDOW_HIDDEN_COORDINATE: i32 = -10_000;
const STICKY_NOTE_WINDOW_LABEL_PREFIX: &str = "sticky-note-";
const STICKY_NOTES_CHANGED_EVENT: &str = "sticky-notes-changed";
const SHOW_STICKY_REMINDERS_EVENT: &str = "show-sticky-reminders";
const STICKY_REMINDER_POLL_SECONDS: u64 = 30;
const MAX_INDIVIDUAL_OVERDUE_NOTIFICATIONS: usize = 3;
const STICKY_NOTIFICATION_APP_ID: &str = "com.tabkeep.desktop";
const STICKY_NOTIFICATION_APP_NAME: &str = "TabKeep";
const STICKY_NOTIFICATION_ICON_FILE: &str = "notification-icon.png";
const STICKY_NOTE_HOTKEY_ID: i32 = 0x544e;
const STICKY_NOTE_TOGGLE_HOTKEY_ID: i32 = 0x544f;
const DESKTOP_USAGE_FILE: &str = "desktop-usage-stats.json";

#[derive(Clone)]
struct DesktopState {
    api_token: Arc<Mutex<Option<String>>>,
    client: reqwest::Client,
    pending_ocr: Arc<Mutex<Option<PendingOcrFlow>>>,
    latest_ocr_result: Arc<Mutex<Option<ocr::OcrFlowResult>>>,
    latest_selection_result: Arc<Mutex<Option<selection::SelectionTranslateResult>>>,
    selection_hotkey: Arc<Mutex<Option<selection::HotkeyController>>>,
    selection_hotkey_error: Arc<Mutex<Option<String>>>,
    selection_running: Arc<Mutex<bool>>,
    usage_stats: Arc<Mutex<DailyUsageStats>>,
}

#[derive(Clone)]
struct HttpState {
    desktop: DesktopState,
    app: tauri::AppHandle,
}

#[derive(Default)]
struct StickyReminderTrayItem(Mutex<Option<tauri::menu::MenuItem<tauri::Wry>>>);

#[derive(Debug, Clone)]
enum OcrFlowMode {
    Recognize,
    Translate,
}

struct PendingOcrFlow {
    mode: OcrFlowMode,
    request: ocr::OcrRequest,
    screenshot: ocr::ScreenshotInfo,
    responder: oneshot::Sender<ocr::OcrFlowResult>,
}

#[derive(Serialize)]
struct DesktopStatus {
    ok: bool,
    app: &'static str,
    version: &'static str,
    backend_url: &'static str,
    desktop_url: String,
    token_cached: bool,
    usage_date: String,
    today_translation_count: u32,
    today_ocr_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DailyUsageStats {
    date: String,
    translations: u32,
    ocr: u32,
}

enum DesktopUsageKind {
    Translation,
    Ocr,
}

#[derive(Serialize)]
struct BackendResponse {
    status: u16,
    ok: bool,
    data: Value,
}

#[derive(Deserialize)]
struct CapturePayload {
    source: String,
    mode: String,
    title: String,
    url: String,
    #[serde(rename = "contentMarkdown")]
    content_markdown: Option<String>,
    excerpt: Option<String>,
    #[serde(rename = "favIconUrl")]
    fav_icon_url: Option<String>,
    #[serde(rename = "capturedAt")]
    captured_at: String,
    #[serde(rename = "notebookId")]
    notebook_id: Option<String>,
    #[serde(rename = "targetDoc")]
    target_doc: Option<String>,
}

#[derive(Deserialize)]
struct TranslatePayload {
    text: String,
    #[serde(rename = "sourceLang")]
    source_lang: Option<String>,
    #[serde(rename = "targetLang")]
    target_lang: Option<String>,
    context: Option<String>,
}

#[derive(Serialize)]
struct TranslateResponse {
    ok: bool,
    text: String,
    #[serde(rename = "translatedText")]
    translated_text: String,
    #[serde(rename = "sourceLang")]
    source_lang: String,
    #[serde(rename = "targetLang")]
    target_lang: String,
    model: String,
}

#[derive(Serialize)]
struct OcrDebugResponse {
    ok: bool,
    provider: ocr::OcrProvider,
    #[serde(rename = "ocrEngine")]
    ocr_engine: String,
    #[serde(rename = "ocrFallbackReason")]
    ocr_fallback_reason: Option<String>,
    #[serde(rename = "sourceLang")]
    source_lang: String,
    #[serde(rename = "originalImagePath")]
    original_image_path: String,
    #[serde(rename = "originalImageDataUrl")]
    original_image_data_url: Option<String>,
    #[serde(rename = "originalWidth")]
    original_width: u32,
    #[serde(rename = "originalHeight")]
    original_height: u32,
    #[serde(rename = "preprocessedImagePath")]
    preprocessed_image_path: Option<String>,
    #[serde(rename = "preprocessedImageDataUrl")]
    preprocessed_image_data_url: Option<String>,
    #[serde(rename = "preprocessedWidth")]
    preprocessed_width: Option<u32>,
    #[serde(rename = "preprocessedHeight")]
    preprocessed_height: Option<u32>,
    #[serde(rename = "rawText")]
    raw_text: String,
    text: String,
    #[serde(rename = "textBoxes")]
    text_boxes: Vec<ocr::OcrTextBox>,
    #[serde(rename = "translatedRegions")]
    translated_regions: Vec<ocr::ComicTextRegion>,
    #[serde(rename = "elapsedMs")]
    elapsed_ms: u128,
    config: ocr::OcrConfig,
}

#[derive(Serialize)]
struct MangaOcrRequest {
    #[serde(rename = "imageBase64")]
    image_base64: String,
    regions: Vec<MangaOcrRegionRequest>,
}

#[derive(Serialize)]
struct MangaOcrRegionRequest {
    id: String,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
}

#[derive(Debug, Deserialize)]
struct MangaOcrResponse {
    ok: bool,
    engine: String,
    regions: Vec<MangaOcrRegionResponse>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MangaOcrRegionResponse {
    id: String,
    text: String,
}

#[derive(Serialize)]
struct ComicDetectionRequest {
    #[serde(rename = "imageBase64")]
    image_base64: String,
    #[serde(rename = "sourceLang")]
    source_lang: String,
}

#[derive(Debug, Deserialize)]
struct ComicDetectionResponse {
    ok: bool,
    engine: String,
    regions: Vec<ComicDetectionRegionResponse>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ComicDetectionRegionResponse {
    id: String,
    #[serde(rename = "textBounds")]
    text_bounds: ocr::OcrBounds,
    #[serde(rename = "bubbleBounds")]
    bubble_bounds: Option<ocr::OcrBounds>,
    direction: ocr::ComicTextDirection,
    #[serde(rename = "readingOrder")]
    reading_order: usize,
    confidence: f32,
}

struct OcrRegionRefinement {
    text: String,
    regions: Vec<ocr::ComicTextRegion>,
    engine: String,
    fallback_reason: Option<String>,
}

#[derive(Serialize)]
struct TranslateProviderTestResponse {
    ok: bool,
    provider: String,
    #[serde(rename = "translatedText")]
    translated_text: Option<String>,
    #[serde(rename = "latencyMs")]
    latency_ms: u128,
    error: Option<String>,
}

#[derive(Deserialize)]
struct BackendConfigPayload {
    #[serde(rename = "modelConfig")]
    model_config: Option<ModelConfigPayload>,
}

#[derive(Deserialize)]
struct ModelConfigPayload {
    model: String,
    #[serde(rename = "baseURL")]
    base_url: String,
    #[serde(rename = "apiKey")]
    api_key: String,
}

#[derive(Deserialize)]
struct ChatCompletionPayload {
    choices: Vec<ChatChoicePayload>,
}

#[derive(Deserialize)]
struct ChatChoicePayload {
    message: ChatMessagePayload,
}

#[derive(Deserialize)]
struct ChatMessagePayload {
    content: Option<String>,
}

#[derive(Deserialize)]
struct RegionTranslationEnvelope {
    translations: Vec<RegionTranslationItem>,
}

#[derive(Deserialize)]
struct RegionTranslationItem {
    id: String,
    text: String,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = DesktopState {
        api_token: Arc::new(Mutex::new(None)),
        client: reqwest::Client::new(),
        pending_ocr: Arc::new(Mutex::new(None)),
        latest_ocr_result: Arc::new(Mutex::new(None)),
        latest_selection_result: Arc::new(Mutex::new(None)),
        selection_hotkey: Arc::new(Mutex::new(None)),
        selection_hotkey_error: Arc::new(Mutex::new(None)),
        selection_running: Arc::new(Mutex::new(false)),
        usage_stats: Arc::new(Mutex::new(DailyUsageStats::today())),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("tabkeep-desktop".into()),
                    }),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                ])
                .build(),
        )
        .manage(state.clone())
        .manage(StickyReminderTrayItem::default())
        .setup(move |app| {
            match load_usage_stats(&app.handle()) {
                Ok(stats) => set_usage_stats(&state, stats),
                Err(err) => log::warn!("读取桌面用量统计失败: {err}"),
            }
            setup_tray(app)?;
            if let Err(err) = setup_sticky_notification_identity(&app.handle()) {
                log::warn!("初始化 TabKeep 通知身份失败: {err}");
            }
            setup_close_to_hide(app);
            setup_selection_hotkey(app, state.clone());
            setup_sticky_note_hotkey(app);
            setup_sticky_note_reminder_scheduler(app.handle().clone());
            if let Err(err) = sticky_notes::ensure_daily_poetry_note(&app.handle()) {
                log::warn!("初始化今日诗笺失败: {err}");
            }
            let poetry_app = app.handle().clone();
            let poetry_client = state.client.clone();
            tauri::async_runtime::spawn(async move {
                match sticky_notes::refresh_daily_poetry_note(&poetry_app, &poetry_client, false)
                    .await
                {
                    Ok(note) => {
                        emit_sticky_notes_changed(&poetry_app, "poetry", Some(&note.id));
                    }
                    Err(err) => log::warn!("后台刷新今日诗笺失败: {err}"),
                }
            });

            let server_state = HttpState {
                desktop: state.clone(),
                app: app.handle().clone(),
            };
            tauri::async_runtime::spawn(async move {
                if let Err(err) = run_http_server(server_state).await {
                    log::error!("TabKeep desktop HTTP server failed: {err}");
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_desktop_status,
            get_cached_api_token,
            set_cached_api_token,
            clear_cached_api_token,
            backend_request,
            get_ocr_config,
            set_ocr_config,
            get_translate_provider_config,
            set_translate_provider_config,
            test_translate_provider,
            start_ocr_recognize,
            start_ocr_translate,
            debug_region_ocr,
            finish_screen_selection,
            cancel_screen_selection,
            get_latest_ocr_result,
            get_ocr_debug_records,
            open_region_box,
            close_region_box,
            get_region_box_config,
            set_region_box_config,
            set_region_box_passthrough,
            run_region_ocr,
            run_region_translate,
            get_selection_translate_config,
            set_selection_translate_config,
            trigger_selection_translate,
            get_latest_selection_translate_result,
            open_external_target,
            sticky_notes_list,
            sticky_notes_get,
            sticky_notes_save,
            sticky_notes_delete,
            sticky_notes_save_image,
            sticky_notes_load_image,
            open_sticky_note_window,
            create_sticky_note_window,
            sticky_notes_import_markdown,
            sticky_notes_export_markdown,
            sticky_notes_list_categories,
            sticky_notes_create_category,
            sticky_notes_rename_category,
            sticky_notes_delete_category,
            sticky_notes_move_category,
            get_sticky_note_shortcut_config,
            set_sticky_note_shortcut_config,
            sticky_notes_set_reminder,
            sticky_notes_cancel_reminder,
            sticky_notes_snooze_reminder,
            sticky_notes_complete_reminder,
            sticky_notes_refresh_daily_poetry,
        ])
        .run(tauri::generate_context!())
        .expect("error while running TabKeep desktop");
}

fn setup_close_to_hide(app: &tauri::App) {
    if let Some(win) = app.get_webview_window("main") {
        let win_clone = win.clone();
        win.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = win_clone.hide();
            }
        });
    }
}

#[tauri::command]
fn open_external_target(target: String) -> Result<(), String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("来源为空".to_string());
    }
    if target.len() > 4096 {
        return Err("来源路径过长".to_string());
    }
    open_target_with_system(target)
}

#[tauri::command]
fn sticky_notes_list(app: tauri::AppHandle) -> Result<Vec<sticky_notes::StickyNote>, String> {
    sticky_notes::list_notes(&app)
}

#[tauri::command]
fn sticky_notes_get(app: tauri::AppHandle, id: String) -> Result<sticky_notes::StickyNote, String> {
    sticky_notes::get_note(&app, &id)
}

#[tauri::command]
fn sticky_notes_save(
    app: tauri::AppHandle,
    draft: sticky_notes::StickyNoteDraft,
) -> Result<sticky_notes::StickyNote, String> {
    let note = sticky_notes::save_note(&app, draft)?;
    emit_sticky_notes_changed(&app, "save", Some(&note.id));
    Ok(note)
}

#[tauri::command]
fn sticky_notes_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    sticky_notes::delete_note(&app, &id)?;
    close_sticky_note_windows_for_note(&app, &id);
    emit_sticky_notes_changed(&app, "delete", Some(&id));
    refresh_sticky_reminder_tray_item(&app);
    Ok(())
}

#[tauri::command]
fn sticky_notes_save_image(
    app: tauri::AppHandle,
    id: String,
    data_url: String,
) -> Result<sticky_notes::StickyNoteAsset, String> {
    sticky_notes::save_image_asset(&app, &id, &data_url)
}

#[tauri::command]
fn sticky_notes_load_image(
    app: tauri::AppHandle,
    id: String,
    file_name: String,
) -> Result<String, String> {
    sticky_notes::load_image_asset(&app, &id, &file_name)
}

#[tauri::command]
async fn open_sticky_note_window(app: tauri::AppHandle, id: String) -> Result<String, String> {
    let note = sticky_notes::get_note(&app, &id)?;
    open_sticky_note_window_for_note(&app, &note)
}

#[tauri::command]
async fn create_sticky_note_window(
    app: tauri::AppHandle,
) -> Result<sticky_notes::StickyNote, String> {
    create_and_open_sticky_note(&app)
}

#[tauri::command]
fn sticky_notes_import_markdown(
    app: tauri::AppHandle,
    path: Option<String>,
    category: Option<String>,
) -> Result<sticky_notes::StickyNote, String> {
    let note = sticky_notes::import_markdown_file(&app, path, category)?;
    emit_sticky_notes_changed(&app, "create", Some(&note.id));
    Ok(note)
}

#[tauri::command]
fn sticky_notes_export_markdown(
    app: tauri::AppHandle,
    id: String,
    path: Option<String>,
) -> Result<(), String> {
    sticky_notes::export_markdown_file(&app, &id, path)
}

#[tauri::command]
fn sticky_notes_list_categories(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    sticky_notes::list_categories(&app)
}

#[tauri::command]
fn sticky_notes_create_category(
    app: tauri::AppHandle,
    name: String,
) -> Result<Vec<String>, String> {
    let categories = sticky_notes::create_category(&app, &name)?;
    emit_sticky_notes_changed(&app, "category", None);
    Ok(categories)
}

#[tauri::command]
fn sticky_notes_rename_category(
    app: tauri::AppHandle,
    old_name: String,
    new_name: String,
) -> Result<(), String> {
    sticky_notes::rename_category(&app, &old_name, &new_name)?;
    emit_sticky_notes_changed(&app, "category", None);
    Ok(())
}

#[tauri::command]
fn sticky_notes_delete_category(app: tauri::AppHandle, name: String) -> Result<(), String> {
    sticky_notes::delete_category(&app, &name)?;
    emit_sticky_notes_changed(&app, "category", None);
    Ok(())
}

#[tauri::command]
fn sticky_notes_move_category(
    app: tauri::AppHandle,
    id: String,
    category: String,
) -> Result<sticky_notes::StickyNote, String> {
    let note = sticky_notes::move_note_to_category(&app, &id, &category)?;
    emit_sticky_notes_changed(&app, "save", Some(&note.id));
    Ok(note)
}

#[tauri::command]
fn get_sticky_note_shortcut_config(
    app: tauri::AppHandle,
) -> Result<sticky_notes::StickyShortcutConfig, String> {
    sticky_notes::get_shortcut_config(&app)
}

#[tauri::command]
fn set_sticky_note_shortcut_config(
    app: tauri::AppHandle,
    config: sticky_notes::StickyShortcutConfig,
) -> Result<sticky_notes::StickyShortcutConfig, String> {
    sticky_notes::save_shortcut_config(&app, config)
}

#[tauri::command]
fn sticky_notes_set_reminder(
    app: tauri::AppHandle,
    id: String,
    due_at: String,
) -> Result<sticky_notes::StickyNote, String> {
    let note = sticky_notes::set_reminder(&app, &id, &due_at)?;
    emit_sticky_notes_changed(&app, "reminder", Some(&note.id));
    refresh_sticky_reminder_tray_item(&app);
    Ok(note)
}

#[tauri::command]
fn sticky_notes_cancel_reminder(
    app: tauri::AppHandle,
    id: String,
) -> Result<sticky_notes::StickyNote, String> {
    let note = sticky_notes::cancel_reminder(&app, &id)?;
    emit_sticky_notes_changed(&app, "reminder", Some(&note.id));
    refresh_sticky_reminder_tray_item(&app);
    Ok(note)
}

#[tauri::command]
fn sticky_notes_snooze_reminder(
    app: tauri::AppHandle,
    id: String,
    minutes: i64,
) -> Result<sticky_notes::StickyNote, String> {
    let note = sticky_notes::snooze_reminder(&app, &id, minutes)?;
    emit_sticky_notes_changed(&app, "reminder", Some(&note.id));
    refresh_sticky_reminder_tray_item(&app);
    Ok(note)
}

#[tauri::command]
fn sticky_notes_complete_reminder(
    app: tauri::AppHandle,
    id: String,
) -> Result<sticky_notes::StickyNote, String> {
    let note = sticky_notes::complete_reminder(&app, &id)?;
    emit_sticky_notes_changed(&app, "reminder", Some(&note.id));
    refresh_sticky_reminder_tray_item(&app);
    Ok(note)
}

#[tauri::command]
async fn sticky_notes_refresh_daily_poetry(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    force: Option<bool>,
) -> Result<sticky_notes::StickyNote, String> {
    let note = sticky_notes::refresh_daily_poetry_note(&app, &state.client, force.unwrap_or(false))
        .await?;
    emit_sticky_notes_changed(&app, "poetry", Some(&note.id));
    Ok(note)
}

fn create_and_open_sticky_note(app: &tauri::AppHandle) -> Result<sticky_notes::StickyNote, String> {
    let note = sticky_notes::create_blank_note(app)?;
    let _ = open_sticky_note_window_for_note(app, &note)?;
    emit_sticky_notes_changed(app, "create", Some(&note.id));
    Ok(note)
}

fn emit_sticky_notes_changed(app: &tauri::AppHandle, action: &str, note_id: Option<&str>) {
    if let Err(err) = app.emit(
        STICKY_NOTES_CHANGED_EVENT,
        json!({
            "action": action,
            "noteId": note_id,
        }),
    ) {
        log::warn!("发送便签变更事件失败: {err}");
    }
}

fn open_sticky_note_window_for_note(
    app: &tauri::AppHandle,
    note: &sticky_notes::StickyNote,
) -> Result<String, String> {
    close_legacy_sticky_note_windows(app, &note.id);
    let label = format!("{STICKY_NOTE_WINDOW_LABEL_PREFIX}{}", note.id);
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.show();
        let _ = window.set_always_on_top(true);
        let _ = window.set_focus();
        return Ok(label);
    }

    let width = note
        .window_bounds
        .as_ref()
        .map(|bounds| bounds.width.max(STICKY_NOTE_WINDOW_MIN_WIDTH))
        .unwrap_or(STICKY_NOTE_WINDOW_DEFAULT_WIDTH);
    let height = note
        .window_bounds
        .as_ref()
        .map(|bounds| bounds.height.max(STICKY_NOTE_WINDOW_MIN_HEIGHT))
        .unwrap_or(STICKY_NOTE_WINDOW_DEFAULT_HEIGHT);
    let restored_bounds = note
        .window_bounds
        .as_ref()
        .and_then(|bounds| valid_sticky_window_bounds(app, bounds));

    let mut builder = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::App(format!("index.html?view=sticky-note&noteId={}", note.id).into()),
    )
    .title(format!(
        "TabKeep 便签 - {}",
        sticky_note_window_title(&note)
    ))
    .inner_size(width as f64, height as f64)
    .min_inner_size(
        STICKY_NOTE_WINDOW_MIN_WIDTH as f64,
        STICKY_NOTE_WINDOW_MIN_HEIGHT as f64,
    )
    .decorations(false)
    .transparent(false)
    .background_color(Color(255, 214, 232, 255))
    .always_on_top(true)
    .focused(true)
    .resizable(true)
    .visible(true);

    if let Some(bounds) = &restored_bounds {
        builder = builder.position(bounds.x as f64, bounds.y as f64);
    } else {
        builder = builder.center();
    }

    log::info!(
        "Opening sticky note window label={label}, note_id={}, width={width}, height={height}, restored_bounds={:?}",
        note.id,
        restored_bounds
    );

    let window = builder
        .build()
        .map_err(|err| format!("打开便签窗口失败: {err}"))?;

    log::info!(
        "Sticky note window opened label={label}, note_id={}",
        note.id
    );
    let _ = window.show();
    let _ = window.set_focus();

    attach_sticky_note_bounds_sync(app, note.id.clone(), &window);
    Ok(label)
}

fn close_legacy_sticky_note_windows(app: &tauri::AppHandle, note_id: &str) {
    let legacy_label = "sticky-note";
    let instance_prefix = format!("{STICKY_NOTE_WINDOW_LABEL_PREFIX}{note_id}--");
    let broken_instance_prefix = format!("sticky-note__{note_id}__");
    let mut closed_any = false;
    for (label, window) in app.webview_windows() {
        if label == legacy_label
            || label.starts_with(&instance_prefix)
            || label.starts_with(&broken_instance_prefix)
            || label.starts_with("sticky-note__")
        {
            let _ = window.destroy();
            closed_any = true;
        }
    }
    if closed_any {
        std::thread::sleep(std::time::Duration::from_millis(80));
    }
}

fn close_sticky_note_windows_for_note(app: &tauri::AppHandle, note_id: &str) {
    let label = format!("{STICKY_NOTE_WINDOW_LABEL_PREFIX}{note_id}");
    let instance_prefix = format!("{STICKY_NOTE_WINDOW_LABEL_PREFIX}{note_id}--");
    let broken_instance_prefix = format!("sticky-note__{note_id}__");
    for (window_label, window) in app.webview_windows() {
        if window_label == label
            || window_label.starts_with(&instance_prefix)
            || window_label.starts_with(&broken_instance_prefix)
        {
            let _ = window.destroy();
        }
    }
}

fn sticky_note_window_title(note: &sticky_notes::StickyNote) -> String {
    let title = note.title.trim();
    if !title.is_empty() {
        title.chars().take(24).collect()
    } else {
        "未命名".to_string()
    }
}

fn attach_sticky_note_bounds_sync(
    app: &tauri::AppHandle,
    note_id: String,
    window: &tauri::WebviewWindow,
) {
    let app = app.clone();
    let window_for_event = window.clone();
    window.on_window_event(move |event| {
        if matches!(
            event,
            tauri::WindowEvent::Moved(_)
                | tauri::WindowEvent::Resized(_)
                | tauri::WindowEvent::CloseRequested { .. }
        ) {
            if let Err(err) = save_sticky_note_window_bounds(&app, &note_id, &window_for_event) {
                log::warn!("保存便签窗口位置失败: {err}");
            }
        }
    });
}

fn save_sticky_note_window_bounds(
    app: &tauri::AppHandle,
    note_id: &str,
    window: &tauri::WebviewWindow,
) -> Result<(), String> {
    if window.is_minimized().unwrap_or(false) {
        return Ok(());
    }
    let position = window
        .outer_position()
        .map_err(|err| format!("读取便签窗口位置失败: {err}"))?;
    let size = window
        .inner_size()
        .map_err(|err| format!("读取便签窗口尺寸失败: {err}"))?;
    let Some(bounds) = valid_sticky_window_bounds(
        app,
        &sticky_notes::StickyWindowBounds {
            x: position.x,
            y: position.y,
            width: size.width.max(STICKY_NOTE_WINDOW_MIN_WIDTH),
            height: size.height.max(STICKY_NOTE_WINDOW_MIN_HEIGHT),
        },
    ) else {
        return Ok(());
    };
    sticky_notes::save_window_bounds(app, note_id, bounds)?;
    Ok(())
}

fn valid_sticky_window_bounds(
    app: &tauri::AppHandle,
    bounds: &sticky_notes::StickyWindowBounds,
) -> Option<sticky_notes::StickyWindowBounds> {
    if bounds.x <= STICKY_NOTE_WINDOW_HIDDEN_COORDINATE
        || bounds.y <= STICKY_NOTE_WINDOW_HIDDEN_COORDINATE
    {
        return None;
    }

    let normalized = sticky_notes::StickyWindowBounds {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width.max(STICKY_NOTE_WINDOW_MIN_WIDTH),
        height: bounds.height.max(STICKY_NOTE_WINDOW_MIN_HEIGHT),
    };

    let Ok(monitors) = app.available_monitors() else {
        return Some(normalized);
    };
    if monitors.is_empty() {
        return Some(normalized);
    }

    let center_x = normalized.x.saturating_add((normalized.width / 2) as i32);
    let center_y = normalized.y.saturating_add((normalized.height / 2) as i32);
    let is_visible = monitors.iter().any(|monitor| {
        let area = monitor.work_area();
        let left = area.position.x;
        let top = area.position.y;
        let right = left.saturating_add(i32::try_from(area.size.width).unwrap_or(i32::MAX));
        let bottom = top.saturating_add(i32::try_from(area.size.height).unwrap_or(i32::MAX));
        center_x >= left && center_x <= right && center_y >= top && center_y <= bottom
    });

    is_visible.then_some(normalized)
}

#[cfg(windows)]
fn open_target_with_system(target: &str) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let operation = wide_null("open");
    let file = wide_null(target);
    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(operation.as_ptr()),
            PCWSTR(file.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    if (result.0 as isize) <= 32 {
        return Err(format!(
            "系统打开来源失败，ShellExecute code={}",
            result.0 as isize
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn wide_null(value: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    std::ffi::OsStr::new(value)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(not(windows))]
fn open_target_with_system(target: &str) -> Result<(), String> {
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(opener)
        .arg(target)
        .spawn()
        .map_err(|err| format!("系统打开来源失败: {err}"))?;
    Ok(())
}

fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;

    let new_sticky = MenuItem::with_id(app, "new-sticky-note", "新建便签", true, None::<&str>)?;
    let reminders = MenuItem::with_id(app, "sticky-reminders", "查看提醒", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "打开 TabKeep", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&new_sticky, &reminders, &show, &quit])?;

    if let Ok(mut item) = app.state::<StickyReminderTrayItem>().0.lock() {
        *item = Some(reminders);
    }

    let mut builder = TrayIconBuilder::new()
        .tooltip("TabKeep")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "new-sticky-note" => {
                if let Err(err) = create_and_open_sticky_note(app) {
                    log::warn!("托盘新建便签失败: {err}");
                }
            }
            "sticky-reminders" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
                if let Err(err) = app.emit(SHOW_STICKY_REMINDERS_EVENT, ()) {
                    log::warn!("打开便签提醒列表失败: {err}");
                }
            }
            "show" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    refresh_sticky_reminder_tray_item(&app.handle());
    Ok(())
}

fn setup_sticky_note_reminder_scheduler(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        process_due_sticky_reminders(&app);
        loop {
            sleep(Duration::from_secs(STICKY_REMINDER_POLL_SECONDS)).await;
            process_due_sticky_reminders(&app);
        }
    });
}

fn process_due_sticky_reminders(app: &tauri::AppHandle) {
    let now = chrono::Utc::now();
    let due = match sticky_notes::due_reminders(app, now) {
        Ok(notes) => notes,
        Err(err) => {
            log::warn!("检查便签提醒失败: {err}");
            return;
        }
    };
    if due.is_empty() {
        refresh_sticky_reminder_tray_item(app);
        return;
    }

    if due.len() > MAX_INDIVIDUAL_OVERDUE_NOTIFICATIONS {
        let body = format!("有 {} 条便签提醒已到期，打开 TabKeep 查看。", due.len());
        let _ = show_sticky_notification(app, "便签提醒", &body);
        for note in &due {
            let _ = sticky_notes::mark_reminder_notified(app, &note.id, now);
        }
    } else {
        for note in &due {
            let title = sticky_note_window_title(note);
            let body = if note.preview.trim().is_empty() {
                "提醒时间到了".to_string()
            } else {
                note.preview.chars().take(90).collect()
            };
            let _ = show_sticky_notification(app, &title, &body);
            let _ = sticky_notes::mark_reminder_notified(app, &note.id, now);
        }
    }

    emit_sticky_notes_changed(app, "reminder-fired", None);
    refresh_sticky_reminder_tray_item(app);
}

#[cfg(windows)]
fn show_sticky_notification(app: &tauri::AppHandle, title: &str, body: &str) -> Result<(), String> {
    use tauri_winrt_notification::{IconCrop, Toast};

    let icon_path = sticky_notification_icon_path(app)?;
    Toast::new(STICKY_NOTIFICATION_APP_ID)
        .icon(&icon_path, IconCrop::Square, STICKY_NOTIFICATION_APP_NAME)
        .title(title)
        .text1(body)
        .show()
        .map_err(|err| {
            let message = format!("显示便签提醒失败: {err}");
            log::warn!("{message}");
            message
        })
}

#[cfg(not(windows))]
fn show_sticky_notification(app: &tauri::AppHandle, title: &str, body: &str) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|err| {
            let message = format!("显示便签提醒失败: {err}");
            log::warn!("{message}");
            message
        })
}

fn setup_sticky_notification_identity(app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows_registry::CURRENT_USER;

        let icon_path = sticky_notification_icon_path(app)?;
        let key = CURRENT_USER
            .create(format!(
                r"SOFTWARE\Classes\AppUserModelId\{STICKY_NOTIFICATION_APP_ID}"
            ))
            .map_err(|err| format!("创建通知注册表项失败: {err}"))?;
        key.set_string("DisplayName", STICKY_NOTIFICATION_APP_NAME)
            .map_err(|err| format!("写入通知名称失败: {err}"))?;
        key.set_string("IconBackgroundColor", "0")
            .map_err(|err| format!("写入通知图标背景失败: {err}"))?;
        key.set_hstring("IconUri", &icon_path.as_path().into())
            .map_err(|err| format!("写入通知图标失败: {err}"))?;
    }
    Ok(())
}

#[cfg(windows)]
fn sticky_notification_icon_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path()
        .app_local_data_dir()
        .map_err(|err| format!("获取通知图标目录失败: {err}"))?
        .join(STICKY_NOTIFICATION_ICON_FILE);
    if path.is_file() {
        return Ok(path);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("创建通知图标目录失败: {err}"))?;
    }
    let icon = app
        .default_window_icon()
        .ok_or_else(|| "应用图标不可用".to_string())?;
    image::save_buffer_with_format(
        &path,
        icon.rgba(),
        icon.width(),
        icon.height(),
        image::ColorType::Rgba8,
        image::ImageFormat::Png,
    )
    .map_err(|err| format!("保存通知图标失败: {err}"))?;
    Ok(path)
}

fn refresh_sticky_reminder_tray_item(app: &tauri::AppHandle) {
    let count = sticky_notes::active_reminder_count(app).unwrap_or(0);
    let text = if count == 0 {
        "查看提醒".to_string()
    } else {
        format!("查看提醒（{count}）")
    };
    if let Some(state) = app.try_state::<StickyReminderTrayItem>() {
        if let Ok(item) = state.0.lock() {
            if let Some(item) = item.as_ref() {
                if let Err(err) = item.set_text(text) {
                    log::warn!("更新托盘提醒数量失败: {err}");
                }
            }
        }
    }
}

fn setup_sticky_note_hotkey(app: &tauri::App) {
    let app = app.handle().clone();
    std::thread::spawn(move || sticky_note_hotkey_thread(app));
}

#[cfg(windows)]
fn sticky_note_hotkey_thread(app: tauri::AppHandle) {
    use windows::Win32::UI::{
        Input::KeyboardAndMouse::RegisterHotKey,
        WindowsAndMessaging::{PeekMessageW, MSG, PM_REMOVE, WM_HOTKEY},
    };

    let config = sticky_notes::get_shortcut_config(&app).unwrap_or_default();
    let new_note_hotkey = parse_windows_hotkey(&config.new_note_hotkey);
    let toggle_hotkey = parse_windows_hotkey(&config.toggle_window_hotkey);
    let mut warmup = MSG::default();
    let _ = unsafe { PeekMessageW(&mut warmup, None, 0, 0, PM_REMOVE) };

    if let Some((modifiers, key)) = new_note_hotkey {
        if let Err(err) = unsafe { RegisterHotKey(None, STICKY_NOTE_HOTKEY_ID, modifiers, key) } {
            log::warn!("注册便签全局快捷键 {} 失败: {err}", config.new_note_hotkey);
        } else {
            log::info!("便签全局快捷键已注册: {}", config.new_note_hotkey);
        }
    } else {
        log::warn!("便签新建快捷键配置无效: {}", config.new_note_hotkey);
    }

    if let Some((modifiers, key)) = toggle_hotkey {
        if let Err(err) =
            unsafe { RegisterHotKey(None, STICKY_NOTE_TOGGLE_HOTKEY_ID, modifiers, key) }
        {
            log::warn!(
                "注册便签小窗切换快捷键 {} 失败: {err}",
                config.toggle_window_hotkey
            );
        } else {
            log::info!("便签小窗切换快捷键已注册: {}", config.toggle_window_hotkey);
        }
    } else {
        log::warn!(
            "便签小窗切换快捷键配置无效: {}",
            config.toggle_window_hotkey
        );
    }

    loop {
        let mut message = MSG::default();
        while unsafe { PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() } {
            if message.message == WM_HOTKEY && message.wParam.0 as i32 == STICKY_NOTE_HOTKEY_ID {
                if let Err(err) = create_and_open_sticky_note(&app) {
                    log::warn!("快捷键新建便签失败: {err}");
                }
            }
            if message.message == WM_HOTKEY
                && message.wParam.0 as i32 == STICKY_NOTE_TOGGLE_HOTKEY_ID
            {
                if let Err(err) = toggle_recent_sticky_note_window(&app) {
                    log::warn!("快捷键切换便签小窗失败: {err}");
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
}

#[cfg(windows)]
fn parse_windows_hotkey(
    value: &str,
) -> Option<(
    windows::Win32::UI::Input::KeyboardAndMouse::HOT_KEY_MODIFIERS,
    u32,
)> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        HOT_KEY_MODIFIERS, MOD_ALT, MOD_CONTROL, MOD_SHIFT, MOD_WIN,
    };

    let mut modifiers = HOT_KEY_MODIFIERS(0);
    let mut key: Option<u32> = None;
    for part in value
        .split('+')
        .map(|part| part.trim())
        .filter(|part| !part.is_empty())
    {
        match part.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => modifiers |= MOD_CONTROL,
            "alt" | "option" => modifiers |= MOD_ALT,
            "shift" => modifiers |= MOD_SHIFT,
            "win" | "meta" | "command" | "cmd" => modifiers |= MOD_WIN,
            other => {
                if key.is_some() {
                    return None;
                }
                key = hotkey_key_code(other);
            }
        }
    }
    key.map(|key| (modifiers, key))
}

#[cfg(windows)]
fn hotkey_key_code(value: &str) -> Option<u32> {
    if value.len() == 1 {
        let ch = value.chars().next()?.to_ascii_uppercase();
        if ch.is_ascii_alphanumeric() {
            return Some(ch as u32);
        }
    }
    if let Some(rest) = value.strip_prefix('f') {
        let number: u32 = rest.parse().ok()?;
        if (1..=24).contains(&number) {
            return Some(0x70 + number - 1);
        }
    }
    match value {
        "space" => Some(0x20),
        "tab" => Some(0x09),
        "enter" => Some(0x0D),
        "escape" | "esc" => Some(0x1B),
        _ => None,
    }
}

fn toggle_recent_sticky_note_window(app: &tauri::AppHandle) -> Result<(), String> {
    let mut hid_visible = false;
    for (label, window) in app.webview_windows() {
        if label.starts_with(STICKY_NOTE_WINDOW_LABEL_PREFIX)
            && window.is_visible().unwrap_or(false)
        {
            let _ = window.hide();
            hid_visible = true;
        }
    }
    if hid_visible {
        return Ok(());
    }

    let notes = sticky_notes::list_notes(app)?;
    if let Some(note) = notes.first() {
        open_sticky_note_window_for_note(app, note)?;
    } else {
        create_and_open_sticky_note(app)?;
    }
    Ok(())
}

#[cfg(not(windows))]
fn sticky_note_hotkey_thread(_app: tauri::AppHandle) {
    log::info!("便签全局快捷键首版仅支持 Windows");
}

fn setup_selection_hotkey(app: &tauri::App, state: DesktopState) {
    let app_handle = app.handle().clone();
    let initial_config = selection::load_config(&app_handle);
    let status = state.selection_hotkey_error.clone();
    let trigger_app = app_handle.clone();
    let trigger_state = state.clone();
    let on_trigger = Arc::new(move || {
        let app = trigger_app.clone();
        let state = trigger_state.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(err) = trigger_selection_translate_flow(app, state).await {
                log::warn!("划词翻译触发失败: {err}");
            }
        });
    });
    let controller = selection::start_hotkey_thread(initial_config, status, on_trigger);
    if let Ok(mut guard) = state.selection_hotkey.lock() {
        *guard = Some(controller);
    }
}

async fn run_http_server(state: HttpState) -> anyhow::Result<()> {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let mut app = Router::new()
        .route("/health", get(health))
        .route("/capture", post(capture))
        .route("/translate", post(translate))
        .route("/input_translate", post(translate))
        .route("/selection_translate", post(translate))
        .route("/ocr_recognize", post(ocr_recognize))
        .route("/ocr_translate", post(ocr_translate))
        .route("/region/open", post(region_open))
        .route("/region/close", post(region_close))
        .route("/region/config", get(region_config));

    #[cfg(debug_assertions)]
    {
        app = app
            .route("/debug/sticky/open", post(debug_sticky_open))
            .route(
                "/debug/sticky/frontend-open",
                post(debug_sticky_frontend_open),
            )
            .route(
                "/debug/sticky/frontend-open-existing",
                post(debug_sticky_frontend_open_existing),
            )
            .route(
                "/debug/sticky/frontend-result",
                post(debug_sticky_frontend_result),
            );
    }

    let app = app.with_state(state).layer(cors);

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", DESKTOP_PORT)).await?;
    log::info!("TabKeep desktop HTTP server listening on 127.0.0.1:{DESKTOP_PORT}");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health(AxumState(state): AxumState<HttpState>, headers: HeaderMap) -> impl IntoResponse {
    remember_token_from_headers(&state.desktop, &headers);
    Json(status_payload(&state.desktop))
}

async fn region_open(AxumState(state): AxumState<HttpState>) -> Response {
    match region::open_windows(&state.app) {
        Ok(config) => json_response(
            StatusCode::OK,
            json!({
                "ok": true,
                "config": config
            }),
        ),
        Err(err) => json_response(
            StatusCode::BAD_REQUEST,
            json!({
                "ok": false,
                "error": err
            }),
        ),
    }
}

async fn region_close(AxumState(state): AxumState<HttpState>) -> Response {
    match region::close_windows(&state.app) {
        Ok(()) => json_response(
            StatusCode::OK,
            json!({
                "ok": true
            }),
        ),
        Err(err) => json_response(
            StatusCode::BAD_REQUEST,
            json!({
                "ok": false,
                "error": err
            }),
        ),
    }
}

#[cfg(debug_assertions)]
async fn debug_sticky_open(AxumState(state): AxumState<HttpState>) -> Response {
    match create_and_open_sticky_note(&state.app) {
        Ok(note) => {
            let windows: Vec<String> = state.app.webview_windows().keys().cloned().collect();
            json_response(
                StatusCode::OK,
                json!({
                    "ok": true,
                    "noteId": note.id,
                    "windowLabels": windows,
                }),
            )
        }
        Err(err) => json_response(
            StatusCode::BAD_REQUEST,
            json!({
                "ok": false,
                "error": err,
            }),
        ),
    }
}

#[cfg(debug_assertions)]
async fn debug_sticky_frontend_open(AxumState(state): AxumState<HttpState>) -> Response {
    match state
        .app
        .emit_to("main", "debug-sticky-create-window", json!({}))
    {
        Ok(_) => json_response(
            StatusCode::OK,
            json!({
                "ok": true,
                "message": "debug-sticky-create-window emitted",
            }),
        ),
        Err(err) => json_response(
            StatusCode::BAD_REQUEST,
            json!({
                "ok": false,
                "error": err.to_string(),
            }),
        ),
    }
}

#[cfg(debug_assertions)]
async fn debug_sticky_frontend_open_existing(AxumState(state): AxumState<HttpState>) -> Response {
    match state
        .app
        .emit_to("main", "debug-sticky-open-existing-window", json!({}))
    {
        Ok(_) => json_response(
            StatusCode::OK,
            json!({
                "ok": true,
                "message": "debug-sticky-open-existing-window emitted",
            }),
        ),
        Err(err) => json_response(
            StatusCode::BAD_REQUEST,
            json!({
                "ok": false,
                "error": err.to_string(),
            }),
        ),
    }
}

#[cfg(debug_assertions)]
async fn debug_sticky_frontend_result(Json(payload): Json<Value>) -> Response {
    log::info!("Sticky frontend debug result: {payload}");
    json_response(StatusCode::OK, json!({ "ok": true }))
}

async fn region_config(AxumState(state): AxumState<HttpState>) -> impl IntoResponse {
    Json(json!({
        "ok": true,
        "config": region::load_config(&state.app)
    }))
}

async fn capture(
    AxumState(state): AxumState<HttpState>,
    headers: HeaderMap,
    Json(payload): Json<CapturePayload>,
) -> Response {
    remember_token_from_headers(&state.desktop, &headers);
    if payload.source != "tabkeep" {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({
                "ok": false,
                "error": "unsupported capture source"
            }),
        );
    }

    let body = json!({
        "title": payload.title,
        "url": payload.url,
        "excerpt": payload.excerpt,
        "content": payload.content_markdown,
        "notebook_id": payload.notebook_id.unwrap_or_default(),
        "target_doc": payload.target_doc,
        "mode": payload.mode,
        "meta": {
            "favIconUrl": payload.fav_icon_url,
            "capturedAt": payload.captured_at,
            "via": "tabkeep-desktop"
        }
    });

    let mut req = state
        .desktop
        .client
        .post(format!("{BACKEND_URL}/notes/save"))
        .json(&body);
    if let Some(token) = get_cached_token(&state.desktop) {
        req = req.header("X-TabKeep-Token", token);
    }

    let result = req.send().await;

    let Ok(res) = result else {
        return json_response(
            StatusCode::BAD_GATEWAY,
            json!({
                "ok": false,
                "error": "backend request failed"
            }),
        );
    };

    let status = res.status();
    let data = res.json::<Value>().await.unwrap_or_else(|err| {
        json!({
            "ok": false,
            "error": format!("invalid backend JSON: {err}")
        })
    });
    let saved = status.is_success() && data.get("ok").and_then(Value::as_bool) == Some(true);

    if saved {
        json_response(
            StatusCode::OK,
            json!({
                "ok": true,
                "backendStatus": status.as_u16(),
                "data": data
            }),
        )
    } else {
        json_response(
            StatusCode::BAD_GATEWAY,
            json!({
                "ok": false,
                "backendStatus": status.as_u16(),
                "data": data
            }),
        )
    }
}

async fn translate(
    AxumState(state): AxumState<HttpState>,
    headers: HeaderMap,
    Json(payload): Json<TranslatePayload>,
) -> Response {
    remember_token_from_headers(&state.desktop, &headers);

    let text = payload.text.trim();
    if text.is_empty() {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({
                "ok": false,
                "error": "翻译文本不能为空"
            }),
        );
    }
    if text.chars().count() > MAX_TRANSLATE_CHARS {
        return json_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            json!({
                "ok": false,
                "error": format!("翻译文本过长,请控制在 {MAX_TRANSLATE_CHARS} 字符以内")
            }),
        );
    }

    let source_lang = normalize_lang(payload.source_lang, "auto");
    let target_lang = normalize_lang(payload.target_lang, "简体中文");
    let provider_config = translation::load_config(&state.app);

    if provider_config.provider != translation::TranslateProvider::OpenaiCompatible {
        let translated_text = match translation::translate_fast_provider(
            &state.desktop.client,
            &provider_config,
            text,
            &source_lang,
            &target_lang,
        )
        .await
        {
            Ok(value) => value,
            Err(err) => {
                let error = translation::explain_translate_error(&err);
                return json_response(
                    StatusCode::BAD_REQUEST,
                    json!({
                        "ok": false,
                        "error": error
                    }),
                );
            }
        };

        record_desktop_usage(&state.app, &state.desktop, DesktopUsageKind::Translation);
        return json_response(
            StatusCode::OK,
            json!(TranslateResponse {
                ok: true,
                text: text.to_string(),
                translated_text,
                source_lang,
                target_lang,
                model: provider_config.provider.display_name().to_string(),
            }),
        );
    }

    let token = get_cached_token(&state.desktop);
    let model_config = match load_model_config(&state.desktop, token.as_deref()).await {
        Ok(config) => config,
        Err((status, value)) => return json_response(status, value),
    };

    let translated_text = match call_translation_model(
        &state.desktop,
        &model_config,
        text,
        &source_lang,
        &target_lang,
        payload.context.as_deref(),
    )
    .await
    {
        Ok(value) => value,
        Err((status, value)) => return json_response(status, value),
    };

    record_desktop_usage(&state.app, &state.desktop, DesktopUsageKind::Translation);
    json_response(
        StatusCode::OK,
        json!(TranslateResponse {
            ok: true,
            text: text.to_string(),
            translated_text,
            source_lang,
            target_lang,
            model: model_config.model,
        }),
    )
}

async fn ocr_recognize(
    AxumState(state): AxumState<HttpState>,
    headers: HeaderMap,
    Json(payload): Json<ocr::OcrRequest>,
) -> Response {
    remember_token_from_headers(&state.desktop, &headers);
    match start_ocr_flow(state.app, state.desktop, OcrFlowMode::Recognize, payload).await {
        Ok(result) => json_response(StatusCode::OK, json!(result)),
        Err(err) => json_response(
            StatusCode::BAD_REQUEST,
            json!({
                "ok": false,
                "error": err
            }),
        ),
    }
}

async fn ocr_translate(
    AxumState(state): AxumState<HttpState>,
    headers: HeaderMap,
    Json(payload): Json<ocr::OcrRequest>,
) -> Response {
    remember_token_from_headers(&state.desktop, &headers);
    match start_ocr_flow(state.app, state.desktop, OcrFlowMode::Translate, payload).await {
        Ok(result) => json_response(StatusCode::OK, json!(result)),
        Err(err) => json_response(
            StatusCode::BAD_REQUEST,
            json!({
                "ok": false,
                "error": err
            }),
        ),
    }
}

async fn load_model_config(
    state: &DesktopState,
    token: Option<&str>,
) -> Result<ModelConfigPayload, (StatusCode, Value)> {
    let mut req = state.client.get(format!("{BACKEND_URL}/config"));
    if let Some(token) = token {
        req = req.header("X-TabKeep-Token", token);
    }

    let result = req.send().await.map_err(|err| {
        (
            StatusCode::BAD_GATEWAY,
            json!({
                "ok": false,
                "error": format!("读取模型配置失败: {err}")
            }),
        )
    })?;

    let status = result.status();
    let data = result.json::<BackendConfigPayload>().await.map_err(|err| {
        (
            StatusCode::BAD_GATEWAY,
            json!({
                "ok": false,
                "backendStatus": status.as_u16(),
                "error": format!("模型配置响应不是合法 JSON: {err}")
            }),
        )
    })?;

    if !status.is_success() {
        return Err((
            StatusCode::BAD_GATEWAY,
            json!({
                "ok": false,
                "backendStatus": status.as_u16(),
                "error": "读取模型配置失败"
            }),
        ));
    }

    let Some(config) = data.model_config else {
        return Err((
            StatusCode::BAD_REQUEST,
            json!({
                "ok": false,
                "error": "modelConfig 不完整,请先在模型 API 页面配置"
            }),
        ));
    };
    if config.model.trim().is_empty()
        || config.base_url.trim().is_empty()
        || config.api_key.trim().is_empty()
    {
        return Err((
            StatusCode::BAD_REQUEST,
            json!({
                "ok": false,
                "error": "modelConfig 不完整,请先在模型 API 页面配置"
            }),
        ));
    }

    Ok(config)
}

async fn call_translation_model(
    state: &DesktopState,
    config: &ModelConfigPayload,
    text: &str,
    source_lang: &str,
    target_lang: &str,
    context: Option<&str>,
) -> Result<String, (StatusCode, Value)> {
    let context_line = context
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("\n上下文:{value}"))
        .unwrap_or_default();
    call_translation_model_with_prompts(
        state,
        config,
        "你是 TabKeep 的桌面翻译助手。请忠实翻译用户给出的文本,保留原有换行、列表和代码片段。只输出译文,不要解释。",
        &format!(
            "源语言:{source_lang}\n目标语言:{target_lang}{context_line}\n\n待翻译文本:\n{text}"
        ),
    )
    .await
}

async fn call_translation_model_with_prompts(
    state: &DesktopState,
    config: &ModelConfigPayload,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<String, (StatusCode, Value)> {
    let endpoint = format!("{}/chat/completions", config.base_url.trim_end_matches('/'));
    let body = json!({
        "model": config.model,
        "temperature": 0,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_prompt }
        ]
    });

    let result = state
        .client
        .post(endpoint)
        .timeout(Duration::from_secs(45))
        .bearer_auth(config.api_key.trim())
        .json(&body)
        .send()
        .await
        .map_err(|err| {
            (
                StatusCode::BAD_GATEWAY,
                json!({
                    "ok": false,
                    "error": format!("翻译模型请求失败: {err}")
                }),
            )
        })?;

    let status = result.status();
    let raw = result.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err((
            StatusCode::BAD_GATEWAY,
            json!({
                "ok": false,
                "modelStatus": status.as_u16(),
                "error": "翻译模型返回错误",
                "detail": raw.chars().take(500).collect::<String>()
            }),
        ));
    }

    let payload = serde_json::from_str::<ChatCompletionPayload>(&raw).map_err(|err| {
        (
            StatusCode::BAD_GATEWAY,
            json!({
                "ok": false,
                "error": format!("翻译模型响应不是 OpenAI-compatible JSON: {err}")
            }),
        )
    })?;
    let content = payload
        .choices
        .first()
        .and_then(|choice| choice.message.content.as_deref())
        .map(clean_llm_output)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            (
                StatusCode::BAD_GATEWAY,
                json!({
                    "ok": false,
                    "error": "翻译模型没有返回内容"
                }),
            )
        })?;

    Ok(content)
}

#[tauri::command]
fn get_ocr_config(app: tauri::AppHandle) -> ocr::OcrConfig {
    ocr::load_config(&app)
}

#[tauri::command]
fn set_ocr_config(config: ocr::OcrConfig, app: tauri::AppHandle) -> Result<(), String> {
    ocr::save_config(&app, &config)
}

#[tauri::command]
fn get_translate_provider_config(app: tauri::AppHandle) -> translation::TranslateProviderConfig {
    translation::load_config(&app)
}

#[tauri::command]
fn set_translate_provider_config(
    config: translation::TranslateProviderConfig,
    app: tauri::AppHandle,
) -> Result<translation::TranslateProviderConfig, String> {
    translation::save_config(&app, &config)
}

#[tauri::command]
async fn test_translate_provider(
    config: Option<translation::TranslateProviderConfig>,
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> Result<TranslateProviderTestResponse, String> {
    let config = config.unwrap_or_else(|| translation::load_config(&app));
    let provider = config.provider.display_name().to_string();
    let desktop = state.inner().clone();
    let started = Instant::now();
    if let Err(error) = translation::validate_config(&config) {
        return Ok(TranslateProviderTestResponse {
            ok: false,
            provider,
            translated_text: None,
            latency_ms: started.elapsed().as_millis(),
            error: Some(error),
        });
    }
    let result = if config.provider == translation::TranslateProvider::OpenaiCompatible {
        match test_openai_compatible_provider(&desktop).await {
            Ok(value) => Ok(value),
            Err(err) => Err(err),
        }
    } else {
        translation::translate_fast_provider(
            &desktop.client,
            &config,
            "hello",
            "English",
            "简体中文",
        )
        .await
        .map_err(|err| translation::explain_translate_error(&err))
    };
    let latency_ms = started.elapsed().as_millis();

    match result {
        Ok(translated_text) => Ok(TranslateProviderTestResponse {
            ok: true,
            provider,
            translated_text: Some(translated_text),
            latency_ms,
            error: None,
        }),
        Err(error) => Ok(TranslateProviderTestResponse {
            ok: false,
            provider,
            translated_text: None,
            latency_ms,
            error: Some(error),
        }),
    }
}

#[tauri::command]
async fn start_ocr_recognize(
    payload: Option<ocr::OcrRequest>,
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> Result<ocr::OcrFlowResult, String> {
    start_ocr_flow(
        app,
        state.inner().clone(),
        OcrFlowMode::Recognize,
        payload.unwrap_or_default(),
    )
    .await
}

#[tauri::command]
async fn start_ocr_translate(
    payload: Option<ocr::OcrRequest>,
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> Result<ocr::OcrFlowResult, String> {
    start_ocr_flow(
        app,
        state.inner().clone(),
        OcrFlowMode::Translate,
        payload.unwrap_or_default(),
    )
    .await
}

#[tauri::command]
async fn debug_region_ocr(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> Result<OcrDebugResponse, String> {
    let region_config =
        region::sync_from_box_window(&app).unwrap_or_else(|_| region::load_config(&app));
    let ocr_config = ocr::load_config(&app);
    let provider = ocr_config.provider.clone();
    let source_lang = normalize_ocr_lang(Some(&region_config.source_lang));

    hide_region_windows(&app);
    sleep(Duration::from_millis(140)).await;
    let capture_result = region::capture_region(&app, &region_config);
    show_region_windows(&app, &region_config);

    let image_path = capture_result?;
    let original_dimensions = image::image_dimensions(&image_path).unwrap_or((0, 0));

    let (debug, refinement) = recognize_region_image(
        &app,
        state.inner(),
        &ocr_config,
        &provider,
        &source_lang,
        &image_path,
    )
    .await
    .map_err(|err| format!("OCR 调试任务失败: {err}"))?;

    let preprocessed_path = debug.preprocessed_image_path.as_deref().map(PathBuf::from);
    let preprocessed_dimensions = preprocessed_path
        .as_deref()
        .and_then(|path| image::image_dimensions(path).ok());

    Ok(OcrDebugResponse {
        ok: true,
        provider,
        ocr_engine: refinement.engine,
        ocr_fallback_reason: refinement.fallback_reason,
        source_lang,
        original_image_path: image_path.to_string_lossy().replace("\\\\?\\", ""),
        original_image_data_url: ocr::image_data_url(&image_path),
        original_width: original_dimensions.0,
        original_height: original_dimensions.1,
        preprocessed_image_path: debug.preprocessed_image_path,
        preprocessed_image_data_url: preprocessed_path.as_deref().and_then(ocr::image_data_url),
        preprocessed_width: preprocessed_dimensions.map(|value| value.0),
        preprocessed_height: preprocessed_dimensions.map(|value| value.1),
        raw_text: debug.raw_text,
        text: refinement.text,
        text_boxes: debug.text_boxes,
        translated_regions: refinement.regions,
        elapsed_ms: debug.elapsed_ms,
        config: ocr_config,
    })
}

#[tauri::command]
async fn finish_screen_selection(
    selection: ocr::ScreenSelection,
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> Result<(), String> {
    let desktop = state.inner().clone();
    let pending = take_pending_ocr(&desktop)?;
    let _ = close_capture_window(&app);

    let config = ocr::load_config(&app);
    let provider = pending
        .request
        .provider
        .clone()
        .unwrap_or_else(|| config.provider.clone());
    let source_lang = normalize_ocr_lang(pending.request.source_lang.as_deref());
    let target_lang = normalize_lang(pending.request.target_lang.clone(), "简体中文");

    let cut_path = match ocr::crop_selection(&app, &pending.screenshot, &selection) {
        Ok(path) => path,
        Err(err) => {
            let result = ocr::error_result(err, provider, None);
            let _ = show_ocr_result_window(&app, &desktop, &result);
            let _ = pending.responder.send(result);
            return Ok(());
        }
    };

    let (recognition, refinement) =
        match recognize_region_image(&app, &desktop, &config, &provider, &source_lang, &cut_path)
            .await
        {
            Ok(value) => value,
            Err(err) => {
                let result = ocr::error_result(err, provider, Some(&cut_path));
                let _ = show_ocr_result_window(&app, &desktop, &result);
                let _ = pending.responder.send(result);
                return Ok(());
            }
        };
    let image_dimensions = image::image_dimensions(&cut_path).ok();
    let text = refinement.text;
    let regions = refinement.regions;
    let ocr_engine = refinement.engine;
    let ocr_fallback_reason = refinement.fallback_reason;

    record_desktop_usage(&app, &desktop, DesktopUsageKind::Ocr);
    let result = match pending.mode {
        OcrFlowMode::Recognize => ocr::with_comic_layout(
            ocr::success_result(text, provider.clone(), &cut_path, None, None),
            &recognition.text_boxes,
            &regions,
            image_dimensions,
        ),
        OcrFlowMode::Translate => {
            let mut progress = ocr::with_comic_layout(
                ocr::success_result(text.clone(), provider.clone(), &cut_path, None, None),
                &recognition.text_boxes,
                &regions,
                image_dimensions,
            );
            progress.phase = Some("translate".to_string());
            progress.message = Some("OCR 完成,正在翻译...".to_string());
            progress = ocr::with_ocr_engine(progress, &ocr_engine, ocr_fallback_reason.clone());
            let _ = show_ocr_result_window(&app, &desktop, &progress);

            let translation_result = if regions.is_empty() {
                translate_ocr_text(&app, &desktop, &text, &source_lang, &target_lang)
                    .await
                    .map(|(translated_text, model)| (translated_text, Vec::new(), model))
            } else {
                translate_ocr_regions(&app, &desktop, regions.clone(), &source_lang, &target_lang)
                    .await
                    .map(|(regions, model)| (joined_region_translations(&regions), regions, model))
            };

            match translation_result {
                Ok((translated_text, translated_regions, model)) => ocr::with_comic_layout(
                    ocr::success_result(
                        text,
                        provider.clone(),
                        &cut_path,
                        Some(translated_text),
                        Some(model),
                    ),
                    &recognition.text_boxes,
                    &translated_regions,
                    image_dimensions,
                ),
                Err(err) => {
                    let mut result = ocr::with_comic_layout(
                        ocr::success_result(text, provider.clone(), &cut_path, None, None),
                        &recognition.text_boxes,
                        &regions,
                        image_dimensions,
                    );
                    result.ok = false;
                    result.error = Some(err);
                    result.phase = Some("error".to_string());
                    result.message = Some("翻译失败".to_string());
                    result
                }
            }
        }
    };
    let result = ocr::with_ocr_engine(result, &ocr_engine, ocr_fallback_reason);

    let _ = show_ocr_result_window(&app, &desktop, &result);
    let _ = pending.responder.send(result);
    Ok(())
}

#[tauri::command]
fn cancel_screen_selection(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> Result<(), String> {
    let desktop = state.inner().clone();
    let Some(pending) = take_pending_ocr_optional(&desktop)? else {
        let _ = close_capture_window(&app);
        return Ok(());
    };

    let _ = close_capture_window(&app);
    let config = ocr::load_config(&app);
    let provider = pending
        .request
        .provider
        .clone()
        .unwrap_or_else(|| config.provider.clone());
    let result = ocr::error_result("已取消截图".to_string(), provider, None);
    let _ = show_ocr_result_window(&app, &desktop, &result);
    let _ = pending.responder.send(result);
    Ok(())
}

#[tauri::command]
fn get_latest_ocr_result(state: tauri::State<'_, DesktopState>) -> Option<ocr::OcrFlowResult> {
    state
        .latest_ocr_result
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
}

#[tauri::command]
fn get_ocr_debug_records(app: tauri::AppHandle) -> Result<Vec<ocr::OcrDebugRecord>, String> {
    ocr::load_debug_records(&app)
}

#[tauri::command]
fn open_region_box(app: tauri::AppHandle) -> Result<region::RegionBoxConfig, String> {
    region::open_windows(&app)
}

#[tauri::command]
fn close_region_box(app: tauri::AppHandle) -> Result<(), String> {
    region::close_windows(&app)
}

#[tauri::command]
fn get_region_box_config(app: tauri::AppHandle) -> region::RegionBoxConfig {
    region::load_config(&app)
}

#[tauri::command]
fn set_region_box_config(
    config: region::RegionBoxConfig,
    app: tauri::AppHandle,
) -> Result<region::RegionBoxConfig, String> {
    region::save_live_box_config(&app, &config)
}

#[tauri::command]
fn set_region_box_passthrough(
    pass_through: bool,
    app: tauri::AppHandle,
) -> Result<region::RegionBoxConfig, String> {
    region::set_passthrough(&app, pass_through)
}

#[tauri::command]
async fn run_region_ocr(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> Result<ocr::OcrFlowResult, String> {
    run_region_flow(app, state.inner().clone(), OcrFlowMode::Recognize).await
}

#[tauri::command]
async fn run_region_translate(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> Result<ocr::OcrFlowResult, String> {
    run_region_flow(app, state.inner().clone(), OcrFlowMode::Translate).await
}

#[tauri::command]
fn get_selection_translate_config(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> selection::SelectionTranslateConfig {
    let error = state
        .selection_hotkey_error
        .lock()
        .ok()
        .and_then(|guard| guard.clone());
    selection::load_config(&app).with_hotkey_error(error)
}

#[tauri::command]
fn set_selection_translate_config(
    config: selection::SelectionTranslateConfig,
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> Result<selection::SelectionTranslateConfig, String> {
    let saved = selection::save_config(&app, &config)?;
    let hotkey_error = {
        let guard = state
            .selection_hotkey
            .lock()
            .map_err(|_| "全局快捷键状态锁已损坏".to_string())?;
        if let Some(controller) = guard.as_ref() {
            controller.configure(saved.clone())?
        } else {
            Some("全局快捷键线程尚未启动".to_string())
        }
    };
    if let Ok(mut guard) = state.selection_hotkey_error.lock() {
        *guard = hotkey_error.clone();
    }
    Ok(saved.with_hotkey_error(hotkey_error))
}

#[tauri::command]
async fn trigger_selection_translate(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> Result<selection::SelectionTranslateResult, String> {
    trigger_selection_translate_flow(app, state.inner().clone()).await
}

#[tauri::command]
fn get_latest_selection_translate_result(
    state: tauri::State<'_, DesktopState>,
) -> Option<selection::SelectionTranslateResult> {
    state
        .latest_selection_result
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
}

#[tauri::command]
fn get_desktop_status(state: tauri::State<'_, DesktopState>) -> DesktopStatus {
    status_payload(&state)
}

#[tauri::command]
fn get_cached_api_token(state: tauri::State<'_, DesktopState>) -> Option<String> {
    get_cached_token(&state)
}

#[tauri::command]
fn set_cached_api_token(
    token: String,
    state: tauri::State<'_, DesktopState>,
) -> Result<(), String> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("API token 不能为空".to_string());
    }
    set_cached_token(&state, Some(token));
    Ok(())
}

#[tauri::command]
fn clear_cached_api_token(state: tauri::State<'_, DesktopState>) {
    set_cached_token(&state, None);
}

#[tauri::command]
async fn backend_request(
    method: String,
    path: String,
    body: Option<Value>,
    state: tauri::State<'_, DesktopState>,
) -> Result<BackendResponse, String> {
    if !path.starts_with('/') || path.contains("://") {
        return Err("非法后端路径".to_string());
    }

    let body = body.filter(|value| !value.is_null());

    if let Some(token) = body
        .as_ref()
        .and_then(|value| value.get("apiToken"))
        .and_then(Value::as_str)
        .filter(|token| !token.trim().is_empty())
    {
        set_cached_token(&state, Some(token.trim().to_string()));
    }

    let method = Method::from_bytes(method.to_uppercase().as_bytes())
        .map_err(|err| format!("非法 HTTP 方法: {err}"))?;
    let url = format!("{BACKEND_URL}{path}");
    let mut req = state.client.request(method, url);

    if path != "/" {
        if let Some(token) = get_cached_token(&state) {
            req = req.header("X-TabKeep-Token", token);
        }
    }
    if let Some(body) = body {
        req = req.json(&body);
    }

    let res = req
        .send()
        .await
        .map_err(|err| format!("后端请求失败: {err}"))?;
    let status = res.status();
    let data = res.json::<Value>().await.unwrap_or_else(|err| {
        json!({
            "detail": format!("后端返回非 JSON: {err}")
        })
    });

    Ok(BackendResponse {
        status: status.as_u16(),
        ok: status.is_success(),
        data,
    })
}

async fn start_ocr_flow(
    app: tauri::AppHandle,
    state: DesktopState,
    mode: OcrFlowMode,
    request: ocr::OcrRequest,
) -> Result<ocr::OcrFlowResult, String> {
    if !request.screenshot {
        return Err("当前 OCR 流程仅支持 screenshot=true".to_string());
    }
    if state
        .pending_ocr
        .lock()
        .map_err(|_| "OCR 状态锁已损坏".to_string())?
        .is_some()
    {
        return Err("已有截图 OCR 流程正在进行".to_string());
    }

    let screenshot = ocr::capture_primary_screen(&app)?;
    let (sender, receiver) = oneshot::channel();
    {
        let mut guard = state
            .pending_ocr
            .lock()
            .map_err(|_| "OCR 状态锁已损坏".to_string())?;
        if guard.is_some() {
            return Err("已有截图 OCR 流程正在进行".to_string());
        }
        *guard = Some(PendingOcrFlow {
            mode,
            request,
            screenshot,
            responder: sender,
        });
    }

    if let Err(err) = open_capture_window(&app) {
        let _ = take_pending_ocr_optional(&state);
        return Err(err);
    }

    receiver
        .await
        .map_err(|_| "截图 OCR 流程已中断".to_string())
}

async fn recognize_region_image(
    app: &tauri::AppHandle,
    state: &DesktopState,
    config: &ocr::OcrConfig,
    provider: &ocr::OcrProvider,
    source_lang: &str,
    image_path: &std::path::Path,
) -> Result<(ocr::OcrRecognitionDebug, OcrRegionRefinement), String> {
    if ocr::should_use_comic_detector(config) {
        let started = Instant::now();
        let refinement = refine_regions_with_manga_ocr(
            state,
            config,
            provider,
            source_lang,
            image_path,
            String::new(),
            Vec::new(),
        )
        .await;
        if refinement.text.trim().is_empty() {
            return Err(refinement
                .fallback_reason
                .clone()
                .unwrap_or_else(|| "漫画模式未识别到文字".to_string()));
        }
        let recognition = ocr::OcrRecognitionDebug {
            raw_text: refinement.text.clone(),
            text: refinement.text.clone(),
            text_boxes: Vec::new(),
            preprocessed_image_path: None,
            elapsed_ms: started.elapsed().as_millis(),
        };
        return Ok((recognition, refinement));
    }

    let app_for_ocr = app.clone();
    let config_for_ocr = config.clone();
    let provider_for_ocr = provider.clone();
    let path_for_ocr = image_path.to_path_buf();
    let lang_for_ocr = source_lang.to_string();
    let recognition = tauri::async_runtime::spawn_blocking(move || {
        ocr::recognize_with_debug(
            &app_for_ocr,
            &config_for_ocr,
            provider_for_ocr,
            &path_for_ocr,
            &lang_for_ocr,
        )
    })
    .await
    .map_err(|err| format!("OCR 任务失败: {err}"))??;
    if recognition.text.trim().is_empty() {
        return Err("未识别到文字".to_string());
    }
    let regions = ocr::build_comic_text_regions(&recognition.text_boxes, source_lang);
    let refinement = OcrRegionRefinement {
        text: recognition.text.clone(),
        regions,
        engine: ocr::provider_engine_name(provider).to_string(),
        fallback_reason: None,
    };
    Ok((recognition, refinement))
}

async fn run_region_flow(
    app: tauri::AppHandle,
    state: DesktopState,
    mode: OcrFlowMode,
) -> Result<ocr::OcrFlowResult, String> {
    let region_config =
        region::sync_from_box_window(&app).unwrap_or_else(|_| region::load_config(&app));
    let ocr_config = ocr::load_config(&app);
    let provider = ocr_config.provider.clone();
    let source_lang = normalize_ocr_lang(Some(&region_config.source_lang));
    let target_lang = normalize_lang(Some(region_config.target_lang.clone()), "简体中文");

    hide_region_windows(&app);
    sleep(Duration::from_millis(140)).await;
    let capture_result = region::capture_region(&app, &region_config);
    show_region_windows(&app, &region_config);

    let image_path = match capture_result {
        Ok(path) => path,
        Err(err) => {
            let result = ocr::error_result_without_image(err, provider, None);
            publish_region_result(&app, &state, &result);
            return Ok(result);
        }
    };

    let (recognition, refinement) = match recognize_region_image(
        &app,
        &state,
        &ocr_config,
        &provider,
        &source_lang,
        &image_path,
    )
    .await
    {
        Ok(value) => value,
        Err(err) => {
            let result = ocr::error_result_without_image(err, provider, Some(&image_path));
            publish_region_result(&app, &state, &result);
            return Ok(result);
        }
    };
    let image_dimensions = image::image_dimensions(&image_path).ok();
    let text = refinement.text;
    let regions = refinement.regions;
    let ocr_engine = refinement.engine;
    let ocr_fallback_reason = refinement.fallback_reason;

    record_desktop_usage(&app, &state, DesktopUsageKind::Ocr);
    let mode_label = match mode {
        OcrFlowMode::Recognize => "recognize",
        OcrFlowMode::Translate => "translate",
    };
    let result = match mode {
        OcrFlowMode::Recognize => ocr::with_comic_layout(
            ocr::success_result_without_image(text, provider.clone(), &image_path, None, None),
            &recognition.text_boxes,
            &regions,
            image_dimensions,
        ),
        OcrFlowMode::Translate => {
            let mut progress = ocr::with_comic_layout(
                ocr::success_result_without_image(
                    text.clone(),
                    provider.clone(),
                    &image_path,
                    None,
                    None,
                ),
                &recognition.text_boxes,
                &regions,
                image_dimensions,
            );
            progress.phase = Some("translate".to_string());
            progress.message = Some("OCR 完成,正在翻译...".to_string());
            progress = ocr::with_ocr_engine(progress, &ocr_engine, ocr_fallback_reason.clone());
            publish_region_result(&app, &state, &progress);

            let translation_result = if regions.is_empty() {
                translate_ocr_text(&app, &state, &text, &source_lang, &target_lang)
                    .await
                    .map(|(translated_text, model)| (translated_text, Vec::new(), model))
            } else {
                translate_ocr_regions(&app, &state, regions.clone(), &source_lang, &target_lang)
                    .await
                    .map(|(regions, model)| (joined_region_translations(&regions), regions, model))
            };

            match translation_result {
                Ok((translated_text, translated_regions, model)) => ocr::with_comic_layout(
                    ocr::success_result_without_image(
                        text,
                        provider.clone(),
                        &image_path,
                        Some(translated_text),
                        Some(model),
                    ),
                    &recognition.text_boxes,
                    &translated_regions,
                    image_dimensions,
                ),
                Err(err) => {
                    let mut result = ocr::with_comic_layout(
                        ocr::success_result_without_image(
                            text,
                            provider.clone(),
                            &image_path,
                            None,
                            None,
                        ),
                        &recognition.text_boxes,
                        &regions,
                        image_dimensions,
                    );
                    result.ok = false;
                    result.error = Some(err);
                    result.phase = Some("error".to_string());
                    result.message = Some("翻译失败".to_string());
                    result
                }
            }
        }
    };
    let result = ocr::with_ocr_engine(result, &ocr_engine, ocr_fallback_reason);

    if let Err(err) = ocr::save_region_debug_record(
        &app,
        mode_label,
        &source_lang,
        &target_lang,
        provider.clone(),
        &image_path,
        &recognition,
        &result,
    ) {
        log::warn!("保存 OCR 调试记录失败: {err}");
    }

    publish_region_result(&app, &state, &result);
    Ok(result)
}

async fn refine_regions_with_manga_ocr(
    state: &DesktopState,
    config: &ocr::OcrConfig,
    provider: &ocr::OcrProvider,
    source_lang: &str,
    image_path: &std::path::Path,
    fallback_text: String,
    mut regions: Vec<ocr::ComicTextRegion>,
) -> OcrRegionRefinement {
    let fallback_engine = if ocr::should_use_comic_detector(config) {
        "RT-DETR-v2 INT8 ONNX + MangaOCR".to_string()
    } else {
        ocr::provider_engine_name(provider).to_string()
    };
    if !ocr::should_use_comic_detector(config) {
        return OcrRegionRefinement {
            text: fallback_text,
            regions,
            engine: fallback_engine,
            fallback_reason: None,
        };
    }
    let paddle_regions = regions.clone();

    let image_bytes = match fs::read(image_path) {
        Ok(bytes) => bytes,
        Err(err) => {
            return manga_ocr_fallback(
                fallback_text,
                regions,
                fallback_engine,
                format!("读取截图失败: {err}"),
            )
        }
    };
    let image_base64 = general_purpose::STANDARD.encode(image_bytes);
    let detector_source_lang = if matches!(source_lang, "auto" | "自动识别") {
        "ja-JP"
    } else {
        source_lang
    };
    let (detector_engine, detector_fallback_reason) =
        match detect_comic_regions(state, &image_base64, detector_source_lang).await {
            Ok((detected_regions, engine)) if !detected_regions.is_empty() => {
                regions = detected_regions;
                (Some(engine), None)
            }
            Ok(_) => (None, Some("RT-DETR 未检测到漫画文字区域".to_string())),
            Err(err) => (None, Some(format!("RT-DETR 区域检测不可用: {err}"))),
        };
    if regions.is_empty() {
        return OcrRegionRefinement {
            text: fallback_text,
            regions,
            engine: fallback_engine,
            fallback_reason: detector_fallback_reason
                .or_else(|| Some("未提供可供 MangaOCR 重识别的区域".to_string())),
        };
    }

    if !ocr::should_use_manga_ocr(config, source_lang, &fallback_text) {
        if detector_engine.is_some() {
            populate_detected_regions_from_ocr(&mut regions, &paddle_regions, source_lang);
            regions.retain(|region| !region.source_text.trim().is_empty());
            if regions.is_empty() {
                return OcrRegionRefinement {
                    text: fallback_text,
                    regions: paddle_regions,
                    engine: fallback_engine,
                    fallback_reason: Some(
                        "RT-DETR 区域未能与 OCR 文本对齐，已回退原始区域".to_string(),
                    ),
                };
            }
            let detector = detector_engine.unwrap_or_else(|| "RT-DETR-v2 INT8 ONNX".to_string());
            return OcrRegionRefinement {
                text: ocr::join_region_source_text(&regions),
                regions,
                engine: format!("{detector} + {fallback_engine}"),
                fallback_reason: detector_fallback_reason,
            };
        }
        return OcrRegionRefinement {
            text: fallback_text,
            regions,
            engine: fallback_engine,
            fallback_reason: detector_fallback_reason,
        };
    }

    let payload = MangaOcrRequest {
        image_base64,
        regions: regions
            .iter()
            .map(|region| MangaOcrRegionRequest {
                id: region.id.clone(),
                x: region.text_bounds.x,
                y: region.text_bounds.y,
                width: region.text_bounds.width,
                height: region.text_bounds.height,
            })
            .collect(),
    };
    let mut request = state
        .client
        .post(format!("{BACKEND_URL}/ocr/manga"))
        .timeout(Duration::from_secs(300))
        .json(&payload);
    if let Some(token) = get_cached_token(state) {
        request = request.header("X-TabKeep-Token", token);
    }

    let response = match request.send().await {
        Ok(response) => response,
        Err(err) => {
            return manga_ocr_fallback(
                fallback_text,
                paddle_regions,
                fallback_engine,
                format!("MangaOCR 服务不可用: {err}"),
            )
        }
    };
    let status = response.status();
    let payload = match response.json::<MangaOcrResponse>().await {
        Ok(payload) => payload,
        Err(err) => {
            return manga_ocr_fallback(
                fallback_text,
                paddle_regions,
                fallback_engine,
                format!("MangaOCR 响应无效（HTTP {}）: {err}", status.as_u16()),
            )
        }
    };
    if !status.is_success() || !payload.ok {
        return manga_ocr_fallback(
            fallback_text,
            paddle_regions,
            fallback_engine,
            payload
                .error
                .unwrap_or_else(|| format!("MangaOCR 请求失败（HTTP {}）", status.as_u16())),
        );
    }

    let updated = apply_manga_ocr_results(&mut regions, &payload.regions);
    if updated == 0 {
        return manga_ocr_fallback(
            fallback_text,
            paddle_regions,
            fallback_engine,
            "MangaOCR 未返回有效文字".to_string(),
        );
    }
    let missing = regions.len().saturating_sub(updated);
    if detector_engine.is_some() {
        regions.retain(|region| !region.source_text.trim().is_empty());
    }
    let manga_fallback_reason =
        (missing > 0).then(|| format!("MangaOCR 有 {missing} 个区域未返回文字"));
    let fallback_reason = match (detector_fallback_reason, manga_fallback_reason) {
        (Some(detector), Some(manga)) => Some(format!("{detector}; {manga}")),
        (Some(detector), None) => Some(detector),
        (None, Some(manga)) => Some(manga),
        (None, None) => None,
    };
    let manga_engine = if payload.engine.trim().is_empty() {
        "MangaOCR".to_string()
    } else {
        payload.engine
    };
    let engine = detector_engine
        .map(|detector| format!("{detector} + {manga_engine}"))
        .unwrap_or(manga_engine);
    OcrRegionRefinement {
        text: ocr::join_region_source_text(&regions),
        regions,
        engine,
        fallback_reason,
    }
}

fn apply_manga_ocr_results(
    regions: &mut [ocr::ComicTextRegion],
    recognized: &[MangaOcrRegionResponse],
) -> usize {
    let mut updated = 0;
    for region in regions {
        let Some(item) = recognized
            .iter()
            .find(|item| item.id == region.id && !item.text.trim().is_empty())
        else {
            continue;
        };
        region.source_text = item.text.trim().to_string();
        updated += 1;
    }
    updated
}

async fn detect_comic_regions(
    state: &DesktopState,
    image_base64: &str,
    source_lang: &str,
) -> Result<(Vec<ocr::ComicTextRegion>, String), String> {
    let payload = ComicDetectionRequest {
        image_base64: image_base64.to_string(),
        source_lang: source_lang.to_string(),
    };
    let mut request = state
        .client
        .post(format!("{BACKEND_URL}/ocr/comic/detect"))
        .timeout(Duration::from_secs(300))
        .json(&payload);
    if let Some(token) = get_cached_token(state) {
        request = request.header("X-TabKeep-Token", token);
    }
    let response = request
        .send()
        .await
        .map_err(|err| format!("检测服务不可用: {err}"))?;
    let status = response.status();
    let payload = response
        .json::<ComicDetectionResponse>()
        .await
        .map_err(|err| format!("检测响应无效（HTTP {}）: {err}", status.as_u16()))?;
    if !status.is_success() || !payload.ok {
        return Err(payload
            .error
            .unwrap_or_else(|| format!("检测请求失败（HTTP {}）", status.as_u16())));
    }
    let regions = payload
        .regions
        .into_iter()
        .map(|region| ocr::ComicTextRegion {
            id: region.id,
            text_bounds: region.text_bounds,
            bubble_bounds: region.bubble_bounds,
            source_text: String::new(),
            translated_text: None,
            direction: region.direction,
            reading_order: region.reading_order,
            confidence: Some(region.confidence),
            line_boxes: Vec::new(),
        })
        .collect();
    Ok((regions, payload.engine))
}

fn populate_detected_regions_from_ocr(
    detected_regions: &mut [ocr::ComicTextRegion],
    ocr_regions: &[ocr::ComicTextRegion],
    source_lang: &str,
) {
    let mut candidates = Vec::new();
    for region in ocr_regions {
        if region.line_boxes.is_empty() {
            if !region.source_text.trim().is_empty() {
                candidates.push((
                    region.text_bounds,
                    region.source_text.trim().to_string(),
                    region.confidence,
                ));
            }
            continue;
        }
        for line in &region.line_boxes {
            if line.text.trim().is_empty() {
                continue;
            }
            candidates.push((
                ocr::OcrBounds {
                    x: line.x,
                    y: line.y,
                    width: line.width,
                    height: line.height,
                },
                line.text.trim().to_string(),
                line.score,
            ));
        }
    }

    for region in detected_regions {
        let mut matches = candidates
            .iter()
            .filter(|(bounds, _, _)| bounds_belong_to_region(bounds, &region.text_bounds))
            .collect::<Vec<_>>();
        matches.sort_by(|first, second| match region.direction {
            ocr::ComicTextDirection::Horizontal => first
                .0
                .y
                .partial_cmp(&second.0.y)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| {
                    first
                        .0
                        .x
                        .partial_cmp(&second.0.x)
                        .unwrap_or(std::cmp::Ordering::Equal)
                }),
            ocr::ComicTextDirection::Vertical => second
                .0
                .x
                .partial_cmp(&first.0.x)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| {
                    first
                        .0
                        .y
                        .partial_cmp(&second.0.y)
                        .unwrap_or(std::cmp::Ordering::Equal)
                }),
        });
        let separator = if matches!(
            source_lang,
            "zh" | "zh-CN" | "zh-TW" | "ja" | "ja-JP" | "ko" | "ko-KR"
        ) {
            ""
        } else {
            " "
        };
        region.source_text = matches
            .iter()
            .map(|(_, text, _)| text.as_str())
            .collect::<Vec<_>>()
            .join(separator);
        region.confidence = {
            let scores = matches
                .iter()
                .filter_map(|(_, _, score)| *score)
                .collect::<Vec<_>>();
            (!scores.is_empty()).then(|| scores.iter().sum::<f32>() / scores.len() as f32)
        };
    }
}

fn bounds_belong_to_region(candidate: &ocr::OcrBounds, region: &ocr::OcrBounds) -> bool {
    let center_x = candidate.x + candidate.width / 2.0;
    let center_y = candidate.y + candidate.height / 2.0;
    let center_inside = center_x >= region.x
        && center_x <= region.x + region.width
        && center_y >= region.y
        && center_y <= region.y + region.height;
    if center_inside {
        return true;
    }
    let intersection_width =
        (candidate.x + candidate.width).min(region.x + region.width) - candidate.x.max(region.x);
    let intersection_height =
        (candidate.y + candidate.height).min(region.y + region.height) - candidate.y.max(region.y);
    let intersection = intersection_width.max(0.0) * intersection_height.max(0.0);
    let candidate_area = candidate.width.max(0.0) * candidate.height.max(0.0);
    candidate_area > 0.0 && intersection / candidate_area >= 0.15
}

fn manga_ocr_fallback(
    text: String,
    regions: Vec<ocr::ComicTextRegion>,
    engine: String,
    reason: String,
) -> OcrRegionRefinement {
    log::warn!("MangaOCR 回退到 {engine}: {reason}");
    OcrRegionRefinement {
        text,
        regions,
        engine,
        fallback_reason: Some(reason),
    }
}

async fn trigger_selection_translate_flow(
    app: tauri::AppHandle,
    state: DesktopState,
) -> Result<selection::SelectionTranslateResult, String> {
    let _run_guard = begin_selection_run(&state)?;
    log::info!("Selection translate flow started");
    let config = selection::load_config(&app);
    let source_lang = normalize_lang(Some(config.source_lang.clone()), "auto");
    let target_lang = normalize_lang(Some(config.target_lang.clone()), "简体中文");
    let (x, y) = selection::cursor_position();

    if !config.enabled {
        let result = selection::error_result(
            String::new(),
            source_lang,
            target_lang,
            "划词翻译未启用".to_string(),
            x,
            y,
        );
        publish_selection_result(&app, &state, &result);
        return Ok(result);
    }

    let selected_text =
        match tauri::async_runtime::spawn_blocking(selection::read_selected_text_via_copy).await {
            Ok(Ok(text)) => text,
            Ok(Err(err)) => {
                let result =
                    selection::error_result(String::new(), source_lang, target_lang, err, x, y);
                publish_selection_result(&app, &state, &result);
                return Ok(result);
            }
            Err(err) => {
                let result = selection::error_result(
                    String::new(),
                    source_lang,
                    target_lang,
                    format!("读取选中文本任务失败: {err}"),
                    x,
                    y,
                );
                publish_selection_result(&app, &state, &result);
                return Ok(result);
            }
        };
    log::info!(
        "Selection translate copied text, chars={}",
        selected_text.chars().count()
    );

    if selected_text.chars().count() > MAX_TRANSLATE_CHARS {
        let result = selection::error_result(
            selected_text,
            source_lang,
            target_lang,
            format!("选中文本过长,最多支持 {MAX_TRANSLATE_CHARS} 字符"),
            x,
            y,
        );
        publish_selection_result(&app, &state, &result);
        return Ok(result);
    }

    let progress = selection::progress_result(
        selected_text.clone(),
        source_lang.clone(),
        target_lang.clone(),
        "translate",
        "正在翻译选中文本...",
        x,
        y,
    );
    publish_selection_result(&app, &state, &progress);
    log::info!("Selection translate provider request started");

    let result = match translate_desktop_text(
        &app,
        &state,
        &selected_text,
        &source_lang,
        &target_lang,
        Some("用户在其他应用中选中的文本"),
    )
    .await
    {
        Ok((translated_text, model)) => selection::success_result(
            selected_text,
            translated_text,
            model,
            source_lang,
            target_lang,
            x,
            y,
        ),
        Err(err) => selection::error_result(selected_text, source_lang, target_lang, err, x, y),
    };
    publish_selection_result(&app, &state, &result);
    log::info!("Selection translate flow finished, ok={}", result.ok);
    Ok(result)
}

struct SelectionRunGuard {
    state: DesktopState,
}

impl Drop for SelectionRunGuard {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.state.selection_running.lock() {
            *guard = false;
        }
    }
}

fn begin_selection_run(state: &DesktopState) -> Result<SelectionRunGuard, String> {
    let mut guard = state
        .selection_running
        .lock()
        .map_err(|_| "划词翻译状态锁已损坏".to_string())?;
    if *guard {
        return Err("已有划词翻译正在进行".to_string());
    }
    *guard = true;
    Ok(SelectionRunGuard {
        state: state.clone(),
    })
}

fn hide_region_windows(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("region-box") {
        let _ = window.hide();
    }
    if let Some(window) = app.get_webview_window("region-panel") {
        let _ = window.hide();
    }
}

fn show_region_windows(app: &tauri::AppHandle, config: &region::RegionBoxConfig) {
    if let Some(window) = app.get_webview_window("region-box") {
        let _ = window.show();
    }
    let _ = region::apply_window_config(app, config);
    region::emit_config(app, config);
}

fn publish_region_result(
    app: &tauri::AppHandle,
    state: &DesktopState,
    result: &ocr::OcrFlowResult,
) {
    if let Ok(mut guard) = state.latest_ocr_result.lock() {
        *guard = Some(result.clone());
    }
    let _ = app.emit_to("region-box", "region-result-updated", result.clone());
    if should_show_region_result(result) {
        if let Some(window) = app.get_webview_window("region-panel") {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
    let _ = app.emit_to("region-panel", "region-result-updated", result.clone());
}

fn should_show_region_result(result: &ocr::OcrFlowResult) -> bool {
    result
        .translated_text
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
        || (result.error.is_some() && !result.text.trim().is_empty())
}

fn publish_selection_result(
    app: &tauri::AppHandle,
    state: &DesktopState,
    result: &selection::SelectionTranslateResult,
) {
    if let Ok(mut guard) = state.latest_selection_result.lock() {
        *guard = Some(result.clone());
    }
    match selection::open_panel_window(app, result.x, result.y) {
        Ok(window) => {
            let _ = window.show();
            let _ = window.set_focus();
        }
        Err(err) => {
            log::warn!("{err}");
        }
    }
    let _ = app.emit_to(
        "selection-panel",
        "selection-result-updated",
        result.clone(),
    );
}

fn open_capture_window(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("capture") {
        let _ = win.close();
    }
    let win = WebviewWindowBuilder::new(
        app,
        "capture",
        WebviewUrl::App("index.html?view=capture".into()),
    )
    .title("TabKeep Capture")
    .fullscreen(true)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .focused(true)
    .visible(true)
    .build()
    .map_err(|err| format!("打开截图窗口失败: {err}"))?;
    let _ = win.set_focus();
    Ok(())
}

fn close_capture_window(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("capture") {
        win.close()
            .map_err(|err| format!("关闭截图窗口失败: {err}"))?;
    }
    Ok(())
}

fn show_ocr_result_window(
    app: &tauri::AppHandle,
    state: &DesktopState,
    result: &ocr::OcrFlowResult,
) -> Result<(), String> {
    if let Ok(mut guard) = state.latest_ocr_result.lock() {
        *guard = Some(result.clone());
    }

    let win = if let Some(win) = app.get_webview_window("ocr-result") {
        win
    } else {
        WebviewWindowBuilder::new(
            app,
            "ocr-result",
            WebviewUrl::App("index.html?view=ocr-result".into()),
        )
        .title("TabKeep OCR")
        .inner_size(560.0, 680.0)
        .center()
        .decorations(true)
        .always_on_top(true)
        .focused(true)
        .visible(true)
        .build()
        .map_err(|err| format!("打开 OCR 结果窗口失败: {err}"))?
    };
    let _ = win.show();
    let _ = win.set_focus();
    let _ = app.emit_to("ocr-result", "ocr-result-updated", result.clone());
    Ok(())
}

fn take_pending_ocr(state: &DesktopState) -> Result<PendingOcrFlow, String> {
    take_pending_ocr_optional(state)?.ok_or_else(|| "没有正在进行的截图 OCR 流程".to_string())
}

fn take_pending_ocr_optional(state: &DesktopState) -> Result<Option<PendingOcrFlow>, String> {
    let mut guard = state
        .pending_ocr
        .lock()
        .map_err(|_| "OCR 状态锁已损坏".to_string())?;
    Ok(guard.take())
}

async fn translate_ocr_text(
    app: &tauri::AppHandle,
    state: &DesktopState,
    text: &str,
    source_lang: &str,
    target_lang: &str,
) -> Result<(String, String), String> {
    translate_desktop_text(
        app,
        state,
        text,
        source_lang,
        target_lang,
        Some("OCR 截图识别结果"),
    )
    .await
}

async fn translate_ocr_regions(
    app: &tauri::AppHandle,
    state: &DesktopState,
    mut regions: Vec<ocr::ComicTextRegion>,
    source_lang: &str,
    target_lang: &str,
) -> Result<(Vec<ocr::ComicTextRegion>, String), String> {
    if regions.is_empty() {
        return Err("没有可翻译的漫画文本区域".to_string());
    }

    let provider_config = translation::load_config(app);
    if provider_config.provider != translation::TranslateProvider::OpenaiCompatible {
        for region in &mut regions {
            let translated_text = translation::translate_fast_provider(
                &state.client,
                &provider_config,
                &region.source_text,
                source_lang,
                target_lang,
            )
            .await
            .map_err(|err| translation::explain_translate_error(&err))?;
            region.translated_text = Some(translated_text);
        }
        record_desktop_usage(app, state, DesktopUsageKind::Translation);
        return Ok((regions, provider_config.provider.display_name().to_string()));
    }

    let token = get_cached_token(state);
    let model_config = load_model_config(state, token.as_deref())
        .await
        .map_err(error_from_json_response)?;
    let model = model_config.model.clone();
    let source_payload = regions
        .iter()
        .map(|region| {
            json!({
                "id": region.id,
                "text": region.source_text,
                "readingOrder": region.reading_order,
                "direction": region.direction,
            })
        })
        .collect::<Vec<_>>();
    let user_prompt = format!(
        "源语言:{source_lang}\n目标语言:{target_lang}\n场景:漫画或图片中的多个独立文本区域。请结合整页上下文翻译，但不要合并、拆分或重排区域。\n\n输入区域 JSON:\n{}",
        serde_json::to_string_pretty(&source_payload).unwrap_or_default()
    );
    let structured_result = call_translation_model_with_prompts(
        state,
        &model_config,
        "你是漫画翻译助手。必须只输出合法 JSON，格式为 {\"translations\":[{\"id\":\"region_01\",\"text\":\"译文\"}]}。每个输入 id 必须且只能出现一次，不得改变 id，不得增加解释。",
        &user_prompt,
    )
    .await
    .map_err(error_from_json_response)
    .and_then(|raw| apply_region_translations(&mut regions, &raw));

    if structured_result.is_err() {
        log::warn!("结构化区域翻译解析失败，改为逐区域翻译以保持坐标映射");
        for region in &mut regions {
            let translated_text = call_translation_model(
                state,
                &model_config,
                &region.source_text,
                source_lang,
                target_lang,
                Some("漫画中的单个文本区域，只返回该区域译文"),
            )
            .await
            .map_err(error_from_json_response)?;
            region.translated_text = Some(translated_text);
        }
    }

    record_desktop_usage(app, state, DesktopUsageKind::Translation);
    Ok((regions, model))
}

fn apply_region_translations(
    regions: &mut [ocr::ComicTextRegion],
    raw: &str,
) -> Result<(), String> {
    let value = clean_llm_output(raw);
    let envelope = serde_json::from_str::<RegionTranslationEnvelope>(&value)
        .map_err(|err| format!("区域翻译响应不是合法 JSON: {err}"))?;
    if envelope.translations.len() != regions.len() {
        return Err(format!(
            "区域翻译数量不一致: 期望 {}, 实际 {}",
            regions.len(),
            envelope.translations.len()
        ));
    }

    let mut translated_values = Vec::with_capacity(regions.len());
    for region in regions.iter() {
        let matches = envelope
            .translations
            .iter()
            .filter(|item| item.id == region.id)
            .collect::<Vec<_>>();
        if matches.len() != 1 {
            return Err(format!("区域 {} 缺失或重复", region.id));
        }
        let translated_text = matches[0].text.trim();
        if translated_text.is_empty() {
            return Err(format!("区域 {} 的译文为空", region.id));
        }
        translated_values.push(translated_text.to_string());
    }
    for (region, translated_text) in regions.iter_mut().zip(translated_values) {
        region.translated_text = Some(translated_text);
    }
    Ok(())
}

fn joined_region_translations(regions: &[ocr::ComicTextRegion]) -> String {
    regions
        .iter()
        .filter_map(|region| region.translated_text.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

async fn translate_desktop_text(
    app: &tauri::AppHandle,
    state: &DesktopState,
    text: &str,
    source_lang: &str,
    target_lang: &str,
    context: Option<&str>,
) -> Result<(String, String), String> {
    let provider_config = translation::load_config(app);
    if provider_config.provider != translation::TranslateProvider::OpenaiCompatible {
        let translated_text = translation::translate_fast_provider(
            &state.client,
            &provider_config,
            text,
            source_lang,
            target_lang,
        )
        .await
        .map_err(|err| translation::explain_translate_error(&err))?;
        record_desktop_usage(app, state, DesktopUsageKind::Translation);
        return Ok((
            translated_text,
            provider_config.provider.display_name().to_string(),
        ));
    }

    let token = get_cached_token(state);
    let model_config = load_model_config(state, token.as_deref())
        .await
        .map_err(error_from_json_response)?;
    let model = model_config.model.clone();
    let translated_text = call_translation_model(
        state,
        &model_config,
        text,
        source_lang,
        target_lang,
        context,
    )
    .await
    .map_err(error_from_json_response)?;
    record_desktop_usage(app, state, DesktopUsageKind::Translation);
    Ok((translated_text, model))
}

async fn test_openai_compatible_provider(state: &DesktopState) -> Result<String, String> {
    let token = get_cached_token(state);
    let model_config = load_model_config(state, token.as_deref())
        .await
        .map_err(error_from_json_response)?;
    call_translation_model(
        state,
        &model_config,
        "hello",
        "English",
        "简体中文",
        Some("翻译服务连接测试"),
    )
    .await
    .map_err(error_from_json_response)
}

fn error_from_json_response((_status, value): (StatusCode, Value)) -> String {
    value
        .get("error")
        .or_else(|| value.get("detail"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| value.to_string())
}

fn status_payload(state: &DesktopState) -> DesktopStatus {
    let usage = current_usage_stats(state);
    DesktopStatus {
        ok: true,
        app: "TabKeep",
        version: env!("CARGO_PKG_VERSION"),
        backend_url: BACKEND_URL,
        desktop_url: format!("http://127.0.0.1:{DESKTOP_PORT}"),
        token_cached: get_cached_token(state).is_some(),
        usage_date: usage.date,
        today_translation_count: usage.translations,
        today_ocr_count: usage.ocr,
    }
}

impl DailyUsageStats {
    fn today() -> Self {
        Self {
            date: today_usage_date(),
            translations: 0,
            ocr: 0,
        }
    }

    fn normalize_for_today(&mut self) {
        let today = today_usage_date();
        if self.date != today {
            self.date = today;
            self.translations = 0;
            self.ocr = 0;
        }
    }
}

fn today_usage_date() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

fn current_usage_stats(state: &DesktopState) -> DailyUsageStats {
    let Ok(mut guard) = state.usage_stats.lock() else {
        return DailyUsageStats::today();
    };
    guard.normalize_for_today();
    guard.clone()
}

fn set_usage_stats(state: &DesktopState, stats: DailyUsageStats) {
    if let Ok(mut guard) = state.usage_stats.lock() {
        *guard = stats;
        guard.normalize_for_today();
    }
}

fn record_desktop_usage(app: &tauri::AppHandle, state: &DesktopState, kind: DesktopUsageKind) {
    let snapshot = {
        let Ok(mut guard) = state.usage_stats.lock() else {
            log::warn!("桌面用量统计锁已损坏");
            return;
        };
        guard.normalize_for_today();
        match kind {
            DesktopUsageKind::Translation => {
                guard.translations = guard.translations.saturating_add(1)
            }
            DesktopUsageKind::Ocr => guard.ocr = guard.ocr.saturating_add(1),
        }
        guard.clone()
    };
    if let Err(err) = write_usage_stats(app, &snapshot) {
        log::warn!("保存桌面用量统计失败: {err}");
    }
}

fn load_usage_stats(app: &tauri::AppHandle) -> Result<DailyUsageStats, String> {
    let path = usage_stats_path(app)?;
    if !path.exists() {
        return Ok(DailyUsageStats::today());
    }
    let raw = fs::read_to_string(&path).map_err(|err| format!("读取用量统计失败: {err}"))?;
    if raw.trim().is_empty() {
        return Ok(DailyUsageStats::today());
    }
    let mut stats: DailyUsageStats =
        serde_json::from_str(&raw).map_err(|err| format!("解析用量统计失败: {err}"))?;
    stats.normalize_for_today();
    Ok(stats)
}

fn write_usage_stats(app: &tauri::AppHandle, stats: &DailyUsageStats) -> Result<(), String> {
    let path = usage_stats_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("创建用量统计目录失败: {err}"))?;
    }
    let raw =
        serde_json::to_string_pretty(stats).map_err(|err| format!("序列化用量统计失败: {err}"))?;
    fs::write(path, raw).map_err(|err| format!("写入用量统计失败: {err}"))
}

fn usage_stats_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|err| format!("获取应用数据目录失败: {err}"))?
        .join(DESKTOP_USAGE_FILE))
}

fn remember_token_from_headers(state: &DesktopState, headers: &HeaderMap) {
    let Some(value) = headers
        .get("x-tabkeep-token")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return;
    };
    set_cached_token(state, Some(value.to_string()));
}

fn get_cached_token(state: &DesktopState) -> Option<String> {
    state
        .api_token
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(ToOwned::to_owned))
}

fn set_cached_token(state: &DesktopState, token: Option<String>) {
    if let Ok(mut guard) = state.api_token.lock() {
        *guard = token;
    }
}

fn normalize_lang(value: Option<String>, fallback: &str) -> String {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

fn normalize_ocr_lang(value: Option<&str>) -> String {
    let value = value.map(str::trim).filter(|value| !value.is_empty());
    match value.unwrap_or("auto") {
        "auto" | "自动识别" => "auto".to_string(),
        "简体中文" | "中文" | "Chinese" | "zh" | "zh-CN" | "zh-Hans" => "zh-CN".to_string(),
        "繁體中文" | "繁体中文" | "zh-TW" | "zh-Hant" => "zh-TW".to_string(),
        "English" | "英文" | "en" | "en-US" => "en-US".to_string(),
        "日本語" | "日语" | "ja" | "ja-JP" => "ja-JP".to_string(),
        "한국어" | "韩语" | "ko" | "ko-KR" => "ko-KR".to_string(),
        other => other.to_string(),
    }
}

fn clean_llm_output(raw: &str) -> String {
    let mut value = raw.to_string();
    while let Some(start) = value.find("<think>") {
        let search_start = start + "<think>".len();
        let Some(relative_end) = value[search_start..].find("</think>") else {
            break;
        };
        let end = search_start + relative_end + "</think>".len();
        value.replace_range(start..end, "");
    }

    let trimmed = value.trim();
    if !trimmed.starts_with("```") {
        return trimmed.to_string();
    }

    let mut lines = trimmed.lines();
    let _ = lines.next();
    let mut body = lines.collect::<Vec<_>>().join("\n");
    if body.trim_end().ends_with("```") {
        body = body.trim_end_matches('`').trim_end().to_string();
    }
    body.trim().to_string()
}

#[cfg(test)]
mod region_translation_tests {
    use super::*;

    fn region(id: &str) -> ocr::ComicTextRegion {
        ocr::ComicTextRegion {
            id: id.to_string(),
            text_bounds: ocr::OcrBounds {
                x: 0.0,
                y: 0.0,
                width: 120.0,
                height: 48.0,
            },
            bubble_bounds: None,
            source_text: format!("source {id}"),
            translated_text: None,
            direction: ocr::ComicTextDirection::Horizontal,
            reading_order: 0,
            confidence: Some(0.95),
            line_boxes: Vec::new(),
        }
    }

    #[test]
    fn applies_structured_translations_by_id_instead_of_response_order() {
        let mut regions = vec![region("region_01"), region("region_02")];
        let response = r#"```json
{"translations":[{"id":"region_02","text":"第二段"},{"id":"region_01","text":"第一段"}]}
```"#;

        apply_region_translations(&mut regions, response).unwrap();

        assert_eq!(regions[0].translated_text.as_deref(), Some("第一段"));
        assert_eq!(regions[1].translated_text.as_deref(), Some("第二段"));
    }

    #[test]
    fn rejects_incomplete_structured_translation_without_partial_updates() {
        let mut regions = vec![region("region_01"), region("region_02")];
        let response = r#"{"translations":[{"id":"region_01","text":"第一段"},{"id":"unknown","text":"错误"}]}"#;

        let error = apply_region_translations(&mut regions, response).unwrap_err();

        assert!(error.contains("region_02"));
        assert!(regions
            .iter()
            .all(|region| region.translated_text.is_none()));
    }

    #[test]
    fn applies_manga_ocr_text_by_stable_region_id() {
        let mut regions = vec![region("region_01"), region("region_02")];
        let recognized = vec![
            MangaOcrRegionResponse {
                id: "region_02".to_string(),
                text: " 二つ目 ".to_string(),
            },
            MangaOcrRegionResponse {
                id: "region_01".to_string(),
                text: "一つ目".to_string(),
            },
        ];

        let updated = apply_manga_ocr_results(&mut regions, &recognized);

        assert_eq!(updated, 2);
        assert_eq!(regions[0].source_text, "一つ目");
        assert_eq!(regions[1].source_text, "二つ目");
    }

    #[test]
    fn maps_multiple_ocr_lines_into_one_detected_comic_region() {
        let mut detected = vec![region("region_01")];
        detected[0].source_text.clear();
        detected[0].text_bounds = ocr::OcrBounds {
            x: 10.0,
            y: 10.0,
            width: 180.0,
            height: 100.0,
        };
        let mut paddle = region("paddle");
        paddle.line_boxes = vec![
            ocr::OcrTextBox {
                text: "I wonder if".to_string(),
                score: Some(0.9),
                x: 30.0,
                y: 30.0,
                width: 100.0,
                height: 20.0,
            },
            ocr::OcrTextBox {
                text: "there are rumors".to_string(),
                score: Some(0.8),
                x: 25.0,
                y: 58.0,
                width: 130.0,
                height: 20.0,
            },
        ];

        populate_detected_regions_from_ocr(&mut detected, &[paddle], "en-US");

        assert_eq!(detected[0].source_text, "I wonder if there are rumors");
        assert_eq!(detected[0].confidence, Some(0.85));
    }
}

fn json_response(status: StatusCode, value: Value) -> Response {
    (status, Json(value)).into_response()
}
