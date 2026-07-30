use std::{
    collections::BTreeSet,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard, OnceLock},
};

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const STICKY_NOTES_FILE: &str = "sticky-notes.json";
const STICKY_NOTES_CONFLICT_PREFIX: &str = "STICKY_NOTE_CONFLICT:";
const STICKY_ASSETS_DIR: &str = "sticky-note-assets";
const DEFAULT_COLOR: &str = "#ffd6e8";
const MAX_TITLE_CHARS: usize = 120;
const MAX_CONTENT_CHARS: usize = 50_000;
const MAX_CATEGORY_CHARS: usize = 60;
const MAX_IMAGE_BYTES: usize = 12 * 1024 * 1024;
const HIDDEN_WINDOW_COORDINATE: i32 = -10_000;
const DEFAULT_VIEW_MODE: &str = "edit";
const DEFAULT_NEW_NOTE_HOTKEY: &str = "Ctrl+Alt+N";
const DEFAULT_TOGGLE_WINDOW_HOTKEY: &str = "Ctrl+Alt+M";
const REMINDER_STATUS_SCHEDULED: &str = "scheduled";
const REMINDER_STATUS_NOTIFIED: &str = "notified";
const REMINDER_STATUS_COMPLETED: &str = "completed";
const MAX_SNOOZE_MINUTES: i64 = 7 * 24 * 60;
const DAILY_POETRY_NOTE_ID: &str = "tabkeep-daily-poetry";
const DAILY_POETRY_SYSTEM_KIND: &str = "dailyPoetry";
const DAILY_POETRY_TITLE: &str = "今日诗笺";
const DAILY_POETRY_PLACEHOLDER: &str = "正在为你寻一句诗。";
const DAILY_POETRY_TOKEN_URL: &str = "https://v2.jinrishici.com/token";
const DAILY_POETRY_SENTENCE_URL: &str = "https://v2.jinrishici.com/sentence";
const DAILY_POETRY_REFRESH_HOURS: i64 = 6;

