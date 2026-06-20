mod export;
mod search;
mod settings;
mod sprites;

use casc_core::{FileIndex, FileKind, IndexEntry, Storage, StorageInfo};
use serde::Serialize;
use settings::{Bookmark, Settings, SettingsState};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

pub struct Opened {
    pub storage: Storage,
    pub index: FileIndex,
}

#[derive(Default)]
pub struct AppState {
    pub opened: Mutex<Option<Opened>>,
}

#[derive(Debug, Serialize)]
pub struct ApiError {
    pub message: String,
}

impl From<casc_core::CascError> for ApiError {
    fn from(e: casc_core::CascError) -> Self {
        Self { message: e.to_string() }
    }
}

pub type ApiResult<T> = std::result::Result<T, ApiError>;

#[derive(Debug, Serialize)]
struct OpenResult {
    info: StorageInfo,
    indexed_dirs: usize,
    indexed_files: usize,
}

#[tauri::command]
async fn open_storage(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    settings_state: tauri::State<'_, SettingsState>,
    path: String,
) -> ApiResult<OpenResult> {
    // Build can be slow (200ms+) on huge storages — push to a blocking thread
    // so the UI thread stays responsive.
    let path_clone = path.clone();
    let result = tokio::task::spawn_blocking(move || -> ApiResult<(Storage, FileIndex, StorageInfo)> {
        let storage = Storage::open(PathBuf::from(&path_clone))?;
        let info = storage.info()?;
        let index = storage.build_index()?;
        Ok((storage, index, info))
    })
    .await
    .map_err(|e| ApiError { message: format!("join error: {e}") })??;

    let (storage, index, info) = result;
    let indexed_dirs = index.dir_count();
    let indexed_files = index.file_count();
    *state.opened.lock().expect("opened storage lock poisoned") = Some(Opened { storage, index });

    // Record success in settings — last_storage_path + recents.
    {
        let mut s = settings_state.0.lock().expect("settings lock poisoned");
        s.touch_recent(&path);
        let _ = s.save(&app);
    }

    Ok(OpenResult { info, indexed_dirs, indexed_files })
}

#[tauri::command]
fn close_storage(state: tauri::State<'_, AppState>) {
    *state.opened.lock().expect("opened storage lock poisoned") = None;
}

#[tauri::command]
fn list_dir(state: tauri::State<'_, AppState>, path: String) -> ApiResult<Vec<IndexEntry>> {
    let lock = state.opened.lock().expect("opened storage lock poisoned");
    let opened = lock
        .as_ref()
        .ok_or_else(|| ApiError { message: "no storage open".into() })?;
    Ok(opened.index.list(&path))
}

#[derive(Debug, Serialize)]
struct FilePreview {
    path: String,
    size: u64,
    kind: FileKind,
    /// First `bytes.len()` bytes of the file (≤ requested `max_bytes`).
    bytes: Vec<u8>,
    truncated: bool,
}

#[tauri::command]
fn read_file_preview(
    state: tauri::State<'_, AppState>,
    path: String,
    max_bytes: u32,
) -> ApiResult<FilePreview> {
    let lock = state.opened.lock().expect("opened storage lock poisoned");
    let opened = lock
        .as_ref()
        .ok_or_else(|| ApiError { message: "no storage open".into() })?;
    let (storage_path, size) = opened
        .index
        .resolve(&path)
        .ok_or_else(|| ApiError { message: format!("not in index: {path}") })?;
    let bytes = opened.storage.read_n(&storage_path, max_bytes as usize)?;
    let kind = FileKind::sniff(&path, &bytes);
    let truncated = (bytes.len() as u64) < size;
    Ok(FilePreview { path, size, kind, bytes, truncated })
}

#[derive(Debug, Serialize)]
struct FileMeta {
    path: String,
    storage_path: String,
    size: u64,
    kind: FileKind,
}

#[tauri::command]
fn get_file_meta(state: tauri::State<'_, AppState>, path: String) -> ApiResult<FileMeta> {
    let lock = state.opened.lock().expect("opened storage lock poisoned");
    let opened = lock
        .as_ref()
        .ok_or_else(|| ApiError { message: "no storage open".into() })?;
    let (storage_path, size) = opened
        .index
        .resolve(&path)
        .ok_or_else(|| ApiError { message: format!("not in index: {path}") })?;
    // Sniff without reading content — extension-based only.
    let kind = FileKind::sniff(&path, &[]);
    Ok(FileMeta { path, storage_path, size, kind })
}

