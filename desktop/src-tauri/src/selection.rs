use std::{
    fs,
    path::PathBuf,
    sync::{mpsc, Arc, Mutex},
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{
    window::Color, AppHandle, Manager, PhysicalPosition, Position, WebviewUrl, WebviewWindowBuilder,
};

const CONFIG_FILE: &str = "selection-translate-config.json";
const DEFAULT_HOTKEY: &str = "Ctrl+Alt+T";
const HOTKEY_ID: i32 = 0x544b;
const PANEL_WIDTH: f64 = 520.0;
const PANEL_HEIGHT: f64 = 220.0;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SelectionTranslateConfig {
    pub enabled: bool,
    pub hotkey: String,
    #[serde(rename = "sourceLang")]
    pub source_lang: String,
    #[serde(rename = "targetLang")]
    pub target_lang: String,
    #[serde(
        rename = "hotkeyError",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub hotkey_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SelectionTranslateResult {
    pub ok: bool,
    pub text: String,
    #[serde(rename = "translatedText")]
    pub translated_text: Option<String>,
    #[serde(rename = "sourceLang")]
    pub source_lang: String,
    #[serde(rename = "targetLang")]
    pub target_lang: String,
    pub model: Option<String>,
    pub error: Option<String>,
    pub phase: Option<String>,
    pub message: Option<String>,
    pub x: i32,
    pub y: i32,
}

#[derive(Clone)]
pub struct HotkeyController {
    sender: mpsc::Sender<HotkeyCommand>,
}

enum HotkeyCommand {
    Configure(
        SelectionTranslateConfig,
        mpsc::Sender<Result<Option<String>, String>>,
    ),
}

impl Default for SelectionTranslateConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            hotkey: DEFAULT_HOTKEY.to_string(),
            source_lang: "auto".to_string(),
            target_lang: "简体中文".to_string(),
            hotkey_error: None,
        }
    }
}

impl SelectionTranslateConfig {
    pub fn with_hotkey_error(mut self, error: Option<String>) -> Self {
        self.hotkey_error = error;
        self
    }
}

impl HotkeyController {
    pub fn configure(&self, config: SelectionTranslateConfig) -> Result<Option<String>, String> {
        let (sender, receiver) = mpsc::channel();
        self.sender
            .send(HotkeyCommand::Configure(config, sender))
            .map_err(|_| "全局快捷键线程已停止".to_string())?;
        receiver
            .recv_timeout(Duration::from_secs(2))
            .map_err(|_| "全局快捷键配置超时".to_string())?
    }
}

pub fn load_config(app: &AppHandle) -> SelectionTranslateConfig {
    let Ok(path) = config_path(app) else {
        return SelectionTranslateConfig::default();
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return SelectionTranslateConfig::default();
    };
    sanitize_config(serde_json::from_str(&raw).unwrap_or_default())
}

pub fn save_config(
    app: &AppHandle,
    config: &SelectionTranslateConfig,
) -> Result<SelectionTranslateConfig, String> {
    let config = sanitize_config(config.clone());
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("创建划词翻译配置目录失败: {err}"))?;
    }
    let mut persisted = config.clone();
    persisted.hotkey_error = None;
    let raw = serde_json::to_string_pretty(&persisted)
        .map_err(|err| format!("序列化划词翻译配置失败: {err}"))?;
    fs::write(path, raw).map_err(|err| format!("写入划词翻译配置失败: {err}"))?;
    Ok(config)
}

pub fn start_hotkey_thread(
    initial_config: SelectionTranslateConfig,
    status: Arc<Mutex<Option<String>>>,
    on_trigger: Arc<dyn Fn() + Send + Sync + 'static>,
) -> HotkeyController {
    let (sender, receiver) = mpsc::channel::<HotkeyCommand>();
    thread::spawn(move || hotkey_thread(receiver, initial_config, status, on_trigger));
    HotkeyController { sender }
}

pub fn success_result(
    text: String,
    translated_text: String,
    model: String,
    source_lang: String,
    target_lang: String,
    x: i32,
    y: i32,
) -> SelectionTranslateResult {
    SelectionTranslateResult {
        ok: true,
        text,
        translated_text: Some(translated_text),
        source_lang,
        target_lang,
        model: Some(model),
        error: None,
        phase: Some("done".to_string()),
        message: Some("翻译完成".to_string()),
        x,
        y,
    }
}

pub fn progress_result(
    text: String,
    source_lang: String,
    target_lang: String,
    phase: &str,
    message: &str,
    x: i32,
    y: i32,
) -> SelectionTranslateResult {
    SelectionTranslateResult {
        ok: true,
        text,
        translated_text: None,
        source_lang,
        target_lang,
        model: None,
        error: None,
        phase: Some(phase.to_string()),
        message: Some(message.to_string()),
        x,
        y,
    }
}

