use std::sync::{Arc, Mutex};

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
use tauri::Manager;
use tower_http::cors::{Any, CorsLayer};

const BACKEND_URL: &str = "http://127.0.0.1:38471";
const DESKTOP_PORT: u16 = 38472;

#[derive(Clone)]
struct DesktopState {
    api_token: Arc<Mutex<Option<String>>>,
    client: reqwest::Client,
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = DesktopState {
        api_token: Arc::new(Mutex::new(None)),
        client: reqwest::Client::new(),
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

            let server_state = state.clone();
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

async fn run_http_server(state: DesktopState) -> anyhow::Result<()> {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/health", get(health))
        .route("/capture", post(capture))
        .route("/translate", post(not_implemented))
        .route("/input_translate", post(not_implemented))
        .route("/selection_translate", post(not_implemented))
        .route("/ocr_recognize", post(not_implemented))
        .route("/ocr_translate", post(not_implemented))
        .with_state(state)
        .layer(cors);

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", DESKTOP_PORT)).await?;
    log::info!("TabKeep desktop HTTP server listening on 127.0.0.1:{DESKTOP_PORT}");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health(
    AxumState(state): AxumState<DesktopState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    remember_token_from_headers(&state, &headers);
    Json(status_payload(&state))
}

async fn capture(
    AxumState(state): AxumState<DesktopState>,
    headers: HeaderMap,
    Json(payload): Json<CapturePayload>,
) -> Response {
    remember_token_from_headers(&state, &headers);
    let Some(token) = get_cached_token(&state) else {
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

async fn not_implemented() -> impl IntoResponse {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({
            "ok": false,
            "error": "This TabKeep desktop endpoint is reserved for a later phase"
        })),
    )
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
        let token = get_cached_token(&state)
            .ok_or_else(|| "桌面端还没有 TabKeep API token".to_string())?;
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

fn json_response(status: StatusCode, value: Value) -> Response {
    (status, Json(value)).into_response()
}
