use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const STICKY_NOTES_FILE: &str = "sticky-notes.json";
const DEFAULT_COLOR: &str = "#fff7c2";
const MAX_TITLE_CHARS: usize = 120;
const MAX_CONTENT_CHARS: usize = 50_000;
const MAX_CATEGORY_CHARS: usize = 60;
const HIDDEN_WINDOW_COORDINATE: i32 = -10_000;
const DEFAULT_VIEW_MODE: &str = "edit";
const DEFAULT_NEW_NOTE_HOTKEY: &str = "Ctrl+Alt+N";
const DEFAULT_TOGGLE_WINDOW_HOTKEY: &str = "Ctrl+Alt+M";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StickyNote {
    pub id: String,
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
    #[serde(default)]
    pub tile_pinned: bool,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_bounds: Option<StickyWindowBounds>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tile_bounds: Option<StickyWindowBounds>,
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
    pub tile_pinned: Option<bool>,
    #[serde(default)]
    pub window_bounds: Option<StickyWindowBounds>,
    #[serde(default)]
    pub tile_bounds: Option<StickyWindowBounds>,
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
}

pub fn list_notes(app: &AppHandle) -> Result<Vec<StickyNote>, String> {
    let mut notes = read_store(app)?.notes;
    sort_notes(&mut notes);
    Ok(notes)
}

pub fn get_note(app: &AppHandle, id: &str) -> Result<StickyNote, String> {
    let id = sanitize_id(id)?;
    read_store(app)?
        .notes
        .into_iter()
        .find(|note| note.id == id)
        .ok_or_else(|| "便签不存在".to_string())
}

pub fn save_note(app: &AppHandle, draft: StickyNoteDraft) -> Result<StickyNote, String> {
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
        note.title = title;
        note.content = content;
        note.color = color;
        note.pinned = draft.pinned.unwrap_or(note.pinned);
        note.category = category;
        note.preview = preview(&note.content);
        note.word_count = count_note_chars(&note.content);
        note.view_mode = view_mode;
        note.tile_pinned = draft.tile_pinned.unwrap_or(note.tile_pinned);
        if draft.window_bounds.is_some() {
            note.window_bounds = normalize_bounds(draft.window_bounds);
        }
        if draft.tile_bounds.is_some() {
            note.tile_bounds = normalize_bounds(draft.tile_bounds);
        }
        note.updated_at = now;
        note.clone()
    } else {
        let category = normalize_category(draft.category.as_deref().unwrap_or(""))?;
        ensure_category(&mut store, &category);
        let note = StickyNote {
            id: Uuid::new_v4().to_string(),
            title,
            preview: preview(&content),
            word_count: count_note_chars(&content),
            content,
            color,
            pinned: draft.pinned.unwrap_or(false),
            category,
            view_mode: normalize_view_mode(draft.view_mode.as_deref().unwrap_or(DEFAULT_VIEW_MODE)),
            tile_pinned: draft.tile_pinned.unwrap_or(false),
            created_at: now.clone(),
            updated_at: now,
            window_bounds: normalize_bounds(draft.window_bounds),
            tile_bounds: normalize_bounds(draft.tile_bounds),
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
            title: String::new(),
            content: String::new(),
            color: Some(DEFAULT_COLOR.to_string()),
            pinned: Some(false),
            category: None,
            view_mode: Some(DEFAULT_VIEW_MODE.to_string()),
            tile_pinned: Some(false),
            window_bounds: None,
            tile_bounds: None,
        },
    )
}

pub fn save_window_bounds(
    app: &AppHandle,
    id: &str,
    bounds: StickyWindowBounds,
) -> Result<StickyNote, String> {
    update_bounds(app, id, bounds, BoundsTarget::Window)
}

pub fn save_tile_bounds(
    app: &AppHandle,
    id: &str,
    bounds: StickyWindowBounds,
) -> Result<StickyNote, String> {
    update_bounds(app, id, bounds, BoundsTarget::Tile)
}

pub fn set_tile_pinned(app: &AppHandle, id: &str, pinned: bool) -> Result<StickyNote, String> {
    let id = sanitize_id(id)?;
    let mut store = read_store(app)?;
    let Some(note) = store.notes.iter_mut().find(|note| note.id == id) else {
        return Err("便签不存在".to_string());
    };
    note.tile_pinned = pinned;
    let saved = note.clone();
    write_store(app, &store)?;
    Ok(saved)
}

pub fn delete_note(app: &AppHandle, id: &str) -> Result<(), String> {
    let id = sanitize_id(id)?;
    let mut store = read_store(app)?;
    let original_len = store.notes.len();
    store.notes.retain(|note| note.id != id);
    if store.notes.len() == original_len {
        return Err("便签不存在".to_string());
    }
    write_store(app, &store)
}

pub fn list_categories(app: &AppHandle) -> Result<Vec<String>, String> {
    Ok(read_store(app)?.categories)
}

pub fn create_category(app: &AppHandle, name: &str) -> Result<(), String> {
    let category = normalize_category(name)?;
    if category.is_empty() {
        return Err("分类名不能为空".to_string());
    }
    let mut store = read_store(app)?;
    ensure_category(&mut store, &category);
    write_store(app, &store)
}

