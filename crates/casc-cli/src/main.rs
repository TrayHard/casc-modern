use anyhow::{Context, Result};
use casc_core::Storage;
use clap::{Parser, Subcommand};
use indicatif::{ProgressBar, ProgressStyle};
use std::io::Write;
use std::path::PathBuf;

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
        /// Case-insensitive substring filter on the full path.
        #[arg(long)]
        filter: Option<String>,
        /// Output as JSON lines.
        #[arg(long)]
        json: bool,
    },
    /// Extract a single file.
    Extract {
        storage: PathBuf,
        /// File path inside the storage (e.g. data/global/excel/levels.txt).
        file: String,
        /// Output path. Defaults to the file's basename in CWD.
        #[arg(short, long)]
        out: Option<PathBuf>,
    },
    /// Extract every file (optionally filtered) into an output directory.
    ExtractAll {
        storage: PathBuf,
        #[arg(short, long)]
        out: PathBuf,
        #[arg(long)]
        filter: Option<String>,
    },
    /// Write a file's contents to stdout.
    Cat {
        storage: PathBuf,
        file: String,
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

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();

    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Info { storage } => cmd_info(storage),
        Cmd::List { storage, filter, json } => cmd_list(storage, filter, json),
        Cmd::Extract { storage, file, out } => cmd_extract(storage, file, out),
        Cmd::ExtractAll { storage, out, filter } => cmd_extract_all(storage, out, filter),
        Cmd::Cat { storage, file } => cmd_cat(storage, file),
        Cmd::Dc6Debug { storage, file, palette, out } => {
            cmd_dc6_debug(storage, file, palette, out)
        }
    }
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

fn cmd_list(path: PathBuf, filter: Option<String>, json: bool) -> Result<()> {
    let s = Storage::open(&path)?;
    let needle = filter.as_deref().map(|f| f.to_ascii_lowercase());
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let mut count = 0usize;
    for f in s.all_files()? {
        if let Some(n) = &needle {
            if !f.full_path.to_ascii_lowercase().contains(n) {
                continue;
            }
        }
        count += 1;
        if json {
            // Use serde_json to handle escapes properly — D2R paths contain
            // backslashes, which a hand-rolled escape would silently mangle.
            let line = serde_json::json!({
                "name": &f.full_path,
                "size": f.size,
            });
            writeln!(out, "{line}")?;
        } else {
            writeln!(out, "{:>12}  {}", f.size, f.full_path)?;
        }
    }
    if !json {
        eprintln!("{count} files");
    }
    Ok(())
}

fn cmd_extract(path: PathBuf, file: String, out: Option<PathBuf>) -> Result<()> {
    let s = Storage::open(&path)?;
    let out = out.unwrap_or_else(|| {
        let base = file.rsplit(['/', '\\']).next().unwrap_or(&file).to_string();
        PathBuf::from(base)
    });
    let bytes = s.extract(&file, &out)?;
    eprintln!("wrote {} ({} bytes)", out.display(), bytes);
    Ok(())
}

fn cmd_extract_all(path: PathBuf, out_dir: PathBuf, filter: Option<String>) -> Result<()> {
    let s = Storage::open(&path)?;
    let needle = filter.as_deref().map(|f| f.to_ascii_lowercase());
    let files: Vec<_> = s
        .all_files()?
        .into_iter()
        .filter(|f| {
            needle
                .as_ref()
                .is_none_or(|n| f.full_path.to_ascii_lowercase().contains(n))
        })
        .collect();

    let pb = ProgressBar::new(files.len() as u64);
    pb.set_style(
        ProgressStyle::with_template("{bar:40.cyan/blue} {pos}/{len} {msg}")
            .unwrap(),
    );

    for f in files {
        let target = out_dir.join(f.full_path.replace('\\', "/"));
        if let Err(e) = s.extract(&f.full_path, &target) {
            eprintln!("skip {}: {e}", f.full_path);
        }
        pb.inc(1);
    }
    pb.finish_with_message("done");
    Ok(())
}

fn cmd_cat(path: PathBuf, file: String) -> Result<()> {
    let s = Storage::open(&path)?;
    let bytes = s.read(&file)?;
    std::io::stdout().write_all(&bytes)?;
    Ok(())
}

fn cmd_dc6_debug(storage: PathBuf, file: String, palette: String, out: PathBuf) -> Result<()> {
    let s = Storage::open(&storage)?;
    let idx = s.build_index()?;
    let (sp, _) = idx.resolve(&file).context("dc6 not in index")?;
    let d = casc_core::formats::dc6::decode(&s.read(&sp)?)?;
    eprintln!("dirs {} fpd {} frames {}", d.directions, d.frames_per_dir, d.frames.len());
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

