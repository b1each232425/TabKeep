use std::{
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
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::{
    sync::oneshot,
    time::{sleep, Duration},
};
use tower_http::cors::{Any, CorsLayer};

mod ocr;
mod region;
mod selection;
mod translation;

const BACKEND_URL: &str = "http://127.0.0.1:38471";
const DESKTOP_PORT: u16 = 38472;
const MAX_TRANSLATE_CHARS: usize = 12_000;

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
}

#[derive(Clone)]
struct HttpState {
    desktop: DesktopState,
    app: tauri::AppHandle,
}

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
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
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
        .setup(move |app| {
            setup_tray(app)?;
            setup_close_to_hide(app);
            setup_selection_hotkey(app, state.clone());

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
            finish_screen_selection,
            cancel_screen_selection,
            get_latest_ocr_result,
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

fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;

    let show = MenuItem::with_id(app, "show", "打开 TabKeep", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut builder = TrayIconBuilder::new()
        .tooltip("TabKeep Desktop")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
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
    Ok(())
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

    let app = Router::new()
        .route("/health", get(health))
        .route("/capture", post(capture))
        .route("/translate", post(translate))
        .route("/input_translate", post(translate))
        .route("/selection_translate", post(translate))
        .route("/ocr_recognize", post(ocr_recognize))
        .route("/ocr_translate", post(ocr_translate))
        .route("/region/open", post(region_open))
        .route("/region/close", post(region_close))
        .route("/region/config", get(region_config))
        .with_state(state)
        .layer(cors);

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
    let Some(token) = get_cached_token(&state.desktop) else {
        return json_response(
            StatusCode::UNAUTHORIZED,
            json!({
                "ok": false,
                "error": "TabKeep desktop has no API token yet"
            }),
        );
    };

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

    let result = state
        .desktop
        .client
        .post(format!("{BACKEND_URL}/notes/save"))
        .header("X-TabKeep-Token", token)
        .json(&body)
        .send()
        .await;

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

    let Some(token) = get_cached_token(&state.desktop) else {
        return json_response(
            StatusCode::UNAUTHORIZED,
            json!({
                "ok": false,
                "error": "TabKeep desktop has no API token yet"
            }),
        );
    };

    let model_config = match load_model_config(&state.desktop, &token).await {
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
    token: &str,
) -> Result<ModelConfigPayload, (StatusCode, Value)> {
    let result = state
        .client
        .get(format!("{BACKEND_URL}/config"))
        .header("X-TabKeep-Token", token)
        .send()
        .await
        .map_err(|err| {
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
    let endpoint = format!("{}/chat/completions", config.base_url.trim_end_matches('/'));
    let context_line = context
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("\n上下文:{value}"))
        .unwrap_or_default();

    let body = json!({
        "model": config.model,
        "temperature": 0,
        "messages": [
            {
                "role": "system",
                "content": "你是 TabKeep 的桌面翻译助手。请忠实翻译用户给出的文本,保留原有换行、列表和代码片段。只输出译文,不要解释。"
            },
            {
                "role": "user",
                "content": format!(
                    "源语言:{source_lang}\n目标语言:{target_lang}{context_line}\n\n待翻译文本:\n{text}"
                )
            }
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

    let app_for_ocr = app.clone();
    let config_for_ocr = config.clone();
    let provider_for_ocr = provider.clone();
    let path_for_ocr = cut_path.clone();
    let lang_for_ocr = source_lang.clone();
    let text_result = tauri::async_runtime::spawn_blocking(move || {
        ocr::recognize(
            &app_for_ocr,
            &config_for_ocr,
            provider_for_ocr,
            &path_for_ocr,
            &lang_for_ocr,
        )
    })
    .await
    .map_err(|err| format!("OCR 任务失败: {err}"))?;

    let text = match text_result {
        Ok(value) if !value.trim().is_empty() => value,
        Ok(_) => {
            let result = ocr::error_result("未识别到文字".to_string(), provider, Some(&cut_path));
            let _ = show_ocr_result_window(&app, &desktop, &result);
            let _ = pending.responder.send(result);
            return Ok(());
        }
        Err(err) => {
            let result = ocr::error_result(err, provider, Some(&cut_path));
            let _ = show_ocr_result_window(&app, &desktop, &result);
            let _ = pending.responder.send(result);
            return Ok(());
        }
    };

    let result = match pending.mode {
        OcrFlowMode::Recognize => ocr::success_result(text, provider, &cut_path, None, None),
        OcrFlowMode::Translate => {
            let mut progress =
                ocr::success_result(text.clone(), provider.clone(), &cut_path, None, None);
            progress.phase = Some("translate".to_string());
            progress.message = Some("OCR 完成,正在翻译...".to_string());
            let _ = show_ocr_result_window(&app, &desktop, &progress);

            match translate_ocr_text(&app, &desktop, &text, &source_lang, &target_lang).await {
                Ok((translated_text, model)) => ocr::success_result(
                    text,
                    provider,
                    &cut_path,
                    Some(translated_text),
                    Some(model),
                ),
                Err(err) => {
                    let mut result = ocr::success_result(text, provider, &cut_path, None, None);
                    result.ok = false;
                    result.error = Some(err);
                    result.phase = Some("error".to_string());
                    result.message = Some("翻译失败".to_string());
                    result
                }
            }
        }
    };

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
        let token =
            get_cached_token(&state).ok_or_else(|| "桌面端还没有 TabKeep API token".to_string())?;
        req = req.header("X-TabKeep-Token", token);
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

    let app_for_ocr = app.clone();
    let config_for_ocr = ocr_config.clone();
    let provider_for_ocr = provider.clone();
    let path_for_ocr = image_path.clone();
    let lang_for_ocr = source_lang.clone();
    let text_result = tauri::async_runtime::spawn_blocking(move || {
        ocr::recognize(
            &app_for_ocr,
            &config_for_ocr,
            provider_for_ocr,
            &path_for_ocr,
            &lang_for_ocr,
        )
    })
    .await
    .map_err(|err| format!("区域 OCR 任务失败: {err}"))?;

    let text = match text_result {
        Ok(value) if !value.trim().is_empty() => value,
        Ok(_) => {
            let result = ocr::error_result_without_image(
                "未识别到文字".to_string(),
                provider,
                Some(&image_path),
            );
            publish_region_result(&app, &state, &result);
            return Ok(result);
        }
        Err(err) => {
            let result = ocr::error_result_without_image(err, provider, Some(&image_path));
            publish_region_result(&app, &state, &result);
            return Ok(result);
        }
    };

    let result = match mode {
        OcrFlowMode::Recognize => {
            ocr::success_result_without_image(text, provider, &image_path, None, None)
        }
        OcrFlowMode::Translate => {
            let mut progress = ocr::success_result_without_image(
                text.clone(),
                provider.clone(),
                &image_path,
                None,
                None,
            );
            progress.phase = Some("translate".to_string());
            progress.message = Some("OCR 完成,正在翻译...".to_string());
            publish_region_result(&app, &state, &progress);

            match translate_ocr_text(&app, &state, &text, &source_lang, &target_lang).await {
                Ok((translated_text, model)) => ocr::success_result_without_image(
                    text,
                    provider,
                    &image_path,
                    Some(translated_text),
                    Some(model),
                ),
                Err(err) => {
                    let mut result =
                        ocr::success_result_without_image(text, provider, &image_path, None, None);
                    result.ok = false;
                    result.error = Some(err);
                    result.phase = Some("error".to_string());
                    result.message = Some("翻译失败".to_string());
                    result
                }
            }
        }
    };

    publish_region_result(&app, &state, &result);
    Ok(result)
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
        return Ok((
            translated_text,
            provider_config.provider.display_name().to_string(),
        ));
    }

    let token = get_cached_token(state).ok_or_else(|| {
        "桌面端还没有 TabKeep API token,请先打开扩展 popup 或在桌面端保存 Token".to_string()
    })?;
    let model_config = load_model_config(state, &token)
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
    Ok((translated_text, model))
}

async fn test_openai_compatible_provider(state: &DesktopState) -> Result<String, String> {
    let token = get_cached_token(state).ok_or_else(|| {
        "桌面端还没有 TabKeep API token,请先打开扩展 popup 或在桌面端保存 Token".to_string()
    })?;
    let model_config = load_model_config(state, &token)
        .await
        .map_err(error_from_json_response)?;
    call_translation_model(
        state,
        &model_config,
        "hello",
        "English",
        "简体中文",
        Some("Provider 连接测试"),
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
    DesktopStatus {
        ok: true,
        app: "TabKeep Desktop Companion",
        version: env!("CARGO_PKG_VERSION"),
        backend_url: BACKEND_URL,
        desktop_url: format!("http://127.0.0.1:{DESKTOP_PORT}"),
        token_cached: get_cached_token(state).is_some(),
    }
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

fn json_response(status: StatusCode, value: Value) -> Response {
    (status, Json(value)).into_response()
}