static STORE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StickyNote {
    pub id: String,
    #[serde(default)]
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_kind: Option<String>,
    pub title: String,
    pub content: String,
    pub color: String,
    pub pinned: bool,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub preview: String,
    #[serde(default)]
    pub word_count: usize,
    #[serde(default = "default_view_mode")]
    pub view_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reminder: Option<StickyReminder>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_bounds: Option<StickyWindowBounds>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StickyReminder {
    pub due_at: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_notified_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StickyWindowBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StickyShortcutConfig {
    pub new_note_hotkey: String,
    pub toggle_window_hotkey: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StickyNoteAsset {
    pub file_name: String,
    pub markdown_url: String,
}

impl Default for StickyShortcutConfig {
    fn default() -> Self {
        Self {
            new_note_hotkey: DEFAULT_NEW_NOTE_HOTKEY.to_string(),
            toggle_window_hotkey: DEFAULT_TOGGLE_WINDOW_HOTKEY.to_string(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StickyNoteDraft {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub revision: Option<u64>,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub pinned: Option<bool>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub view_mode: Option<String>,
    #[serde(default)]
    pub window_bounds: Option<StickyWindowBounds>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PoetryTokenResponse {
    status: String,
    data: Option<String>,
    err_message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PoetrySentenceResponse {
    status: String,
    data: Option<PoetrySentenceData>,
    err_message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PoetrySentenceData {
    content: String,
    origin: PoetryOrigin,
}

#[derive(Debug, Deserialize)]
struct PoetryOrigin {
    title: String,
    dynasty: String,
    author: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StickyNoteStore {
    #[serde(default)]
    notes: Vec<StickyNote>,
    #[serde(default)]
    categories: Vec<String>,
    #[serde(default)]
    shortcuts: StickyShortcutConfig,
    #[serde(default)]
    poetry_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    poetry_cached_at: Option<String>,
}

pub fn list_notes(app: &AppHandle) -> Result<Vec<StickyNote>, String> {
    let _guard = store_guard()?;
    let mut store = read_store(app)?;
    if ensure_daily_poetry_note_in_store(&mut store) {
        write_store(app, &store)?;
    }
    let mut notes = store.notes;
    sort_notes(&mut notes);
    Ok(notes)
}

pub fn get_note(app: &AppHandle, id: &str) -> Result<StickyNote, String> {
    let _guard = store_guard()?;
    let id = sanitize_id(id)?;
    let mut store = read_store(app)?;
    if ensure_daily_poetry_note_in_store(&mut store) {
        write_store(app, &store)?;
    }
    store
        .notes
        .into_iter()
        .find(|note| note.id == id)
        .ok_or_else(|| "便签不存在".to_string())
}

pub fn save_note(app: &AppHandle, draft: StickyNoteDraft) -> Result<StickyNote, String> {
    let _guard = store_guard()?;
    let mut store = read_store(app)?;
    let now = Utc::now().to_rfc3339();
    let title = clamp_chars(draft.title.trim(), MAX_TITLE_CHARS);
    let content = clamp_chars(&draft.content, MAX_CONTENT_CHARS);
    let color = normalize_color(draft.color.as_deref());

    let saved = if let Some(id) = draft.id.as_deref().filter(|value| !value.trim().is_empty()) {
        let id = sanitize_id(id)?;
        let Some(index) = store.notes.iter().position(|note| note.id == id) else {
            return Err("便签不存在".to_string());
        };
        if is_system_note(&store.notes[index]) {
            return Err("系统诗笺由 TabKeep 自动维护，不能手动编辑".to_string());
        }
        let next_revision = checked_next_revision(store.notes[index].revision, draft.revision)?;
        let current_category = store.notes[index].category.clone();
        let current_view_mode = store.notes[index].view_mode.clone();
        let category = normalize_category(
            draft
                .category
                .as_deref()
                .unwrap_or(current_category.as_str()),
        )?;
        let view_mode = normalize_view_mode(
            draft
                .view_mode
                .as_deref()
                .unwrap_or(current_view_mode.as_str()),
        );
        ensure_category(&mut store, &category);
        let note = &mut store.notes[index];
        note.revision = next_revision;
        note.title = title;
        note.content = content;
        note.color = color;
        note.pinned = draft.pinned.unwrap_or(note.pinned);
        note.category = category;
        note.preview = preview(&note.content);
        note.word_count = count_note_chars(&note.content);
        note.view_mode = view_mode;
        if draft.window_bounds.is_some() {
            note.window_bounds = normalize_bounds(draft.window_bounds);
        }
        note.updated_at = now;
        note.clone()
    } else {
        let category = normalize_category(draft.category.as_deref().unwrap_or(""))?;
        ensure_category(&mut store, &category);
        let note = StickyNote {
            id: Uuid::new_v4().to_string(),
            revision: 1,
            system_kind: None,
            title,
            preview: preview(&content),
            word_count: count_note_chars(&content),
            content,
            color,
            pinned: draft.pinned.unwrap_or(false),
            category,
            view_mode: normalize_view_mode(draft.view_mode.as_deref().unwrap_or(DEFAULT_VIEW_MODE)),
            reminder: None,
            created_at: now.clone(),
            updated_at: now,
            window_bounds: normalize_bounds(draft.window_bounds),
        };
        store.notes.push(note.clone());
        note
    };

    normalize_store(&mut store);
    write_store(app, &store)?;
    Ok(saved)
}

pub fn create_blank_note(app: &AppHandle) -> Result<StickyNote, String> {
    save_note(
        app,
        StickyNoteDraft {
            id: None,
            revision: None,
            title: String::new(),
            content: String::new(),
            color: Some(DEFAULT_COLOR.to_string()),
            pinned: Some(false),
            category: None,
            view_mode: Some(DEFAULT_VIEW_MODE.to_string()),
            window_bounds: None,
        },
    )
}

pub fn ensure_daily_poetry_note(app: &AppHandle) -> Result<StickyNote, String> {
    let _guard = store_guard()?;
    let mut store = read_store(app)?;
    let changed = ensure_daily_poetry_note_in_store(&mut store);
    let note = daily_poetry_note(&store)?;
    if changed {
        write_store(app, &store)?;
    }
    Ok(note)
}

pub async fn refresh_daily_poetry_note(
    app: &AppHandle,
    client: &reqwest::Client,
    force: bool,
) -> Result<StickyNote, String> {
    let (current, mut token, cache_is_fresh) = {
        let _guard = store_guard()?;
        let mut store = read_store(app)?;
        let changed = ensure_daily_poetry_note_in_store(&mut store);
        let current = daily_poetry_note(&store)?;
        let cache_is_fresh = !force
            && store
                .poetry_cached_at
                .as_deref()
                .is_some_and(poetry_cache_is_fresh)
            && current.content != DAILY_POETRY_PLACEHOLDER;
        if changed {
            write_store(app, &store)?;
        }
        (current, store.poetry_token, cache_is_fresh)
    };

    if cache_is_fresh {
        return Ok(current);
    }

    if token.trim().is_empty() {
        token = fetch_poetry_token(client).await?;
        let _guard = store_guard()?;
        let mut store = read_store(app)?;
        ensure_daily_poetry_note_in_store(&mut store);
        store.poetry_token = token.clone();
        write_store(app, &store)?;
    }

    let sentence = fetch_poetry_sentence(client, &token).await?;
    let content = render_poetry_markdown(&sentence);
    let now = Utc::now().to_rfc3339();

    let _guard = store_guard()?;
    let mut store = read_store(app)?;
    ensure_daily_poetry_note_in_store(&mut store);
    let note = store
        .notes
        .iter_mut()
        .find(|note| note.id == DAILY_POETRY_NOTE_ID)
        .ok_or_else(|| "今日诗笺初始化失败".to_string())?;
    note.content = content;
    note.preview = preview(&note.content);
    note.word_count = count_note_chars(&note.content);
    note.revision = note.revision.saturating_add(1).max(1);
    note.updated_at = now.clone();
    let saved = note.clone();
    store.poetry_cached_at = Some(now);
    normalize_store(&mut store);
    write_store(app, &store)?;
    Ok(saved)
}

pub fn save_window_bounds(
    app: &AppHandle,
    id: &str,
    bounds: StickyWindowBounds,
) -> Result<StickyNote, String> {
    let _guard = store_guard()?;
    let id = sanitize_id(id)?;
    let mut store = read_store(app)?;
    let Some(note) = store.notes.iter_mut().find(|note| note.id == id) else {
        return Err("便签不存在".to_string());
    };
    note.window_bounds = normalize_bounds(Some(bounds));
    let saved = note.clone();
    write_store(app, &store)?;
    Ok(saved)
}

pub fn delete_note(app: &AppHandle, id: &str) -> Result<(), String> {
    let _guard = store_guard()?;
    let id = sanitize_id(id)?;
    let mut store = read_store(app)?;
    if store
        .notes
        .iter()
        .find(|note| note.id == id)
        .is_some_and(is_system_note)
        || id == DAILY_POETRY_NOTE_ID
    {
        return Err("今日诗笺是永久便签，不能删除".to_string());
    }
    let original_len = store.notes.len();
    store.notes.retain(|note| note.id != id);
    if store.notes.len() == original_len {
        return Err("便签不存在".to_string());
    }
    write_store(app, &store)?;
    let assets_dir = note_assets_dir(app, &id)?;
    if assets_dir.exists() {
        if let Err(err) = fs::remove_dir_all(assets_dir) {
            log::warn!("Failed to clean sticky note assets for {id}: {err}");
        }
    }
    Ok(())
}

pub fn save_image_asset(
    app: &AppHandle,
    id: &str,
    data_url: &str,
) -> Result<StickyNoteAsset, String> {
    let id = sanitize_id(id)?;
    get_note(app, &id)?;
    let (mime, encoded) = split_image_data_url(data_url)?;
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| "图片数据无效".to_string())?;
    if bytes.is_empty() {
        return Err("图片内容为空".to_string());
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("图片过大，单张不能超过 12 MB".to_string());
    }

    let extension = image_extension(mime).ok_or_else(|| "不支持这种图片格式".to_string())?;
    let file_name = format!("{}.{}", Uuid::new_v4(), extension);
    let dir = note_assets_dir(app, &id)?;
    fs::create_dir_all(&dir).map_err(|err| format!("创建便签图片目录失败: {err}"))?;
    fs::write(dir.join(&file_name), bytes).map_err(|err| format!("保存便签图片失败: {err}"))?;

    Ok(StickyNoteAsset {
        markdown_url: format!("sticky-asset://{file_name}"),
        file_name,
    })
}

pub fn load_image_asset(app: &AppHandle, id: &str, file_name: &str) -> Result<String, String> {
    let id = sanitize_id(id)?;
    let file_name = sanitize_asset_file_name(file_name)?;
    let mime =
        image_mime_from_file_name(&file_name).ok_or_else(|| "不支持这种图片格式".to_string())?;
    let path = note_assets_dir(app, &id)?.join(file_name);
    let bytes = fs::read(path).map_err(|err| format!("读取便签图片失败: {err}"))?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("图片过大，无法显示".to_string());
    }
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

pub fn list_categories(app: &AppHandle) -> Result<Vec<String>, String> {
    let _guard = store_guard()?;
    Ok(read_store(app)?.categories)
}

pub fn create_category(app: &AppHandle, name: &str) -> Result<Vec<String>, String> {
    let _guard = store_guard()?;
    let category = normalize_category(name)?;
    if category.is_empty() {
        return Err("分类名不能为空".to_string());
    }
    let mut store = read_store(app)?;
    ensure_category(&mut store, &category);
    write_store(app, &store)?;
    Ok(store.categories)
}

pub fn rename_category(app: &AppHandle, old_name: &str, new_name: &str) -> Result<(), String> {
    let _guard = store_guard()?;
    let old_name = normalize_category(old_name)?;
    let new_name = normalize_category(new_name)?;
    if old_name.is_empty() || new_name.is_empty() {
        return Err("分类名不能为空".to_string());
    }
    let mut store = read_store(app)?;
    if !store
        .categories
        .iter()
        .any(|category| category == &old_name)
        && !store.notes.iter().any(|note| note.category == old_name)
    {
        return Err("分类不存在".to_string());
    }
    for note in &mut store.notes {
        if note.category == old_name {
            note.category = new_name.clone();
            mark_note_changed(note);
        }
    }
    store.categories.retain(|category| category != &old_name);
    ensure_category(&mut store, &new_name);
    normalize_store(&mut store);
    write_store(app, &store)
}

pub fn delete_category(app: &AppHandle, name: &str) -> Result<(), String> {
    let _guard = store_guard()?;
    let name = normalize_category(name)?;
    if name.is_empty() {
        return Err("分类名不能为空".to_string());
    }
    let mut store = read_store(app)?;
    store.categories.retain(|category| category != &name);
    for note in &mut store.notes {
        if note.category == name {
            note.category.clear();
            mark_note_changed(note);
        }
    }
    normalize_store(&mut store);
    write_store(app, &store)
}

pub fn move_note_to_category(
    app: &AppHandle,
    id: &str,
    category: &str,
) -> Result<StickyNote, String> {
    let _guard = store_guard()?;
    let id = sanitize_id(id)?;
    let category = normalize_category(category)?;
    let mut store = read_store(app)?;
    ensure_category(&mut store, &category);
    let Some(note) = store.notes.iter_mut().find(|note| note.id == id) else {
        return Err("便签不存在".to_string());
    };
    if is_system_note(note) {
        return Err("系统诗笺不能移动分类".to_string());
    }
    note.category = category;
    mark_note_changed(note);
    let saved = note.clone();
    write_store(app, &store)?;
    Ok(saved)
}

pub fn import_markdown_file(
    app: &AppHandle,
    path: Option<String>,
    category: Option<String>,
) -> Result<StickyNote, String> {
    let path = path_from_optional(path, "请选择要导入的 Markdown 文件")?;
    if path.extension().and_then(|ext| ext.to_str()).unwrap_or("") != "md" {
        return Err("只支持导入 .md 文件".to_string());
    }
    let content = fs::read_to_string(&path).map_err(|err| format!("读取 Markdown 失败: {err}"))?;
    let title = imported_markdown_title(&path, &content);
    save_note(
        app,
        StickyNoteDraft {
            id: None,
            revision: None,
            title,
            content,
            color: Some(DEFAULT_COLOR.to_string()),
            pinned: Some(false),
            category,
            view_mode: Some(DEFAULT_VIEW_MODE.to_string()),
            window_bounds: None,
        },
    )
}

pub fn export_markdown_file(app: &AppHandle, id: &str, path: Option<String>) -> Result<(), String> {
    let path = path_from_optional(path, "请选择导出 Markdown 的保存路径")?;
    let note = get_note(app, id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("创建导出目录失败: {err}"))?;
    }

    let file_stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("sticky-note");
    let assets_dir_name = format!("{file_stem}_assets");
    let (export_content, asset_names) =
        rewrite_export_asset_references(&note.content, &assets_dir_name)?;

    if !asset_names.is_empty() {
        let source_dir = note_assets_dir(app, &note.id)?;
        for file_name in &asset_names {
            let source = source_dir.join(file_name);
            if !source.is_file() {
                return Err(format!("便签图片不存在: {file_name}"));
            }
        }

        let export_assets_dir = path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(&assets_dir_name);
        fs::create_dir_all(&export_assets_dir)
            .map_err(|err| format!("创建图片附件目录失败: {err}"))?;
        for file_name in &asset_names {
            fs::copy(
                source_dir.join(file_name),
                export_assets_dir.join(file_name),
            )
            .map_err(|err| format!("导出便签图片失败: {err}"))?;
        }
    }

    fs::write(path, export_content).map_err(|err| format!("导出 Markdown 失败: {err}"))
}

pub fn get_shortcut_config(app: &AppHandle) -> Result<StickyShortcutConfig, String> {
    let _guard = store_guard()?;
    Ok(read_store(app)?.shortcuts)
}

pub fn save_shortcut_config(
    app: &AppHandle,
    config: StickyShortcutConfig,
) -> Result<StickyShortcutConfig, String> {
    let _guard = store_guard()?;
    let mut store = read_store(app)?;
    store.shortcuts = StickyShortcutConfig {
        new_note_hotkey: normalize_hotkey_label(&config.new_note_hotkey, DEFAULT_NEW_NOTE_HOTKEY),
        toggle_window_hotkey: normalize_hotkey_label(
            &config.toggle_window_hotkey,
            DEFAULT_TOGGLE_WINDOW_HOTKEY,
        ),
    };
    let saved = store.shortcuts.clone();
    write_store(app, &store)?;
    Ok(saved)
}

pub fn set_reminder(app: &AppHandle, id: &str, due_at: &str) -> Result<StickyNote, String> {
    let due_at = parse_reminder_time(due_at)?;
    if due_at <= Utc::now() {
        return Err("提醒时间必须晚于当前时间".to_string());
    }
    update_reminder(app, id, |note| {
        note.reminder = Some(StickyReminder {
            due_at: due_at.to_rfc3339(),
            status: REMINDER_STATUS_SCHEDULED.to_string(),
            last_notified_at: None,
            completed_at: None,
        });
    })
}

pub fn cancel_reminder(app: &AppHandle, id: &str) -> Result<StickyNote, String> {
    update_reminder(app, id, |note| {
        note.reminder = None;
    })
}

pub fn snooze_reminder(app: &AppHandle, id: &str, minutes: i64) -> Result<StickyNote, String> {
    if !(1..=MAX_SNOOZE_MINUTES).contains(&minutes) {
        return Err("延后时间必须在 1 分钟到 7 天之间".to_string());
    }
    let due_at = Utc::now() + Duration::minutes(minutes);
    update_reminder(app, id, |note| {
        note.reminder = Some(StickyReminder {
            due_at: due_at.to_rfc3339(),
            status: REMINDER_STATUS_SCHEDULED.to_string(),
            last_notified_at: None,
            completed_at: None,
        });
    })
}

pub fn complete_reminder(app: &AppHandle, id: &str) -> Result<StickyNote, String> {
    update_reminder(app, id, |note| {
        if let Some(reminder) = &mut note.reminder {
            reminder.status = REMINDER_STATUS_COMPLETED.to_string();
            reminder.completed_at = Some(Utc::now().to_rfc3339());
        }
    })
}

pub fn due_reminders(app: &AppHandle, now: DateTime<Utc>) -> Result<Vec<StickyNote>, String> {
    let _guard = store_guard()?;
    let mut notes = read_store(app)?
        .notes
        .into_iter()
        .filter(|note| reminder_is_due(note.reminder.as_ref(), now))
        .collect::<Vec<_>>();
    notes.sort_by(|left, right| {
        let left_due = left.reminder.as_ref().map(|value| value.due_at.as_str());
        let right_due = right.reminder.as_ref().map(|value| value.due_at.as_str());
        left_due.cmp(&right_due)
    });
    Ok(notes)
}

pub fn mark_reminder_notified(
    app: &AppHandle,
    id: &str,
    notified_at: DateTime<Utc>,
) -> Result<StickyNote, String> {
    update_reminder(app, id, |note| {
        if let Some(reminder) = &mut note.reminder {
            if reminder.status == REMINDER_STATUS_SCHEDULED {
                reminder.status = REMINDER_STATUS_NOTIFIED.to_string();
                reminder.last_notified_at = Some(notified_at.to_rfc3339());
            }
        }
    })
}

pub fn active_reminder_count(app: &AppHandle) -> Result<usize, String> {
    let _guard = store_guard()?;
    Ok(read_store(app)?
        .notes
        .iter()
        .filter(|note| {
            note.reminder
                .as_ref()
                .is_some_and(|reminder| reminder.status != REMINDER_STATUS_COMPLETED)
        })
        .count())
}

fn update_reminder(
    app: &AppHandle,
    id: &str,
    update: impl FnOnce(&mut StickyNote),
) -> Result<StickyNote, String> {
    let _guard = store_guard()?;
    let id = sanitize_id(id)?;
    let mut store = read_store(app)?;
    let Some(note) = store.notes.iter_mut().find(|note| note.id == id) else {
        return Err("便签不存在".to_string());
    };
    if is_system_note(note) {
        return Err("系统诗笺不支持提醒".to_string());
    }
    update(note);
    mark_note_changed(note);
    let saved = note.clone();
    normalize_store(&mut store);
    write_store(app, &store)?;
    Ok(saved)
}

fn checked_next_revision(current: u64, expected: Option<u64>) -> Result<u64, String> {
    let Some(expected) = expected else {
        return Err(format!(
            "{STICKY_NOTES_CONFLICT_PREFIX}便签版本信息缺失，请重新载入后再编辑"
        ));
    };
    if expected != current {
        return Err(format!(
            "{STICKY_NOTES_CONFLICT_PREFIX}便签已在另一个窗口更新，当前修改尚未保存"
        ));
    }
    Ok(current.saturating_add(1).max(1))
}

fn mark_note_changed(note: &mut StickyNote) {
    note.revision = note.revision.saturating_add(1).max(1);
    note.updated_at = Utc::now().to_rfc3339();
}

fn read_store(app: &AppHandle) -> Result<StickyNoteStore, String> {
    let path = notes_path(app)?;
    read_store_from_path(&path)
}

fn read_store_from_path(path: &Path) -> Result<StickyNoteStore, String> {
    match read_store_file(path) {
        Ok(Some(mut store)) => {
            normalize_store(&mut store);
            return Ok(store);
        }
        Ok(None) => {}
        Err(primary_error) => {
            log::warn!("便签主数据不可用，尝试从备份恢复: {primary_error}");
        }
    }

    let backup_path = notes_backup_path(path);
    match read_store_file(&backup_path) {
        Ok(Some(mut store)) => {
            normalize_store(&mut store);
            if let Err(err) = write_store_file(path, &store, false) {
                log::warn!("恢复便签主数据失败，将继续使用备份内容: {err}");
            } else {
                log::warn!("已从备份恢复便签数据");
            }
            Ok(store)
        }
        Ok(None) if !path.exists() => Ok(default_store()),
        Ok(None) => Err("便签数据损坏且没有可用备份".to_string()),
        Err(backup_error) => Err(format!("便签数据和备份均无法读取: {backup_error}")),
    }
}

fn write_store(app: &AppHandle, store: &StickyNoteStore) -> Result<(), String> {
    let path = notes_path(app)?;
    write_store_file(&path, store, true)
}

fn read_store_file(path: &Path) -> Result<Option<StickyNoteStore>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let raw =
        fs::read_to_string(path).map_err(|err| format!("读取 {} 失败: {err}", path.display()))?;
    if raw.trim().is_empty() {
        return Err(format!("{} 是空文件", path.display()));
    }
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|err| format!("解析 {} 失败: {err}", path.display()))
}

fn write_store_file(
    path: &Path,
    store: &StickyNoteStore,
    preserve_previous: bool,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("创建便签数据目录失败: {err}"))?;
    }
    let raw =
        serde_json::to_string_pretty(store).map_err(|err| format!("序列化便签数据失败: {err}"))?;
    let temporary_path = path.with_extension("json.tmp");
    write_synced_file(&temporary_path, raw.as_bytes())?;

    let backup_path = notes_backup_path(path);
    let backup = preserve_previous
        .then_some(backup_path.as_path())
        .filter(|_| read_store_file(path).is_ok_and(|store| store.is_some()));
    replace_file_atomically(path, &temporary_path, backup)
}

fn write_synced_file(path: &Path, content: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(path)
        .map_err(|err| format!("创建便签临时数据失败: {err}"))?;
    file.write_all(content)
        .map_err(|err| format!("写入便签临时数据失败: {err}"))?;
    file.sync_all()
        .map_err(|err| format!("同步便签临时数据失败: {err}"))
}

fn notes_backup_path(path: &Path) -> PathBuf {
    path.with_extension("json.bak")
}

#[cfg(windows)]
fn replace_file_atomically(
    destination: &Path,
    replacement: &Path,
    backup: Option<&Path>,
) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::PCWSTR,
        Win32::Storage::FileSystem::{ReplaceFileW, REPLACE_FILE_FLAGS},
    };

    if !destination.exists() {
        return fs::rename(replacement, destination)
            .map_err(|err| format!("写入便签数据失败: {err}"));
    }
    if let Some(backup) = backup {
        if backup.exists() {
            fs::remove_file(backup).map_err(|err| format!("更新便签备份失败: {err}"))?;
        }
    }

    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let replacement_wide: Vec<u16> = replacement
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let backup_wide = backup.map(|path| {
        path.as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<u16>>()
    });
    let backup_ptr = backup_wide
        .as_ref()
        .map_or(PCWSTR::null(), |path| PCWSTR(path.as_ptr()));

    unsafe {
        ReplaceFileW(
            PCWSTR(destination_wide.as_ptr()),
            PCWSTR(replacement_wide.as_ptr()),
            backup_ptr,
            REPLACE_FILE_FLAGS(0),
            None,
            None,
        )
    }
    .map_err(|err| format!("原子替换便签数据失败: {err}"))
}

#[cfg(not(windows))]
fn replace_file_atomically(
    destination: &Path,
    replacement: &Path,
    backup: Option<&Path>,
) -> Result<(), String> {
    if let Some(backup) = backup {
        let temporary_backup = backup.with_extension("bak.tmp");
        fs::copy(destination, &temporary_backup)
            .map_err(|err| format!("创建便签备份失败: {err}"))?;
        let backup_file = OpenOptions::new()
            .read(true)
            .open(&temporary_backup)
            .map_err(|err| format!("打开便签备份失败: {err}"))?;
        backup_file
            .sync_all()
            .map_err(|err| format!("同步便签备份失败: {err}"))?;
        fs::rename(&temporary_backup, backup).map_err(|err| format!("更新便签备份失败: {err}"))?;
    }
    fs::rename(replacement, destination).map_err(|err| format!("写入便签数据失败: {err}"))
}

fn notes_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|err| format!("获取应用数据目录失败: {err}"))?
        .join(STICKY_NOTES_FILE))
}