#[tauri::command]
fn get_settings(state: tauri::State<'_, SettingsState>) -> Settings {
    state.0.lock().expect("settings lock poisoned").clone()
}

/// True when the running binary lives in a typical installer-managed
/// location (Program Files, AppData\Local\Programs on Windows; /usr/bin,
/// /opt or /Applications elsewhere). Portable builds run from arbitrary
/// paths and shouldn't auto-update through msiexec — they need a
/// download-and-replace flow instead.
#[tauri::command]
fn is_installed() -> bool {
    let Ok(path) = std::env::current_exe() else {
        return false;
    };
    let s = path.to_string_lossy().to_lowercase().replace('/', "\\");
    s.contains("\\program files\\")
        || s.contains("\\program files (x86)\\")
        || s.contains("\\appdata\\local\\programs\\")
        // Unix-ish heuristics for future Linux/macOS builds.
        || s.starts_with("\\usr\\bin\\")
        || s.starts_with("\\usr\\local\\bin\\")
        || s.starts_with("\\opt\\")
        || s.starts_with("\\applications\\")
}

/// Extract a file into the OS temp directory and return its on-disk path.
/// Used by "Open externally" — frontend then opens it via the shell.
#[tauri::command]
fn extract_to_temp(state: tauri::State<'_, AppState>, path: String) -> ApiResult<String> {
    let lock = state.opened.lock().expect("opened storage lock poisoned");
    let opened = lock
        .as_ref()
        .ok_or_else(|| ApiError { message: "no storage open".into() })?;
    let (storage_path, _) = opened
        .index
        .resolve(&path)
        .ok_or_else(|| ApiError { message: format!("not in index: {path}") })?;
    let basename = path.rsplit('/').next().unwrap_or(&path);
    let dir = std::env::temp_dir().join("casc-modern");
    std::fs::create_dir_all(&dir).map_err(|e| ApiError { message: e.to_string() })?;
    let target = dir.join(basename);
    opened.storage.extract(&storage_path, &target)?;
    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
fn set_last_export_dir(
    app: tauri::AppHandle,
    state: tauri::State<'_, SettingsState>,
    dir: String,
) -> ApiResult<()> {
    let mut s = state.0.lock().expect("settings lock poisoned");
    s.last_export_dir = Some(dir);
    s.save(&app)
        .map_err(|e| ApiError { message: e.to_string() })?;
    Ok(())
}

#[tauri::command]
fn set_bookmarks(
    app: tauri::AppHandle,
    state: tauri::State<'_, SettingsState>,
    bookmarks: Vec<Bookmark>,
) -> ApiResult<()> {
    let mut s = state.0.lock().expect("settings lock poisoned");
    s.bookmarks = bookmarks;
    s.save(&app)
        .map_err(|e| ApiError { message: e.to_string() })?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let s = Settings::load(app.handle());
            app.manage(SettingsState(Mutex::new(s)));

            // WebView2 consumes Ctrl+F (find bar), Ctrl+P (print), etc. as
            // browser accelerator keys before the webview's JS sees the
            // keydown, so the app-level handler can't repurpose Ctrl+F for our
            // Search panel. Turn the accelerator keys off so those shortcuts
            // reach the frontend.
            #[cfg(windows)]
            {
                use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
                use windows::core::Interface;
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.with_webview(|webview| unsafe {
                        let controller = webview.controller();
                        if let Ok(core) = controller.CoreWebView2() {
                            if let Ok(settings) = core.Settings() {
                                if let Ok(s3) = settings.cast::<ICoreWebView2Settings3>() {
                                    let _ = s3.SetAreBrowserAcceleratorKeysEnabled(false);
                                }
                            }
                        }
                    });
                }
            }

            Ok(())
        })
        .manage(AppState::default())
        .manage(search::SearchState::default())
        .manage(export::ExportState::default())
        .invoke_handler(tauri::generate_handler![
            open_storage,
            close_storage,
            list_dir,
            read_file_preview,
            get_file_meta,
            get_settings,
            set_last_export_dir,
            set_bookmarks,
            extract_to_temp,
            is_installed,
            search::search_names,
            search::search_content,
            search::cancel_search,
            export::export_path,
            export::export_paths,
            export::cancel_export,
            sprites::decode_sprite,
            sprites::export_path_as_png,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
