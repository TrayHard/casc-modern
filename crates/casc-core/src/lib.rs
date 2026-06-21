//! Safe Rust wrapper over [`casclib_sys`] — the CascLib C++ engine.
//!
//! Shared by `casc-cli` and the Tauri backend. All paths are passed as
//! ANSI-encoded `CString`s, matching CascLib's default (non-UNICODE) build.

pub mod formats;
pub mod index;
pub use index::{FileIndex, IndexEntry};

use casclib_sys as sys;
use serde::Serialize;
use std::ffi::CString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::ptr;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CascError {
    #[error("CascLib reported error {code:#x} ({op})")]
    Backend { op: &'static str, code: u32 },
    #[error("path contained a NUL byte: {0}")]
    BadPath(String),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("file not found in storage: {0}")]
    NotFound(String),
}

pub type Result<T> = std::result::Result<T, CascError>;

fn last_err(op: &'static str) -> CascError {
    let code = unsafe { sys::GetCascError() };
    CascError::Backend { op, code }
}

fn to_cstring(path: &Path) -> Result<CString> {
    let s = path.to_string_lossy().into_owned();
    CString::new(s.clone()).map_err(|_| CascError::BadPath(s))
}

#[derive(Debug, Clone, Serialize)]
pub struct StorageInfo {
    pub product: String,
    pub build: u32,
    pub local_file_count: u32,
    pub total_file_count: u32,
    pub features: u32,
    /// Bitmask of locales installed in this storage (CASC_LOCALE_*). Used to
    /// decide which per-file locale flags count as "the user's locale".
    pub installed_locales: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    /// Last path segment ("levels.txt").
    pub name: String,
    /// Storage-relative full path ("data/global/excel/levels.txt").
    pub full_path: String,
    pub is_dir: bool,
    pub size: u64,
    /// True when the entry is a CKey/EKey/FileDataId fake name (not a real name).
    pub is_synthetic_name: bool,
    /// True when the file's data is present in the local storage. CascLib marks
    /// indexed-but-not-downloaded files (other locales, on-demand video) as
    /// unavailable; reading them fails.
    pub available: bool,
    /// Per-file locale bitmask (CASC_FIND_DATA.dwLocaleFlags). 0 = locale-neutral.
    pub locale_flags: u32,
}

/// Opened CASC storage handle. RAII-closed on drop.
pub struct Storage {
    handle: sys::HANDLE,
    root_path: PathBuf,
}

// SAFETY: CascLib's per-storage HANDLE is a heap-allocated descriptor with
// internal locking for state mutations (see CascCommon.h:TCascStorage). Moving
// the pointer to another thread is sound — what is NOT sound is concurrent
// access, hence no `Sync` impl: every method takes `&self` and serializes
// through an external Mutex in the binaries (`AppState.opened`).
unsafe impl Send for Storage {}

impl Drop for Storage {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe { sys::CascCloseStorage(self.handle) };
        }
    }
}

