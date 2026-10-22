# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Communication

Always respond to the user in the language they use to address you (e.g. reply
in Russian if they write in Russian, in English if they write in English).
This applies to chat responses only — code, comments, identifiers, and commit
messages stay in English to match the existing conventions.

Commit messages must contain **no AI attribution of any kind** — no
`Co-Authored-By: Claude …`, no "Generated with Claude Code" trailers, nothing
similar. Plain message only.

## Commit vs. release — two separate actions

"Commit" and "publish a new version" are **distinct actions and must never be
conflated**:

- **Commit** (`git commit`, optionally push) = saving work to git history.
  Nothing else. When the user says "commit", do ONLY that — never bump the
  version, build, tag a `vX.Y.Z`, or create a GitHub release.
- **Release / publish a new version** = the full versioned signed-build flow.
  This is a maintainer-only process, gated on the private updater key and
  documented separately (not part of the public repo). It happens **only**
  when the user explicitly asks to release or publish a new version.

A release *contains* commits, but a plain commit never escalates into a release.

## Work for other projects

Keep this repository's public files specific to CASC Modern. Save notes, data,
exports, scripts, and selection presets for any other project or service under
`local-only/other-projects/<project-name>/`. The entire `local-only/` directory
is ignored by Git. Do not add its contents to commits or move them into public
documentation or source fixtures. Use `--tags-file` when a CLI command needs a
project-specific preset from that directory. Keep CASC Modern's release keys
and build helpers in `nogit/`.

## What this is

