use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

use chrono::Utc;
use serde::Serialize;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const LEGACY_DATA_ENV: &str = "TABKEEP_LEGACY_DATA_DIR";
const LEGACY_DATA_MARKER: &str = "legacy-backend-data-path.txt";
const MIGRATION_RECEIPT: &str = "migration-receipt.json";
const ALLOWED_ENTRIES: &[&str] = &[
    "config.json",
    "knowledge.db",
    "knowledge.db-wal",
    "knowledge.db-shm",
    "knowledge.lance",
    "models",
    "notes",
];

#[derive(Debug, PartialEq, Eq)]
pub enum MigrationOutcome {
    NoLegacySource,
    NoEligibleData,
    TargetAlreadyInitialized,
    Migrated {
        source: PathBuf,
        copied_entries: Vec<String>,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MigrationReceipt<'a> {
    migration_version: u32,
    migrated_at: String,
    source: &'a Path,
    copied_entries: &'a [String],
}

pub fn migrate_legacy_backend_data(app: &AppHandle) -> Result<MigrationOutcome, String> {
    let app_data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|err| format!("无法定位应用数据目录: {err}"))?;
    let target_data_dir = app_data_dir.join("backend").join("data");
    let source = discover_legacy_source(&app_data_dir)?;
    let Some(source) = source else {
        return Ok(MigrationOutcome::NoLegacySource);
    };

    let outcome = migrate_from_source(&source, &target_data_dir)?;
    if matches!(outcome, MigrationOutcome::Migrated { .. }) {
        let _ = fs::remove_file(app_data_dir.join(LEGACY_DATA_MARKER));
    }
    Ok(outcome)
}

fn discover_legacy_source(app_data_dir: &Path) -> Result<Option<PathBuf>, String> {
    if let Some(source) = std::env::var_os(LEGACY_DATA_ENV) {
        let source = PathBuf::from(source);
        if !source.as_os_str().is_empty() {
            return Ok(Some(source));
        }
    }

    let marker = app_data_dir.join(LEGACY_DATA_MARKER);
    if !marker.exists() {
        return Ok(None);
    }
    let source =
        fs::read_to_string(&marker).map_err(|err| format!("读取旧数据迁移标记失败: {err}"))?;
    let source = source.trim();
    if source.is_empty() {
        return Ok(None);
    }
    Ok(Some(PathBuf::from(source)))
}

fn migrate_from_source(source: &Path, target: &Path) -> Result<MigrationOutcome, String> {
    if target_has_entries(target)? {
        return Ok(MigrationOutcome::TargetAlreadyInitialized);
    }
    if !source.is_dir() {
        return Ok(MigrationOutcome::NoLegacySource);
    }

    let source = source
        .canonicalize()
        .map_err(|err| format!("无法解析旧数据目录: {err}"))?;
    if target.exists() {
        let target_canonical = target
            .canonicalize()
            .map_err(|err| format!("无法解析正式数据目录: {err}"))?;
        if source == target_canonical {
            return Ok(MigrationOutcome::TargetAlreadyInitialized);
        }
    }

    let target_parent = target
        .parent()
        .ok_or_else(|| "正式数据目录没有父目录".to_string())?;
    fs::create_dir_all(target_parent).map_err(|err| format!("创建后端数据父目录失败: {err}"))?;
    let staging = target_parent.join(format!(
        ".data-migration-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    fs::create_dir(&staging).map_err(|err| format!("创建迁移暂存目录失败: {err}"))?;

    let migration_result = (|| -> Result<Vec<String>, String> {
        let mut copied_entries = Vec::new();
        for entry_name in ALLOWED_ENTRIES {
            let from = source.join(entry_name);
            if !from.exists() {
                continue;
            }
            let to = staging.join(entry_name);
            copy_entry(&from, &to)?;
            copied_entries.push((*entry_name).to_string());
        }

        if copied_entries.is_empty() {
            return Ok(copied_entries);
        }
        validate_staging(&staging)?;
        write_receipt(&staging, &source, &copied_entries)?;
        Ok(copied_entries)
    })();

    let copied_entries = match migration_result {
        Ok(entries) if entries.is_empty() => {
            let _ = fs::remove_dir_all(&staging);
            return Ok(MigrationOutcome::NoEligibleData);
        }
        Ok(entries) => entries,
        Err(err) => {
            let _ = fs::remove_dir_all(&staging);
            return Err(err);
        }
    };

    if target.exists() {
        fs::remove_dir(target).map_err(|err| format!("移除空的正式数据目录失败: {err}"))?;
    }
    if let Err(err) = fs::rename(&staging, target) {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("启用迁移后的数据目录失败: {err}"));
    }

    Ok(MigrationOutcome::Migrated {
        source,
        copied_entries,
    })
}

fn target_has_entries(target: &Path) -> Result<bool, String> {
    if !target.exists() {
        return Ok(false);
    }
    if !target.is_dir() {
        return Err("正式后端数据路径不是目录".to_string());
    }
    target
        .read_dir()
        .map_err(|err| format!("读取正式后端数据目录失败: {err}"))?
        .next()
        .transpose()
        .map(|entry| entry.is_some())
        .map_err(|err| format!("读取正式后端数据目录失败: {err}"))
}

fn copy_entry(source: &Path, target: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source)
        .map_err(|err| format!("读取迁移项元数据失败 {}: {err}", source.display()))?;
    if metadata.file_type().is_symlink() {
        return Err(format!("迁移项不能是符号链接: {}", source.display()));
    }
    if metadata.is_file() {
        fs::copy(source, target)
            .map(|_| ())
            .map_err(|err| format!("复制迁移文件失败 {}: {err}", source.display()))
    } else if metadata.is_dir() {
        copy_directory(source, target)
    } else {
        Err(format!("迁移项类型不受支持: {}", source.display()))
    }
}