impl Storage {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let root_path = path.as_ref().to_path_buf();
        let c_path = to_cstring(&root_path)?;
        let mut handle: sys::HANDLE = ptr::null_mut();
        let ok = unsafe {
            sys::CascOpenStorage(c_path.as_ptr(), sys::CASC_LOCALE_ALL, &mut handle)
        };
        if !sys::ok(ok) || handle.is_null() {
            return Err(last_err("CascOpenStorage"));
        }
        Ok(Self { handle, root_path })
    }

    pub fn root_path(&self) -> &Path {
        &self.root_path
    }

    pub fn info(&self) -> Result<StorageInfo> {
        let local_file_count = self.get_storage_dword(
            sys::CASC_STORAGE_INFO_CLASS::CascStorageLocalFileCount,
        )?;
        let total_file_count = self.get_storage_dword(
            sys::CASC_STORAGE_INFO_CLASS::CascStorageTotalFileCount,
        )?;
        let features = self
            .get_storage_dword(sys::CASC_STORAGE_INFO_CLASS::CascStorageFeatures)
            .unwrap_or(0);
        let installed_locales = self
            .get_storage_dword(sys::CASC_STORAGE_INFO_CLASS::CascStorageInstalledLocales)
            .unwrap_or(0);

        let mut product: sys::CASC_STORAGE_PRODUCT = unsafe { std::mem::zeroed() };
        let mut needed: usize = 0;
        let product_ptr: *mut sys::CASC_STORAGE_PRODUCT = &mut product;
        let ok = unsafe {
            sys::CascGetStorageInfo(
                self.handle,
                sys::CASC_STORAGE_INFO_CLASS::CascStorageProduct,
                product_ptr.cast(),
                std::mem::size_of::<sys::CASC_STORAGE_PRODUCT>(),
                &mut needed,
            )
        };
        let (code_name, build) = if sys::ok(ok) {
            (
                sys::fixed_cstr_to_string(&product.szCodeName),
                product.BuildNumber,
            )
        } else {
            (String::new(), 0)
        };

        Ok(StorageInfo {
            product: code_name,
            build,
            local_file_count,
            total_file_count,
            features,
            installed_locales,
        })
    }

    fn get_storage_dword(&self, class: sys::CASC_STORAGE_INFO_CLASS) -> Result<u32> {
        let mut value: u32 = 0;
        let mut needed: usize = 0;
        let ok = unsafe {
            sys::CascGetStorageInfo(
                self.handle,
                class,
                (&mut value as *mut u32).cast(),
                std::mem::size_of::<u32>(),
                &mut needed,
            )
        };
        if !sys::ok(ok) {
            return Err(last_err("CascGetStorageInfo"));
        }
        Ok(value)
    }

    /// Enumerate every file. Returns one [`Entry`] per file (no directories).
    pub fn all_files(&self) -> Result<Vec<Entry>> {
        let mut out = Vec::new();
        self.walk(|e| {
            out.push(e);
            true
        })?;
        Ok(out)
    }

    /// Walk every file in the storage, calling `f` for each. Stop early by
    /// returning `false` from the closure.
    pub fn walk<F: FnMut(Entry) -> bool>(&self, mut f: F) -> Result<()> {
        // CASC_FIND_DATA is large — keep it on the heap to avoid stack blowups.
        let mut find = Box::new(sys::empty_find_data());
        let mask = CString::new("*").unwrap();
        let hfind = unsafe {
            sys::CascFindFirstFile(
                self.handle,
                mask.as_ptr(),
                &mut *find as *mut _,
                ptr::null(),
            )
        };
        if hfind.is_null() {
            // Empty storage — not an error, just no matches.
            let code = unsafe { sys::GetCascError() };
            if code == 0 || code == 18
            /* ERROR_NO_MORE_FILES on Win, treat as empty */
            {
                return Ok(());
            }
            return Err(CascError::Backend { op: "CascFindFirstFile", code });
        }

        loop {
            let entry = find_data_to_entry(&find);
            let cont = f(entry);
            if !cont {
                break;
            }
            let next_ok = unsafe { sys::CascFindNextFile(hfind, &mut *find as *mut _) };
            if !sys::ok(next_ok) {
                break;
            }
        }

        unsafe { sys::CascFindClose(hfind) };
        Ok(())
    }

    /// Read a file's full contents into memory.
    pub fn read(&self, file: &str) -> Result<Vec<u8>> {
        self.read_limited(file, None)
    }

    /// Read up to `max_bytes` from the start of a file. Cheaper than
    /// [`Storage::read`] for huge files when you only need a preview.
    pub fn read_n(&self, file: &str, max_bytes: usize) -> Result<Vec<u8>> {
        self.read_limited(file, Some(max_bytes))
    }

    /// Shared implementation for [`Self::read`] and [`Self::read_n`].
    /// `max_bytes = None` reads the entire file; `Some(n)` caps at `n`.
    fn read_limited(&self, file: &str, max_bytes: Option<usize>) -> Result<Vec<u8>> {
        let mut h_file: sys::HANDLE = ptr::null_mut();
        let c_file = CString::new(file).map_err(|_| CascError::BadPath(file.to_string()))?;
        let ok = unsafe {
            sys::CascOpenFile(
                self.handle,
                c_file.as_ptr().cast(),
                sys::CASC_LOCALE_ALL,
                sys::CASC_OPEN_BY_NAME,
                &mut h_file,
            )
        };
        if !sys::ok(ok) || h_file.is_null() {
            return Err(last_err("CascOpenFile"));
        }
        let guard = FileGuard(h_file);

        let mut full_size: u64 = 0;
        let ok = unsafe { sys::CascGetFileSize64(guard.0, &mut full_size) };
        if !sys::ok(ok) {
            return Err(last_err("CascGetFileSize64"));
        }
        // Guard against 32-bit hosts where a >4GB file would overflow usize.
        let full_size_usize =
            usize::try_from(full_size).map_err(|_| CascError::Backend {
                op: "file too large for address space",
                code: 0,
            })?;
        let want_total = max_bytes.map_or(full_size_usize, |m| m.min(full_size_usize));

        let mut buf = vec![0u8; want_total];
        let mut total_read: usize = 0;
        while total_read < buf.len() {
            let want = (buf.len() - total_read).min(u32::MAX as usize) as u32;
            let mut got: u32 = 0;
            let ok = unsafe {
                sys::CascReadFile(
                    guard.0,
                    buf[total_read..].as_mut_ptr().cast(),
                    want,
                    &mut got,
                )
            };
            if !sys::ok(ok) {
                return Err(last_err("CascReadFile"));
            }
            if got == 0 {
                break;
            }
            total_read += got as usize;
        }
        buf.truncate(total_read);
        Ok(buf)
    }

    /// Build a normalized directory index by enumerating every file in the
    /// storage. ~200ms for D2R's ~175k files. Cache the result and serve
    /// `list_dir` calls from it.
    pub fn build_index(&self) -> Result<FileIndex> {
        let mut idx = FileIndex::default();
        self.walk(|e| {
            idx.add(e.full_path, e.size, e.available, e.locale_flags);
            true
        })?;
        idx.finalize();
        Ok(idx)
    }

    /// Extract a file to disk. Returns bytes written.
    pub fn extract(&self, file: &str, out_path: impl AsRef<Path>) -> Result<u64> {
        let out_path = out_path.as_ref();
        if let Some(parent) = out_path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        let bytes = self.read(file)?;
        let mut sink = std::fs::File::create(out_path)?;
        sink.write_all(&bytes)?;
        Ok(bytes.len() as u64)
    }
}

