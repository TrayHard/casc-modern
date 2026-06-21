import type { ComponentType, CSSProperties, ReactNode } from "react";
import {
  BgColorsOutlined,
  CodeOutlined,
  DatabaseOutlined,
  FileImageOutlined,
  FileOutlined,
  FileTextOutlined,
  FolderOutlined,
  FontColorsOutlined,
  SoundOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";
import type { IconSpecJson, IconThemeJson } from "./api";

type IconComp = ComponentType<{ style?: CSSProperties }>;

// ── Icon vocabulary ─────────────────────────────────────────────────────────
// A fixed set of named glyphs. Themes reference these by key (a string), so a
// theme is plain JSON — no React components — and can be imported/exported.
export const ICON_VOCAB: Record<string, IconComp> = {
  file: FileOutlined,
  folder: FolderOutlined,
  image: FileImageOutlined,
  audio: SoundOutlined,
  video: VideoCameraOutlined,
  code: CodeOutlined,
  text: FileTextOutlined,
  palette: BgColorsOutlined,
  font: FontColorsOutlined,
  data: DatabaseOutlined,
};

export const ICON_VOCAB_KEYS = Object.keys(ICON_VOCAB);

export type IconSpec = { icon: string; color: string };
/// A fully-resolved theme (folder + default file + per-extension overrides).
export type IconTheme = {
  name: string;
  folder: IconSpec;
  file: IconSpec;
  byExt: Record<string, IconSpec>;
};

const img = (color: string): IconSpec => ({ icon: "image", color });

// ── Built-in default theme ──────────────────────────────────────────────────
export const DEFAULT_THEME: IconTheme = {
  name: "default",
  folder: { icon: "folder", color: "#e8b339" },
  file: { icon: "file", color: "#8c8c8c" },
  byExt: {
    // images
    sprite: img("#36cfc9"),
    dds: img("#36cfc9"),
    tga: img("#36cfc9"),
    bmp: img("#36cfc9"),
    pcx: img("#36cfc9"),
    png: img("#36cfc9"),
    jpg: img("#36cfc9"),
    jpeg: img("#36cfc9"),
    // legacy D2 graphics
    dc6: img("#ffa940"),
    dcc: img("#ffa940"),
    dt1: img("#ffa940"),
    // palettes
    pl2: { icon: "palette", color: "#ff85c0" },
    pal: { icon: "palette", color: "#ff85c0" },
    // audio
    flac: { icon: "audio", color: "#b37feb" },
    ogg: { icon: "audio", color: "#b37feb" },
    wav: { icon: "audio", color: "#b37feb" },
    mp3: { icon: "audio", color: "#b37feb" },
    opus: { icon: "audio", color: "#b37feb" },
    // video
    webm: { icon: "video", color: "#ff7875" },
    mp4: { icon: "video", color: "#ff7875" },
    ogv: { icon: "video", color: "#ff7875" },
    // structured / json-like
    json: { icon: "code", color: "#73d13d" },
    model: { icon: "code", color: "#73d13d" },
    skeleton: { icon: "code", color: "#73d13d" },
    animations: { icon: "code", color: "#73d13d" },
    particles: { icon: "code", color: "#73d13d" },
    physics: { icon: "code", color: "#73d13d" },
    cloth: { icon: "code", color: "#73d13d" },
    timelines: { icon: "code", color: "#73d13d" },
    params: { icon: "code", color: "#73d13d" },
    frontend: { icon: "code", color: "#73d13d" },
    fltr: { icon: "code", color: "#73d13d" },
    // text / code
    txt: { icon: "text", color: "#bfbfbf" },
    log: { icon: "text", color: "#bfbfbf" },
    srt: { icon: "text", color: "#bfbfbf" },
    bat: { icon: "text", color: "#bfbfbf" },
    html: { icon: "code", color: "#ff9c6e" },
    htm: { icon: "code", color: "#ff9c6e" },
    js: { icon: "code", color: "#ffd666" },
    mjs: { icon: "code", color: "#ffd666" },
    css: { icon: "code", color: "#69c0ff" },
    py: { icon: "code", color: "#95de64" },
    // fonts
    ttf: { icon: "font", color: "#d3adf7" },
    otf: { icon: "font", color: "#d3adf7" },
    // D2 data
    cof: { icon: "data", color: "#ffc069" },
    ds1: { icon: "data", color: "#ffc069" },
    tbl: { icon: "data", color: "#ffc069" },
    bin: { icon: "data", color: "#ffc069" },
    dat: { icon: "data", color: "#ffc069" },
  },
};

// A second built-in to demonstrate the theming pipeline: one calm gray glyph
// per category, no per-extension colors.
const MONOCHROME_THEME: IconTheme = {
  name: "monochrome",
  folder: { icon: "folder", color: "#9e9e9e" },
  file: { icon: "file", color: "#8c8c8c" },
  byExt: {},
};

export const BUILTIN_THEMES: IconTheme[] = [DEFAULT_THEME, MONOCHROME_THEME];

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/// The spec for an entry under a given theme. Per-extension wins, else the
/// theme's default file spec; directories use the folder spec.
function specFor(theme: IconTheme, name: string, isDir: boolean): IconSpec {
  if (isDir) return theme.folder;
  return theme.byExt[extOf(name)] ?? theme.file;
}

/// Render the icon for an entry under a specific theme.
export function iconFromTheme(
  theme: IconTheme,
  name: string,
  isDir: boolean
): ReactNode {
  const spec = specFor(theme, name, isDir);
  const Comp = ICON_VOCAB[spec.icon] ?? FileOutlined;
  return <Comp style={{ color: spec.color }} />;
}

/// Convenience for callers without theme context: render under the default.
export function fileIcon(name: string, isDir: boolean): ReactNode {
  return iconFromTheme(DEFAULT_THEME, name, isDir);
}

/// Resolve the active theme by name, merging imported overrides on top of the
/// built-in default so a custom theme can override only some extensions.
export function resolveTheme(name: string, custom: IconThemeJson[]): IconTheme {
  if (!name || name === "default") return DEFAULT_THEME;
  const builtin = BUILTIN_THEMES.find((t) => t.name === name);
  if (builtin) return builtin;
  const c = custom.find((t) => t.name === name);
  if (!c) return DEFAULT_THEME;
  return {
    name: c.name,
    folder: c.folder ?? DEFAULT_THEME.folder,
    file: c.file ?? DEFAULT_THEME.file,
    byExt: { ...DEFAULT_THEME.byExt, ...(c.byExt ?? {}) },
  };
}

/// All selectable theme names (built-ins + imported), de-duplicated.
export function themeNames(custom: IconThemeJson[]): string[] {
  const names = BUILTIN_THEMES.map((t) => t.name);
  for (const c of custom) if (!names.includes(c.name)) names.push(c.name);
  return names;
}

function isSpec(v: unknown): v is IconSpecJson {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as IconSpecJson).icon === "string" &&
    typeof (v as IconSpecJson).color === "string"
  );
}

/// Validate + normalize imported theme JSON. Returns null if unusable. Unknown
/// glyph keys are coerced to "file" so a bad import never throws at render.
export function validateIconThemeJson(value: unknown): IconThemeJson | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== "string" || !v.name.trim()) return null;
  const norm = (s: IconSpecJson): IconSpecJson => ({
    icon: ICON_VOCAB[s.icon] ? s.icon : "file",
    color: s.color,
  });
  const out: IconThemeJson = { name: v.name.trim() };
  if (isSpec(v.folder)) out.folder = norm(v.folder);
  if (isSpec(v.file)) out.file = norm(v.file);
  if (v.byExt && typeof v.byExt === "object") {
    const byExt: Record<string, IconSpecJson> = {};
    for (const [k, spec] of Object.entries(v.byExt as Record<string, unknown>)) {
      if (isSpec(spec)) byExt[k.toLowerCase()] = norm(spec);
    }
    out.byExt = byExt;
  }
  return out;
}
