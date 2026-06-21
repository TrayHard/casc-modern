//! Pre-built directory index over a CASC storage.
//!
//! A single full enumeration of the storage produces a tree-shaped index
//! keyed by normalized virtual path. Subsequent `list_dir` queries are O(1)
//! HashMap lookups + cloning a small Vec, which is what the GUI hits every
//! time the user expands a node.

use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// One row shown in the tree or list. Suitable for direct serde to the
/// frontend.
#[derive(Debug, Clone, Serialize)]
pub struct IndexEntry {
    /// Basename of the entry (one path segment).
    pub name: String,
    /// Normalized virtual path from storage root. Use as a stable id and to
    /// query [`FileIndex::list`] for children.
    pub path: String,
    /// Original CascLib-facing path. Only set for files — pass this to
    /// [`crate::Storage::read`] / `extract`. `None` for directories.
    pub storage_path: Option<String>,
    pub is_dir: bool,
    pub size: u64,
    /// Whether the file's data is present locally. Directories are always
    /// `true`; files reflect CascLib's `bFileAvailable`.
    pub local: bool,
    /// Locale bitmask. For files: CASC_FIND_DATA.dwLocaleFlags (0 = neutral).
    /// For directories: the OR of all descendant files' flags, with neutral
    /// descendants forcing `0xFFFFFFFF` ("universally relevant"). The frontend
    /// hides an entry when `flags != 0 && (flags & installed_locales) == 0`.
    pub locale_flags: u32,
}

#[derive(Debug, Default)]
pub struct FileIndex {
    by_dir: HashMap<String, DirContent>,
    /// Reverse lookup: normalized file path -> original storage path.
    /// Used so the frontend can refer to files by normalized path.
    storage_paths: HashMap<String, FileRecord>,
    /// Aggregated locale bitmask per directory (see [`IndexEntry::locale_flags`]).
    dir_locale: HashMap<String, u32>,
}

#[derive(Debug, Default)]
struct DirContent {
    subdirs: BTreeSet<String>,
    files: BTreeMap<String, FileRecord>,
}

#[derive(Debug, Clone)]
struct FileRecord {
    storage_path: String,
    size: u64,
    available: bool,
    locale_flags: u32,
}

impl FileIndex {
    /// Register a file in the index. Idempotent for duplicate paths — later
    /// records win, matching CascLib's "open by name" behavior.
    pub fn add(&mut self, storage_path: String, size: u64, available: bool, locale_flags: u32) {
        // CascLib enumerates VFS-root pseudo-files like "data:" or "hd:" —
        // descriptors with no real path. They share a name with the product
        // directory created from real paths like "data:data\foo.txt", so they
        // would collide. Skip them; users can still extract by full storage
        // path via the CLI if needed.
        if storage_path.is_empty() || storage_path.ends_with(':') {
            return;
        }

        let normalized = normalize(&storage_path);
        let segments: Vec<&str> = normalized.split('/').filter(|s| !s.is_empty()).collect();
        if segments.is_empty() {
            return;
        }

        // Walk the path, registering every ancestor directory under its parent.
        for i in 0..segments.len().saturating_sub(1) {
            let parent: String = segments[..i].join("/");
            let child = segments[i].to_string();
            self.by_dir.entry(parent).or_default().subdirs.insert(child);
        }

        // Aggregate locale coverage up the directory chain so the UI can hide
        // folders that hold nothing for the user's locale. A neutral file
        // (flags == 0) marks every ancestor as universally relevant.
        let contrib = if locale_flags == 0 { 0xFFFF_FFFF } else { locale_flags };
        for k in 0..segments.len() {
            let prefix: String = segments[..k].join("/");
            *self.dir_locale.entry(prefix).or_insert(0) |= contrib;
        }

        let parent: String = segments[..segments.len() - 1].join("/");
        let file_name = segments.last().unwrap().to_string();
        let record = FileRecord { storage_path, size, available, locale_flags };
        self.by_dir
            .entry(parent.clone())
            .or_default()
            .files
            .insert(file_name.clone(), record.clone());
        let key = if parent.is_empty() {
            file_name
        } else {
            format!("{parent}/{file_name}")
        };
        self.storage_paths.insert(key, record);
    }

