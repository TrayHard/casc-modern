//! Compare two independent CASC storages and preview files from either side.

use crate::{ApiError, ApiResult};
use base64::Engine;
use casc_core::formats::{
    dc6,
    encode::{encode_rgba, ImageFormat},
    spa1,
};
use casc_core::index::normalize;
use casc_core::{FileIndex, FileKind, Storage, StorageInfo};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{Emitter, Manager};

const TEXT_PREVIEW_LIMIT: usize = 1024 * 1024;
const IMAGE_FILE_LIMIT: u64 = 24 * 1024 * 1024;
const IMAGE_PIXEL_LIMIT: u64 = 8192 * 8192;

#[derive(Default)]
pub struct ComparisonState {
    current: Mutex<Option<Comparison>>,
    job: Mutex<Option<Arc<AtomicBool>>>,
}

#[derive(Clone, Serialize)]
struct CompareProgress {
    phase: &'static str,
    processed: usize,
    total: usize,
}

pub struct Comparison {
    left: Side,
    right: Side,
    changes: Vec<DiffEntry>,
    summary: DiffSummary,
}

struct Side {
    storage: Storage,
    files: HashMap<String, CompareFile>,
    info: StorageInfo,
    path: String,
}

#[derive(Clone)]
struct CompareFile {
    storage_path: String,
    size: u64,
    content_key: [u8; 16],
    encoded_key: [u8; 16],
    span_count: u32,
    local: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum DiffStatus {
    Added,
    Removed,
    Changed,
    Unverified,
}

impl DiffStatus {
    fn name(self) -> &'static str {
        match self {
            Self::Added => "added",
            Self::Removed => "removed",
            Self::Changed => "changed",
            Self::Unverified => "unverified",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct DiffEntry {
    path: String,
    status: DiffStatus,
    left_size: Option<u64>,
    right_size: Option<u64>,
    verification_error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct DiffSummary {
    added: usize,
    removed: usize,
    changed: usize,
    unverified: usize,
}

#[derive(Serialize)]
pub struct CompareResult {
    left_path: String,
    right_path: String,
    left_info: StorageInfo,
    right_info: StorageInfo,
    summary: DiffSummary,
}

#[derive(Serialize)]
pub struct DiffPage {
    entries: Vec<DiffEntry>,
    total: usize,
}

#[derive(Serialize)]
pub struct ComparePreview {
    kind: &'static str,
    size: u64,
    text: Option<String>,
    image_b64: Option<String>,
    truncated: bool,
}

fn check_cancel(cancel: &AtomicBool) -> ApiResult<()> {
    if cancel.load(Ordering::Relaxed) {
        return Err(ApiError {
            message: "comparison cancelled".into(),
        });
    }
    Ok(())
}

fn load_side(path: String, cancel: &AtomicBool) -> ApiResult<Side> {
    check_cancel(cancel)?;
    let storage = Storage::open(PathBuf::from(&path))?;
    let info = storage.info()?;
    let mut index = FileIndex::default();
    let mut files = HashMap::new();
    storage.walk(|entry| {
        if cancel.load(Ordering::Relaxed) {
            return false;
        }
        let virtual_path = normalize(&entry.full_path).to_ascii_lowercase();
        index.add(
            entry.full_path.clone(),
            entry.size,
            entry.available,
            entry.locale_flags,
        );
        files.insert(
            virtual_path,
            CompareFile {
                storage_path: entry.full_path,
                size: entry.size,
                content_key: entry.content_key,
                encoded_key: entry.encoded_key,
                span_count: entry.span_count,
                local: entry.available,
            },
        );
        true
    })?;
    check_cancel(cancel)?;
    index.finalize();
    files.retain(|_, file| index.resolve(&normalize(&file.storage_path)).is_some());
    Ok(Side {
        storage,
        files,
        info,
        path,
    })
}

fn has_key(key: &[u8; 16]) -> bool {
    key.iter().any(|byte| *byte != 0)
}

// CascLib can report encoded sizes when content sizes are unavailable. Only
// keys or decoded bytes establish equality, never the enumerated file size.
fn changed_status(
    a: &CompareFile,
    b: &CompareFile,
    compare_bytes: impl FnOnce() -> casc_core::Result<bool>,
) -> Option<DiffStatus> {
    let single_span = a.span_count == 1 && b.span_count == 1;
    if single_span && has_key(&a.content_key) && has_key(&b.content_key) {
        return (a.content_key != b.content_key).then_some(DiffStatus::Changed);
    }
    // TVFS uses the first 9 bytes as the encoded content identity. Static
    // storages put the archive location in bytes 9..16 (CascRootFile_TVFS.cpp),
    // so those trailing bytes are not comparable across storage layouts.
    // A multi-span file needs every span checked, not just the first key.
    if single_span
        && a.encoded_key[..9].iter().any(|byte| *byte != 0)
        && a.encoded_key[..9] == b.encoded_key[..9]
    {
        return None;
    }
    match compare_bytes() {
        Ok(true) => None,
        Ok(false) => Some(DiffStatus::Changed),
        Err(_) => Some(DiffStatus::Unverified),
    }
}

fn build_comparison(
    left_path: String,
    right_path: String,
    mut progress: impl FnMut(CompareProgress),
    cancel: &AtomicBool,
) -> ApiResult<Comparison> {
    progress(CompareProgress {
        phase: "Opening left storage",
        processed: 0,
        total: 0,
    });
    let left = load_side(left_path, cancel)?;
    check_cancel(cancel)?;
    progress(CompareProgress {
        phase: "Opening right storage",
        processed: 0,
        total: 0,
    });
    let right = load_side(right_path, cancel)?;
    let mut paths: Vec<String> = left
        .files
        .keys()
        .chain(right.files.keys())
        .cloned()
        .collect();
    paths.sort_unstable();
    paths.dedup();
    let mut changes = Vec::new();
    let mut summary = DiffSummary::default();
    let total = paths.len();
    for (processed, path) in paths.into_iter().enumerate() {
        check_cancel(cancel)?;
        if processed % 500 == 0 {
            progress(CompareProgress {
                phase: "Comparing files",
                processed,
                total,
            });
        }
        let a = left.files.get(&path);
        let b = right.files.get(&path);
        let mut verification_error = None;
        let status = match (a, b) {
            (Some(a), Some(b)) => changed_status(a, b, || {
                let result = left.storage.same_content_cancellable(
                    &a.storage_path,
                    &right.storage,
                    &b.storage_path,
                    || cancel.load(Ordering::Relaxed),
                );
                if let Err(error) = &result {
                    verification_error = Some(match (a.local, b.local) {
                        (false, false) => {
                            "File data is not installed locally in either version.".into()
                        }
                        (false, true) => {
                            "File data is not installed locally in the left version.".into()
                        }
                        (true, false) => {
                            "File data is not installed locally in the right version.".into()
                        }
                        (true, true) => error.to_string(),
                    });
                }
                result
            }),
            (Some(_), None) => Some(DiffStatus::Removed),
            (None, Some(_)) => Some(DiffStatus::Added),
            (None, None) => None,
        };
        let Some(status) = status else { continue };
        match status {
            DiffStatus::Added => summary.added += 1,
            DiffStatus::Removed => summary.removed += 1,
            DiffStatus::Changed => summary.changed += 1,
            DiffStatus::Unverified => summary.unverified += 1,
        }
        changes.push(DiffEntry {
            path,
            status,
            left_size: a.map(|file| file.size),
            right_size: b.map(|file| file.size),
            verification_error,
        });
    }
    check_cancel(cancel)?;
    progress(CompareProgress {
        phase: "Comparing files",
        processed: total,
        total,
    });
    Ok(Comparison {
        left,
        right,
        changes,
        summary,
    })
}

#[tauri::command]
pub async fn compare_storages(
    app: tauri::AppHandle,
    state: tauri::State<'_, ComparisonState>,
    left_path: String,
    right_path: String,
) -> ApiResult<CompareResult> {
    if left_path.trim().is_empty() || right_path.trim().is_empty() {
        return Err(ApiError {
            message: "select both storage folders".into(),
        });
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut job = state.job.lock().expect("comparison job lock poisoned");
        if job.is_some() {
            return Err(ApiError {
                message: "a comparison is already running".into(),
            });
        }
        *job = Some(cancel.clone());
    }
    tokio::task::spawn_blocking(move || {
        let state = app.state::<ComparisonState>();
        // Release the busy state even if a decoder or CascLib wrapper panics.
        struct JobGuard<'a>(&'a ComparisonState);
        impl Drop for JobGuard<'_> {
            fn drop(&mut self) {
                *self.0.job.lock().expect("comparison job lock poisoned") = None;
            }
        }
        let _guard = JobGuard(&state);
        let comparison = build_comparison(
            left_path,
            right_path,
            |progress| {
                let _ = app.emit("compare_progress", progress);
            },
            &cancel,
        )?;
        let result = CompareResult {
            left_path: comparison.left.path.clone(),
            right_path: comparison.right.path.clone(),
            left_info: comparison.left.info.clone(),
            right_info: comparison.right.info.clone(),
            summary: comparison.summary.clone(),
        };
        // Share the job lock with close_comparison so closing cannot race with
        // publication and leave an invisible comparison holding both storages.
        let _job = state.job.lock().expect("comparison job lock poisoned");
        check_cancel(&cancel)?;
        *state.current.lock().expect("comparison lock poisoned") = Some(comparison);
        Ok(result)
    })
    .await
    .map_err(|e| ApiError {
        message: format!("join error: {e}"),
    })?
}

#[tauri::command]
pub async fn compare_page(
    app: tauri::AppHandle,
    query: String,
    status: String,
    offset: usize,
    limit: usize,
) -> ApiResult<DiffPage> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<ComparisonState>();
        let lock = state.current.lock().expect("comparison lock poisoned");
        let comparison = lock.as_ref().ok_or_else(|| ApiError {
            message: "no comparison open".into(),
        })?;
        Ok(filter_page(
            &comparison.changes,
            &query,
            &status,
            offset,
            limit,
        ))
    })
    .await
    .map_err(|e| ApiError {
        message: format!("join error: {e}"),
    })?
}

