use anyhow::{anyhow, bail, Context, Result};
use casc_core::formats::encode::{encode_rgba, ImageFormat};
use casc_core::formats::spa1::{self, SpA1};
use casc_core::index::normalize;
use casc_core::{Entry, Storage};
use clap::{Args, Parser, Subcommand};
use indicatif::{ProgressBar, ProgressStyle};
use std::collections::{BTreeMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};

/// CASC Modern CLI — browse and extract files from Blizzard CASC storages.
#[derive(Parser)]
#[command(name = "casc", version, about)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Print storage info (product, build, file count).
    Info {
        /// Path to the storage root (e.g. game install folder).
        storage: PathBuf,
    },
    /// List files in the storage, optionally filtered.
    List {
        storage: PathBuf,
        #[command(flatten)]
        select: Select,
        #[command(flatten)]
        m: ModArg,
        /// Output as JSON lines.
        #[arg(long)]
        json: bool,
    },
    /// Extract a single file.
    Extract {
        storage: PathBuf,
        /// File path inside the storage: CascLib form
        /// (data:data/global/excel/levels.txt) or the GUI path
        /// (data/data/global/excel/levels.txt).
        file: String,
        /// Output path. Defaults to the file's basename in CWD.
        #[arg(short, long)]
        out: Option<PathBuf>,
        #[command(flatten)]
        m: ModArg,
    },
    /// Extract every matching file into an output directory, keeping the
    /// GUI folder structure (data/data/global/...).
    ExtractAll {
        storage: PathBuf,
        #[arg(short, long)]
        out: PathBuf,
        #[command(flatten)]
        select: Select,
        #[command(flatten)]
        m: ModArg,
        /// Write every file straight into OUT as its lowercase basename
        /// (skills.txt). Fails before writing if two files share a basename.
        #[arg(long)]
        flat: bool,
        /// Write each .sprite as images: png, webp, webp-lossless, jpeg or
        /// avif. One frame gives name.webp, more give name_0.webp,
        /// name_1.webp, ... Skips *.lowend.sprite and legacy *.dc6; other
        /// files are copied.
        #[arg(long, value_name = "FORMAT")]
        convert: Option<ImageFormat>,
        /// Quality of lossy --convert formats (webp, jpeg, avif), 0-100.
        #[arg(
            long,
            default_value_t = 90,
            requires = "convert",
            value_parser = clap::value_parser!(u8).range(0..=100)
        )]
        quality: u8,
    },
    /// Write a file's contents to stdout. Takes the same paths as `extract`.
    Cat {
        storage: PathBuf,
        file: String,
        #[command(flatten)]
        m: ModArg,
    },
    /// Decode a .dc6 frame to PNG using a palette (debug).
    Dc6Debug {
        storage: PathBuf,
        file: String,
        #[arg(long, default_value = "data/data/global/palette/units/pal.dat")]
        palette: String,
        #[arg(short, long, default_value = "dc6-debug.png")]
        out: PathBuf,
    },
}

/// Which files `list` / `extract-all` touch. No filter and no tag = all files.
#[derive(Args)]
struct Select {
    /// Case-insensitive substring of the path; `/` and `\` both work.
    #[arg(long)]
    filter: Option<String>,
    /// Named set of folders/files from the tags file. Repeat to combine
    /// (--tag skills --tag strings).
    #[arg(long)]
    tag: Vec<String>,
    /// JSON file mapping tag names to path lists: {"skills": ["data/data/global/excel/skills.txt", ...]}.
    #[arg(long, default_value = "casc-tags.json")]
    tags_file: PathBuf,
}

/// `Select` resolved against the tags file. Every path is compared in
/// [`key`] form.
struct Matcher {
    filter: Option<String>,
    /// `None` = no `--tag` given. `Some(vec![])` matches nothing, never all.
    prefixes: Option<Vec<String>>,
}

impl Matcher {
    fn new(select: &Select) -> Result<Self> {
        let prefixes = if select.tag.is_empty() {
            None
        } else {
            Some(tag_paths(&select.tags_file, &select.tag)?)
        };
        Ok(Self {
            filter: select
                .filter
                .as_deref()
                .map(|f| normalize(f).to_ascii_lowercase()),
            prefixes,
        })
    }

    fn matches(&self, full_path: &str) -> bool {
        let p = key(full_path);
        self.filter.as_ref().is_none_or(|f| p.contains(f.as_str()))
            && self
                .prefixes
                .as_ref()
                .is_none_or(|ps| ps.iter().any(|pre| under(&p, pre)))
    }
}

/// Virtual path, lowercase, no outer `/`: accepts CascLib and GUI forms alike.
fn key(path: &str) -> String {
    normalize(path).trim_matches('/').to_ascii_lowercase()
}

