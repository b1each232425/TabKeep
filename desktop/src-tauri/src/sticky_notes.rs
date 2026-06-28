use std::{fs, path::PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const STICKY_NOTES_FILE: &str = "sticky-notes.json";
const DEFAULT_COLOR: &str = "#fff7c2";
const MAX_TITLE_CHARS: usize = 120;
const MAX_CONTENT_CHARS: usize = 50_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StickyNote {
    pub id: String,
    pub title: String,
    pub content: String,
    pub color: String,
    pub pinned: bool,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_bounds: Option<StickyWindowBounds>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StickyWindowBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
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
    pub window_bounds: Option<StickyWindowBounds>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StickyNoteStore {
    notes: Vec<StickyNote>,
}

pub fn list_notes(app: &AppHandle) -> Result<Vec<StickyNote>, String> {
    let mut notes = read_store(app)?.notes;
    notes.sort_by(|left, right| {
        right
            .pinned
            .cmp(&left.pinned)
            .then_with(|| right.updated_at.cmp(&left.updated_at))
            .then_with(|| left.title.cmp(&right.title))
    });
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
        if let Some(note) = store.notes.iter_mut().find(|note| note.id == id) {
            note.title = title;
            note.content = content;
            note.color = color;
            note.pinned = draft.pinned.unwrap_or(note.pinned);
            if draft.window_bounds.is_some() {
                note.window_bounds = normalize_bounds(draft.window_bounds);
            }
            note.updated_at = now;
            note.clone()
        } else {
            return Err("便签不存在".to_string());
        }
    } else {
        let note = StickyNote {
            id: Uuid::new_v4().to_string(),
            title,
            content,
            color,
            pinned: draft.pinned.unwrap_or(false),
            created_at: now.clone(),
            updated_at: now,
            window_bounds: normalize_bounds(draft.window_bounds),
        };
        store.notes.push(note.clone());
        note
    };

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
            window_bounds: None,
        },
    )
}

pub fn save_window_bounds(
    app: &AppHandle,
    id: &str,
    bounds: StickyWindowBounds,
) -> Result<StickyNote, String> {
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
    let id = sanitize_id(id)?;
    let mut store = read_store(app)?;
    let original_len = store.notes.len();
    store.notes.retain(|note| note.id != id);
    if store.notes.len() == original_len {
        return Err("便签不存在".to_string());
    }
    write_store(app, &store)
}

fn read_store(app: &AppHandle) -> Result<StickyNoteStore, String> {
    let path = notes_path(app)?;
    if !path.exists() {
        return Ok(StickyNoteStore::default());
    }
    let raw = fs::read_to_string(&path).map_err(|err| format!("读取便签数据失败: {err}"))?;
    if raw.trim().is_empty() {
        return Ok(StickyNoteStore::default());
    }
    serde_json::from_str(&raw).map_err(|err| format!("解析便签数据失败: {err}"))
}

fn write_store(app: &AppHandle, store: &StickyNoteStore) -> Result<(), String> {
    let path = notes_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("创建便签数据目录失败: {err}"))?;
    }
    let raw = serde_json::to_string_pretty(store)
        .map_err(|err| format!("序列化便签数据失败: {err}"))?;
    fs::write(path, raw).map_err(|err| format!("写入便签数据失败: {err}"))
}

fn notes_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|err| format!("获取应用数据目录失败: {err}"))?
        .join(STICKY_NOTES_FILE))
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

fn normalize_bounds(bounds: Option<StickyWindowBounds>) -> Option<StickyWindowBounds> {
    bounds.map(|value| StickyWindowBounds {
        x: value.x,
        y: value.y,
        width: value.width.max(280),
        height: value.height.max(260),
    })
}

fn clamp_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}
