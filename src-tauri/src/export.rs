//! Bulk export of files and (recursively) directories from a CASC storage to
//! the local filesystem. Streams progress events to the UI.

use crate::{ApiError, ApiResult, AppState};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
pub struct ExportState {
    pub cancel: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportProgress {
    pub current: u32,
    pub total: u32,
    pub current_path: String,
    pub bytes_written: u64,
    pub errors: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportSummary {
    pub files_written: u32,
    pub bytes_written: u64,
    pub errors: Vec<String>,
    pub cancelled: bool,
    pub target_dir: String,
    pub elapsed_ms: u128,
}

/// Export a virtual path (file or directory) to `target_dir`.
/// For directories, the storage layout under the path is preserved
/// relative to `target_dir`.
#[tauri::command]
pub async fn export_path(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    export_state: tauri::State<'_, ExportState>,
    virtual_path: String,
    target_dir: String,
) -> ApiResult<ExportSummary> {
    // Collect work list: (storage_path, size, relative_out_path)
    let tasks: Vec<(String, u64, String)> = {
        let lock = state.opened.lock().unwrap();
        let opened = lock
            .as_ref()
            .ok_or_else(|| ApiError { message: "no storage open".into() })?;
        let mut out = Vec::new();
        // File case
        if let Some((storage_path, size)) = opened.index.resolve(&virtual_path) {
            let basename = virtual_path
                .rsplit('/')
                .next()
                .unwrap_or(&virtual_path)
                .to_string();
            out.push((storage_path, size, basename));
        } else {
            // Directory case — collect every file under the prefix.
            let prefix = if virtual_path.is_empty() {
                String::new()
            } else {
                format!("{}/", virtual_path.trim_end_matches('/'))
            };
            for (norm_path, storage_path, size) in opened.index.iter_files() {
                let rel = if prefix.is_empty() {
                    Some(norm_path.to_string())
                } else {
                    norm_path
                        .strip_prefix(&prefix)
                        .map(|s| s.to_string())
                };
                if let Some(rel) = rel {
                    out.push((storage_path.to_string(), size, rel));
                }
            }
            if out.is_empty() {
                return Err(ApiError {
                    message: format!("{virtual_path}: nothing to export"),
                });
            }
        }
        out
    };
    let total = tasks.len() as u32;

    export_state.cancel.store(false, Ordering::SeqCst);
    let cancel = export_state.cancel.clone();
    let target = PathBuf::from(&target_dir);

    let app_blocking = app.clone();
    let result = tokio::task::spawn_blocking(move || -> ExportSummary {
        let started = std::time::Instant::now();
        let mut written = 0u32;
        let mut bytes = 0u64;
        let mut errors: Vec<String> = Vec::new();

        for (i, (storage_path, _size, rel)) in tasks.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                return ExportSummary {
                    files_written: written,
                    bytes_written: bytes,
                    errors,
                    cancelled: true,
                    target_dir: target_dir.clone(),
                    elapsed_ms: started.elapsed().as_millis(),
                };
            }
            let out_path = target.join(rel);
            let result = extract_one(&app_blocking, storage_path, &out_path);
            match result {
                Ok(n) => {
                    written += 1;
                    bytes += n;
                }
                Err(e) => {
                    errors.push(format!("{rel}: {e}"));
                }
            }
            if (i as u32) % 16 == 0 || (i as u32) + 1 == total {
                let _ = app_blocking.emit(
                    "export_progress",
                    ExportProgress {
                        current: (i as u32) + 1,
                        total,
                        current_path: rel.clone(),
                        bytes_written: bytes,
                        errors: errors.len() as u32,
                    },
                );
            }
        }

        ExportSummary {
            files_written: written,
            bytes_written: bytes,
            errors,
            cancelled: false,
            target_dir: target_dir.clone(),
            elapsed_ms: started.elapsed().as_millis(),
        }
    })
    .await
    .map_err(|e| ApiError { message: format!("join: {e}") })?;

    let _ = app.emit("export_done", &result);
    Ok(result)
}

#[tauri::command]
pub fn cancel_export(state: tauri::State<'_, ExportState>) {
    state.cancel.store(true, Ordering::SeqCst);
}

fn extract_one(app: &AppHandle, storage_path: &str, out_path: &Path) -> Result<u64, String> {
    let app_state = app.state::<AppState>();
    let lock = app_state.opened.lock().unwrap();
    let opened = lock
        .as_ref()
        .ok_or_else(|| "storage closed during export".to_string())?;
    opened
        .storage
        .extract(storage_path, out_path)
        .map_err(|e| e.to_string())
}