fn note_assets_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|err| format!("获取应用数据目录失败: {err}"))?
        .join(STICKY_ASSETS_DIR)
        .join(id))
}

fn ensure_daily_poetry_note_in_store(store: &mut StickyNoteStore) -> bool {
    if let Some(note) = store
        .notes
        .iter_mut()
        .find(|note| note.id == DAILY_POETRY_NOTE_ID)
    {
        let mut changed = false;
        if note.system_kind.as_deref() != Some(DAILY_POETRY_SYSTEM_KIND) {
            note.system_kind = Some(DAILY_POETRY_SYSTEM_KIND.to_string());
            changed = true;
        }
        if note.title != DAILY_POETRY_TITLE {
            note.title = DAILY_POETRY_TITLE.to_string();
            changed = true;
        }
        if !note.pinned {
            note.pinned = true;
            changed = true;
        }
        if !note.category.is_empty() {
            note.category.clear();
            changed = true;
        }
        if note.view_mode != "preview" {
            note.view_mode = "preview".to_string();
            changed = true;
        }
        if note.reminder.is_some() {
            note.reminder = None;
            changed = true;
        }
        return changed;
    }

    let now = Utc::now().to_rfc3339();
    store.notes.push(StickyNote {
        id: DAILY_POETRY_NOTE_ID.to_string(),
        revision: 1,
        system_kind: Some(DAILY_POETRY_SYSTEM_KIND.to_string()),
        title: DAILY_POETRY_TITLE.to_string(),
        content: DAILY_POETRY_PLACEHOLDER.to_string(),
        color: DEFAULT_COLOR.to_string(),
        pinned: true,
        category: String::new(),
        preview: DAILY_POETRY_PLACEHOLDER.to_string(),
        word_count: count_note_chars(DAILY_POETRY_PLACEHOLDER),
        view_mode: "preview".to_string(),
        reminder: None,
        created_at: now.clone(),
        updated_at: now,
        window_bounds: None,
    });
    sort_notes(&mut store.notes);
    true
}

