# Third-party notices

CASC Modern bundles or links against the following third-party components.
Their licenses apply to those portions of the distributed binary.

## CascLib

Author: Ladislav Zezula ("Ladik")
Upstream: https://github.com/ladislav-zezula/CascLib
License: MIT
Vendored at: `vendor/CascLib/` (see `vendor/CascLib/LICENSE` and `vendor/CascLib/UPSTREAM.md`)

CascLib is statically linked into `casc-modern.exe` via `crates/casclib-sys`.
The original CascLib copyright notice is preserved in the vendored sources.

## Tauri

Upstream: https://github.com/tauri-apps/tauri
License: MIT or Apache-2.0 (dual)

## React, antd, CodeMirror, react-window

All MIT-licensed. Full license texts ship with the respective npm packages
under `node_modules/<package>/LICENSE` and are bundled into the frontend
artifact by Vite.

## Rust crates

All Rust crates pulled by `Cargo.toml` are MIT or MIT-or-Apache-2.0.
A complete machine-readable listing is available via `cargo license`
(or `cargo about generate`) on a checked-out copy.

---

This NOTICE file is informational. The license under which CASC Modern itself
is distributed is in `LICENSE` (MIT).
