//! Persistent user settings stored as JSON under the app data directory.
//!
//! Single source of truth for cross-launch state — last opened storage, last
//! export directory, recents list.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// Bumped whenever this struct gains a field that can't be defaulted from
/// an older settings.json. Always written; ignored on read unless we add a
/// migration step in [`Settings::load`].
pub const CURRENT_SCHEMA_VERSION: u32 = 4;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Schema version of the on-disk file. See [`CURRENT_SCHEMA_VERSION`].
    pub schema_version: u32,
    pub last_storage_path: Option<String>,
    pub last_export_dir: Option<String>,
    /// Most-recently-opened storages, newest first, capped at 8.
    pub recent_storages: Vec<String>,
    /// User-pinned shortcuts to files/folders inside the storage.
    pub bookmarks: Vec<Bookmark>,
    /// User-facing preferences (the Settings panel).
    pub preferences: Preferences,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            schema_version: CURRENT_SCHEMA_VERSION,
            last_storage_path: None,
            last_export_dir: None,
            recent_storages: Vec::new(),
            bookmarks: Vec::new(),
            preferences: Preferences::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Bookmark {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// User-facing preferences. Kept separate from the app-state fields above so the
/// settings drawer can replace them wholesale without clobbering
/// last_storage_path / bookmarks / recents.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Preferences {
    /// Files larger than this (bytes) get an "open externally" prompt in the
    /// JSON/text viewers instead of loading inline. 0 disables the prompt.
    pub json_external_threshold_bytes: u64,
    /// Decoded mini previews for image files in the tree (else format icons).
    pub thumbnails_in_tree: bool,
    /// Decoded mini previews in the directory (right-panel) list.
    pub thumbnails_in_browser: bool,
    /// Hide files/folders whose locale differs from the storage's installed one.
    pub hide_other_locales: bool,
    /// Active format-icon theme name ("default" = built-in).
    pub icon_theme: String,
    /// User-imported icon themes (opaque JSON owned by the frontend).
    pub custom_icon_themes: Vec<serde_json::Value>,
    /// Extra rows/columns rendered beyond the viewport in virtualized grids
    /// (the TSV table). Higher = fewer blanks while fast-scrolling, more work.
    pub table_overscan: u32,
    /// Hide `*.lowend.sprite` low-quality variants from the tree and the
    /// directory list (the high-quality `.sprite` stays; the viewer can still
    /// switch quality).
    pub hide_lowend: bool,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            json_external_threshold_bytes: 2 * 1024 * 1024,
            thumbnails_in_tree: true,
            thumbnails_in_browser: true,
            hide_other_locales: false,
            icon_theme: "default".to_string(),
            custom_icon_themes: Vec::new(),
            table_overscan: 16,
            hide_lowend: true,
        }
    }
}

impl Settings {
    pub fn load(app: &AppHandle) -> Self {
        let mut s: Settings = match settings_file(app) {
            Ok(path) if path.exists() => std::fs::read_to_string(&path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default(),
            _ => Self::default(),
        };
        // Version-specific migrations: force each new default only the first
        // time it's introduced, so we don't clobber later user customization.
        if s.schema_version < 3 {
            s.preferences.json_external_threshold_bytes = 2 * 1024 * 1024;
            s.preferences.table_overscan = 16;
        }
        if s.schema_version < 4 {
            s.preferences.hide_lowend = true;
        }
        s.schema_version = CURRENT_SCHEMA_VERSION;
        s
    }

    pub fn save(&self, app: &AppHandle) -> std::io::Result<()> {
        let path = settings_file(app).map_err(std::io::Error::other)?;
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