fn daily_poetry_note(store: &StickyNoteStore) -> Result<StickyNote, String> {
    store
        .notes
        .iter()
        .find(|note| note.id == DAILY_POETRY_NOTE_ID)
        .cloned()
        .ok_or_else(|| "今日诗笺初始化失败".to_string())
}

fn is_system_note(note: &StickyNote) -> bool {
    note.id == DAILY_POETRY_NOTE_ID || note.system_kind.is_some()
}

fn poetry_cache_is_fresh(value: &str) -> bool {
    DateTime::parse_from_rfc3339(value)
        .map(|value| {
            Utc::now() - value.with_timezone(&Utc) < Duration::hours(DAILY_POETRY_REFRESH_HOURS)
        })
        .unwrap_or(false)
}

async fn fetch_poetry_token(client: &reqwest::Client) -> Result<String, String> {
    let response = client
        .get(DAILY_POETRY_TOKEN_URL)
        .timeout(std::time::Duration::from_secs(12))
        .send()
        .await
        .map_err(|err| format!("获取今日诗词 Token 失败: {err}"))?;
    let status = response.status();
    let payload = response
        .json::<PoetryTokenResponse>()
        .await
        .map_err(|err| format!("解析今日诗词 Token 失败: {err}"))?;
    if !status.is_success() || payload.status != "success" {
        return Err(payload
            .err_message
            .filter(|message| !message.trim().is_empty())
            .unwrap_or_else(|| format!("获取今日诗词 Token 失败（HTTP {status}）")));
    }
    payload
        .data
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "今日诗词接口没有返回 Token".to_string())
}

