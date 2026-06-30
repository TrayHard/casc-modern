# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-07-01

### Added
- **Export preserving the full folder tree**: a new "…with full path" entry in
  the file, folder, and multi-select context menus recreates each item's
  complete virtual path from the storage root under the chosen target — pick a
  folder (or the root) and the original directory structure is reproduced on
  disk, mirroring the classic CascView "keep full path" extraction. The
  existing entries are unchanged: "Export folder…" still flattens a folder's
  contents directly into the target.

## [0.2.0] - 2026-06-21

### Added
- **Format & folder icons** in the tree and the directory list, driven by a
  single swappable icon palette (`src/lib/fileIcons.tsx`) rather than hardcoded
  per-call-site conditionals — groundwork for future theming.
- **Image viewers for standard raster formats** (`.tga`, `.bmp`, `.png`,
  `.jpg`) decoded in Rust via the `image` crate, with the same percent-zoom
  controls as the sprite viewer.
- **Mini thumbnails in the tree** for image-like files (sprites + the raster
  formats above): the first sprite frame or a downscaled image, decoded lazily
  for visible nodes only, cached, and capped by file size — with the format
  icon as a fallback.
- **"Not downloaded" indicator**: files that are indexed but whose data isn't
  present in the local storage (other locales, on-demand cinematics) are dimmed
  and tagged with a cloud icon in both the tree and the directory list, using
  CascLib's per-file availability flag.
- **App settings panel** (gear in the header) — persisted preferences for: the
  JSON/text size threshold above which files open externally instead of inline;
  image thumbnails in the tree; image thumbnails in the directory list; hiding
  other-locale files/folders; and the format-icon theme.
- **Icon themes**: the default palette plus a built-in monochrome theme, and
  import of custom themes from a JSON file (glyph vocabulary + per-extension
  colors). Applies live.
- **TSV table viewer**: D2R's tab-separated `.txt` tables render as a sortable,
  both-axis–virtualized grid with a row filter and resizable columns; non-tabular
  text falls back to the Text tab.
- **Hide other locales**: a setting filters files/folders whose locale doesn't
  match the storage's installed locale, using per-file `dwLocaleFlags` and a
  per-directory aggregated mask.
- **DC6 viewer** for classic Diablo II graphics (`.dc6`): frame stepping, zoom
  with Fit/1:1, and a palette picker (default "units"); decoded and
  palette-applied in Rust (index 0 transparent).
- **Copy name** in the right-click menu (alongside Copy path).
- **Shift-click a folder's collapse arrow** to also collapse every nested
  folder under it.
- **Search "only downloaded files"** filter (on by default) skips
  indexed-but-not-downloaded files in both name and content search.
- **Hide low-quality sprites** setting (on by default) drops the
  `*.lowend.sprite` duplicates (every sprite ships a high + lowend pair, 1:1);
  the sprite viewer gained a **High / Low** quality toggle to switch in place.
- **Auto-sized TSV columns**: table columns fit their widest cell or header on
  load (clamped), and double-clicking a column border refits that one column.

### Changed
- **Image / sprite / DC6 viewers** open at 100% zoom with **Fit** / **1:1**
  controls (plain buttons, even-height info pills, no frame around the image)
  and zoom from 1%.
- **Defaults**: JSON/text external-open threshold is now 2 MB and the table-grid
  overscan is 16 (existing settings are migrated up on launch).
- **DC6 / sprite previews** now appear as mini icons in the tree and directory
  list, and `.dc6` can be exported as PNG (right-click → Export as PNG, or the
  button in the viewer; multi-frame files export one PNG per frame).
- **Settings** moved into **General** / **Performance** tabs; the Performance
  tab holds the JSON/text external-open threshold and a table-grid overscan.
- **Resizable layout**: the divider between the tree and the right panel can be
  dragged (with sensible min sizes).
- **Storage tree** keeps each entry on a single line, scrolls horizontally for
  long names, and disallows text selection. Rows are kept cheap (precomputed
  icons, no per-node Tooltips/animation) so virtual scrolling stays smooth, and
  the connector lines were dropped.
- **Directory rows** darken on hover for clearer cursor indication; native
  scroll areas (TSV grid, directory table) use thin dark scrollbars.
- **Bookmarks / navigation** center the target node in the tree (and expand the
  folder) instead of leaving it at the bottom edge.
- **TSV table viewer** rewritten on `@tanstack/react-virtual` with **both-axis
  virtualization** (antd's table renders every column, which janked on D2R's
  100+-column tables); adds click-to-sort, a row filter, resizable columns, and
  fits the height so the window edge stays visible.

### Removed
- **`.dds` preview.** Almost all of D2R's `.dds` are 3D volume textures (color
  LUTs, hair volumes) that don't read as 2D images; the dedicated decoder and
  dependency were removed. `.dds` now opens in the Hex view only.

