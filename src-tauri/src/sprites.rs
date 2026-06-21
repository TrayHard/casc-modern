//! Tauri commands wrapping the SpA1 sprite decoder.
//!
//! Two surfaces:
//! - `decode_sprite` — render the atlas to PNG (base64) for live inline preview.
//! - `export_path_as_png` — bulk-convert .sprite files under a virtual path,
//!   reusing the export progress event pipeline.

use crate::{ApiError, ApiResult, AppState};
use base64::Engine;
use casc_core::formats::{dc6, spa1};
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
pub async fn decode_sprite(app: AppHandle, path: String) -> ApiResult<SpriteImage> {
    // Decode + PNG-encode are CPU-heavy (big atlases take seconds): run on a
    // blocking thread so the UI event loop stays responsive.
    tokio::task::spawn_blocking(move || -> ApiResult<SpriteImage> {
        let state = app.state::<AppState>();
        let bytes = read_indexed(&state, &path)?;
        let sprite = spa1::decode(&bytes).map_err(|e| ApiError {
            message: format!("decode_sprite: {e}"),
        })?;
        let png = sprite.to_png().map_err(|e| ApiError {
            message: format!("to_png: {e}"),
        })?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
        Ok(SpriteImage {
            width: sprite.width,
            height: sprite.height,
            frame_count: sprite.frame_count,
            frame_width: sprite.frame_width(),
            frame_height: sprite.frame_height(),
            png_b64: b64,
        })
    })
    .await
    .map_err(|e| ApiError {
        message: format!("join: {e}"),
    })?
}

