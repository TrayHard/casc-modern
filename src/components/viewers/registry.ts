import { CodeViewer } from "./CodeViewer";
import { HexViewer } from "./HexViewer";
import { SpriteViewer } from "./SpriteViewer";
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

/// Ordered tabs presented for a file. First entry is the default tab.
const VIEWERS: Viewer[] = [
  {
    id: "sprite",
    label: "Image",
    matches: (m) => ext(m) === "sprite",
    Component: SpriteViewer,
  },
  {
    id: "json",
    label: "JSON",
    matches: (m) => JSON_LIKE_EXTS.has(ext(m)),
    Component: (props) => CodeViewer({ ...props, prettyJson: true }),
  },
  {
    id: "code",
    label: "Text",
    matches: (m) =>
      CODE_EXTS.has(ext(m)) && !JSON_LIKE_EXTS.has(ext(m)),
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