### Fixed
- Binary files with a JSON-ish extension (e.g. a binary `.particles`) no longer
  open in the JSON/Text tabs — those viewers now require a text content sniff.
- **Localized JSON opens as JSON again.** The text sniff now accepts valid
  UTF-8 (and a leading BOM), so strings files with CJK/accented characters are
  no longer misclassified as binary and hidden behind the Hex-only view.
- **UI no longer freezes ("Not responding") while decoding a large image** —
  sprite/image/thumbnail decoding moved off the UI thread (async +
  `spawn_blocking`).
- **The sprite frame list ("+N") opens again** — the overflow popover gated its
  content to empty, which left antd's trigger unwired, so clicking did nothing;
  it now opens on click with a memoized frame grid.

### Performance
- **Directory table virtualized** so large folders only mount the rows on
  screen and re-sorting is O(viewport), not O(rows).
- **DC6 frames load lazily** — a metadata-only command plus a per-frame command
  replace shipping every glyph of a font as base64 in one payload; the thumbnail
  strip fetches frames as they scroll into view, and palette switches only
  refetch what's visible.
- **Lighter viewer IPC** — the TSV table reads decoded text instead of a boxed
  byte array, and the sprite/image viewers hold the decoded PNG as a Blob object
  URL rather than a duplicate `data:` string.
- **Fewer spurious re-renders** — a settings toggle no longer refetches the tree
  root or loses expansion state; off-screen thumbnail decodes are cancelled so
  they don't block the rows on screen.

## [0.1.6] - 2026-06-21

### Fixed
- **0.1.5 shipped with all UI styling missing — fixed.** The startup-flash
  change added an inline `<style>` to `index.html`, which Tauri hashes into the
  Content-Security-Policy; that disables `'unsafe-inline'` and so blocked Ant
  Design's runtime styles. The dark startup is preserved (window background +
  stylesheet).

## [0.1.5] - 2026-06-21

### Fixed
- No more white flash on startup — the window paints dark immediately (dark
  window / WebView2 background) instead of flashing white before the UI loads.

## [0.1.4] - 2026-06-21

### Fixed
- **Ctrl+F** now opens Search instead of the WebView2 find bar — browser
  accelerator keys are disabled so the shortcut reaches the app.
- The update prompt renders changelog formatting (headings, bullet points)
  instead of showing raw Markdown.

## [0.1.3] - 2026-06-21

### Added
- The search field is focused automatically when the Search panel opens, so
  Ctrl+F / F3 drops the cursor straight into it, ready to type.

## [0.1.2] - 2026-06-21

### Added
- Open Search from anywhere with **Ctrl+F** or **F3** when no text-like file is
  open (with a file open, those keys still drive its in-viewer search).
- The current app version is shown in the title bar.
- The update prompt now lists what's new and how many releases you're behind,
  read straight from this changelog.

### Fixed
- Search panel: removed the duplicate close button and aligned the remaining
  one to the top-right corner.

## [0.1.1] - 2026-06-20

Initial public release.

### Added
- CASC storage browser for Diablo II: Resurrected, built on vendored
  [CascLib](https://github.com/ladislav-zezula/CascLib) via a hand-written FFI
  layer (`crates/casclib-sys`) — no bindgen, no system CascLib required.
- Lazy-loaded virtual file tree, directory view, and unified selection model.
- Explorer-style multi-select in the directory view (Ctrl / Shift) with
  "Export selected" to extract exactly the files you pick.
- File name and content search.
- Viewers: hex preview, CodeMirror (JSON/HTML/JS/CSS/Python/text), and a custom
  SpA1 sprite decoder with an animated-atlas frame slider.
- Recursive export of files and folders; "Export as PNG" for sprites.
- `casc` CLI (`info` / `list` / `extract` / `cat`) sharing the same engine.
- Settings persistence with forward-compatible schema (`#[serde(default)]`).
- Signed auto-updater (minisign) for installed builds.

### Fixed
- "Open externally" now works (the opener path scope was missing).
- Bulk PNG export no longer aborts the whole batch on a single malformed
  sprite, and large atlases no longer overflow.

[0.3.0]: https://github.com/TrayHard/casc-modern/releases/tag/v0.3.0
[0.2.0]: https://github.com/TrayHard/casc-modern/releases/tag/v0.2.0
[0.1.6]: https://github.com/TrayHard/casc-modern/releases/tag/v0.1.6
[0.1.5]: https://github.com/TrayHard/casc-modern/releases/tag/v0.1.5
[0.1.4]: https://github.com/TrayHard/casc-modern/releases/tag/v0.1.4
[0.1.3]: https://github.com/TrayHard/casc-modern/releases/tag/v0.1.3
[0.1.2]: https://github.com/TrayHard/casc-modern/releases/tag/v0.1.2
[0.1.1]: https://github.com/TrayHard/casc-modern/releases/tag/v0.1.1