pub fn rename_category(app: &AppHandle, old_name: &str, new_name: &str) -> Result<(), String> {
    let old_name = normalize_category(old_name)?;
    let new_name = normalize_category(new_name)?;
    if old_name.is_empty() || new_name.is_empty() {
        return Err("分类名不能为空".to_string());
    }
    let mut store = read_store(app)?;
    if !store.categories.iter().any(|category| category == &old_name)
        && !store.notes.iter().any(|note| note.category == old_name)
    {
        return Err("分类不存在".to_string());
    }
    for note in &mut store.notes {
        if note.category == old_name {
            note.category = new_name.clone();
        }
    }
    store.categories.retain(|category| category != &old_name);
    ensure_category(&mut store, &new_name);
    normalize_store(&mut store);
    write_store(app, &store)
}

pub fn delete_category(app: &AppHandle, name: &str) -> Result<(), String> {
    let name = normalize_category(name)?;
    if name.is_empty() {
        return Err("分类名不能为空".to_string());
    }
    let mut store = read_store(app)?;
    store.categories.retain(|category| category != &name);
    for note in &mut store.notes {
        if note.category == name {
            note.category.clear();
        }
    }
    normalize_store(&mut store);
    write_store(app, &store)
}

pub fn move_note_to_category(app: &AppHandle, id: &str, category: &str) -> Result<StickyNote, String> {
    let id = sanitize_id(id)?;
    let category = normalize_category(category)?;
    let mut store = read_store(app)?;
    ensure_category(&mut store, &category);
    let Some(note) = store.notes.iter_mut().find(|note| note.id == id) else {
        return Err("便签不存在".to_string());
    };
    note.category = category;
    note.updated_at = Utc::now().to_rfc3339();
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
            title,
            content,
            color: Some(DEFAULT_COLOR.to_string()),
            pinned: Some(false),
            category,
            view_mode: Some("split".to_string()),
            tile_pinned: Some(false),
            window_bounds: None,
            tile_bounds: None,
        },
    )
}

pub fn export_markdown_file(
    app: &AppHandle,
    id: &str,
    path: Option<String>,
) -> Result<(), String> {
    let path = path_from_optional(path, "请选择导出 Markdown 的保存路径")?;
    let note = get_note(app, id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("创建导出目录失败: {err}"))?;
    }
    fs::write(path, note.content).map_err(|err| format!("导出 Markdown 失败: {err}"))
}

pub fn get_shortcut_config(app: &AppHandle) -> Result<StickyShortcutConfig, String> {
    Ok(read_store(app)?.shortcuts)
}

pub fn save_shortcut_config(
    app: &AppHandle,
    config: StickyShortcutConfig,
) -> Result<StickyShortcutConfig, String> {
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

enum BoundsTarget {
    Window,
    Tile,
}

fn update_bounds(
    app: &AppHandle,
    id: &str,
    bounds: StickyWindowBounds,
    target: BoundsTarget,
) -> Result<StickyNote, String> {
    let id = sanitize_id(id)?;
    let mut store = read_store(app)?;
    let Some(note) = store.notes.iter_mut().find(|note| note.id == id) else {
        return Err("便签不存在".to_string());
    };
    match target {
        BoundsTarget::Window => note.window_bounds = normalize_bounds(Some(bounds)),
        BoundsTarget::Tile => note.tile_bounds = normalize_bounds(Some(bounds)),
    }
    let saved = note.clone();
    write_store(app, &store)?;
    Ok(saved)
}

fn read_store(app: &AppHandle) -> Result<StickyNoteStore, String> {
    let path = notes_path(app)?;
    if !path.exists() {
        return Ok(default_store());
    }
    let raw = fs::read_to_string(&path).map_err(|err| format!("读取便签数据失败: {err}"))?;
    if raw.trim().is_empty() {
        return Ok(default_store());
    }
    let mut store: StickyNoteStore =
        serde_json::from_str(&raw).map_err(|err| format!("解析便签数据失败: {err}"))?;
    normalize_store(&mut store);
    Ok(store)
}

fn write_store(app: &AppHandle, store: &StickyNoteStore) -> Result<(), String> {
    let path = notes_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("创建便签数据目录失败: {err}"))?;
    }
    let raw =
        serde_json::to_string_pretty(store).map_err(|err| format!("序列化便签数据失败: {err}"))?;
    fs::write(path, raw).map_err(|err| format!("写入便签数据失败: {err}"))
}

fn notes_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|err| format!("获取应用数据目录失败: {err}"))?
        .join(STICKY_NOTES_FILE))
}

fn default_store() -> StickyNoteStore {
    StickyNoteStore {
        notes: Vec::new(),
        categories: Vec::new(),
        shortcuts: StickyShortcutConfig::default(),
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
        note.window_bounds = normalize_bounds(note.window_bounds.clone());
        note.tile_bounds = normalize_bounds(note.tile_bounds.clone());
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

fn sort_notes(notes: &mut [StickyNote]) {
    notes.sort_by(|left, right| {
        right
            .pinned
            .cmp(&left.pinned)
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

fn normalize_color(value: Option<&str>) -> String {
    let candidate = value.unwrap_or(DEFAULT_COLOR).trim();
    if candidate.len() == 7
        && candidate.starts_with('#')
        && candidate.chars().skip(1).all(|ch| ch.is_ascii_hexdigit())
    {
        candidate.to_string()
    } else {
        DEFAULT_COLOR.to_string()
    }
}

fn normalize_view_mode(value: &str) -> String {
    match value.trim() {
        "edit" | "split" | "preview" => value.trim().to_string(),
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
    fn preview_and_word_count_are_stable() {
        assert_eq!(preview("# Title\n\nhello world"), "# Title hello world");
        assert_eq!(count_note_chars("a b\nc"), 3);
    }
}