async fn fetch_poetry_sentence(
    client: &reqwest::Client,
    token: &str,
) -> Result<PoetrySentenceData, String> {
    let response = client
        .get(DAILY_POETRY_SENTENCE_URL)
        .header("X-User-Token", token)
        .timeout(std::time::Duration::from_secs(12))
        .send()
        .await
        .map_err(|err| format!("获取今日诗词失败: {err}"))?;
    let status = response.status();
    let payload = response
        .json::<PoetrySentenceResponse>()
        .await
        .map_err(|err| format!("解析今日诗词失败: {err}"))?;
    if !status.is_success() || payload.status != "success" {
        return Err(payload
            .err_message
            .filter(|message| !message.trim().is_empty())
            .unwrap_or_else(|| format!("获取今日诗词失败（HTTP {status}）")));
    }
    payload
        .data
        .filter(|value| !value.content.trim().is_empty())
        .ok_or_else(|| "今日诗词接口没有返回诗句".to_string())
}

fn render_poetry_markdown(sentence: &PoetrySentenceData) -> String {
    let content = sentence.content.trim();
    let dynasty = sentence.origin.dynasty.trim();
    let author = sentence.origin.author.trim();
    let title = sentence.origin.title.trim();
    let source = match (dynasty.is_empty(), author.is_empty(), title.is_empty()) {
        (false, false, false) => format!("〔{dynasty}〕{author}《{title}》"),
        (_, false, false) => format!("{author}《{title}》"),
        (_, _, false) => format!("《{title}》"),
        (_, false, true) => author.to_string(),
        _ => "今日诗词".to_string(),
    };
    format!("> {content}\n\n—— {source}")
}