struct FileGuard(sys::HANDLE);
impl Drop for FileGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { sys::CascCloseFile(self.0) };
        }
    }
}

fn find_data_to_entry(f: &sys::CASC_FIND_DATA) -> Entry {
    let full_path = sys::fixed_cstr_to_string(&f.szFileName);
    let name = full_path
        .rsplit(['/', '\\'])
        .next()
        .map(|s| s.to_string())
        .unwrap_or_else(|| full_path.clone());
    Entry {
        name,
        full_path,
        is_dir: false,
        size: f.FileSize,
        is_synthetic_name: f.NameType != 0, // 0 = CascNameFull
        available: f.bFileAvailable != 0,
        locale_flags: f.dwLocaleFlags,
    }
}

/// Coarse file-type sniff for the UI viewer.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub enum FileKind {
    Text,
    Blp,
    Dc6,
    Dcc,
    Dt1,
    Palette,
    Image,
    Binary,
}

impl FileKind {
    pub fn sniff(name: &str, bytes: &[u8]) -> Self {
        let lower = name.to_ascii_lowercase();
        if lower.ends_with(".dc6") {
            return Self::Dc6;
        }
        if lower.ends_with(".dcc") {
            return Self::Dcc;
        }
        if lower.ends_with(".dt1") {
            return Self::Dt1;
        }
        if lower.ends_with(".pl2") || lower.ends_with(".pal") {
            return Self::Palette;
        }
        if bytes.starts_with(b"BLP1") || bytes.starts_with(b"BLP2") {
            return Self::Blp;
        }
        if bytes.starts_with(&[0x89, b'P', b'N', b'G']) || bytes.starts_with(b"\xFF\xD8\xFF") {
            return Self::Image;
        }
        let prefix_len = bytes.len().min(512);
        if looks_textual(&bytes[..prefix_len]) {
            Self::Text
        } else {
            Self::Binary
        }
    }
}

/// Heuristic: is this prefix human-readable text? Accepts valid UTF-8 (so
/// localized JSON with CJK/accented characters counts as text, not binary),
/// tolerating a trailing multibyte char cut off by the 512-byte read, and a
/// leading UTF-8 BOM. Rejects control bytes other than tab/newline/CR.
fn looks_textual(prefix: &[u8]) -> bool {
    let bytes = prefix
        .strip_prefix(&[0xEF, 0xBB, 0xBF])
        .unwrap_or(prefix);
    let valid = match std::str::from_utf8(bytes) {
        Ok(_) => bytes.len(),
        Err(e) => e.valid_up_to(),
    };
    // Invalid UTF-8 well before the end means it isn't truncation — it's binary.
    if bytes.len().saturating_sub(valid) > 3 {
        return false;
    }
    bytes[..valid].iter().all(|&b| {
        b == b'\t' || b == b'\n' || b == b'\r' || (0x20..0x7F).contains(&b) || b >= 0x80
    })
}
