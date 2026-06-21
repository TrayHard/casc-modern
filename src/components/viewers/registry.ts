import { CodeViewer } from "./CodeViewer";
import { HexViewer } from "./HexViewer";
import { SpriteViewer } from "./SpriteViewer";
import { Dc6Viewer } from "./Dc6Viewer";
import { MediaViewer } from "./MediaViewer";
import { ImageViewer } from "./ImageViewer";
import { TsvViewer } from "./TsvViewer";
import type { Viewer } from "./types";
import type { FileMeta } from "../../lib/api";

function ext(meta: FileMeta): string {
  const dot = meta.path.lastIndexOf(".");
  return dot > 0 ? meta.path.slice(dot + 1).toLowerCase() : "";
}

const JSON_LIKE_EXTS = new Set([
  "json",
  "model",
  "skeleton",
  "animations",
  "particles",
  "physics",
  "cloth",
  "timelines",
  "params",
  "frontend",
  "fltr",
]);

const CODE_EXTS = new Set([
  ...JSON_LIKE_EXTS,
  "txt",
  "html",
  "htm",
  "js",
  "mjs",
  "css",
  "py",
  "bat",
  "h",
  "log",
  "srt",
  "tsx",
  "ts",
]);

/// Browser-playable audio and video containers (D2R ships .flac audio and
/// .webm cinematics). Other audio/video formats fall through to hex.
const MEDIA_EXTS = new Set([
  "flac",
  "ogg",
  "wav",
  "mp3",
  "m4a",
  "opus",
  "aac",
  "webm",
  "mp4",
  "ogv",
  "mov",
]);

/// Standard raster images decodable by the `image` crate. The SpA1 ".sprite"
/// format has its own viewer above. (PCX/DDS aren't useful to preview here.)
const IMAGE_EXTS = new Set(["tga", "bmp", "png", "jpg", "jpeg"]);

/// Tab-separated tables (D2R ships Excel data as .txt). Shown as the default
/// tab for these; TsvViewer falls back gracefully for non-tabular text.
const TSV_EXTS = new Set(["txt", "tsv"]);

/// Ordered tabs presented for a file. First entry is the default tab.
const VIEWERS: Viewer[] = [
  {
    id: "sprite",
    label: "Image",
    matches: (m) => ext(m) === "sprite",
    Component: SpriteViewer,
  },
  {
    id: "dc6",
    label: "Image",
    matches: (m) => ext(m) === "dc6",
    Component: Dc6Viewer,
  },
  {
    id: "media",
    label: "Play",
    matches: (m) => MEDIA_EXTS.has(ext(m)),
    Component: MediaViewer,
  },
  {
    id: "image",
    label: "Image",
    matches: (m) => IMAGE_EXTS.has(ext(m)),
    Component: ImageViewer,
  },
  {
    id: "json",
    label: "JSON",
    // Gate on the content sniff: a binary file with a json-ish extension
    // (e.g. a binary .particles) must NOT open in the JSON tab.
    matches: (m) => JSON_LIKE_EXTS.has(ext(m)) && m.kind === "Text",
    Component: (props) => CodeViewer({ ...props, prettyJson: true }),
  },
  {
    id: "table",
    label: "Table",
    matches: (m) => TSV_EXTS.has(ext(m)) && m.kind === "Text",
    Component: TsvViewer,
  },
  {
    id: "code",
    label: "Text",
    matches: (m) =>
      CODE_EXTS.has(ext(m)) && !JSON_LIKE_EXTS.has(ext(m)) && m.kind === "Text",
    Component: CodeViewer,
  },
  {
    id: "text",
    label: "Text",
    // Plain-text sniff for files without a recognized extension.
    matches: (m) => m.kind === "Text" && !CODE_EXTS.has(ext(m)),
    Component: CodeViewer,
  },
  {
    id: "hex",
    label: "Hex",
    matches: () => true,
    Component: HexViewer,
  },
];

export function viewersFor(meta: FileMeta): Viewer[] {
  return VIEWERS.filter((v) => v.matches(meta));
}
