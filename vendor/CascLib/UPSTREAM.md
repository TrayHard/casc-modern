# Vendored CascLib

Source: https://github.com/ladislav-zezula/CascLib
License: MIT (see `LICENSE` in this directory)

Vendored at commit: `9fb2d38` (Merge pull request #287 from ladislav-zezula/LZ_DownloadSupportFix)

Built from source by `crates/casclib-sys/build.rs` using the `cc` crate. The
source list mirrors `CMakeLists.txt` in this directory — keep them in sync
when updating.

To refresh:

    cd vendor/
    rm -rf CascLib
    git clone --depth 1 https://github.com/ladislav-zezula/CascLib.git
    # Update the commit hash above.
    rm -rf CascLib/.git