pub fn error_result(
    text: String,
    source_lang: String,
    target_lang: String,
    error: String,
    x: i32,
    y: i32,
) -> SelectionTranslateResult {
    SelectionTranslateResult {
        ok: false,
        text,
        translated_text: None,
        source_lang,
        target_lang,
        model: None,
        error: Some(error),
        phase: Some("error".to_string()),
        message: Some("划词翻译失败".to_string()),
        x,
        y,
    }
}

pub fn open_panel_window(app: &AppHandle, x: i32, y: i32) -> Result<tauri::WebviewWindow, String> {
    let window = if let Some(window) = app.get_webview_window("selection-panel") {
        window
    } else {
        WebviewWindowBuilder::new(
            app,
            "selection-panel",
            WebviewUrl::App("index.html?view=selection-panel".into()),
        )
        .title("TabKeep Selection Translator")
        .inner_size(PANEL_WIDTH, PANEL_HEIGHT)
        .position(panel_x(x) as f64, panel_y(y) as f64)
        .decorations(false)
        .transparent(true)
        .background_color(Color(0, 0, 0, 0))
        .always_on_top(true)
        .resizable(false)
        .visible(false)
        .build()
        .map_err(|err| format!("打开划词翻译窗口失败: {err}"))?
    };
    window
        .set_position(Position::Physical(PhysicalPosition::new(
            panel_x(x),
            panel_y(y),
        )))
        .map_err(|err| format!("移动划词翻译窗口失败: {err}"))?;
    let _ = window.set_always_on_top(true);
    Ok(window)
}

pub fn cursor_position() -> (i32, i32) {
    cursor_position_impl()
}

#[cfg(windows)]
pub fn read_selected_text_via_copy() -> Result<String, String> {
    thread::spawn(read_selected_text_via_copy_impl)
        .join()
        .map_err(|_| "划词翻译剪贴板线程异常退出".to_string())?
}

#[cfg(not(windows))]
pub fn read_selected_text_via_copy() -> Result<String, String> {
    read_selected_text_via_copy_impl()
}

fn sanitize_config(mut config: SelectionTranslateConfig) -> SelectionTranslateConfig {
    config.hotkey = DEFAULT_HOTKEY.to_string();
    if config.source_lang.trim().is_empty() {
        config.source_lang = "auto".to_string();
    } else {
        config.source_lang = config.source_lang.trim().to_string();
    }
    if config.target_lang.trim().is_empty() {
        config.target_lang = "简体中文".to_string();
    } else {
        config.target_lang = config.target_lang.trim().to_string();
    }
    config.hotkey_error = None;
    config
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|err| format!("获取应用数据目录失败: {err}"))?
        .join(CONFIG_FILE))
}

fn panel_x(cursor_x: i32) -> i32 {
    cursor_x.saturating_add(16)
}

fn panel_y(cursor_y: i32) -> i32 {
    cursor_y.saturating_add(18)
}

#[cfg(windows)]
fn hotkey_thread(
    receiver: mpsc::Receiver<HotkeyCommand>,
    initial_config: SelectionTranslateConfig,
    status: Arc<Mutex<Option<String>>>,
    on_trigger: Arc<dyn Fn() + Send + Sync + 'static>,
) {
    use windows::Win32::UI::{
        Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey, MOD_ALT, MOD_CONTROL, VK_T},
        WindowsAndMessaging::{PeekMessageW, MSG, PM_REMOVE, WM_HOTKEY},
    };

    let mut registered = false;
    let mut warmup = MSG::default();
    let _ = unsafe { PeekMessageW(&mut warmup, None, 0, 0, PM_REMOVE) };
    let mut apply_config = |config: SelectionTranslateConfig| -> Result<Option<String>, String> {
        if registered {
            let _ = unsafe { UnregisterHotKey(None, HOTKEY_ID) };
            registered = false;
        }
        if !config.enabled {
            set_status(&status, None);
            return Ok(None);
        }
        let result =
            unsafe { RegisterHotKey(None, HOTKEY_ID, MOD_CONTROL | MOD_ALT, VK_T.0 as u32) };
        match result {
            Ok(()) => {
                registered = true;
                set_status(&status, None);
                Ok(None)
            }
            Err(err) => {
                let message = format!("注册全局快捷键 {} 失败: {err}", config.hotkey);
                set_status(&status, Some(message.clone()));
                Ok(Some(message))
            }
        }
    };

    let _ = apply_config(initial_config);

    loop {
        while let Ok(command) = receiver.try_recv() {
            match command {
                HotkeyCommand::Configure(config, responder) => {
                    let _ = responder.send(apply_config(config));
                }
            }
        }

        let mut message = MSG::default();
        while unsafe { PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() } {
            if message.message == WM_HOTKEY && message.wParam.0 as i32 == HOTKEY_ID {
                on_trigger();
            }
        }
        thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(not(windows))]