fn default_store() -> StickyNoteStore {
    StickyNoteStore {
        notes: Vec::new(),
        categories: Vec::new(),
        shortcuts: StickyShortcutConfig::default(),
        poetry_token: String::new(),
        poetry_cached_at: None,
    }
}

fn normalize_store(store: &mut StickyNoteStore) {
    let mut categories: BTreeSet<String> = store
        .categories
        .iter()
        .filter_map(|category| normalize_category_lossy(category))
        .filter(|category| !category.is_empty())
        .collect();

    for note in &mut store.notes {
        note.title = clamp_chars(note.title.trim(), MAX_TITLE_CHARS);
        note.content = clamp_chars(&note.content, MAX_CONTENT_CHARS);
        note.color = normalize_color(Some(&note.color));
        note.category = normalize_category_lossy(&note.category).unwrap_or_default();
        if !note.category.is_empty() {
            categories.insert(note.category.clone());
        }
        note.preview = preview(&note.content);
        note.word_count = count_note_chars(&note.content);
        note.view_mode = normalize_view_mode(&note.view_mode);
        note.reminder = normalize_reminder(note.reminder.take());
        note.window_bounds = normalize_bounds(note.window_bounds.clone());
        if is_system_note(note) {
            note.id = DAILY_POETRY_NOTE_ID.to_string();
            note.system_kind = Some(DAILY_POETRY_SYSTEM_KIND.to_string());
            note.title = DAILY_POETRY_TITLE.to_string();
            note.pinned = true;
            note.category.clear();
            note.view_mode = "preview".to_string();
            note.reminder = None;
        }
    }

    store.categories = categories.into_iter().collect();
    store.shortcuts = StickyShortcutConfig {
        new_note_hotkey: normalize_hotkey_label(
            &store.shortcuts.new_note_hotkey,
            DEFAULT_NEW_NOTE_HOTKEY,
        ),
        toggle_window_hotkey: normalize_hotkey_label(
            &store.shortcuts.toggle_window_hotkey,
            DEFAULT_TOGGLE_WINDOW_HOTKEY,
        ),
    };
    sort_notes(&mut store.notes);
}

fn normalize_reminder(reminder: Option<StickyReminder>) -> Option<StickyReminder> {
    let mut reminder = reminder?;
    let due_at = parse_reminder_time(&reminder.due_at).ok()?;
    reminder.due_at = due_at.to_rfc3339();
    reminder.status = match reminder.status.as_str() {
        REMINDER_STATUS_NOTIFIED => REMINDER_STATUS_NOTIFIED.to_string(),
        REMINDER_STATUS_COMPLETED => REMINDER_STATUS_COMPLETED.to_string(),
        _ => REMINDER_STATUS_SCHEDULED.to_string(),
    };
    if reminder.status != REMINDER_STATUS_COMPLETED {
        reminder.completed_at = None;
    }
    Some(reminder)
}

fn parse_reminder_time(value: &str) -> Result<DateTime<Utc>, String> {
    DateTime::parse_from_rfc3339(value.trim())
        .map(|value| value.with_timezone(&Utc))
        .map_err(|_| "提醒时间格式无效".to_string())
}

fn reminder_is_due(reminder: Option<&StickyReminder>, now: DateTime<Utc>) -> bool {
    let Some(reminder) = reminder else {
        return false;
    };
    reminder.status == REMINDER_STATUS_SCHEDULED
        && parse_reminder_time(&reminder.due_at).is_ok_and(|due_at| due_at <= now)
}

