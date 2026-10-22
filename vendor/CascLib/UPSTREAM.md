# Vendored CascLib

Source: https://github.com/ladislav-zezula/CascLib
License: MIT (see `LICENSE` in this directory)

Base vendored at commit: `9fb2d38` (Merge pull request #287 from ladislav-zezula/LZ_DownloadSupportFix).
Steam static-storage support from upstream pull request #290 (merged as `c1fd59b`)
is applied to six source files.

Built from source by `crates/casclib-sys/build.rs` using the `cc` crate. The
source list mirrors `CMakeLists.txt` in this directory — keep them in sync
when updating.

To refresh:

    cd vendor/
    rm -rf CascLib
    git clone --depth 1 https://github.com/ladislav-zezula/CascLib.git
    # Update the commit hash above.
    rm -rf CascLib/.git