fn filter_page(
    changes: &[DiffEntry],
    query: &str,
    status: &str,
    offset: usize,
    limit: usize,
) -> DiffPage {
    let query = query.trim().to_ascii_lowercase();
    let matches = changes.iter().filter(|entry| {
        (status == "all" || entry.status.name() == status)
            && (query.is_empty() || entry.path.to_ascii_lowercase().contains(&query))
    });
    let mut total = 0;
    let mut entries = Vec::new();
    for entry in matches {
        if total >= offset && entries.len() < limit.min(500) {
            entries.push(entry.clone());
        }
        total += 1;
    }
    DiffPage { entries, total }
}

fn preview(side: &Side, path: &str) -> ApiResult<ComparePreview> {
    let file = side.files.get(path).ok_or_else(|| ApiError {
        message: format!("file is absent on this side: {path}"),
    })?;
    let lower = path.to_ascii_lowercase();
    let is_image = [".sprite", ".dc6", ".png", ".jpg", ".jpeg", ".bmp", ".tga"]
        .iter()
        .any(|ext| lower.ends_with(ext));
    if is_image && file.size <= IMAGE_FILE_LIMIT {
        let bytes = side
            .storage
            .read_n(&file.storage_path, IMAGE_FILE_LIMIT as usize + 1)?;
        if bytes.len() as u64 > IMAGE_FILE_LIMIT {
            return notice(file.size, "Image is too large for an inline preview.");
        }
        let png = if lower.ends_with(".sprite") {
            let sprite = spa1::decode(&bytes)?;
            if (sprite.frame_width() as u64) * (sprite.frame_height() as u64) > IMAGE_PIXEL_LIMIT {
                return notice(file.size, "Image is too large for an inline preview.");
            }
            sprite.frame_to_png(0)?
        } else if lower.ends_with(".dc6") {
            let dc6 = dc6::decode(&bytes)?;
            let frame = dc6.frames.first().ok_or_else(|| ApiError {
                message: "DC6 has no frames".into(),
            })?;
            if (frame.width as u64) * (frame.height as u64) > IMAGE_PIXEL_LIMIT {
                return notice(file.size, "Image is too large for an inline preview.");
            }
            let palette = side
                .files
                .get("data/data/global/palette/units/pal.dat")
                .and_then(|palette_file| side.storage.read(&palette_file.storage_path).ok())
                .and_then(|bytes| dc6::parse_dat_palette(&bytes).ok())
                .unwrap_or_else(dc6::grayscale_palette);
            encode_rgba(
                frame.width,
                frame.height,
                &dc6::to_rgba(frame, &palette),
                ImageFormat::Png,
                100,
            )?
        } else {
            let (width, height) = image::ImageReader::new(std::io::Cursor::new(&bytes))
                .with_guessed_format()
                .map_err(|e| ApiError {
                    message: e.to_string(),
                })?
                .into_dimensions()
                .map_err(|e| ApiError {
                    message: e.to_string(),
                })?;
            if (width as u64) * (height as u64) > IMAGE_PIXEL_LIMIT {
                return notice(file.size, "Image is too large for an inline preview.");
            }
            let image = image::load_from_memory(&bytes).map_err(|e| ApiError {
                message: e.to_string(),
            })?;
            if (image.width() as u64) * (image.height() as u64) > IMAGE_PIXEL_LIMIT {
                return notice(file.size, "Image is too large for an inline preview.");
            }
            let mut png = Vec::new();
            image
                .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
                .map_err(|e| ApiError {
                    message: e.to_string(),
                })?;
            png
        };
        return Ok(ComparePreview {
            kind: "image",
            size: file.size,
            text: None,
            image_b64: Some(base64::engine::general_purpose::STANDARD.encode(png)),
            truncated: false,
        });
    }
    if is_image {
        return notice(file.size, "Image is too large for an inline preview.");
    }
    let mut bytes = side
        .storage
        .read_n(&file.storage_path, TEXT_PREVIEW_LIMIT + 1)?;
    let truncated = bytes.len() > TEXT_PREVIEW_LIMIT;
    bytes.truncate(TEXT_PREVIEW_LIMIT);
    let kind = FileKind::sniff(path, &bytes);
    if kind == FileKind::Text {
        let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
        return Ok(ComparePreview {
            kind: "text",
            size: file.size,
            text: Some(String::from_utf8_lossy(body).into_owned()),
            image_b64: None,
            truncated,
        });
    }
    let mut hex = String::new();
    for (row, chunk) in bytes[..bytes.len().min(512)].chunks(16).enumerate() {
        use std::fmt::Write;
        let _ = write!(hex, "{:08x}  ", row * 16);
        for byte in chunk {
            let _ = write!(hex, "{byte:02x} ");
        }
        hex.push('\n');
    }
    Ok(ComparePreview {
        kind: "hex",
        size: file.size,
        text: Some(hex),
        image_b64: None,
        truncated: truncated || bytes.len() > 512,
    })
}