/// `path` is the file `prefix` or lies inside the folder `prefix`.
fn under(path: &str, prefix: &str) -> bool {
    path.strip_prefix(prefix)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

/// Union of the path lists behind `names` in the tags file, in [`key`] form.
fn tag_paths(file: &Path, names: &[String]) -> Result<Vec<String>> {
    let text = std::fs::read_to_string(file).with_context(|| {
        format!(
            "read tags file {} (pass --tags-file to use another)",
            file.display()
        )
    })?;
    let tags: BTreeMap<String, Vec<String>> = serde_json::from_str(&text).with_context(|| {
        format!(
            "parse {}: expected {{\"tag\": [\"path\", ...]}}",
            file.display()
        )
    })?;
    let mut out = Vec::new();
    for name in names {
        let paths = tags.get(name).with_context(|| {
            let known: Vec<&str> = tags.keys().map(String::as_str).collect();
            format!(
                "unknown tag `{name}` in {}; known: {}",
                file.display(),
                known.join(", ")
            )
        })?;
        out.extend(paths.iter().map(|p| key(p)));
    }
    Ok(out)
}

/// Files matching `select`, CASC and mod alike. Warns about tag paths that
/// match nothing: usually a typo or a missing product root (data/global/...
/// instead of data/data/global/...).
fn select_files(s: &Storage, select: &Select, mods: &ModFiles) -> Result<Vec<Item>> {
    let m = Matcher::new(select)?;
    let files: Vec<Item> = merge(s.all_files()?, mods)
        .into_iter()
        .filter(|f| m.matches(&f.name))
        .collect();
    for pre in m.prefixes.iter().flatten() {
        if !files.iter().any(|f| under(&key(&f.name), pre)) {
            eprintln!("warning: tag path matches no selected file: {pre}");
        }
    }
    Ok(files)
}

/// Overlay of an unpacked D2R mod folder on top of the CASC storage.
#[derive(Args)]
struct ModArg {
    /// Prefer files from a mod: `-m` alone takes the only mod in STORAGE/mods,
    /// `-m=NAME` takes STORAGE/mods/NAME/NAME.mpq, `-m=PATH` a mod folder or
    /// `*.mpq` folder anywhere. The value needs `=`, so `-m` never takes the
    /// next argument.
    #[arg(
        short = 'm',
        long = "mod",
        value_name = "NAME_OR_PATH",
        num_args = 0..=1,
        require_equals = true
    )]
    r#mod: Option<Option<String>>,
}

impl ModArg {
    /// Files of the chosen mod; empty without `-m`.
    fn files(&self, storage: &Path) -> Result<ModFiles> {
        let Some(arg) = &self.r#mod else {
            return Ok(ModFiles::new());
        };
        let mpq = resolve_mod(storage, arg.as_deref())?;
        eprintln!("mod: {}", mpq.display());
        mod_files(&mpq)
    }
}

/// A selected file: its mod copy when the mod has one, otherwise CASC's.
#[derive(Clone, Debug, PartialEq)]
struct Item {
    /// CascLib name (`data:data\global\x`); mod-only files get one built
    /// from their path inside the mod.
    name: String,
    size: u64,
    mod_file: Option<PathBuf>,
}

/// Mod files keyed by virtual path in [`key`] form.
type ModFiles = BTreeMap<String, Item>;

fn is_mpq(p: &Path) -> bool {
    p.extension().is_some_and(|e| e.eq_ignore_ascii_case("mpq"))
}

/// Subfolders of `dir`, sorted; none if `dir` can't be read.
fn subdirs(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    out.sort();
    out
}

/// The `*.mpq` folder for `-m` (`arg` = None) or `-m=NAME_OR_PATH`.
fn resolve_mod(storage: &Path, arg: Option<&str>) -> Result<PathBuf> {
    let mods = storage.join("mods");
    let found = subdirs(&mods);
    let names = || {
        let n: Vec<_> = found
            .iter()
            .filter_map(|p| p.file_name()?.to_str())
            .collect();
        format!("found {}: {}", n.len(), n.join(", "))
    };
    let dir = match arg {
        None => match found.as_slice() {
            [one] => one.clone(),
            _ => bail!(
                "-m needs exactly one mod in {}, {}; pick one with -m=NAME",
                mods.display(),
                names()
            ),
        },
        Some(a) => {
            let by_name = mods.join(a).join(format!("{a}.mpq"));
            if by_name.is_dir() {
                return Ok(by_name);
            }
            let p = PathBuf::from(a);
            if !p.is_dir() {
                bail!(
                    "mod `{a}` not found: no {} and no such folder; mods in {}, {}",
                    by_name.display(),
                    mods.display(),
                    names()
                );
            }
            p
        }
    };
    if is_mpq(&dir) {
        return Ok(dir);
    }
    let mpqs: Vec<PathBuf> = subdirs(&dir).into_iter().filter(|p| is_mpq(p)).collect();
    match mpqs.as_slice() {
        [one] => Ok(one.clone()),
        _ => bail!(
            "{} must be a *.mpq folder or hold exactly one, found {}",
            dir.display(),
            mpqs.len()
        ),
    }
}

