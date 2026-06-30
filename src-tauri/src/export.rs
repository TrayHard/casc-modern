//! Bulk export of files and (recursively) directories from a CASC storage to
//! the local filesystem. Streams progress events to the UI.

use crate::{ApiError, ApiResult, AppState, Opened};
use serde::Serialize;
use std::collections::HashSet;
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

/// A unit of export work: which file to pull from the storage, its size, and
/// the path (relative to the chosen target dir) it should be written to.
type Task = (String, u64, String);

/// How a collected file's destination (relative to the chosen target dir) is
/// derived from its virtual path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Layout {
    /// Flatten the selected directory's contents directly into the target —
    /// the long-standing single-directory "Export folder…" behavior. A file
    /// yields its basename.
    Flat,
    /// Keep the selected item's own name as the leading output segment so
    /// sibling selections don't collide — the multi-select export default. A
    /// file yields its basename.
    UnderBasename,
    /// Recreate the full virtual path from the storage root under the target —
    /// mirrors the original CascView "keep full path" export, so a whole tree
    /// can be reproduced from any selection.
    FullTree,
}

/// Collect the work list for a single virtual path, laying out destinations
/// according to `layout` (see [`Layout`]).
fn collect_tasks(opened: &Opened, virtual_path: &str, layout: Layout) -> Vec<Task> {
    if let Some((storage_path, size)) = opened.index.resolve(virtual_path) {
        let rel = if layout == Layout::FullTree {
            virtual_path.to_string()
        } else {
            virtual_path
                .rsplit('/')
                .next()
                .unwrap_or(virtual_path)
                .to_string()
        };
        return vec![(storage_path, size, rel)];
    }

    // Directory case — collect every file under the prefix.
    let trimmed = virtual_path.trim_end_matches('/');
    let prefix = if trimmed.is_empty() {
        String::new()
    } else {
        format!("{trimmed}/")
    };
    let dir_name = trimmed.rsplit('/').next().unwrap_or(trimmed).to_string();

    let mut out = Vec::new();
    for (norm_path, storage_path, size, _avail) in opened.index.iter_files() {
        // Files outside the selected prefix don't belong to this selection.
        if !prefix.is_empty() && !norm_path.starts_with(prefix.as_str()) {
            continue;
        }
        let rel = match layout {
            Layout::FullTree => norm_path.to_string(),
            Layout::Flat | Layout::UnderBasename => {
                let stripped = norm_path.strip_prefix(&prefix).unwrap_or(norm_path);
                if layout == Layout::UnderBasename && !dir_name.is_empty() {
                    format!("{dir_name}/{stripped}")
                } else {
                    stripped.to_string()
                }
            }
        };
        out.push((storage_path.to_string(), size, rel));
    }
    out
}

/// Export a virtual path (file or directory) to `target_dir`.
///
/// With `keep_full_path` the file's complete virtual path from the storage
/// root is recreated under `target_dir` (the original CascView behavior);
/// otherwise a directory's contents are flattened directly into `target_dir`
/// and a file keeps only its basename.
#[tauri::command]
pub async fn export_path(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    export_state: tauri::State<'_, ExportState>,
    virtual_path: String,
    target_dir: String,
    keep_full_path: bool,
) -> ApiResult<ExportSummary> {
    let layout = if keep_full_path {
        Layout::FullTree
    } else {
        Layout::Flat
    };
    let tasks = {
        let lock = state.opened.lock().expect("opened storage lock poisoned");
        let opened = lock.as_ref().ok_or_else(|| ApiError {
            message: "no storage open".into(),
        })?;
        let tasks = collect_tasks(opened, &virtual_path, layout);
        if tasks.is_empty() {
            return Err(ApiError {
                message: format!("{virtual_path}: nothing to export"),
            });
        }
        tasks
    };

    run_export(app, export_state.cancel.clone(), tasks, target_dir).await
}

/// Export an explicit list of virtual paths (files and/or directories) to
/// `target_dir` — backs the directory view's multi-select export. By default
/// files keep their basename and directories keep their own name as the
/// leading output segment; with `keep_full_path` every file's complete virtual
/// path from the storage root is recreated instead. Duplicate destinations
/// (e.g. a file selected alongside its parent folder) are written only once.
#[tauri::command]
pub async fn export_paths(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    export_state: tauri::State<'_, ExportState>,
    paths: Vec<String>,
    target_dir: String,
    keep_full_path: bool,
) -> ApiResult<ExportSummary> {
    let layout = if keep_full_path {
        Layout::FullTree
    } else {
        Layout::UnderBasename
    };
    let tasks = {
        let lock = state.opened.lock().expect("opened storage lock poisoned");
        let opened = lock.as_ref().ok_or_else(|| ApiError {
            message: "no storage open".into(),
        })?;
        let mut out: Vec<Task> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        for p in &paths {
            for task in collect_tasks(opened, p, layout) {
                if seen.insert(task.2.clone()) {
                    out.push(task);
                }
            }
        }
        if out.is_empty() {
            return Err(ApiError {
                message: "nothing to export".into(),
            });
        }
        out
    };

    run_export(app, export_state.cancel.clone(), tasks, target_dir).await
}

/// Run a prepared task list on a blocking thread, streaming `export_progress`
/// events and emitting `export_done` when finished. Shared by every export
/// entry point.
async fn run_export(
    app: AppHandle,
    cancel: Arc<AtomicBool>,
    tasks: Vec<Task>,
    target_dir: String,
) -> ApiResult<ExportSummary> {
    let total = tasks.len() as u32;
    cancel.store(false, Ordering::SeqCst);
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
            if (i as u32).is_multiple_of(16) || (i as u32) + 1 == total {
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
    .map_err(|e| ApiError {
        message: format!("join: {e}"),
    })?;

    let _ = app.emit("export_done", &result);
    Ok(result)
}

#[tauri::command]
pub fn cancel_export(state: tauri::State<'_, ExportState>) {
    state.cancel.store(true, Ordering::SeqCst);
}

fn extract_one(app: &AppHandle, storage_path: &str, out_path: &Path) -> Result<u64, String> {
    let app_state = app.state::<AppState>();
    let lock = app_state
        .opened
        .lock()
        .expect("opened storage lock poisoned");
    let opened = lock
        .as_ref()
        .ok_or_else(|| "storage closed during export".to_string())?;
    opened
        .storage
        .extract(storage_path, out_path)
        .map_err(|e| e.to_string())
}