fn hotkey_thread(
    receiver: mpsc::Receiver<HotkeyCommand>,
    _initial_config: SelectionTranslateConfig,
    status: Arc<Mutex<Option<String>>>,
    _on_trigger: Arc<dyn Fn() + Send + Sync + 'static>,
) {
    set_status(
        &status,
        Some("划词翻译全局快捷键首版仅支持 Windows".to_string()),
    );
    for command in receiver {
        match command {
            HotkeyCommand::Configure(_, responder) => {
                let _ =
                    responder.send(Ok(Some("划词翻译全局快捷键首版仅支持 Windows".to_string())));
            }
        }
    }
}

fn set_status(status: &Arc<Mutex<Option<String>>>, value: Option<String>) {
    if let Ok(mut guard) = status.lock() {
        *guard = value;
    }
}

#[cfg(windows)]
fn cursor_position_impl() -> (i32, i32) {
    use windows::Win32::{Foundation::POINT, UI::WindowsAndMessaging::GetCursorPos};

    let mut point = POINT::default();
    if unsafe { GetCursorPos(&mut point) }.is_ok() {
        (point.x, point.y)
    } else {
        (160, 160)
    }
}

#[cfg(not(windows))]
fn cursor_position_impl() -> (i32, i32) {
    (160, 160)
}

#[cfg(windows)]
fn read_selected_text_via_copy_impl() -> Result<String, String> {
    use windows::Win32::System::DataExchange::GetClipboardSequenceNumber;

    log::info!("Selection translate clipboard backup started");
    let backup = OleClipboardBackup::capture();
    log::info!("Selection translate clipboard backup captured");
    let before_sequence = unsafe { GetClipboardSequenceNumber() };
    wait_for_hotkey_keys_released();
    log::info!("Selection translate hotkey keys released");
    let copy_result = simulate_copy_shortcut(CopyShortcut::CtrlC)
        .and_then(|_| read_copied_text_after_sequence(before_sequence))
        .or_else(|err| {
            log::warn!("Selection translate Ctrl+C did not produce text: {err}; retry Ctrl+Insert");
            let retry_sequence = unsafe { GetClipboardSequenceNumber() };
            simulate_copy_shortcut(CopyShortcut::CtrlInsert)
                .and_then(|_| read_copied_text_after_sequence(retry_sequence))
        });
    let result = match copy_result {
        Ok(text) => Ok(text),
        Err(err) => Err(err),
    };
    log::info!("Selection translate clipboard restore started");
    if let Err(err) = backup.restore() {
        log::warn!("恢复剪贴板失败: {err}");
    }
    log::info!("Selection translate clipboard restore finished");
    result
}

#[cfg(not(windows))]
fn read_selected_text_via_copy_impl() -> Result<String, String> {
    Err("划词翻译首版仅支持 Windows".to_string())
}

#[cfg(windows)]
fn read_copied_text_after_sequence(before_sequence: u32) -> Result<String, String> {
    use windows::Win32::System::DataExchange::GetClipboardSequenceNumber;

    let mut changed = false;
    let mut last_text_error = None;
    for _ in 0..32 {
        thread::sleep(Duration::from_millis(50));
        if unsafe { GetClipboardSequenceNumber() } != before_sequence {
            changed = true;
            match read_clipboard_text() {
                Ok(text) => {
                    let text = text.trim().to_string();
                    if !text.is_empty() {
                        return Ok(text);
                    }
                    last_text_error = Some("当前选中内容不是可翻译文本".to_string());
                }
                Err(err) => {
                    last_text_error = Some(err);
                }
            }
        }
    }
    if !changed {
        return Err("没有读取到新的选中文本,请确认当前应用中已经选中文字".to_string());
    }

    Err(last_text_error.unwrap_or_else(|| "当前选中内容不是可翻译文本".to_string()))
}

#[cfg(windows)]
fn wait_for_hotkey_keys_released() {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VIRTUAL_KEY, VK_CONTROL, VK_MENU, VK_T,
    };

    fn is_down(key: VIRTUAL_KEY) -> bool {
        (unsafe { GetAsyncKeyState(key.0 as i32) } as u16 & 0x8000) != 0
    }

    for _ in 0..40 {
        if !is_down(VK_CONTROL) && !is_down(VK_MENU) && !is_down(VK_T) {
            thread::sleep(Duration::from_millis(80));
            return;
        }
        thread::sleep(Duration::from_millis(25));
    }
    thread::sleep(Duration::from_millis(120));
}