/// Every file under `mpq`. A mod mirrors CASC's `data:` root, so
/// `<mpq>/<rest>` overrides the virtual path `data/<rest>`.
fn mod_files(mpq: &Path) -> Result<ModFiles> {
    let mut out = ModFiles::new();
    let mut dirs = vec![mpq.to_path_buf()];
    while let Some(dir) = dirs.pop() {
        for e in std::fs::read_dir(&dir).with_context(|| format!("read {}", dir.display()))? {
            let e = e?;
            let meta = e.metadata()?;
            if meta.is_dir() {
                dirs.push(e.path());
                continue;
            }
            let rest = e
                .path()
                .strip_prefix(mpq)?
                .to_string_lossy()
                .replace('/', "\\");
            let name = format!("data:{rest}");
            out.insert(
                key(&name),
                Item {
                    name,
                    size: meta.len(),
                    mod_file: Some(e.path()),
                },
            );
        }
    }
    Ok(out)
}

/// CASC files with their mod copies swapped in, then the mod-only files.
fn merge(base: Vec<Entry>, mods: &ModFiles) -> Vec<Item> {
    let mut hit = HashSet::new();
    let mut out: Vec<Item> = base
        .into_iter()
        .map(|e| match mods.get_key_value(&key(&e.full_path)) {
            Some((k, m)) => {
                hit.insert(k);
                Item {
                    name: e.full_path,
                    ..m.clone()
                }
            }
            None => Item {
                name: e.full_path,
                size: e.size,
                mod_file: None,
            },
        })
        .collect();
    out.extend(
        mods.iter()
            .filter(|(k, _)| !hit.contains(k))
            .map(|(_, m)| m.clone()),
    );
    out
}

/// Bytes of a selected file, from the mod copy when there is one.
fn load(s: &Storage, f: &Item) -> Result<Vec<u8>> {
    match &f.mod_file {
        Some(p) => std::fs::read(p).with_context(|| format!("read {}", p.display())),
        None => Ok(s.read(&f.name)?),
    }
}

/// Bytes of `file` (either path form), from the mod copy when there is one.
fn read_file(s: &Storage, mods: &ModFiles, file: &str) -> Result<Vec<u8>> {
    match mods.get(&key(file)) {
        Some(m) => load(s, m),
        None => Ok(s.read(&storage_path(s, file)?)?),
    }
}

fn write_file(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, bytes).with_context(|| format!("write {}", path.display()))
}

/// Lowercase basename: a file's output name under `--flat`.
fn flat_name(f: &Item) -> String {
    key(&f.name)
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_string()
}

/// Every name `--flat` writes, paired with its source file. Under
/// `--convert`, `frames` gives a sprite's frame count, or None when it can't
/// be decoded: it then writes nothing and the export reports it.
fn flat_outputs(
    files: &[Item],
    convert: Option<ImageFormat>,
    frames: impl Fn(&Item) -> Option<u32>,
) -> Vec<(String, &str)> {
    let mut out = Vec::new();
    for f in files {
        let name = flat_name(f);
        match convert.filter(|_| is_sprite(&name)) {
            None => out.push((name, f.name.as_str())),
            Some(fmt) => out.extend(
                frames(f)
                    .into_iter()
                    .flat_map(|n| frame_names(&name, n, fmt))
                    .map(|n| (n, f.name.as_str())),
            ),
        }
    }
    out
}

/// Errors listing every output name that more than one file would write.
fn check_clashes(outs: &[(String, &str)]) -> Result<()> {
    let mut by_name: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for (n, f) in outs {
        by_name.entry(n).or_default().push(f);
    }
    let clashes: Vec<String> = by_name
        .iter()
        .filter(|(_, fs)| fs.len() > 1)
        .map(|(n, fs)| format!("  {n}: {}", fs.join(", ")))
        .collect();
    if !clashes.is_empty() {
        bail!(
            "--flat would write several files to the same name:\n{}",
            clashes.join("\n")
        );
    }
    Ok(())
}

fn is_sprite(path: &str) -> bool {
    path.to_ascii_lowercase().ends_with(".sprite")
}

/// What `--convert` leaves out: low-graphics duplicates of the HD sprites and
/// classic (legacy) Diablo II graphics.
const CONVERT_SKIPS: [&str; 2] = [".lowend.sprite", ".dc6"];

/// Index in [`CONVERT_SKIPS`] of the suffix that makes `--convert` skip `f`.
fn convert_skip(f: &Item) -> Option<usize> {
    let k = key(&f.name);
    CONVERT_SKIPS.iter().position(|s| k.ends_with(s))
}

/// `--convert` output names for the sprite at `path` (`x/name.sprite`):
/// `x/name.webp` for one frame, else `x/name_0.webp` … `x/name_{N-1}.webp`.
fn frame_names(path: &str, frames: u32, format: ImageFormat) -> Vec<String> {
    let stem = &path[..path.len() - ".sprite".len()];
    let ext = format.extension();
    if frames == 1 {
        return vec![format!("{stem}.{ext}")];
    }
    (0..frames).map(|i| format!("{stem}_{i}.{ext}")).collect()
}

