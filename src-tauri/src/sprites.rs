//! Tauri commands wrapping the SpA1 sprite decoder.
//!
//! Two surfaces:
//! - `decode_sprite` — render the atlas to PNG (base64) for live inline preview.
//! - `export_path_as_png` — bulk-convert .sprite files under a virtual path,
//!   reusing the export progress event pipeline.

use crate::{ApiError, ApiResult, AppState};
use base64::Engine;
use casc_core::formats::spa1;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager};

use crate::export::{ExportProgress, ExportState, ExportSummary};

#[derive(Debug, Serialize)]
pub struct SpriteImage {
    pub width: u32,
    pub height: u32,
    pub frame_count: u32,
    pub frame_width: u32,
    pub frame_height: u32,
    /// PNG-encoded atlas (base64). Empty when `error` is set.
    pub png_b64: String,
}

#[tauri::command]
pub fn decode_sprite(state: tauri::State<'_, AppState>, path: String) -> ApiResult<SpriteImage> {
    let lock = state.opened.lock().expect("opened storage lock poisoned");
    let opened = lock
        .as_ref()
        .ok_or_else(|| ApiError { message: "no storage open".into() })?;
    let (storage_path, _) = opened
        .index
        .resolve(&path)
        .ok_or_else(|| ApiError { message: format!("not in index: {path}") })?;
    let bytes = opened.storage.read(&storage_path)?;
    let sprite = spa1::decode(&bytes)
        .map_err(|e| ApiError { message: format!("decode_sprite: {e}") })?;
    let png = sprite
        .to_png()
        .map_err(|e| ApiError { message: format!("to_png: {e}") })?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
    Ok(SpriteImage {
        width: sprite.width,
        height: sprite.height,
        frame_count: sprite.frame_count,
        frame_width: sprite.frame_width(),
        frame_height: sprite.frame_height(),
        png_b64: b64,
    })
}