fn notice(size: u64, text: &str) -> ApiResult<ComparePreview> {
    Ok(ComparePreview {
        kind: "notice",
        size,
        text: Some(text.into()),
        image_b64: None,
        truncated: false,
    })
}

#[tauri::command]
pub async fn compare_preview(
    app: tauri::AppHandle,
    side: String,
    path: String,
) -> ApiResult<ComparePreview> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<ComparisonState>();
        let lock = state.current.lock().expect("comparison lock poisoned");
        let comparison = lock.as_ref().ok_or_else(|| ApiError {
            message: "no comparison open".into(),
        })?;
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match side.as_str() {
            "left" => preview(&comparison.left, &path),
            "right" => preview(&comparison.right, &path),
            _ => Err(ApiError {
                message: "invalid comparison side".into(),
            }),
        }))
        .unwrap_or_else(|_| {
            Err(ApiError {
                message: "image decoder could not preview this file".into(),
            })
        })
    })
    .await
    .map_err(|e| ApiError {
        message: format!("join error: {e}"),
    })?
}

#[tauri::command]
pub async fn close_comparison(app: tauri::AppHandle) -> ApiResult<()> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<ComparisonState>();
        let job = state.job.lock().expect("comparison job lock poisoned");
        if let Some(cancel) = job.as_ref() {
            cancel.store(true, Ordering::Relaxed);
        }
        *state.current.lock().expect("comparison lock poisoned") = None;
    })
    .await
    .map_err(|e| ApiError {
        message: format!("join error: {e}"),
    })
}