/// Decodes a sprite. A decoder panic becomes an error so one bad file can't
/// abort the batch, as in src-tauri/src/sprites.rs.
fn decode_sprite(bytes: &[u8]) -> Result<SpA1> {
    let sp = std::panic::catch_unwind(move || spa1::decode(bytes))
        .map_err(|_| anyhow!("sprite decoder panicked"))??;
    // Also caps the frame count, which drives how many names get built.
    if sp.frame_width() == 0 {
        bail!("{} frames in a {}px wide sprite", sp.frame_count, sp.width);
    }
    Ok(sp)
}

/// A sprite's frames encoded as `format`, named by [`frame_names`] for `path`.
fn convert_sprite(
    bytes: &[u8],
    path: &str,
    format: ImageFormat,
    quality: u8,
) -> Result<Vec<(String, Vec<u8>)>> {
    let sp = decode_sprite(bytes)?;
    frame_names(path, sp.frame_count, format)
        .into_iter()
        .zip(0..)
        .map(|(name, i)| {
            let rgba = sp.frame_rgba(i)?;
            let img = encode_rgba(sp.frame_width(), sp.frame_height(), &rgba, format, quality)?;
            Ok((name, img))
        })
        .collect()
}

/// CascLib names (they contain `:`) go to CascLib as-is; anything else is
/// looked up as a GUI path in the index.
fn storage_path(s: &Storage, file: &str) -> Result<String> {
    if file.contains(':') {
        return Ok(file.to_string());
    }
    let idx = s.build_index()?;
    idx.resolve(&normalize(file))
        .map(|(sp, _)| sp)
        .with_context(|| format!("not in storage: {file}"))
}

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();

    let cli = Cli::parse();
    let res = match cli.cmd {
        Cmd::Info { storage } => cmd_info(storage),
        Cmd::List {
            storage,
            select,
            m,
            json,
        } => cmd_list(storage, select, m, json),
        Cmd::Extract {
            storage,
            file,
            out,
            m,
        } => cmd_extract(storage, file, out, m),
        Cmd::ExtractAll {
            storage,
            out,
            select,
            m,
            flat,
            convert,
            quality,
        } => cmd_extract_all(storage, out, select, m, flat, convert, quality),
        Cmd::Cat { storage, file, m } => cmd_cat(storage, file, m),
        Cmd::Dc6Debug {
            storage,
            file,
            palette,
            out,
        } => cmd_dc6_debug(storage, file, palette, out),
    };
    // `casc cat x | head` closes stdout early; that is not a failure.
    if let Err(e) = &res {
        if e.downcast_ref::<std::io::Error>()
            .is_some_and(|io| io.kind() == std::io::ErrorKind::BrokenPipe)
        {
            return Ok(());
        }
    }
    res
}

fn cmd_info(path: PathBuf) -> Result<()> {
    let s = Storage::open(&path).with_context(|| format!("open {}", path.display()))?;
    let info = s.info()?;
    println!("product:  {}", info.product);
    println!("build:    {}", info.build);
    println!("local:    {}", info.local_file_count);
    println!("total:    {}", info.total_file_count);
    println!("features: {:#010x}", info.features);
    println!("root:     {}", s.root_path().display());
    Ok(())
}

fn cmd_list(path: PathBuf, select: Select, m: ModArg, json: bool) -> Result<()> {
    let s = Storage::open(&path)?;
    let with_mod = m.r#mod.is_some();
    let files = select_files(&s, &select, &m.files(&path)?)?;
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    for f in &files {
        let source = if f.mod_file.is_some() { "mod" } else { "base" };
        if json {
            // Use serde_json to handle escapes properly — D2R paths contain
            // backslashes, which a hand-rolled escape would silently mangle.
            let mut line = serde_json::json!({
                "name": &f.name,
                "size": f.size,
            });
            if with_mod {
                line["source"] = source.into();
            }
            writeln!(out, "{line}")?;
        } else if with_mod {
            writeln!(out, "{:>12}  {source:<4}  {}", f.size, f.name)?;
        } else {
            writeln!(out, "{:>12}  {}", f.size, f.name)?;
        }
    }
    if !json && with_mod {
        let from_mod = files.iter().filter(|f| f.mod_file.is_some()).count();
        eprintln!("{} files ({from_mod} from mod)", files.len());
    } else if !json {
        eprintln!("{} files", files.len());
    }
    Ok(())
}

fn cmd_extract(path: PathBuf, file: String, out: Option<PathBuf>, m: ModArg) -> Result<()> {
    let s = Storage::open(&path)?;
    let mods = m.files(&path)?;
    let out = out.unwrap_or_else(|| {
        let base = file.rsplit(['/', '\\']).next().unwrap_or(&file).to_string();
        PathBuf::from(base)
    });
    let bytes = read_file(&s, &mods, &file).with_context(|| format!("extract {file}"))?;
    write_file(&out, &bytes)?;
    let source = if mods.contains_key(&key(&file)) {
        "mod"
    } else {
        "base"
    };
    eprintln!("wrote {} ({} bytes, {source})", out.display(), bytes.len());
    Ok(())
}