fn store_guard() -> Result<MutexGuard<'static, ()>, String> {
    STORE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "便签存储锁已损坏".to_string())
}

fn sort_notes(notes: &mut [StickyNote]) {
    notes.sort_by(|left, right| {
        is_system_note(right)
            .cmp(&is_system_note(left))
            .then_with(|| right.pinned.cmp(&left.pinned))
            .then_with(|| right.updated_at.cmp(&left.updated_at))
            .then_with(|| left.title.cmp(&right.title))
    });
}

fn ensure_category(store: &mut StickyNoteStore, category: &str) {
    if category.is_empty() || store.categories.iter().any(|value| value == category) {
        return;
    }
    store.categories.push(category.to_string());
    store.categories.sort();
}

fn sanitize_id(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 80 {
        return Err("便签 ID 无效".to_string());
    }
    if !trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err("便签 ID 无效".to_string());
    }
    Ok(trimmed.to_string())
}

fn sanitize_asset_file_name(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.len() > 120
        || !trimmed
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
        || trimmed.starts_with('.')
        || trimmed.contains("..")
    {
        return Err("便签图片名称无效".to_string());
    }
    Ok(trimmed.to_string())
}

fn split_image_data_url(value: &str) -> Result<(&str, &str), String> {
    let (header, encoded) = value
        .split_once(',')
        .ok_or_else(|| "图片数据无效".to_string())?;
    let mime = header
        .strip_prefix("data:")
        .and_then(|value| value.strip_suffix(";base64"))
        .ok_or_else(|| "图片数据无效".to_string())?;
    if encoded.len() > (MAX_IMAGE_BYTES * 4 / 3) + 16 {
        return Err("图片过大，单张不能超过 12 MB".to_string());
    }
    Ok((mime, encoded))
}

fn image_extension(mime: &str) -> Option<&'static str> {
    match mime {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

fn image_mime_from_file_name(file_name: &str) -> Option<&'static str> {
    match Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())?
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

fn rewrite_export_asset_references(
    content: &str,
    assets_dir_name: &str,
) -> Result<(String, BTreeSet<String>), String> {
    const PREFIX: &str = "sticky-asset://";
    let mut names = BTreeSet::new();
    let mut cursor = 0;

    while let Some(relative_start) = content[cursor..].find(PREFIX) {
        let name_start = cursor + relative_start + PREFIX.len();
        let name_end = content[name_start..]
            .find(|ch: char| !(ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.')))
            .map(|offset| name_start + offset)
            .unwrap_or(content.len());
        let file_name = sanitize_asset_file_name(&content[name_start..name_end])?;
        names.insert(file_name);
        cursor = name_end;
    }

    let mut rewritten = content.to_string();
    for file_name in &names {
        rewritten = rewritten.replace(
            &format!("{PREFIX}{file_name}"),
            &format!("<./{assets_dir_name}/{file_name}>"),
        );
    }
    Ok((rewritten, names))
}

fn normalize_category(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.chars().count() > MAX_CATEGORY_CHARS {
        return Err("分类名过长".to_string());
    }
    if !category_chars_valid(trimmed) {
        return Err("分类名不能包含路径或特殊字符".to_string());
    }
    Ok(trimmed.to_string())
}

fn normalize_category_lossy(value: &str) -> Option<String> {
    normalize_category(value).ok()
}

fn category_chars_valid(value: &str) -> bool {
    !value
        .chars()
        .any(|ch| matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
}

fn normalize_color(_value: Option<&str>) -> String {
    DEFAULT_COLOR.to_string()
}

fn normalize_view_mode(value: &str) -> String {
    match value.trim() {
        "preview" => "preview".to_string(),
        "edit" | "split" => DEFAULT_VIEW_MODE.to_string(),
        _ => DEFAULT_VIEW_MODE.to_string(),
    }
}

fn default_view_mode() -> String {
    DEFAULT_VIEW_MODE.to_string()
}

fn normalize_bounds(bounds: Option<StickyWindowBounds>) -> Option<StickyWindowBounds> {
    bounds.and_then(|value| {
        if value.x <= HIDDEN_WINDOW_COORDINATE || value.y <= HIDDEN_WINDOW_COORDINATE {
            return None;
        }
        Some(StickyWindowBounds {
            x: value.x,
            y: value.y,
            width: value.width.max(280),
            height: value.height.max(260),
        })
    })
}

fn path_from_optional(path: Option<String>, missing: &str) -> Result<PathBuf, String> {
    let Some(path) = path else {
        return Err(missing.to_string());
    };
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(missing.to_string());
    }
    Ok(PathBuf::from(trimmed))
}

fn imported_markdown_title(path: &Path, content: &str) -> String {
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(title) = trimmed.strip_prefix("# ") {
            let title = title.trim();
            if !title.is_empty() {
                return clamp_chars(title, MAX_TITLE_CHARS);
            }
        }
    }
    path.file_stem()
        .and_then(|value| value.to_str())
        .map(|value| clamp_chars(value, MAX_TITLE_CHARS))
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "导入便签".to_string())
}

fn preview(content: &str) -> String {
    content
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(120)
        .collect()
}

fn count_note_chars(content: &str) -> usize {
    content.chars().filter(|ch| !ch.is_whitespace()).count()
}

