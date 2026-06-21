import { invoke } from "@tauri-apps/api/core";

export type StorageInfo = {
  product: string;
  build: number;
  local_file_count: number;
  total_file_count: number;
  features: number;
  /** Bitmask of locales installed in this storage (CASC_LOCALE_*). */
  installed_locales: number;
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
  /** False for indexed-but-not-downloaded files (online-only / other locales). */
  local: boolean;
  /** Locale bitmask (files: dwLocaleFlags; dirs: aggregated). 0 = neutral. */
  locale_flags: number;
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

export type TextPreview = {
  text: string;
  size: number;
  truncated: boolean;
};

export type Settings = {
  last_storage_path: string | null;
  last_export_dir: string | null;
  recent_storages: string[];
  bookmarks: Bookmark[];
  preferences: Preferences;
};

/** User-facing preferences (the Settings panel). Mirrors Rust `Preferences`. */
export type Preferences = {
  json_external_threshold_bytes: number;
  thumbnails_in_tree: boolean;
  thumbnails_in_browser: boolean;
  hide_other_locales: boolean;
  icon_theme: string;
  /** Imported icon themes (opaque JSON owned by the frontend). */
  custom_icon_themes: IconThemeJson[];
  /** Extra rows/cols rendered beyond the viewport in virtualized grids. */
  table_overscan: number;
  /** Hide `*.lowend.sprite` low-quality variants from the tree / browser. */
  hide_lowend: boolean;
};

/** Shape of an icon theme (default + imported). See lib/fileIcons. */
export type IconThemeJson = {
  name: string;
  folder?: IconSpecJson;
  file?: IconSpecJson;
  byExt?: Record<string, IconSpecJson>;
};

export type IconSpecJson = { icon: string; color: string };

export const DEFAULT_PREFERENCES: Preferences = {
  json_external_threshold_bytes: 2 * 1024 * 1024,
  thumbnails_in_tree: true,
  thumbnails_in_browser: true,
  hide_other_locales: false,
  icon_theme: "default",
  custom_icon_themes: [],
  table_overscan: 16,
  hide_lowend: true,
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
  /** Decoded UTF-8 text (BOM-stripped) — cheaper than bytes for big tables. */
  readTextPreview: (path: string, maxBytes: number) =>
    invoke<TextPreview>("read_text_preview", { path, maxBytes }),
  getFileMeta: (path: string) => invoke<FileMeta>("get_file_meta", { path }),
  getSettings: () => invoke<Settings>("get_settings"),
  setLastExportDir: (dir: string) => invoke<void>("set_last_export_dir", { dir }),
  setBookmarks: (bookmarks: Bookmark[]) =>
    invoke<void>("set_bookmarks", { bookmarks }),
  setPreferences: (preferences: Preferences) =>
    invoke<void>("set_preferences", { preferences }),
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),
  extractToTemp: (path: string) => invoke<string>("extract_to_temp", { path }),
  isInstalled: () => invoke<boolean>("is_installed"),

  searchNames: (
    query: string,
    useRegex: boolean,
    limit: number,
    localOnly: boolean
  ) => invoke<NameHit[]>("search_names", { query, useRegex, limit, localOnly }),
  searchContent: (
    query: string,
    glob: string | null,
    maxFileSize: number,
    caseInsensitive: boolean,
    localOnly: boolean
  ) =>
    invoke<number>("search_content", {
      query,
      glob,
      maxFileSize,
      caseInsensitive,
      localOnly,
    }),
  cancelSearch: () => invoke<void>("cancel_search"),

  exportPath: (virtualPath: string, targetDir: string) =>
    invoke<ExportSummary>("export_path", { virtualPath, targetDir }),
  exportPaths: (paths: string[], targetDir: string) =>
    invoke<ExportSummary>("export_paths", { paths, targetDir }),
  exportPathAsPng: (virtualPath: string, targetDir: string) =>
    invoke<ExportSummary>("export_path_as_png", { virtualPath, targetDir }),
  cancelExport: () => invoke<void>("cancel_export"),

  decodeSprite: (path: string) => invoke<SpriteImage>("decode_sprite", { path }),
  /** Cheap DC6 metadata (frame geometry, no pixels). */
  dc6Info: (path: string) => invoke<Dc6Info>("dc6_info", { path }),
  /** One DC6 frame as a base64 PNG, for the given palette. */
  dc6Frame: (path: string, palette: string | undefined, frame: number) =>
    invoke<Dc6FrameImage>("dc6_frame", { path, palette: palette ?? null, frame }),
  decodeImage: (path: string) => invoke<RasterImage>("decode_image", { path }),
  /** Small PNG (base64) preview: first sprite frame or a downscaled image. */
  thumbnail: (path: string, max: number) =>
    invoke<string>("thumbnail", { path, max }),
};

export type RasterImage = {
  width: number;
  height: number;
  png_b64: string;
};

export type SpriteImage = {
  width: number;
  height: number;
  frame_count: number;
  frame_width: number;
  frame_height: number;
  png_b64: string;
};

export type Dc6FrameImage = {
  width: number;
  height: number;
  offset_x: number;
  offset_y: number;
  png_b64: string;
};

export type Dc6FrameMeta = {
  width: number;
  height: number;
  offset_x: number;
  offset_y: number;
};

export type Dc6Info = {
  directions: number;
  frames_per_dir: number;
  frame_count: number;
  frames: Dc6FrameMeta[];
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

/// Tauri rejects a `Result<_, ApiError>` command with the serialized error
/// object `{ message }`. Interpolating that straight into a string yields the
/// useless "[object Object]"; pull the human message out, falling back to the
/// raw value for plain-string throws.
export function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(e);
}

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
