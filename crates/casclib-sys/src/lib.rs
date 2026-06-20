//! Raw FFI bindings to CascLib's public C API (CascLib.h).
//!
//! ANSI build (no UNICODE define). On Windows that's narrow `char*` paths; on
//! Unix `LPCTSTR == char*` already. Path arguments use [`std::ffi::CString`].
//!
//! Struct field layout mirrors CascLib.h. Check carefully if you bump the
//! vendored CascLib.

#![allow(non_camel_case_types, non_snake_case, dead_code)]

use std::os::raw::{c_char, c_void};

pub type HANDLE = *mut c_void;
pub type DWORD = u32;
pub type BYTE = u8;
pub type ULONGLONG = u64;
pub type LONGLONG = i64;
pub type LPCSTR = *const c_char;
pub type LPCTSTR = *const c_char;
pub type LPBYTE = *mut BYTE;
pub type PDWORD = *mut DWORD;
pub type PULONGLONG = *mut ULONGLONG;

pub const MD5_HASH_SIZE: usize = 0x10;
pub const CASC_KEY_LENGTH: usize = 0x10;

#[cfg(windows)]
pub const MAX_PATH: usize = 260;
#[cfg(not(windows))]
pub const MAX_PATH: usize = 1024;

// Open-file flags
pub const CASC_OPEN_BY_NAME: DWORD = 0x00000000;
pub const CASC_OPEN_BY_CKEY: DWORD = 0x00000001;
pub const CASC_OPEN_BY_EKEY: DWORD = 0x00000002;
pub const CASC_OPEN_BY_FILEID: DWORD = 0x00000003;
pub const CASC_OPEN_TYPE_MASK: DWORD = 0x0000000F;
pub const CASC_STRICT_DATA_CHECK: DWORD = 0x00000010;
pub const CASC_OVERCOME_ENCRYPTED: DWORD = 0x00000020;
pub const CASC_OPEN_CKEY_ONCE: DWORD = 0x00000040;

pub const CASC_LOCALE_ALL: DWORD = 0xFFFFFFFF;
pub const CASC_LOCALE_NONE: DWORD = 0x00000000;
pub const CASC_LOCALE_ENUS: DWORD = 0x00000002;

// Storage feature flags
pub const CASC_FEATURE_FILE_NAMES: DWORD = 0x00000001;
pub const CASC_FEATURE_ROOT_CKEY: DWORD = 0x00000002;
pub const CASC_FEATURE_TAGS: DWORD = 0x00000004;
pub const CASC_FEATURE_FNAME_HASHES: DWORD = 0x00000008;
pub const CASC_FEATURE_FILE_DATA_IDS: DWORD = 0x00000020;
pub const CASC_FEATURE_DATA_ARCHIVES: DWORD = 0x00000100;

// Invalid sentinels
pub const CASC_INVALID_ID: DWORD = 0xFFFFFFFF;
pub const CASC_INVALID_SIZE: DWORD = 0xFFFFFFFF;

// FILE_BEGIN / SetFilePointer style move methods
pub const FILE_BEGIN: DWORD = 0;
pub const FILE_CURRENT: DWORD = 1;
pub const FILE_END: DWORD = 2;

#[repr(C)]
#[derive(Copy, Clone)]
pub enum CASC_STORAGE_INFO_CLASS {
    CascStorageLocalFileCount = 0,
    CascStorageTotalFileCount = 1,
    CascStorageFeatures = 2,
    CascStorageInstalledLocales = 3,
    CascStorageProduct = 4,
    CascStorageTags = 5,
    CascStoragePathProduct = 6,
    CascStorageInfoClassMax = 7,
}

#[repr(C)]
#[derive(Copy, Clone)]
pub enum CASC_FILE_INFO_CLASS {
    CascFileContentKey = 0,
    CascFileEncodedKey = 1,
    CascFileFullInfo = 2,
    CascFileSpanInfo = 3,
    CascFileInfoClassMax = 4,
}

#[repr(C)]
#[derive(Copy, Clone)]
pub enum CASC_NAME_TYPE {
    CascNameFull = 0,
    CascNameDataId = 1,
    CascNameCKey = 2,
    CascNameEKey = 3,
}

#[repr(C)]
pub struct CASC_STORAGE_PRODUCT {
    pub szCodeName: [c_char; 0x1C],
    pub BuildNumber: DWORD,
}

#[repr(C)]
pub struct CASC_FIND_DATA {
    pub szFileName: [c_char; MAX_PATH],
    pub CKey: [BYTE; MD5_HASH_SIZE],
    pub EKey: [BYTE; MD5_HASH_SIZE],
    pub TagBitMask: ULONGLONG,
    pub FileSize: ULONGLONG,
    pub szPlainName: *mut c_char,
    pub dwFileDataId: DWORD,
    pub dwLocaleFlags: DWORD,
    pub dwContentFlags: DWORD,
    pub dwSpanCount: DWORD,
    // `DWORD bFileAvailable:1;` — C allocates a full DWORD for the bitfield.
    pub bFileAvailable: DWORD,
    // `CASC_NAME_TYPE NameType;` — enum sized as int (DWORD on every supported target).
    pub NameType: DWORD,
}