fn normalize_hotkey_label(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 80 {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

fn clamp_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imported_markdown_title_prefers_first_h1() {
        let path = PathBuf::from("fallback.md");
        assert_eq!(
            imported_markdown_title(&path, "intro\n# Real Title\nbody"),
            "Real Title"
        );
    }

    #[test]
    fn imported_markdown_title_falls_back_to_file_name() {
        let path = PathBuf::from("meeting-note.md");
        assert_eq!(imported_markdown_title(&path, "no heading"), "meeting-note");
    }

    #[test]
    fn category_rejects_path_separators() {
        assert!(normalize_category("work").is_ok());
        assert!(normalize_category("work/log").is_err());
    }

    #[test]
    fn standalone_category_survives_store_normalization() {
        let mut store = default_store();
        ensure_category(&mut store, "工作");
        normalize_store(&mut store);

        assert_eq!(store.categories, vec!["工作".to_string()]);
        assert!(store.notes.is_empty());
    }

    #[test]
    fn preview_and_word_count_are_stable() {
        assert_eq!(preview("# Title\n\nhello world"), "# Title hello world");
        assert_eq!(count_note_chars("a b\nc"), 3);
    }

    #[test]
    fn daily_poetry_note_is_created_once_and_is_protected() {
        let mut store = default_store();
        assert!(ensure_daily_poetry_note_in_store(&mut store));
        assert!(!ensure_daily_poetry_note_in_store(&mut store));
        assert_eq!(store.notes.len(), 1);
        let note = &store.notes[0];
        assert_eq!(note.id, DAILY_POETRY_NOTE_ID);
        assert_eq!(note.system_kind.as_deref(), Some(DAILY_POETRY_SYSTEM_KIND));
        assert!(note.pinned);
        assert!(is_system_note(note));
    }

    #[test]
    fn poetry_response_renders_sentence_and_source() {
        let sentence = PoetrySentenceData {
            content: "君问归期未有期，巴山夜雨涨秋池。".to_string(),
            origin: PoetryOrigin {
                title: "夜雨寄北".to_string(),
                dynasty: "唐".to_string(),
                author: "李商隐".to_string(),
            },
        };
        assert_eq!(
            render_poetry_markdown(&sentence),
            "> 君问归期未有期，巴山夜雨涨秋池。\n\n—— 〔唐〕李商隐《夜雨寄北》"
        );
    }

    #[test]
    fn image_data_url_requires_supported_base64_mime() {
        assert_eq!(
            split_image_data_url("data:image/png;base64,YQ==").unwrap(),
            ("image/png", "YQ==")
        );
        assert!(split_image_data_url("image/png,YQ==").is_err());
        assert!(image_extension("image/svg+xml").is_none());
    }

    #[test]
    fn asset_file_name_cannot_escape_note_directory() {
        assert!(sanitize_asset_file_name("image-1.png").is_ok());
        assert!(sanitize_asset_file_name("../image.png").is_err());
        assert!(sanitize_asset_file_name("folder/image.png").is_err());
    }

    #[test]
    fn export_rewrites_and_deduplicates_sticky_assets() {
        let content = "![one](sticky-asset://a.png)\n![again](sticky-asset://a.png)";
        let (rewritten, names) =
            rewrite_export_asset_references(content, "example_assets").unwrap();
        assert_eq!(names.into_iter().collect::<Vec<_>>(), vec!["a.png"]);
        assert_eq!(
            rewritten,
            "![one](<./example_assets/a.png>)\n![again](<./example_assets/a.png>)"
        );
    }

    #[test]
    fn old_note_json_ignores_removed_tile_fields_and_defaults_to_no_reminder() {
        let raw = r##"{
          "notes": [{
            "id": "note-1",
            "title": "old",
            "content": "",
            "color": "#ffd6e8",
            "pinned": false,
            "tilePinned": true,
            "tileBounds": {
              "x": 10,
              "y": 20,
              "width": 320,
              "height": 360
            },
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z"
          }]
        }"##;
        let mut store: StickyNoteStore = serde_json::from_str(raw).unwrap();
        normalize_store(&mut store);
        assert!(store.notes[0].reminder.is_none());
    }

    #[test]
    fn stale_revision_is_rejected_after_another_window_saves() {
        let first_saved_revision = checked_next_revision(1, Some(1)).unwrap();
        assert_eq!(first_saved_revision, 2);

        let error = checked_next_revision(first_saved_revision, Some(1)).unwrap_err();
        assert!(error.starts_with(STICKY_NOTES_CONFLICT_PREFIX));
    }

    #[test]
    fn interrupted_temporary_write_does_not_change_primary_store() {
        let directory = test_store_directory("interrupted-write");
        let path = directory.join(STICKY_NOTES_FILE);
        let mut store = default_store();
        store.categories = vec!["current".to_string()];
        write_store_file(&path, &store, true).unwrap();

        fs::write(path.with_extension("json.tmp"), b"{\"notes\":")
            .expect("write simulated interrupted temporary file");

        let loaded = read_store_from_path(&path).unwrap();
        assert_eq!(loaded.categories, vec!["current"]);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn corrupt_primary_store_recovers_previous_backup() {
        let directory = test_store_directory("backup-recovery");
        let path = directory.join(STICKY_NOTES_FILE);
        let mut first = default_store();
        first.categories = vec!["previous".to_string()];
        write_store_file(&path, &first, true).unwrap();

        let mut second = default_store();
        second.categories = vec!["latest".to_string()];
        write_store_file(&path, &second, true).unwrap();
        assert!(notes_backup_path(&path).exists());

        fs::write(&path, b"{broken json").expect("corrupt primary store");
        let recovered = read_store_from_path(&path).unwrap();
        assert_eq!(recovered.categories, vec!["previous"]);

        let restored_primary = read_store_file(&path).unwrap().unwrap();
        assert_eq!(restored_primary.categories, vec!["previous"]);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn scheduled_reminder_becomes_due_at_target_time() {
        let due_at = DateTime::parse_from_rfc3339("2026-07-28T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let reminder = StickyReminder {
            due_at: due_at.to_rfc3339(),
            status: REMINDER_STATUS_SCHEDULED.to_string(),
            last_notified_at: None,
            completed_at: None,
        };
        assert!(!reminder_is_due(
            Some(&reminder),
            due_at - Duration::seconds(1)
        ));
        assert!(reminder_is_due(Some(&reminder), due_at));
    }

    #[test]
    fn completed_reminder_is_not_due() {
        let reminder = StickyReminder {
            due_at: "2026-07-28T12:00:00Z".to_string(),
            status: REMINDER_STATUS_COMPLETED.to_string(),
            last_notified_at: None,
            completed_at: Some("2026-07-28T12:01:00Z".to_string()),
        };
        let now = DateTime::parse_from_rfc3339("2026-07-28T13:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert!(!reminder_is_due(Some(&reminder), now));
    }

    fn test_store_directory(label: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("tabkeep-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).expect("create sticky-note test directory");
        directory
    }
}