/// Read an indexed file's bytes, holding the storage lock only for the read.
fn read_indexed(state: &AppState, path: &str) -> ApiResult<Vec<u8>> {
    let lock = state.opened.lock().expect("opened storage lock poisoned");
    let opened = lock.as_ref().ok_or_else(|| ApiError {
        message: "no storage open".into(),
    })?;
    let (storage_path, _) = opened.index.resolve(path).ok_or_else(|| ApiError {
        message: format!("not in index: {path}"),
    })?;
    Ok(opened.storage.read(&storage_path)?)
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
        let opened = lock.as_ref().ok_or_else(|| ApiError {
            message: "no storage open".into(),
        })?;
        let mut out = Vec::new();
        if let Some((storage_path, _)) = opened.index.resolve(&virtual_path) {
            if is_sprite(&virtual_path) || is_dc6(&virtual_path) {
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
            for (norm_path, storage_path, _size, _avail) in opened.index.iter_files() {
                if !is_sprite(norm_path) && !is_dc6(norm_path) {
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
                    message: format!(
                        "{virtual_path}: no exportable graphics (.sprite/.dc6) inside"
                    ),
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
            if (i as u32).is_multiple_of(8) || (i as u32) + 1 == total {
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
    .map_err(|e| ApiError {
        message: format!("join: {e}"),
    })?;

    let _ = app.emit("export_done", &result);
    Ok(result)
}

/// Refuse to inline-preview images above this many pixels (PNG-encode + base64
/// over IPC gets too heavy); the user can still export them.
const MAX_IMAGE_PIXELS: u64 = 8192 * 8192;

#[derive(Debug, Serialize)]
pub struct Dc6FrameImage {
    pub width: u32,
    pub height: u32,
    pub offset_x: i32,
    pub offset_y: i32,
    /// PNG-encoded frame (base64).
    pub png_b64: String,
}

#[derive(Debug, Serialize)]
pub struct Dc6Image {
    pub directions: u32,
    pub frames_per_dir: u32,
    pub frame_count: u32,
    pub frames: Vec<Dc6FrameImage>,
}

/// Canonical default palette ("units"); the frontend can pass another.
const DEFAULT_DC6_PALETTE: &str = "data/data/global/palette/units/pal.dat";

/// Decode a classic `.dc6` (indexed) to per-frame PNGs, applying a palette.
#[tauri::command]
pub async fn decode_dc6(
    app: AppHandle,
    path: String,
    palette: Option<String>,
) -> ApiResult<Dc6Image> {
    tokio::task::spawn_blocking(move || -> ApiResult<Dc6Image> {
        let state = app.state::<AppState>();
        let bytes = read_indexed(&state, &path)?;
        let pal_path = palette.as_deref().unwrap_or(DEFAULT_DC6_PALETTE);
        let pal = dc6_palette(&state, pal_path);
        let decoded = dc6::decode(&bytes).map_err(|e| ApiError {
            message: format!("decode_dc6: {e}"),
        })?;
        let mut frames = Vec::with_capacity(decoded.frames.len());
        for f in &decoded.frames {
            if (f.width as u64) * (f.height as u64) > MAX_IMAGE_PIXELS {
                return Err(ApiError {
                    message: format!("dc6 frame is {}×{} — too large", f.width, f.height),
                });
            }
            let rgba = dc6::to_rgba(f, &pal);
            let png_b64 =
                rgba_to_png_b64(f.width, f.height, rgba).map_err(|e| ApiError { message: e })?;
            frames.push(Dc6FrameImage {
                width: f.width,
                height: f.height,
                offset_x: f.offset_x,
                offset_y: f.offset_y,
                png_b64,
            });
        }
        Ok(Dc6Image {
            directions: decoded.directions,
            frames_per_dir: decoded.frames_per_dir,
            frame_count: frames.len() as u32,
            frames,
        })
    })
    .await
    .map_err(|e| ApiError {
        message: format!("join: {e}"),
    })?
}

#[derive(Debug, Serialize)]
pub struct RasterImage {
    pub width: u32,
    pub height: u32,
    /// PNG-encoded image (base64).
    pub png_b64: String,
}

/// Decode a standard raster image (.tga, .bmp, .png, .jpg) to PNG for inline
/// display. Content-sniff first; fall back to the extension because TGA has no
/// magic bytes.
#[tauri::command]
pub async fn decode_image(app: AppHandle, path: String) -> ApiResult<RasterImage> {
    tokio::task::spawn_blocking(move || -> ApiResult<RasterImage> {
        let state = app.state::<AppState>();
        let bytes = read_indexed(&state, &path)?;
        let (rgba, width, height) = decode_to_rgba(&path, &bytes).map_err(|e| ApiError {
            message: format!("decode_image: {e}"),
        })?;
        if (width as u64) * (height as u64) > MAX_IMAGE_PIXELS {
            return Err(ApiError {
                message: format!(
                    "image is {width}×{height} — too large to preview inline; export it instead"
                ),
            });
        }
        let png_b64 = rgba_to_png_b64(width, height, rgba).map_err(|e| ApiError { message: e })?;
        Ok(RasterImage {
            width,
            height,
            png_b64,
        })
    })
    .await
    .map_err(|e| ApiError {
        message: format!("join: {e}"),
    })?
}

/// Decode a raster image to raw RGBA8 + dimensions via the `image` crate —
/// content-sniff first, then by extension since TGA has no magic bytes.
fn decode_to_rgba(path: &str, bytes: &[u8]) -> Result<(Vec<u8>, u32, u32), String> {
    let img = match image::load_from_memory(bytes) {
        Ok(i) => i,
        Err(_) => {
            let ext = path.rsplit('.').next().unwrap_or("");
            let fmt = image::ImageFormat::from_extension(ext)
                .ok_or_else(|| format!("unsupported image format: .{ext}"))?;
            image::load_from_memory_with_format(bytes, fmt).map_err(|e| format!("decode: {e}"))?
        }
    };
    let rgba = img.to_rgba8();
    let (w, h) = (rgba.width(), rgba.height());
    Ok((rgba.into_raw(), w, h))
}

/// Encode raw RGBA8 to a PNG byte vector.
fn rgba_to_png(width: u32, height: u32, rgba: Vec<u8>) -> Result<Vec<u8>, String> {
    let buf = image::RgbaImage::from_raw(width, height, rgba)
        .ok_or_else(|| "invalid rgba buffer".to_string())?;
    let mut png: Vec<u8> = Vec::new();
    buf.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| format!("png encode: {e}"))?;
    Ok(png)
}

/// Encode raw RGBA8 to a base64 PNG.
fn rgba_to_png_b64(width: u32, height: u32, rgba: Vec<u8>) -> Result<String, String> {
    Ok(base64::engine::general_purpose::STANDARD.encode(rgba_to_png(width, height, rgba)?))
}

/// Load a DC6 `.dat` palette from the storage, falling back to grayscale.
fn dc6_palette(state: &AppState, pal_path: &str) -> [u8; 768] {
    match read_indexed(state, pal_path) {
        Ok(p) => dc6::parse_dat_palette(&p).unwrap_or_else(|_| dc6::grayscale_palette()),
        Err(_) => dc6::grayscale_palette(),
    }
}

/// Decode a small thumbnail (≤ `max` px on the long side) for tree previews:
/// the first frame of a sprite, or a downscaled raster image. Returns a PNG
/// base64 string. The frontend gates this by file size so we never decode a
/// huge atlas just to shrink it.
#[tauri::command]
pub async fn thumbnail(app: AppHandle, path: String, max: u32) -> ApiResult<String> {
    tokio::task::spawn_blocking(move || -> ApiResult<String> {
        let state = app.state::<AppState>();
        let bytes = read_indexed(&state, &path)?;

        let img: image::DynamicImage = if is_sprite(&path) {
            let sprite = spa1::decode(&bytes).map_err(|e| ApiError {
                message: format!("spa1: {e}"),
            })?;
            let png = if sprite.frame_count > 1 {
                sprite.frame_to_png(0)
            } else {
                sprite.to_png()
            }
            .map_err(|e| ApiError {
                message: format!("frame: {e}"),
            })?;
            image::load_from_memory_with_format(&png, image::ImageFormat::Png).map_err(|e| {
                ApiError {
                    message: format!("reload: {e}"),
                }
            })?
        } else if is_dc6(&path) {
            let pal = dc6_palette(&state, DEFAULT_DC6_PALETTE);
            let d = dc6::decode(&bytes).map_err(|e| ApiError {
                message: format!("dc6: {e}"),
            })?;
            let f = d.frames.first().ok_or_else(|| ApiError {
                message: "dc6: no frames".into(),
            })?;
            image::DynamicImage::ImageRgba8(
                image::RgbaImage::from_raw(f.width, f.height, dc6::to_rgba(f, &pal)).ok_or_else(
                    || ApiError {
                        message: "dc6: bad frame".into(),
                    },
                )?,
            )
        } else {
            let (rgba, w, h) = decode_to_rgba(&path, &bytes).map_err(|e| ApiError {
                message: format!("thumbnail: {e}"),
            })?;
            image::DynamicImage::ImageRgba8(image::RgbaImage::from_raw(w, h, rgba).ok_or_else(
                || ApiError {
                    message: "invalid rgba buffer".into(),
                },
            )?)
        };

        let thumb = img.thumbnail(max, max);
        let mut png: Vec<u8> = Vec::new();
        thumb
            .to_rgba8()
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .map_err(|e| ApiError {
                message: format!("png: {e}"),
            })?;
        Ok(base64::engine::general_purpose::STANDARD.encode(&png))
    })
    .await
    .map_err(|e| ApiError {
        message: format!("join: {e}"),
    })?
}

fn is_sprite(path: &str) -> bool {
    path.to_ascii_lowercase().ends_with(".sprite")
}

fn is_dc6(path: &str) -> bool {
    path.to_ascii_lowercase().ends_with(".dc6")
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
        opened
            .storage
            .read(storage_path)
            .map_err(|e| e.to_string())?
    };
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    if is_dc6(storage_path) {
        let pal = dc6_palette(&app.state::<AppState>(), DEFAULT_DC6_PALETTE);
        let d = dc6::decode(&bytes).map_err(|e| e.to_string())?;
        if d.frames.is_empty() {
            return Err("dc6: no frames".to_string());
        }
        if d.frames.len() <= 1 {
            let f = &d.frames[0];
            let png = rgba_to_png(f.width, f.height, dc6::to_rgba(f, &pal))?;
            std::fs::write(out_path, &png).map_err(|e| e.to_string())?;
            return Ok((1, png.len() as u64));
        }
        let total = d.frames.len() as u32;
        let mut written_bytes: u64 = 0;
        let mut files: u32 = 0;
        for (i, f) in d.frames.iter().enumerate() {
            let png = rgba_to_png(f.width, f.height, dc6::to_rgba(f, &pal))?;
            let target = with_frame_suffix(out_path, i as u32, total);
            std::fs::write(&target, &png).map_err(|e| e.to_string())?;
            written_bytes += png.len() as u64;
            files += 1;
        }
        return Ok((files, written_bytes));
    }

    let sprite = spa1::decode(&bytes).map_err(|e| e.to_string())?;
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