fn cmd_extract_all(
    path: PathBuf,
    out_dir: PathBuf,
    select: Select,
    m: ModArg,
    flat: bool,
    convert: Option<ImageFormat>,
    quality: u8,
) -> Result<()> {
    let s = Storage::open(&path)?;
    let mut files = select_files(&s, &select, &m.files(&path)?)?;
    let mut skipped = [0usize; CONVERT_SKIPS.len()];
    if convert.is_some() {
        files.retain(|f| match convert_skip(f) {
            Some(i) => {
                skipped[i] += 1;
                false
            }
            None => true,
        });
    }
    if files.is_empty() {
        bail!("no files matched");
    }
    // Output paths relative to OUT; under --convert a sprite's frames are
    // named from its path.
    let paths: Vec<String> = if flat {
        // Sprites are read twice: once here for their frame counts, so that
        // no file is written when names clash.
        let frames = |f: &Item| {
            let sp = load(&s, f).and_then(|b| decode_sprite(&b));
            sp.ok().map(|sp| sp.frame_count)
        };
        check_clashes(&flat_outputs(&files, convert, frames))?;
        files.iter().map(flat_name).collect()
    } else {
        files.iter().map(|f| normalize(&f.name)).collect()
    };

    let pb = ProgressBar::new(files.len() as u64);
    pb.set_style(ProgressStyle::with_template("{bar:40.cyan/blue} {pos}/{len} {msg}").unwrap());

    let mut failed = 0usize;
    let (mut sprites, mut images) = (0usize, 0usize);
    for (f, rel) in files.iter().zip(&paths) {
        let res = load(&s, f).and_then(|b| match convert.filter(|_| is_sprite(rel)) {
            None => write_file(&out_dir.join(rel), &b).map(|()| 0),
            Some(fmt) => {
                let frames = convert_sprite(&b, rel, fmt, quality)?;
                for (name, img) in &frames {
                    write_file(&out_dir.join(name), img)?;
                }
                Ok(frames.len())
            }
        });
        match res {
            Ok(0) => {}
            Ok(n) => {
                sprites += 1;
                images += n;
            }
            Err(e) => {
                // Not pb.println: it prints nothing when stderr isn't a terminal.
                pb.suspend(|| eprintln!("skip {}: {e:#}", f.name));
                failed += 1;
            }
        }
        pb.inc(1);
    }
    pb.finish_with_message("done");
    let mut summary = format!(
        "extracted {} of {} files to {}",
        files.len() - failed,
        files.len(),
        out_dir.display()
    );
    if let Some(fmt) = convert {
        let skipped: Vec<String> = CONVERT_SKIPS
            .iter()
            .zip(skipped)
            .map(|(s, n)| format!("{n} *{s}"))
            .collect();
        summary += &format!(
            "; {sprites} sprites as {images} {} images; skipped {}",
            fmt.extension(),
            skipped.join(", ")
        );
    }
    eprintln!("{summary}");
    // Non-zero exit so scripts don't mistake a partial export for success.
    if failed > 0 {
        bail!("{failed} files failed");
    }
    Ok(())
}

fn cmd_cat(path: PathBuf, file: String, m: ModArg) -> Result<()> {
    let s = Storage::open(&path)?;
    let bytes = read_file(&s, &m.files(&path)?, &file).with_context(|| format!("read {file}"))?;
    std::io::stdout().write_all(&bytes)?;
    Ok(())
}