#[repr(C)]
pub struct CASC_FILE_FULL_INFO {
    pub CKey: [BYTE; MD5_HASH_SIZE],
    pub EKey: [BYTE; MD5_HASH_SIZE],
    pub DataFileName: [c_char; 0x10],
    pub StorageOffset: ULONGLONG,
    pub SegmentOffset: ULONGLONG,
    pub TagBitMask: ULONGLONG,
    pub FileNameHash: ULONGLONG,
    pub ContentSize: ULONGLONG,
    pub EncodedSize: ULONGLONG,
    pub SegmentIndex: DWORD,
    pub SpanCount: DWORD,
    pub FileDataId: DWORD,
    pub LocaleFlags: DWORD,
    pub ContentFlags: DWORD,
}

// CascLib uses bool (single byte) in its public API. On every modern ABI both
// MSVC and gcc/clang represent `bool` as a single byte, so we mirror it.
#[allow(non_camel_case_types)]
type CascBool = u8;

extern "C" {
    pub fn CascOpenStorage(
        szParams: LPCTSTR,
        dwLocaleMask: DWORD,
        phStorage: *mut HANDLE,
    ) -> CascBool;

    pub fn CascCloseStorage(hStorage: HANDLE) -> CascBool;

    pub fn CascGetStorageInfo(
        hStorage: HANDLE,
        InfoClass: CASC_STORAGE_INFO_CLASS,
        pvStorageInfo: *mut c_void,
        cbStorageInfo: usize,
        pcbLengthNeeded: *mut usize,
    ) -> CascBool;

    pub fn CascOpenFile(
        hStorage: HANDLE,
        pvFileName: *const c_void,
        dwLocaleFlags: DWORD,
        dwOpenFlags: DWORD,
        PtrFileHandle: *mut HANDLE,
    ) -> CascBool;

    pub fn CascGetFileInfo(
        hFile: HANDLE,
        InfoClass: CASC_FILE_INFO_CLASS,
        pvFileInfo: *mut c_void,
        cbFileInfo: usize,
        pcbLengthNeeded: *mut usize,
    ) -> CascBool;

    pub fn CascGetFileSize64(hFile: HANDLE, PtrFileSize: PULONGLONG) -> CascBool;

    pub fn CascSetFilePointer64(
        hFile: HANDLE,
        DistanceToMove: LONGLONG,
        PtrNewPos: PULONGLONG,
        dwMoveMethod: DWORD,
    ) -> CascBool;

    pub fn CascReadFile(
        hFile: HANDLE,
        lpBuffer: *mut c_void,
        dwToRead: DWORD,
        pdwRead: PDWORD,
    ) -> CascBool;

    pub fn CascCloseFile(hFile: HANDLE) -> CascBool;

    pub fn CascFindFirstFile(
        hStorage: HANDLE,
        szMask: LPCSTR,
        pFindData: *mut CASC_FIND_DATA,
        szListFile: LPCTSTR,
    ) -> HANDLE;

    pub fn CascFindNextFile(hFind: HANDLE, pFindData: *mut CASC_FIND_DATA) -> CascBool;
    pub fn CascFindClose(hFind: HANDLE) -> CascBool;

    pub fn GetCascError() -> DWORD;
    pub fn SetCascError(dwErrCode: DWORD);
}

/// Convenience: turn a CascBool into a Rust bool.
#[inline]
pub fn ok(b: CascBool) -> bool {
    b != 0
}

/// Helper: read a zero-terminated `char` array into a Rust `String`.
///
/// # Safety
/// `ptr` must point to a NUL-terminated buffer.
pub unsafe fn cstr_to_string(ptr: *const c_char) -> String {
    if ptr.is_null() {
        return String::new();
    }
    std::ffi::CStr::from_ptr(ptr).to_string_lossy().into_owned()
}

/// Helper: read a fixed-length char array (may be NUL-padded) into a String.
pub fn fixed_cstr_to_string(bytes: &[c_char]) -> String {
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    let slice: &[u8] = unsafe { std::slice::from_raw_parts(bytes.as_ptr().cast(), end) };
    String::from_utf8_lossy(slice).into_owned()
}

/// Returns a `c == 0`-initialized [`CASC_FIND_DATA`]. The struct is large
/// (>0x500 bytes) so allocate it on the heap when iterating.
pub fn empty_find_data() -> CASC_FIND_DATA {
    unsafe { std::mem::zeroed() }
}