#[tauri::command]
pub async fn cancel_comparison(state: tauri::State<'_, ComparisonState>) -> ApiResult<()> {
    if let Some(cancel) = state
        .job
        .lock()
        .expect("comparison job lock poisoned")
        .as_ref()
    {
        cancel.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_key_is_not_treated_as_a_matching_content_key() {
        assert!(!has_key(&[0; 16]));
        assert!(has_key(&[1; 16]));
    }

    fn file(content: u8, encoded: u8, size: u64) -> CompareFile {
        CompareFile {
            storage_path: "data:test".into(),
            size,
            content_key: [content; 16],
            encoded_key: [encoded; 16],
            span_count: 1,
            local: true,
        }
    }

    #[test]
    fn equal_keys_ignore_compression_sizes() {
        assert_eq!(
            changed_status(&file(1, 2, 100), &file(1, 3, 80), || panic!(
                "must use content keys"
            )),
            None
        );
        assert_eq!(
            changed_status(&file(0, 2, 100), &file(0, 2, 80), || panic!(
                "must use encoded keys"
            )),
            None
        );
    }

    #[test]
    fn different_content_keys_detect_same_size_changes() {
        assert_eq!(
            changed_status(&file(1, 2, 100), &file(3, 4, 100), || panic!(
                "must use content keys"
            )),
            Some(DiffStatus::Changed)
        );
    }

    #[test]
    fn static_archive_locations_do_not_change_encoded_identity() {
        let mut a = file(0, 1, 100);
        let mut b = file(0, 1, 100);
        a.encoded_key[9..].fill(2); // Static archive location.
        b.encoded_key[9..].fill(3); // Dynamic full hash suffix.
        b.local = false;
        assert_eq!(
            changed_status(&a, &b, || panic!("matching keys need no local data")),
            None
        );
        b.encoded_key[0] = 4;
        assert_eq!(
            changed_status(&a, &b, || Ok(false)),
            Some(DiffStatus::Changed)
        );
    }

    #[test]
    fn matching_first_span_does_not_establish_whole_file_equality() {
        let mut a = file(1, 2, 100);
        let mut b = file(1, 2, 100);
        a.span_count = 2;
        b.span_count = 2;
        assert_eq!(
            changed_status(&a, &b, || Ok(false)),
            Some(DiffStatus::Changed)
        );
    }

    #[test]
    fn zero_encoded_prefix_is_not_a_key_even_with_nonzero_suffix() {
        let mut a = file(0, 0, 100);
        a.encoded_key[9..].fill(1);
        assert_eq!(
            changed_status(&a, &a, || Ok(false)),
            Some(DiffStatus::Changed)
        );
    }

    #[test]
    fn missing_keys_fall_back_to_bytes_and_report_read_errors() {
        let a = file(0, 0, 100);
        let b = file(0, 0, 80);
        assert_eq!(changed_status(&a, &b, || Ok(true)), None);
        assert_eq!(
            changed_status(&a, &b, || Ok(false)),
            Some(DiffStatus::Changed)
        );
        assert_eq!(
            changed_status(&a, &b, || Err(casc_core::CascError::NotFound(
                "missing".into()
            ))),
            Some(DiffStatus::Unverified)
        );
    }

    #[test]
    fn filters_before_pagination_and_counts_all_matches() {
        let entries = vec![
            DiffEntry {
                path: "data/a.txt".into(),
                status: DiffStatus::Added,
                left_size: None,
                right_size: Some(10),
                verification_error: None,
            },
            DiffEntry {
                path: "data/b.txt".into(),
                status: DiffStatus::Changed,
                left_size: Some(10),
                right_size: Some(10),
                verification_error: None,
            },
            DiffEntry {
                path: "data/c.txt".into(),
                status: DiffStatus::Changed,
                left_size: Some(10),
                right_size: Some(10),
                verification_error: None,
            },
        ];
        let page = filter_page(&entries, " DATA/ ", "changed", 1, 1);
        assert_eq!(page.total, 2);
        assert_eq!(page.entries[0].path, "data/c.txt");
        assert!(filter_page(&entries, "", "all", 10, 100).entries.is_empty());
    }

    #[test]
    fn cancellation_stops_before_opening_any_storage() {
        let cancelled = AtomicBool::new(true);
        let result = build_comparison(
            "missing-left".into(),
            "missing-right".into(),
            |_| {},
            &cancelled,
        );
        assert_eq!(result.err().unwrap().message, "comparison cancelled");
    }

    #[test]
    #[ignore = "set CASC_COMPARE_LEFT to a local storage folder"]
    fn installed_storage_compares_equal_to_itself() {
        let path = std::env::var("CASC_COMPARE_LEFT").expect("CASC_COMPARE_LEFT");
        let comparison =
            build_comparison(path.clone(), path, |_| {}, &AtomicBool::new(false)).unwrap();
        assert!(!comparison.left.files.is_empty());
        assert!(
            comparison.changes.is_empty(),
            "self-comparison reported differences: {:?}",
            comparison.summary
        );
        eprintln!(
            "Self-comparison passed for {} files",
            comparison.left.files.len()
        );
    }

    /// Opt-in, read-only check against two installed game versions. No GUI.
    #[test]
    #[ignore = "set CASC_COMPARE_LEFT and CASC_COMPARE_RIGHT to local storage folders"]
    fn installed_storages_compare_and_preview() {
        let left = std::env::var("CASC_COMPARE_LEFT").expect("CASC_COMPARE_LEFT");
        let right = std::env::var("CASC_COMPARE_RIGHT").expect("CASC_COMPARE_RIGHT");
        let cancel = AtomicBool::new(false);
        let started = std::time::Instant::now();
        let comparison = build_comparison(
            left,
            right,
            |p| {
                if p.processed % 25000 == 0 {
                    eprintln!("{} {}/{}", p.phase, p.processed, p.total);
                }
            },
            &cancel,
        )
        .unwrap();
        eprintln!(
            "Builds {} -> {}: {:?}, elapsed {:?}",
            comparison.left.info.build,
            comparison.right.info.build,
            comparison.summary,
            started.elapsed()
        );
        assert_eq!(
            comparison.changes.len(),
            comparison.summary.added
                + comparison.summary.removed
                + comparison.summary.changed
                + comparison.summary.unverified
        );
        assert!(comparison
            .changes
            .windows(2)
            .all(|pair| pair[0].path < pair[1].path));
        let mut verified = 0;
        for entry in comparison
            .changes
            .iter()
            .filter(|e| e.status == DiffStatus::Changed)
            .take(20)
        {
            let a = &comparison.left.files[&entry.path];
            let b = &comparison.right.files[&entry.path];
            if let (Ok(left), Ok(right)) = (
                comparison.left.storage.read(&a.storage_path),
                comparison.right.storage.read(&b.storage_path),
            ) {
                assert_ne!(left, right, "false difference: {}", entry.path);
                verified += 1;
            }
        }
        assert!(
            verified > 0,
            "expected readable changed files in distinct versions"
        );
        let mut equal_samples = 0;
        for (path, a) in &comparison.left.files {
            let Some(b) = comparison.right.files.get(path) else {
                continue;
            };
            if !a.local
                || !b.local
                || a.size > 1024 * 1024
                || b.size > 1024 * 1024
                || a.span_count != 1
                || b.span_count != 1
                || !a.encoded_key[..9].iter().any(|byte| *byte != 0)
                || a.encoded_key[..9] != b.encoded_key[..9]
            {
                continue;
            }
            assert!(
                comparison
                    .left
                    .storage
                    .same_content(&a.storage_path, &comparison.right.storage, &b.storage_path)
                    .unwrap(),
                "false key equality: {path}"
            );
            equal_samples += 1;
            if equal_samples == 20 {
                break;
            }
        }
        assert!(
            equal_samples > 0,
            "expected matching keys to verify against bytes"
        );
        let text_path = "data/data/global/excel/skills.txt";
        for side in [&comparison.left, &comparison.right] {
            let text = preview(side, text_path).unwrap();
            assert_eq!(text.kind, "text");
            assert!(text.text.as_ref().unwrap().contains("skill"));
            assert!(side
                .storage
                .same_content(
                    &side.files[text_path].storage_path,
                    &side.storage,
                    &side.files[text_path].storage_path
                )
                .unwrap());
            let interrupted = side.storage.same_content_cancellable(
                &side.files[text_path].storage_path,
                &side.storage,
                &side.files[text_path].storage_path,
                || true,
            );
            assert!(matches!(interrupted, Err(casc_core::CascError::Cancelled)));
            let image_path = side
                .files
                .keys()
                .find(|p| {
                    p.ends_with(".sprite")
                        && p.contains("/ui/")
                        && !p.ends_with(".lowend.sprite")
                        && side.files[*p].size < 1024 * 1024
                })
                .unwrap();
            let image = preview(side, image_path).unwrap();
            assert_eq!(image.kind, "image");
            assert!(image.image_b64.as_ref().unwrap().starts_with("iVBOR"));
            eprintln!(
                "Text and image previews passed for build {}",
                side.info.build
            );
        }
    }
}
