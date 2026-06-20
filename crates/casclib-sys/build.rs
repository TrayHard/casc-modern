// Builds CascLib (vendored at workspace_root/vendor/CascLib) from source as a
// static library and links it into the casclib-sys crate.
//
// Mirrors CascLib's own CMakeLists.txt source list (commit pulled into vendor/).

use std::env;
use std::path::PathBuf;

fn main() {
    let casclib = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("..")
        .join("..")
        .join("vendor")
        .join("CascLib");
    let src = casclib.join("src");

    // --- Bundled zlib (C) ---
    let mut zlib = cc::Build::new();
    zlib.include(src.join("zlib"));
    zlib.warnings(false);
    for f in [
        "adler32.c", "crc32.c", "inffast.c", "inflate.c", "inftrees.c", "zutil.c",
    ] {
        zlib.file(src.join("zlib").join(f));
    }
    zlib.compile("casclib_zlib");

    // --- CascLib core (C++ + a single C file) ---
    let mut build = cc::Build::new();
    build.cpp(true);
    build.warnings(false);
    build.include(&src);
    build.define("CASCLIB_NO_AUTO_LINK_LIBRARY", None);
    build.define("CASCLIB_NODEBUG", None);

    let target_env = env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();

    if target_env == "msvc" {
        build.flag("/std:c++14");
        build.flag("/EHsc");
        // /utf-8 keeps source-literal handling sane across MSVC versions.
        build.flag("/utf-8");
    } else {
        build.flag("-std=c++14");
    }

    if target_os == "windows" {
        build.define("CASCLIB_DETECT_UNICODE_MISMATCHES", None);
    }

    let cpp_sources = [
        // common
        "common/Common.cpp",
        "common/Directory.cpp",
        "common/Csv.cpp",
        "common/FileStream.cpp",
        "common/FileTree.cpp",
        "common/ListFile.cpp",
        "common/Mime.cpp",
        "common/RootHandler.cpp",
        "common/Sockets.cpp",
        // hashes
        "hashes/md5.cpp",
        "hashes/sha1.cpp",
        // overwatch
        "overwatch/apm.cpp",
        "overwatch/cmf.cpp",
        "overwatch/aes.cpp",
        // top-level
        "CascDecompress.cpp",
        "CascDecrypt.cpp",
        "CascDumpData.cpp",
        "CascFiles.cpp",
        "CascFindFile.cpp",
        "CascIndexFiles.cpp",
        "CascOpenFile.cpp",
        "CascOpenStorage.cpp",
        "CascReadFile.cpp",
        "CascRootFile_Diablo3.cpp",
        "CascRootFile_Install.cpp",
        "CascRootFile_MNDX.cpp",
        "CascRootFile_Text.cpp",
        "CascRootFile_TVFS.cpp",
        "CascRootFile_OW.cpp",
        "CascRootFile_WoW.cpp",
    ];
    for f in cpp_sources {
        build.file(src.join(f));
    }
    // The lone C file — cc picks up the language from the extension.
    build.file(src.join("jenkins").join("lookup3.c"));

    build.compile("casclib");

    if target_os == "windows" {
        println!("cargo:rustc-link-lib=dylib=wininet");
        // Required by FileStream's CreateFile/etc.
        println!("cargo:rustc-link-lib=dylib=user32");
    } else if target_os == "macos" {
        println!("cargo:rustc-link-lib=framework=Carbon");
    }

    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed={}", src.display());
}
