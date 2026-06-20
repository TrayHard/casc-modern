import { invoke } from "@tauri-apps/api/core";

export type StorageInfo = {
  product: string;
  build: number;
  local_file_count: number;
  total_file_count: number;
  features: number;
};

export type OpenResult = {
  info: StorageInfo;
  indexed_dirs: number;
  indexed_files: number;
};

export type IndexEntry = {
  name: string;
  path: string;
  storage_path: string | null;
  is_dir: boolean;
  size: number;
};

export type FileKind =
  | "Text"
  | "Blp"
  | "Dc6"
  | "Dcc"
  | "Dt1"
  | "Palette"
  | "Image"
  | "Binary";

export type FilePreview = {
  path: string;
  size: number;
  kind: FileKind;
  bytes: number[];
  truncated: boolean;
};

export type FileMeta = {
  path: string;
  storage_path: string;
  size: number;
  kind: FileKind;
};

export type Settings = {
  last_storage_path: string | null;
  last_export_dir: string | null;
  recent_storages: string[];
  bookmarks: Bookmark[];
};

export type Bookmark = {
  name: string;
  path: string;
  is_dir: boolean;
};

export const api = {
  openStorage: (path: string) => invoke<OpenResult>("open_storage", { path }),
  closeStorage: () => invoke<void>("close_storage"),
  listDir: (path: string) => invoke<IndexEntry[]>("list_dir", { path }),
  readFilePreview: (path: string, maxBytes: number) =>
    invoke<FilePreview>("read_file_preview", { path, maxBytes }),
  getFileMeta: (path: string) => invoke<FileMeta>("get_file_meta", { path }),
  getSettings: () => invoke<Settings>("get_settings"),
  setLastExportDir: (dir: string) => invoke<void>("set_last_export_dir", { dir }),
  setBookmarks: (bookmarks: Bookmark[]) =>
    invoke<void>("set_bookmarks", { bookmarks }),
  extractToTemp: (path: string) => invoke<string>("extract_to_temp", { path }),
  isInstalled: () => invoke<boolean>("is_installed"),

  searchNames: (query: string, useRegex: boolean, limit: number) =>
    invoke<NameHit[]>("search_names", { query, useRegex, limit }),
  searchContent: (
    query: string,
    glob: string | null,
    maxFileSize: number,
    caseInsensitive: boolean
  ) =>
    invoke<number>("search_content", {
      query,
      glob,
      maxFileSize,
      caseInsensitive,
    }),
  cancelSearch: () => invoke<void>("cancel_search"),

  exportPath: (virtualPath: string, targetDir: string) =>
    invoke<ExportSummary>("export_path", { virtualPath, targetDir }),
  exportPathAsPng: (virtualPath: string, targetDir: string) =>
    invoke<ExportSummary>("export_path_as_png", { virtualPath, targetDir }),
  cancelExport: () => invoke<void>("cancel_export"),

  decodeSprite: (path: string) => invoke<SpriteImage>("decode_sprite", { path }),
};

export type SpriteImage = {
  width: number;
  height: number;
  frame_count: number;
  frame_width: number;
  frame_height: number;
  png_b64: string;
};

export type NameHit = {
  path: string;
  is_dir: boolean;
  size: number;
};

export type ContentHit = {
  path: string;
  size: number;
  match_offset: number;
  match_count: number;
  excerpt: string;
};

export type SearchProgress = {
  scanned: number;
  total: number;
  current_path: string;
  matches_so_far: number;
};

export type SearchDone = {
  scanned: number;
  total: number;
  matches: number;
  cancelled: boolean;
  error: string | null;
  elapsed_ms: number;
};

export type ExportProgress = {
  current: number;
  total: number;
  current_path: string;
  bytes_written: number;
  errors: number;
};

export type ExportSummary = {
  files_written: number;
  bytes_written: number;
  errors: string[];
  cancelled: boolean;
  target_dir: string;
  elapsed_ms: number;
};

/// Parent of a normalized path. "" for root.
export function parentPath(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/// Last segment of a normalized path.
export function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