fn copy_directory(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir(target)
        .map_err(|err| format!("创建迁移目录失败 {}: {err}", target.display()))?;
    for entry in fs::read_dir(source)
        .map_err(|err| format!("读取迁移目录失败 {}: {err}", source.display()))?
    {
        let entry = entry.map_err(|err| format!("读取迁移目录项失败: {err}"))?;
        copy_entry(&entry.path(), &target.join(entry.file_name()))?;
    }
    Ok(())
}

fn validate_staging(staging: &Path) -> Result<(), String> {
    let config = staging.join("config.json");
    if config.exists() {
        let bytes = fs::read(&config).map_err(|err| format!("读取迁移配置失败: {err}"))?;
        serde_json::from_slice::<serde_json::Value>(&bytes)
            .map_err(|err| format!("旧 config.json 不是有效 JSON: {err}"))?;
    }

    let database = staging.join("knowledge.db");
    if database.exists() {
        let mut file =
            fs::File::open(&database).map_err(|err| format!("读取迁移知识库失败: {err}"))?;
        let mut header = [0_u8; 16];
        file.read_exact(&mut header)
            .map_err(|err| format!("迁移知识库文件不完整: {err}"))?;
        if &header != b"SQLite format 3\0" {
            return Err("旧 knowledge.db 不是有效 SQLite 数据库".to_string());
        }
    }
    Ok(())
}

fn write_receipt(staging: &Path, source: &Path, copied_entries: &[String]) -> Result<(), String> {
    let receipt = MigrationReceipt {
        migration_version: 1,
        migrated_at: Utc::now().to_rfc3339(),
        source,
        copied_entries,
    };
    let bytes =
        serde_json::to_vec_pretty(&receipt).map_err(|err| format!("生成迁移回执失败: {err}"))?;
    fs::write(staging.join(MIGRATION_RECEIPT), bytes)
        .map_err(|err| format!("写入迁移回执失败: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_allowed_data_and_keeps_source() {
        let root = test_directory("success");
        let source = root.join("legacy");
        let target = root.join("current").join("data");
        fs::create_dir_all(source.join("knowledge.lance")).unwrap();
        fs::create_dir_all(source.join("models")).unwrap();
        fs::write(source.join("config.json"), br#"{"apiToken":"secret"}"#).unwrap();
        write_sqlite_stub(&source.join("knowledge.db"));
        fs::write(source.join("knowledge.lance").join("manifest"), b"vector").unwrap();
        fs::write(source.join("models").join("model.onnx"), b"model").unwrap();
        fs::write(source.join("knowledge.before-test.bak"), b"backup").unwrap();

        let outcome = migrate_from_source(&source, &target).unwrap();

        assert!(matches!(outcome, MigrationOutcome::Migrated { .. }));
        assert!(source.join("config.json").exists());
        assert!(target.join("config.json").exists());
        assert!(target.join("knowledge.db").exists());
        assert!(target.join("knowledge.lance").join("manifest").exists());
        assert!(target.join("models").join("model.onnx").exists());
        assert!(target.join(MIGRATION_RECEIPT).exists());
        assert!(!target.join("knowledge.before-test.bak").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn does_not_overwrite_initialized_target() {
        let root = test_directory("initialized");
        let source = root.join("legacy");
        let target = root.join("current").join("data");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(source.join("config.json"), b"{}").unwrap();
        fs::write(target.join("config.json"), br#"{"current":true}"#).unwrap();

        let outcome = migrate_from_source(&source, &target).unwrap();

        assert_eq!(outcome, MigrationOutcome::TargetAlreadyInitialized);
        assert_eq!(
            fs::read(target.join("config.json")).unwrap(),
            br#"{"current":true}"#
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_source_rolls_back_staging() {
        let root = test_directory("rollback");
        let source = root.join("legacy");
        let target_parent = root.join("current");
        let target = target_parent.join("data");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("config.json"), b"not-json").unwrap();

        let error = migrate_from_source(&source, &target).unwrap_err();

        assert!(error.contains("不是有效 JSON"));
        assert!(!target.exists());
        let leftovers = fs::read_dir(&target_parent)
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(leftovers.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    fn write_sqlite_stub(path: &Path) {
        let mut bytes = b"SQLite format 3\0".to_vec();
        bytes.extend_from_slice(&[0_u8; 64]);
        fs::write(path, bytes).unwrap();
    }

    fn test_directory(label: &str) -> PathBuf {
        let directory =
            std::env::temp_dir().join(format!("tabkeep-migration-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        directory
    }
}