A Tauri 2 (Rust) + React 18 / Vite (TypeScript) desktop app — a CASC storage
browser focused on Diablo II: Resurrected modding. The underlying engine is
[CascLib](https://github.com/ladislav-zezula/CascLib) (Ladislav Zezula, MIT),
**vendored** under `vendor/CascLib/` and built from C++ source by the `cc`
crate — there is **no cmake / no bindgen** in the build path, and no system
CascLib install is required. The custom SpA1 sprite decoder under
`crates/casc-core/src/formats/spa1.rs` replaces the closed-source
D2RSpriteConverter.

## Commands

```bash
npm install                  # frontend deps + tauri-cli
npm run dev                  # Vite dev server only (no Tauri shell)
npm run tdev                 # tauri dev — actual desktop app, hot reload
npm run tcheck               # tsc --noEmit — TypeScript type gate
npm run build                # tsc + vite build (frontend bundle only)
npm run tbuild               # tauri build → portable exe + MSI (unsigned)
cargo test -p casc-core -p casc-cli   # Rust tests (FileIndex, decoders, CLI path matching)
cargo run -p casc-cli --quiet -- <subcommand>   # `casc info|list|extract|extract-all|cat`
cargo install --path crates/casc-cli            # put `casc` on PATH
```

### Pulling game files from the terminal (`casc` CLI)

Use the CLI instead of the GUI when you need game files. Every command takes
the storage root first (the D2R install folder, e.g.
`"D:/Games/Diablo II Resurrected"`).

```bash
casc list   STORAGE --filter excel/skills          # find paths
casc cat    STORAGE data/data/global/excel/skills.txt
casc extract STORAGE data/data/global/excel/skills.txt -o skills.txt
casc extract-all STORAGE -o out --tag skills --tag strings
casc list   STORAGE -m --tag skills                # mod copies over CASC
casc extract-all STORAGE -m --filter hd/global/ui/spells --convert webp --flat -o icons
```

- Paths work in both forms: the GUI path `data/data/global/x` and the CascLib
  name `data:data\global\x` that `list` prints. Note the product root: it is
  `data/data/global/...`, not `data/global/...`.
- `--tag NAME` selects a named set of folders and files from
  `casc-tags.json` in the current directory (`--tags-file` overrides). The file
  is `{"tag": ["folder or file path", ...]}`; a folder covers everything under
  it. Edit it to add or change sets. `list --tag NAME` previews a set; a path
  that matches nothing prints a warning.
- `extract-all` keeps the GUI folder structure under `-o` and exits non-zero if
  nothing matched or any file failed. `--flat` instead writes every file
  straight into `-o` as its lowercase basename (`skills.txt`) and fails before
  writing if two files share a basename.
- `extract-all --convert FORMAT` (`png`, `webp`, `webp-lossless`, `jpeg`,
  `avif`) writes each `.sprite` as images: one frame gives `name.webp`, more
  give `name_0.webp` … `name_{N-1}.webp` (0-based frame index; for skill icon
  sheets it is `IconCel` from skilldesc.txt). It skips `*.lowend.sprite` and
  legacy `*.dc6`, copies all other files unchanged, and counts a sprite that
  fails to decode as a failed file. `--flat` checks clashes on the final image
  names. `--quality N` (0–100, default 90) applies to `webp`, `jpeg` and `avif`.
- `-m` / `--mod` (on `list`, `cat`, `extract`, `extract-all`) overlays an
  unpacked mod: files in the mod replace their CASC copies, and mod-only files
  join the selection. `-m` alone takes the only mod in `STORAGE/mods`,
  `-m=NAME` takes `STORAGE/mods/NAME/NAME.mpq`, and `-m=PATH` takes a mod or
  `*.mpq` folder anywhere. The value needs `=`, so a bare `-m` never eats the
  next argument. A mod mirrors the `data:` root: `<mpq>/data/global/x`
  overrides `data/data/global/x`. `list -m` adds a `mod`/`base` column (JSON:
  `"source"`).

`tcheck` is the only frontend gate — there is no linter. For UI changes,
**verify in the actual running app** (`npm run tdev`); `tcheck` and a passing
`vite build` do not catch runtime errors or visual bugs.

`dev.bat` at the repo root is a one-liner shortcut for `npm run tdev` and is
**gitignored** on purpose (local convenience only).

### Release

**Every release must update `CHANGELOG.md` before building.** Add a new
`## [x.y.z] - YYYY-MM-DD` section at the top (above the previous version) in the
Keep a Changelog format already in the file — `### Added` / `### Changed` /
`### Fixed` bullets covering the user-visible changes — and add the matching
`[x.y.z]: …/releases/tag/vx.y.z` link reference at the bottom. This is **not
optional**: the release tooling embeds `CHANGELOG.md` into the updater manifest
(`latest.json`'s `notes`), and the app parses it to show users what changed and
how many releases they skipped. Keep the version in `CHANGELOG.md`,
`package.json`, `src-tauri/tauri.conf.json`, and `Cargo.toml` in lockstep.

Producing a **signed, auto-updatable** release is a maintainer-only flow that
depends on the private updater key (kept outside the repo) — it is **not** part
of the public repository. Maintainers: see `nogit/CLAUDE.release.md` for the
full procedure, asset list, and key-handling rules.

Public contributors never need any of that — `npm run tbuild` produces a plain
unsigned local build (`tauri build`).

## Architecture

### Workspace layout

```
crates/
  casclib-sys/    # hand-written FFI declarations for CascLib's C API.
                  # No bindgen — sources listed manually in build.rs.
                  # build.rs compiles vendor/CascLib/src/**/*.cpp via the
                  # `cc` crate (plus its bundled zlib). Don't add bindgen.
  casc-core/      # Safe Rust wrapper over casclib-sys + per-format decoders.
                  # Owns FileIndex, Storage, FileKind, formats::spa1.
                  # The only crate that should expose unsafe to nobody else.
  casc-cli/       # `casc` CLI (clap-based) — same engine as the GUI.
src-tauri/        # Tauri 2 backend. Thin IPC layer over casc-core.
                  # Modules: settings, search, export, sprites.
src/              # React 18 + Vite + antd. Single SPA.
vendor/CascLib/   # Vendored MIT-licensed C++ source. UPSTREAM.md records
                  # the commit it was synced from. Refresh by re-cloning
                  # and removing the inner .git/.
nogit/            # Local-only. Keys, build scripts, release.bat. Gitignored.
```

### Selection model is unified across panels

The right pane shows directory contents *or* a file preview based on a single
`Selection` (`src/lib/selection.ts`). The tree on the left, the directory view
on the right, the search drawer, the bookmarks bar, and the Back button all
mutate the same `selection: Selection | null` state in `App.tsx`. When you
change it, `StorageTree` walks the path's ancestors via `ensureLoaded`,
expands them, selects the leaf, and `Tree.scrollTo` brings it into view.

Don't add a parallel "currently selected file path" state — extend `Selection`
instead.

### FileIndex finalize() resolves CASC pseudo-files

`FileIndex` (`crates/casc-core/src/index.rs`) builds the virtual tree from
CascLib's `walk()`. CASC enumerates artifacts like `data:` (no path after the
colon) — empty product roots that would land at root level as a file named
`data`, colliding with the directory `data/data/foo.txt` would create. `add()`
skips paths ending in `:` and `finalize()` drops any remaining file that
shadows a sibling directory at the same level. Without finalize the tree
shows duplicate keys and antd's virtual list goes haywire.

`Storage::build_index()` calls `finalize()` for you. If you add another path
ingest route, call it.

### Viewer registry (formats / kinds)

`src/components/viewers/registry.ts` is the single dispatch table. To add a
new viewer:

1. Add a decoder under `crates/casc-core/src/formats/<name>.rs` (see
   `spa1.rs` as the reference — header parse, RGBA decode, PNG encode).
2. Expose a Tauri command in `src-tauri/src/` that fetches the bytes via
   `AppState.opened.storage.read()`, calls the decoder, and returns a typed
   struct (PNG-as-base64 for images, text for parsed structures).
3. Add the viewer component under `src/components/viewers/`, conforming to
   the `Viewer` interface (matcher + `Component`).
4. Register it in `registry.ts`. Match by extension when possible — `FileKind`
   sniffing is the fallback.

CodeMirror handles JSON / HTML / JS / CSS / Python / plain text. The
`JSON-like` set in `CodeViewer.tsx` covers D2R Toolbox formats (`.model`,
`.skeleton`, etc.) — they're JSON internally even without the `.json`
extension.

### Settings: `#[serde(default)]` is load-bearing

`src-tauri/src/settings.rs`'s `Settings` struct uses `#[serde(default)]` on
every field, and `load()` falls back to `Settings::default()` on any parse
error. This is how the app survives schema drift between versions. **Never
remove or rename an existing field** — only add new ones (with `#[serde(default)]`).
Renames break old `settings.json` files silently.

### Updater: installed vs portable split

`is_installed()` (Rust) heuristically detects whether the running exe lives
under `\Program Files`, `\AppData\Local\Programs`, `/usr/bin`, `/opt`, or
`/Applications`. `UpdateButton` branches on it:

- Installed + update available → `Update.downloadAndInstall()` + `relaunch()`.
- Portable + update available → opens the GitHub releases URL via
  `tauri-plugin-opener`. The silent MSI installer would create a parallel
  install while the user keeps running the stale portable exe.

If you change `tauri.conf.json#identifier` or `productName`, Windows treats
the next MSI as a different product and parallel-installs alongside the old
one. **Don't.**

### Ctrl+F: WebView2 Find Bar is suppressed app-wide

WebView2 ships its own Find Bar bound to Ctrl+F. App-level `keydown` handler
in `App.tsx` calls `preventDefault` for `Ctrl/Cmd+F`, `Ctrl+G`, and `F3` so
the native bar never appears. `CodeViewer` then captures Ctrl+F at the
window level too and calls `openSearchPanel(editorView)` directly — needed
because CodeMirror's keymap only fires when its content element has focus,
and the user often hits Ctrl+F without clicking inside the editor first.

If you add another searchable surface, hook into the same App-level pattern;
don't try to re-enable the WebView2 bar.

### IPC payload sizes

Tauri serializes `Vec<u8>` as a JSON array of numbers — fine for ≤ 1 MB,
miserable above that. The sprite viewer returns PNG bytes as a **base64
string** in `SpriteImage.png_b64` instead. Use the same pattern for any
future viewer that ships binary across IPC.
