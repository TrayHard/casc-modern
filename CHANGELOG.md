# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.2]: https://github.com/TrayHard/casc-modern/releases/tag/v0.1.2
[0.1.1]: https://github.com/TrayHard/casc-modern/releases/tag/v0.1.1
