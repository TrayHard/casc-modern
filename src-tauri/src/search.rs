//! Name and content search over an opened CASC storage.
//!
//! - `search_names` is cheap (HashMap scan) — runs sync, returns the full
//!   result list capped at `limit`.
//! - `search_content` extracts each candidate file and searches its bytes;
//!   blocking work runs on a tokio blocking thread, progress and incremental
//!   hits stream to the frontend via Tauri events.

use crate::{ApiError, ApiResult, AppState};
use globset::Glob;
use memchr::memmem;
use serde::Serialize;
use std::borrow::Cow;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

#[derive(Default)]
pub struct SearchState {
    pub cancel: Arc<AtomicBool>,
    /// Snapshots the storage paths copied out of AppState at search start.
    pub running: Mutex<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct NameHit {
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

#[tauri::command]
pub fn search_names(
    state: tauri::State<'_, AppState>,
    query: String,
    use_regex: bool,
    limit: u32,
    local_only: bool,
) -> ApiResult<Vec<NameHit>> {
    let lock = state.opened.lock().expect("opened storage lock poisoned");
    let opened = lock.as_ref().ok_or_else(|| ApiError {
        message: "no storage open".into(),
    })?;

    let matcher = NameMatcher::build(&query, use_regex)?;
    let mut out = Vec::new();
    let cap = limit.max(1) as usize;

    for dir in opened.index.iter_dirs() {
        if dir.is_empty() {
            continue;
        }
        if matcher.is_match(dir) {
            out.push(NameHit {
                path: dir.to_string(),
                is_dir: true,
                size: 0,
            });
            if out.len() >= cap {
                return Ok(out);
            }
        }
    }
    for (path, _storage, size, available) in opened.index.iter_files() {
        if local_only && !available {
            continue;
        }
        if matcher.is_match(path) {
            out.push(NameHit {
                path: path.to_string(),
                is_dir: false,
                size,
            });
            if out.len() >= cap {
                return Ok(out);
            }
        }
    }
    Ok(out)
}

enum NameMatcher {
    Regex(regex::Regex),
    Substring(String),
}

impl NameMatcher {
    fn build(query: &str, use_regex: bool) -> Result<Self, ApiError> {
        if use_regex {
            regex::RegexBuilder::new(query)
                .case_insensitive(true)
                .build()
                .map(Self::Regex)
                .map_err(|e| ApiError {
                    message: format!("regex: {e}"),
                })
        } else {
            Ok(Self::Substring(query.to_ascii_lowercase()))
        }
    }
    fn is_match(&self, s: &str) -> bool {
        match self {
            Self::Regex(r) => r.is_match(s),
            Self::Substring(needle) => {
                if needle.is_empty() {
                    false
                } else {
                    s.to_ascii_lowercase().contains(needle)
                }
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ContentHit {
    pub path: String,
    pub size: u64,
    pub match_offset: u64,
    pub match_count: u32,
    pub excerpt: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchProgress {
    pub scanned: u32,
    pub total: u32,
    pub current_path: String,
    pub matches_so_far: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchDone {
    pub scanned: u32,
    pub total: u32,
    pub matches: u32,
    pub cancelled: bool,
    pub error: Option<String>,
    pub elapsed_ms: u128,
}

/// Run a content search. Returns the total number of file hits.
/// Streams `search_progress` and `search_hit` events as the scan runs.
// A Tauri command's args come straight from the JS invoke; grouping them into a
// struct would only obscure the call site.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn search_content(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    search_state: tauri::State<'_, SearchState>,
    query: String,
    glob: Option<String>,
    max_file_size: u32,
    case_insensitive: bool,
    local_only: bool,
) -> ApiResult<u32> {
    if query.is_empty() {
        return Err(ApiError {
            message: "query is empty".into(),
        });
    }
    let glob_matcher = match glob.as_deref() {
        Some(p) if !p.is_empty() => Some(
            Glob::new(p)
                .map_err(|e| ApiError {
                    message: format!("glob: {e}"),
                })?
                .compile_matcher(),
        ),
        _ => None,
    };

    // Snapshot the candidate paths up front so we don't hold AppState's lock
    // through the long scan.
    let candidates: Vec<(String, String, u64)> = {
        let lock = state.opened.lock().expect("opened storage lock poisoned");
        let opened = lock.as_ref().ok_or_else(|| ApiError {
            message: "no storage open".into(),
        })?;
        opened
            .index
            .iter_files()
            .filter(|(p, _, size, available)| {
                (!local_only || *available)
                    && *size <= max_file_size as u64
                    && glob_matcher.as_ref().is_none_or(|g| g.is_match(p))
            })
            .map(|(p, s, sz, _)| (p.to_string(), s.to_string(), sz))
            .collect()
    };
    let total = candidates.len() as u32;

    // Reset cancel + running flags.
    search_state.cancel.store(false, Ordering::SeqCst);
    *search_state
        .running
        .lock()
        .expect("search-running lock poisoned") = true;
    let cancel = search_state.cancel.clone();

    // Prebuild the search needle once. `Finder` does SIMD precomputation that
    // is reused for every file scan — much faster than calling `find()` cold
    // 175k times. We hand it owned bytes so the closure captures it cleanly.
    let needle_bytes: Vec<u8> = if case_insensitive {
        query.to_ascii_lowercase().into_bytes()
    } else {
        query.into_bytes()
    };
    let app_for_blocking = app.clone();

    // The blocking task reacquires the storage lock per-read through
    // `app.state::<AppState>()` in `read_storage_file`. CascLib's
    // per-storage handle isn't documented as fully thread-safe, so we
    // serialize reads through the existing Mutex.
    let result = tokio::task::spawn_blocking(move || -> SearchDone {
        let started = std::time::Instant::now();
        let finder = memmem::Finder::new(&needle_bytes);
        let needle_len = needle_bytes.len();
        let mut hits = 0u32;
        let mut scanned = 0u32;
        let mut error: Option<String> = None;

        for (path, storage_path, size) in candidates.iter() {
            if cancel.load(Ordering::Relaxed) {
                return SearchDone {
                    scanned,
                    total,
                    matches: hits,
                    cancelled: true,
                    error: None,
                    elapsed_ms: started.elapsed().as_millis(),
                };
            }
            scanned += 1;
            // Read file bytes. If read fails, skip it.
            let bytes = match read_storage_file(&app_for_blocking, storage_path) {
                Ok(b) => b,
                Err(e) => {
                    error = Some(e);
                    continue;
                }
            };
            // For case-insensitive search we need to lowercase the haystack,
            // but only own a copy when we actually have to. `Cow::Borrowed`
            // skips the allocation entirely for case-sensitive scans.
            let haystack: Cow<'_, [u8]> = if case_insensitive {
                Cow::Owned(bytes.iter().map(u8::to_ascii_lowercase).collect())
            } else {
                Cow::Borrowed(&bytes)
            };
            // Single pass: take the first offset and count the rest with the
            // same Finder. Previously this was two separate scans.
            let mut iter = finder.find_iter(&haystack);
            let Some(offset) = iter.next() else {
                if scanned.is_multiple_of(64) || scanned == total {
                    let _ = app_for_blocking.emit(
                        "search_progress",
                        SearchProgress {
                            scanned,
                            total,
                            current_path: path.clone(),
                            matches_so_far: hits,
                        },
                    );
                }
                continue;
            };
            let count = 1 + iter.count() as u32;
            hits += 1;
            // Excerpt comes from the ORIGINAL bytes (preserves case) so the
            // user sees the real text they hit, not the lowercased copy.
            let excerpt = excerpt(&bytes, offset, needle_len);
            let _ = app_for_blocking.emit(
                "search_hit",
                ContentHit {
                    path: path.clone(),
                    size: *size,
                    match_offset: offset as u64,
                    match_count: count,
                    excerpt,
                },
            );
            // Throttle progress events to once every 64 files.
            if scanned.is_multiple_of(64) || scanned == total {
                let _ = app_for_blocking.emit(
                    "search_progress",
                    SearchProgress {
                        scanned,
                        total,
                        current_path: path.clone(),
                        matches_so_far: hits,
                    },
                );
            }
        }

        SearchDone {
            scanned,
            total,
            matches: hits,
            cancelled: false,
            error,
            elapsed_ms: started.elapsed().as_millis(),
        }
    })
    .await
    .map_err(|e| ApiError {
        message: format!("join: {e}"),
    })?;

    *search_state
        .running
        .lock()
        .expect("search-running lock poisoned") = false;
    let _ = app.emit("search_done", &result);
    Ok(result.matches)
}

#[tauri::command]
pub fn cancel_search(state: tauri::State<'_, SearchState>) {
    state.cancel.store(true, Ordering::SeqCst);
}

fn read_storage_file(app: &AppHandle, storage_path: &str) -> Result<Vec<u8>, String> {
    // Acquire the AppState handle through the app, scoped tight so the lock
    // isn't held across other awaits.
    use tauri::Manager;
    let app_state = app.state::<AppState>();
    let lock = app_state
        .opened
        .lock()
        .expect("opened storage lock poisoned");
    let opened = lock
        .as_ref()
        .ok_or_else(|| "storage closed during search".to_string())?;
    opened.storage.read(storage_path).map_err(|e| e.to_string())
}

/// 64 chars of context around the match, normalized to printable ASCII.
fn excerpt(haystack: &[u8], pos: usize, needle_len: usize) -> String {
    let start = pos.saturating_sub(32);
    let end = (pos + needle_len + 32).min(haystack.len());
    let slice = &haystack[start..end];
    let mut out = String::with_capacity(slice.len());
    for &b in slice {
        if (0x20..0x7F).contains(&b) {
            out.push(b as char);
        } else if b == b'\n' || b == b'\r' || b == b'\t' {
            out.push(' ');
        } else {
            out.push('·');
        }
    }
    out
}
