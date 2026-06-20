//! Persistent user settings stored as JSON under the app data directory.
//!
//! Single source of truth for cross-launch state — last opened storage, last
//! export directory, recents list.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub last_storage_path: Option<String>,
    pub last_export_dir: Option<String>,
    /// Most-recently-opened storages, newest first, capped at 8.
    pub recent_storages: Vec<String>,
    /// User-pinned shortcuts to files/folders inside the storage.
    pub bookmarks: Vec<Bookmark>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Bookmark {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

impl Settings {
    pub fn load(app: &AppHandle) -> Self {
        match settings_file(app) {
            Ok(path) if path.exists() => std::fs::read_to_string(&path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default(),
            _ => Self::default(),
        }
    }

    pub fn save(&self, app: &AppHandle) -> std::io::Result<()> {
        let path = settings_file(app)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        std::fs::write(&path, json)
    }

    /// Promote `path` to the front of `recent_storages`, dedup, cap at 8.
    pub fn touch_recent(&mut self, path: &str) {
        self.recent_storages.retain(|p| p != path);
        self.recent_storages.insert(0, path.to_string());
        self.recent_storages.truncate(8);
        self.last_storage_path = Some(path.to_string());
    }
}

fn settings_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    Ok(dir.join("settings.json"))
}

#[derive(Default)]
pub struct SettingsState(pub Mutex<Settings>);