/// Export every `.sprite` under `virtual_path` (a file or directory) converted
/// to PNG. Non-sprite files are skipped. Same progress event pipeline as a
/// normal export.
#[tauri::command]
pub async fn export_path_as_png(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    export_state: tauri::State<'_, ExportState>,
    virtual_path: String,
    target_dir: String,
) -> ApiResult<ExportSummary> {
    let tasks: Vec<(String, String)> = {
        let lock = state.opened.lock().expect("opened storage lock poisoned");
        let opened = lock
            .as_ref()
            .ok_or_else(|| ApiError { message: "no storage open".into() })?;
        let mut out = Vec::new();
        if let Some((storage_path, _)) = opened.index.resolve(&virtual_path) {
            if is_sprite(&virtual_path) {
                let base = virtual_path
                    .rsplit('/')
                    .next()
                    .unwrap_or(&virtual_path)
                    .to_string();
                out.push((storage_path, replace_ext(&base, "png")));
            }
        } else {
            let prefix = if virtual_path.is_empty() {
                String::new()
            } else {
                format!("{}/", virtual_path.trim_end_matches('/'))
            };
            for (norm_path, storage_path, _size) in opened.index.iter_files() {
                if !is_sprite(norm_path) {
                    continue;
                }
                let rel = if prefix.is_empty() {
                    norm_path.to_string()
                } else if let Some(stripped) = norm_path.strip_prefix(&prefix) {
                    stripped.to_string()
                } else {
                    continue;
                };
                out.push((storage_path.to_string(), replace_ext(&rel, "png")));
            }
            if out.is_empty() {
                return Err(ApiError {
                    message: format!("{virtual_path}: no .sprite files inside"),
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
    let target_dir_clone = target_dir.clone();
    let result = tokio::task::spawn_blocking(move || -> ExportSummary {
        let started = std::time::Instant::now();
        let mut written = 0u32;
        let mut bytes = 0u64;
        let mut errors: Vec<String> = Vec::new();

        for (i, (storage_path, rel)) in tasks.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                return ExportSummary {
                    files_written: written,
                    bytes_written: bytes,
                    errors,
                    cancelled: true,
                    target_dir: target_dir_clone.clone(),
                    elapsed_ms: started.elapsed().as_millis(),
                };
            }
            let out_path = target.join(rel);
            // A malformed sprite must not abort the whole batch: catch any
            // panic from the decoder and record it as a per-file error like a
            // normal failure. The storage lock is released inside
            // `decode_and_write` before decoding, so a panic can't poison it.
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                decode_and_write(&app_blocking, storage_path, &out_path)
            }));
            match outcome {
                Ok(Ok((n_files, n_bytes))) => {
                    written += n_files;
                    bytes += n_bytes;
                }
                Ok(Err(e)) => errors.push(format!("{rel}: {e}")),
                Err(_) => errors.push(format!("{rel}: decoder panicked (skipped)")),
            }
            if (i as u32) % 8 == 0 || (i as u32) + 1 == total {
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
            target_dir: target_dir_clone.clone(),
            elapsed_ms: started.elapsed().as_millis(),
        }
    })
    .await
    .map_err(|e| ApiError { message: format!("join: {e}") })?;

    let _ = app.emit("export_done", &result);
    Ok(result)
}

fn is_sprite(path: &str) -> bool {
    path.to_ascii_lowercase().ends_with(".sprite")
}

fn replace_ext(name: &str, new_ext: &str) -> String {
    match name.rfind('.') {
        Some(i) => format!("{}.{new_ext}", &name[..i]),
        None => format!("{name}.{new_ext}"),
    }
}

/// Decode `storage_path` and write PNGs at `out_path`. Multi-frame sprites
/// split into `name_0001.png` … `name_NNNN.png`. Returns `(files, bytes)`.
fn decode_and_write(
    app: &AppHandle,
    storage_path: &str,
    out_path: &Path,
) -> Result<(u32, u64), String> {
    // Read the raw bytes under the lock, then release it *before* decoding.
    // Decoding an untrusted sprite can be slow or (despite our best efforts)
    // panic; holding the storage mutex across that would serialize the whole
    // export and, on a panic, poison the mutex for every later file.
    let bytes = {
        let app_state = app.state::<AppState>();
        let lock = app_state
            .opened
            .lock()
            .map_err(|_| "storage lock poisoned".to_string())?;
        let opened = lock
            .as_ref()
            .ok_or_else(|| "storage closed during export".to_string())?;
        opened.storage.read(storage_path).map_err(|e| e.to_string())?
    };
    let sprite = spa1::decode(&bytes).map_err(|e| e.to_string())?;
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    if sprite.frame_count <= 1 {
        let png = sprite.to_png().map_err(|e| e.to_string())?;
        std::fs::write(out_path, &png).map_err(|e| e.to_string())?;
        return Ok((1, png.len() as u64));
    }

    let mut written_bytes: u64 = 0;
    let mut files: u32 = 0;
    for i in 0..sprite.frame_count {
        let png = sprite.frame_to_png(i).map_err(|e| e.to_string())?;
        let target = with_frame_suffix(out_path, i, sprite.frame_count);
        std::fs::write(&target, &png).map_err(|e| e.to_string())?;
        written_bytes += png.len() as u64;
        files += 1;
    }
    Ok((files, written_bytes))
}

/// `ring.png` + frame 3 of 12 → `ring_0003.png`. Width of the counter scales
/// with frame_count so sorting matches frame order.
fn with_frame_suffix(out_path: &Path, frame: u32, total: u32) -> PathBuf {
    let digits = total.to_string().len();
    let stem = out_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = out_path
        .extension()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "png".to_string());
    let name = format!("{stem}_{:0width$}.{ext}", frame + 1, width = digits.max(2));
    match out_path.parent() {
        Some(p) => p.join(name),
        None => PathBuf::from(name),
    }
}