fn cmd_dc6_debug(storage: PathBuf, file: String, palette: String, out: PathBuf) -> Result<()> {
    let s = Storage::open(&storage)?;
    let idx = s.build_index()?;
    let (sp, _) = idx.resolve(&file).context("dc6 not in index")?;
    let d = casc_core::formats::dc6::decode(&s.read(&sp)?)?;
    eprintln!(
        "dirs {} fpd {} frames {}",
        d.directions,
        d.frames_per_dir,
        d.frames.len()
    );
    let (psp, _) = idx.resolve(&palette).context("palette not in index")?;
    let pal = casc_core::formats::dc6::parse_dat_palette(&s.read(&psp)?)?;
    let f = &d.frames[0];
    eprintln!(
        "frame0 {}x{} offset ({},{})",
        f.width, f.height, f.offset_x, f.offset_y
    );
    let rgba = casc_core::formats::dc6::to_rgba(f, &pal);
    image::RgbaImage::from_raw(f.width, f.height, rgba)
        .context("bad rgba dims")?
        .save(&out)?;
    eprintln!("saved -> {}", out.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn matcher(filter: Option<&str>, prefixes: Option<&[&str]>) -> Matcher {
        Matcher {
            filter: filter.map(|f| normalize(f).to_ascii_lowercase()),
            prefixes: prefixes.map(|ps| ps.iter().map(|p| key(p)).collect()),
        }
    }

    const LEVELS: &str = "data:data\\global\\excel\\levels.txt";

    #[test]
    fn filter_accepts_either_slash() {
        assert!(matcher(Some("excel/levels.txt"), None).matches(LEVELS));
        assert!(matcher(Some("excel\\LEVELS.txt"), None).matches(LEVELS));
        assert!(matcher(Some("data/data/global"), None).matches(LEVELS));
        assert!(!matcher(Some("excel/skills.txt"), None).matches(LEVELS));
    }

    #[test]
    fn tag_paths_match_files_and_folders_on_segment_boundary() {
        let folder = matcher(None, Some(&["data/data/global/excel/"]));
        assert!(folder.matches(LEVELS));
        assert!(!folder.matches("data:data\\global\\excel2\\levels.txt"));

        let file = matcher(None, Some(&["data:data\\global\\excel\\levels.txt"]));
        assert!(file.matches(LEVELS));
        assert!(!file.matches("data:data\\global\\excel\\levels.txt.bak"));

        // Missing product root: the common hand-written mistake must not match.
        assert!(!matcher(None, Some(&["data/global/excel"])).matches(LEVELS));
    }

    #[test]
    fn empty_tag_matches_nothing_not_everything() {
        assert!(!matcher(None, Some(&[])).matches(LEVELS));
        assert!(matcher(None, None).matches(LEVELS));
    }

    #[test]
    fn filter_and_tag_combine() {
        let m = matcher(Some("levels"), Some(&["data/data/global"]));
        assert!(m.matches(LEVELS));
        assert!(!m.matches("data:data\\global\\excel\\skills.txt"));
    }

    #[test]
    fn unknown_tag_lists_known_ones() {
        let dir = std::env::temp_dir().join(format!("casc-tags-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("tags.json");
        std::fs::write(
            &file,
            r#"{"skills": ["data/data/global/excel/skills.txt"], "ui": []}"#,
        )
        .unwrap();

        let got = tag_paths(&file, &["skills".into()]).unwrap();
        assert_eq!(got, ["data/data/global/excel/skills.txt"]);
        let err = tag_paths(&file, &["nope".into()]).unwrap_err().to_string();
        assert!(err.contains("known: skills, ui"), "{err}");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Fresh empty temp dir for one test.
    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("casc-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    fn entry(full_path: &str, size: u64) -> Entry {
        Entry {
            name: String::new(),
            full_path: full_path.into(),
            is_dir: false,
            size,
            is_synthetic_name: false,
            available: true,
            locale_flags: 0,
        }
    }

    #[test]
    fn mod_paths_map_to_casc_data_root() {
        let dir = temp("modmap");
        let mpq = dir.join("X.mpq");
        touch(&mpq.join("data/global/excel/Skills.txt"), "mod");
        touch(&mpq.join("locales/audio/enus/a.flac"), "a");
        let files = mod_files(&mpq).unwrap();

        // Both CASC path forms, any case, find the mod copy.
        let skills = &files[&key("data:data\\global\\excel\\skills.txt")];
        assert_eq!(skills.name, "data:data\\global\\excel\\Skills.txt");
        assert_eq!(skills.size, 3);
        assert_eq!(
            skills.mod_file.as_deref(),
            Some(&*mpq.join("data/global/excel/Skills.txt"))
        );
        assert!(files.contains_key(&key("data/locales/audio/enUS/a.flac")));
        assert_eq!(files.len(), 2);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn resolve_mod_by_auto_name_and_path() {
        let game = temp("modres");
        let a = game.join("mods/A/A.mpq");
        std::fs::create_dir_all(&a).unwrap();
        let path = |p: &Path| p.to_str().unwrap().to_string();

        assert_eq!(resolve_mod(&game, None).unwrap(), a);
        assert_eq!(resolve_mod(&game, Some("A")).unwrap(), a);
        assert_eq!(
            resolve_mod(&game, Some(&path(&game.join("mods/A")))).unwrap(),
            a
        );
        assert_eq!(resolve_mod(&game, Some(&path(&a))).unwrap(), a);

        let err = resolve_mod(&game, Some("Nope")).unwrap_err().to_string();
        assert!(err.contains("found 1: A"), "{err}");
        // A folder that is neither a *.mpq nor holds exactly one.
        let err = resolve_mod(&game, Some(&path(&game.join("mods"))))
            .unwrap_err()
            .to_string();
        assert!(err.contains("found 0"), "{err}");

        std::fs::create_dir_all(game.join("mods/B/B.mpq")).unwrap();
        let err = resolve_mod(&game, None).unwrap_err().to_string();
        assert!(err.contains("found 2: A, B"), "{err}");
        let err = resolve_mod(&game.join("no-game"), None)
            .unwrap_err()
            .to_string();
        assert!(err.contains("found 0"), "{err}");

        std::fs::remove_dir_all(&game).unwrap();
    }

    #[test]
    fn merge_prefers_mod_and_adds_mod_only_files() {
        let dir = temp("merge");
        let mpq = dir.join("X.mpq");
        touch(&mpq.join("data/global/excel/SKILLS.txt"), "mod!");
        touch(&mpq.join("data/hd/new/thing.sprite"), "new");
        let skills = "data:data\\global\\excel\\skills.txt";
        let items = merge(
            vec![entry(LEVELS, 10), entry(skills, 20)],
            &mod_files(&mpq).unwrap(),
        );

        assert_eq!(items.len(), 3);
        assert_eq!(
            items[0],
            Item {
                name: LEVELS.into(),
                size: 10,
                mod_file: None
            }
        );
        // Case differs between CASC and the mod: still an override.
        assert_eq!((items[1].name.as_str(), items[1].size), (skills, 4));
        assert!(items[1].mod_file.is_some());
        assert_eq!(items[2].name, "data:data\\hd\\new\\thing.sprite");
        assert!(items[2].mod_file.is_some());
        // --tag / --filter see mod-only files by their virtual path.
        assert!(matcher(None, Some(&["data/data/hd/new"])).matches(&items[2].name));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn item(name: &str) -> Item {
        Item {
            name: name.into(),
            size: 0,
            mod_file: None,
        }
    }

    /// Output names `--flat` writes without `--convert`, after the clash check.
    fn flat_names(files: &[Item]) -> Result<Vec<String>> {
        let outs = flat_outputs(files, None, |_| unreachable!());
        check_clashes(&outs)?;
        Ok(outs.into_iter().map(|(n, _)| n).collect())
    }

    #[test]
    fn flat_names_are_lowercase_and_collisions_fail() {
        let names = flat_names(&[
            item("data:data\\global\\excel\\Skills.txt"),
            item("data:data\\local\\lng\\strings\\item-names.json"),
        ])
        .unwrap();
        assert_eq!(names, ["skills.txt", "item-names.json"]);

        let err = flat_names(&[
            item("data:data\\global\\excel\\skills.txt"),
            item("data:data\\local\\lng\\strings\\skills.json"),
            item("data:data\\global\\excel\\base\\Skills.txt"),
        ])
        .unwrap_err()
        .to_string();
        assert!(
            err.contains(
                "skills.txt: data:data\\global\\excel\\skills.txt, data:data\\global\\excel\\base\\Skills.txt"
            ) && !err.contains("skills.json"),
            "{err}"
        );
    }

    #[test]
    fn bare_mod_flag_leaves_next_argument_alone() {
        let parse = |args: &[&str]| Cli::try_parse_from(args).unwrap().cmd;
        let Cmd::Cat { file, m, .. } = parse(&["casc", "cat", "G", "-m", "data/x.txt"]) else {
            unreachable!()
        };
        assert_eq!((file.as_str(), m.r#mod), ("data/x.txt", Some(None)));

        let Cmd::ExtractAll { out, m, flat, .. } =
            parse(&["casc", "extract-all", "G", "-m", "-o", "out", "--flat"])
        else {
            unreachable!()
        };
        assert_eq!(
            (out, m.r#mod, flat),
            (PathBuf::from("out"), Some(None), true)
        );

        for args in [
            ["casc", "list", "G", "-m=ExampleMod"],
            ["casc", "list", "G", "--mod=ExampleMod"],
        ] {
            let Cmd::List { m, .. } = parse(&args) else {
                unreachable!()
            };
            assert_eq!(m.r#mod, Some(Some("ExampleMod".into())));
        }
    }

    #[test]
    fn convert_and_quality_flags_parse() {
        let parse = |args: &[&str]| Cli::try_parse_from(args).map(|c| c.cmd);
        let Ok(Cmd::ExtractAll {
            convert, quality, ..
        }) = parse(&["casc", "extract-all", "G", "-o", "o", "--convert", "WebP"])
        else {
            unreachable!()
        };
        assert_eq!((convert, quality), (Some(ImageFormat::Webp), 90));
        let base = ["casc", "extract-all", "G", "-o", "o"];
        let ok = |extra: &[&str]| parse(&[&base[..], extra].concat()).is_ok();
        assert!(ok(&["--convert", "png", "--quality", "0"]));
        assert!(!ok(&["--convert", "png", "--quality", "101"]));
        assert!(!ok(&["--convert", "gif"]));
        assert!(!ok(&["--quality", "80"]), "--quality needs --convert");
    }

    /// SpA1 bytes for a `w`x`h` RGBA8 atlas of `frames` frames, as in
    /// spa1.rs's tests.
    fn synth_spa1(w: u32, h: u32, frames: u32, pixels: &[u8]) -> Vec<u8> {
        let mut v = b"SpA1".to_vec();
        v.extend_from_slice(&0x001Fu16.to_le_bytes());
        v.extend_from_slice(&(w as u16).to_le_bytes());
        for x in [w, h, 0, frames, 0, 0, pixels.len() as u32, 4] {
            v.extend_from_slice(&x.to_le_bytes());
        }
        v.extend_from_slice(pixels);
        v
    }

    #[test]
    fn sprite_frames_are_named_by_index() {
        let one = frame_names("data/data/hd/x/Amulet1.sprite", 1, ImageFormat::Webp);
        assert_eq!(one, ["data/data/hd/x/Amulet1.webp"]);
        let many = frame_names("soskillicon.sprite", 56, ImageFormat::Webp);
        assert_eq!(many.len(), 56);
        assert_eq!(
            [&many[0], &many[12], &many[55]],
            [
                "soskillicon_0.webp",
                "soskillicon_12.webp",
                "soskillicon_55.webp"
            ]
        );
        assert_eq!(
            frame_names("a.SPRITE", 1, ImageFormat::Jpeg),
            ["a.jpg"],
            "extension case doesn't matter"
        );
    }

    #[test]
    fn convert_skips_lowend_sprites_and_dc6() {
        let skip = |name: &str| convert_skip(&item(name)).map(|i| CONVERT_SKIPS[i]);
        assert_eq!(
            skip("data:data\\hd\\x\\SoSkillIcon.LowEnd.sprite"),
            Some(".lowend.sprite")
        );
        assert_eq!(
            skip("data:data\\global\\ui\\SPELLS\\SoSkillicon.DC6"),
            Some(".dc6")
        );
        for kept in [
            "data:data\\hd\\x\\soskillicon.sprite",
            "data:data\\hd\\x\\lowend.txt",
            "data:data\\global\\excel\\skills.txt",
            "data:data\\local\\lng\\strings\\skills.json",
        ] {
            assert_eq!(skip(kept), None, "{kept}");
        }
    }

    #[test]
    fn convert_sprite_splits_frames_in_order() {
        let red = [255, 0, 0, 255];
        let blue = [0, 0, 255, 255];
        // 4x1 strip: two 2x1 frames, red then blue.
        let raw = synth_spa1(4, 1, 2, &[red, red, blue, blue].concat());
        let out = convert_sprite(&raw, "x/Icon.sprite", ImageFormat::Png, 90).unwrap();
        let names: Vec<&str> = out.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, ["x/Icon_0.png", "x/Icon_1.png"]);
        for ((_, png), px) in out.iter().zip([red, blue]) {
            let img = image::load_from_memory(png).unwrap().to_rgba8();
            assert_eq!(img.dimensions(), (2, 1));
            assert!(img.pixels().all(|p| p.0 == px));
        }

        let one = synth_spa1(2, 2, 1, &red.repeat(4));
        let out = convert_sprite(&one, "icon.sprite", ImageFormat::Webp, 90).unwrap();
        assert_eq!(out[0].0, "icon.webp");
        assert!(out[0].1.starts_with(b"RIFF") && &out[0].1[8..12] == b"WEBP");

        // Corrupt input fails the file instead of panicking.
        assert!(convert_sprite(b"SpA1", "a.sprite", ImageFormat::Png, 90).is_err());
        let too_many = synth_spa1(2, 1, 1_000_000, &red.repeat(2));
        assert!(convert_sprite(&too_many, "a.sprite", ImageFormat::Png, 90).is_err());
    }

    #[test]
    fn flat_convert_names_and_clashes_use_final_names() {
        let frames = |f: &Item| match key(&f.name) {
            k if k.contains("broken") => None,
            k if k.contains("skillicon") || k.starts_with("multi/") => Some(3),
            _ => Some(1),
        };
        let names = |files: &[Item], fmt| -> Vec<String> {
            flat_outputs(files, Some(fmt), frames)
                .into_iter()
                .map(|(n, _)| n)
                .collect()
        };
        let files = [
            item("data:data\\hd\\global\\ui\\items\\misc\\amulet\\Amulet1.sprite"),
            item("data:data\\hd\\global\\ui\\spells\\sorceress\\SoSkillIcon.sprite"),
            item("data:data\\global\\excel\\Skills.txt"),
            item("data:data\\hd\\broken.sprite"),
        ];
        assert_eq!(
            names(&files, ImageFormat::Webp),
            [
                "amulet1.webp",
                "soskillicon_0.webp",
                "soskillicon_1.webp",
                "soskillicon_2.webp",
                "skills.txt"
            ]
        );

        let clash = |files: &[Item], fmt| {
            check_clashes(&flat_outputs(files, Some(fmt), frames))
                .err()
                .map(|e| e.to_string())
        };
        // Same basename, 1 vs 3 frames: foo.webp never meets foo_N.webp, so
        // checking raw basenames would be a false alarm.
        assert_eq!(
            clash(
                &[item("one\\foo.sprite"), item("multi\\foo.sprite")],
                ImageFormat::Webp
            ),
            None
        );
        let a = item("data:data\\hd\\a\\soskillicon.sprite");
        let b = item("data:data\\hd\\b\\soskillicon.sprite");
        let err = clash(&[a, b], ImageFormat::Webp).unwrap();
        assert!(
            err.contains("soskillicon_0.webp: data:data\\hd\\a\\soskillicon.sprite, data:data\\hd\\b\\soskillicon.sprite"),
            "{err}"
        );
        // A frame name meets another sprite's name.
        let err = clash(
            &[item("multi\\fire.sprite"), item("y\\Fire_1.sprite")],
            ImageFormat::Webp,
        )
        .unwrap();
        assert!(
            err.contains("fire_1.webp: multi\\fire.sprite, y\\Fire_1.sprite"),
            "{err}"
        );
        // A converted sprite meets a copied file.
        let err = clash(&[item("x\\a.sprite"), item("y\\a.png")], ImageFormat::Png).unwrap();
        assert!(err.contains("a.png: x\\a.sprite, y\\a.png"), "{err}");
        // Undecodable sprites claim no names.
        assert_eq!(
            clash(
                &[item("x\\broken.sprite"), item("y\\broken.sprite")],
                ImageFormat::Png
            ),
            None
        );
    }
}