    /// List immediate children of a virtual directory. `""` for root.
    /// Directories come first (alphabetical), then files.
    pub fn list(&self, dir: &str) -> Vec<IndexEntry> {
        let dir = dir.trim_matches('/');
        let Some(content) = self.by_dir.get(dir) else {
            return Vec::new();
        };
        let prefix = if dir.is_empty() {
            String::new()
        } else {
            format!("{dir}/")
        };

        let mut out: Vec<IndexEntry> = content
            .subdirs
            .iter()
            .map(|name| IndexEntry {
                path: format!("{prefix}{name}"),
                name: name.clone(),
                storage_path: None,
                is_dir: true,
                size: 0,
                local: true,
                locale_flags: self
                    .dir_locale
                    .get(&format!("{prefix}{name}"))
                    .copied()
                    .unwrap_or(0),
            })
            .collect();
        out.extend(content.files.iter().map(|(name, rec)| IndexEntry {
            name: name.clone(),
            path: format!("{prefix}{name}"),
            storage_path: Some(rec.storage_path.clone()),
            is_dir: false,
            size: rec.size,
            local: rec.available,
            locale_flags: rec.locale_flags,
        }));
        out
    }

    /// Resolve a normalized file path back to (storage_path, size). Returns
    /// `None` for unknown paths or directories.
    pub fn resolve(&self, path: &str) -> Option<(String, u64)> {
        let path = path.trim_matches('/');
        self.storage_paths
            .get(path)
            .map(|r| (r.storage_path.clone(), r.size))
    }

    /// Resolve every file-vs-directory name collision by dropping the file
    /// (directories win, since they aggregate content). Call after the final
    /// `add()`. [`crate::Storage::build_index`] does this automatically.
    pub fn finalize(&mut self) {
        let mut dropped: Vec<String> = Vec::new();
        for (dir, content) in self.by_dir.iter_mut() {
            let prefix = if dir.is_empty() { String::new() } else { format!("{dir}/") };
            content.files.retain(|name, _| {
                if content.subdirs.contains(name) {
                    dropped.push(format!("{prefix}{name}"));
                    false
                } else {
                    true
                }
            });
        }
        for path in dropped {
            self.storage_paths.remove(&path);
        }
    }

    pub fn file_count(&self) -> usize {
        self.storage_paths.len()
    }

    pub fn dir_count(&self) -> usize {
        self.by_dir.len()
    }

    /// Iterate `(normalized_path, storage_path, size, available)` for every
    /// file. Order is unspecified; callers that need ordering should sort.
    pub fn iter_files(&self) -> impl Iterator<Item = (&str, &str, u64, bool)> {
        self.storage_paths
            .iter()
            .map(|(p, r)| (p.as_str(), r.storage_path.as_str(), r.size, r.available))
    }

    /// Iterate every directory's normalized path. `""` for the root.
    pub fn iter_dirs(&self) -> impl Iterator<Item = &str> {
        self.by_dir.keys().map(String::as_str)
    }
}

/// `data:data\global\foo.txt` → `data/data/global/foo.txt`.
fn normalize(path: &str) -> String {
    path.replace([':', '\\'], "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_then_nested() {
        let mut idx = FileIndex::default();
        idx.add("data:data\\global\\excel\\levels.txt".into(), 80_000, true, 0);
        idx.add("data:data\\global\\excel\\misc.txt".into(), 1234, true, 0);
        idx.add("hd:hd\\pl_lit2.tex".into(), 42, true, 0);
        // VFS pseudo-files that share a name with the product directory.
        // Without filtering these would collide in the tree and produce
        // duplicate-key React warnings + visual duplication.
        idx.add("data:".into(), 11_000_000, true, 0);
        idx.add("hd:".into(), 9_000_000, true, 0);
        idx.finalize();

        let root = idx.list("");
        assert_eq!(root.iter().filter(|e| e.is_dir).count(), 2);
        assert!(root.iter().any(|e| e.name == "data" && e.is_dir));
        assert!(root.iter().any(|e| e.name == "hd" && e.is_dir));
        // No file-with-same-name shadowing the directory.
        let by_path: Vec<_> = root.iter().filter(|e| e.path == "data").collect();
        assert_eq!(by_path.len(), 1, "exactly one entry per virtual path");
        assert!(by_path[0].is_dir);

        let excel = idx.list("data/data/global/excel");
        assert_eq!(excel.len(), 2);
        let levels = excel.iter().find(|e| e.name == "levels.txt").unwrap();
        assert_eq!(levels.size, 80_000);
        assert_eq!(
            levels.storage_path.as_deref(),
            Some("data:data\\global\\excel\\levels.txt")
        );

        let resolved = idx.resolve("data/data/global/excel/levels.txt").unwrap();
        assert_eq!(resolved.0, "data:data\\global\\excel\\levels.txt");
        assert_eq!(resolved.1, 80_000);
    }
}