#[cfg(windows)]
enum CopyShortcut {
    CtrlC,
    CtrlInsert,
}

#[cfg(windows)]
fn simulate_copy_shortcut(shortcut: CopyShortcut) -> Result<(), String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_C,
        VK_CONTROL, VK_INSERT,
    };

    fn key_input(key: VIRTUAL_KEY, key_up: bool) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: key,
                    wScan: 0,
                    dwFlags: if key_up {
                        KEYEVENTF_KEYUP
                    } else {
                        Default::default()
                    },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    let copy_key = match shortcut {
        CopyShortcut::CtrlC => VK_C,
        CopyShortcut::CtrlInsert => VK_INSERT,
    };
    let inputs = [
        key_input(VK_CONTROL, false),
        key_input(copy_key, false),
        key_input(copy_key, true),
        key_input(VK_CONTROL, true),
    ];
    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent == inputs.len() as u32 {
        Ok(())
    } else {
        Err("模拟复制快捷键失败".to_string())
    }
}

#[cfg(windows)]
struct OleClipboardBackup {
    data: Option<windows::Win32::System::Com::IDataObject>,
    _com: ComApartment,
}

#[cfg(windows)]
impl OleClipboardBackup {
    fn capture() -> Self {
        use windows::Win32::System::Ole::OleGetClipboard;

        let com = ComApartment::init();
        let data = unsafe { OleGetClipboard() }.ok();
        Self { data, _com: com }
    }

    fn restore(self) -> Result<(), String> {
        use windows::Win32::System::{DataExchange::EmptyClipboard, Ole::OleSetClipboard};

        if let Some(data) = self.data {
            unsafe { OleSetClipboard(&data) }
                .map_err(|err| format!("恢复剪贴板对象失败: {err}"))?;
        } else {
            let _guard = ClipboardGuard::open()?;
            unsafe { EmptyClipboard() }.map_err(|err| format!("清空剪贴板失败: {err}"))?;
        }
        Ok(())
    }
}

#[cfg(windows)]
struct ComApartment {
    initialized: bool,
}

#[cfg(windows)]
impl ComApartment {
    fn init() -> Self {
        use windows::Win32::System::Ole::OleInitialize;

        let initialized = unsafe { OleInitialize(None) }.is_ok();
        Self { initialized }
    }
}

#[cfg(windows)]
impl Drop for ComApartment {
    fn drop(&mut self) {
        if self.initialized {
            unsafe { windows::Win32::System::Ole::OleUninitialize() };
        }
    }
}

#[cfg(windows)]
struct ClipboardGuard;

#[cfg(windows)]
impl ClipboardGuard {
    fn open() -> Result<Self, String> {
        use windows::Win32::System::DataExchange::OpenClipboard;

        let mut last_error = None;
        for _ in 0..10 {
            match unsafe { OpenClipboard(None) } {
                Ok(()) => return Ok(Self),
                Err(err) => {
                    last_error = Some(err.to_string());
                    thread::sleep(Duration::from_millis(30));
                }
            }
        }
        Err(format!(
            "打开剪贴板失败: {}",
            last_error.unwrap_or_else(|| "未知错误".to_string())
        ))
    }
}

#[cfg(windows)]
impl Drop for ClipboardGuard {
    fn drop(&mut self) {
        let _ = unsafe { windows::Win32::System::DataExchange::CloseClipboard() };
    }
}

#[cfg(windows)]
fn read_clipboard_text() -> Result<String, String> {
    use std::slice;
    use windows::Win32::{
        Foundation::HGLOBAL,
        System::{
            DataExchange::{GetClipboardData, IsClipboardFormatAvailable},
            Memory::{GlobalLock, GlobalUnlock},
            Ole::CF_UNICODETEXT,
        },
    };

    if unsafe { IsClipboardFormatAvailable(CF_UNICODETEXT.0 as u32) }.is_err() {
        return Err("剪贴板中没有文本".to_string());
    }
    let _guard = ClipboardGuard::open()?;
    let handle = unsafe { GetClipboardData(CF_UNICODETEXT.0 as u32) }
        .map_err(|err| format!("读取剪贴板文本失败: {err}"))?;
    let hglobal = HGLOBAL(handle.0);
    let ptr = unsafe { GlobalLock(hglobal) } as *const u16;
    if ptr.is_null() {
        return Err("锁定剪贴板文本失败".to_string());
    }
    let mut len = 0usize;
    unsafe {
        while *ptr.add(len) != 0 {
            len += 1;
        }
    }
    let text = unsafe { String::from_utf16_lossy(slice::from_raw_parts(ptr, len)) };
    let _ = unsafe { GlobalUnlock(hglobal) };
    Ok(text)
}
