//! Encoders from a raw RGBA8 buffer to an image file: PNG, WebP (lossy or
//! lossless), JPEG and AVIF. The sibling decoders hand out RGBA8
//! (`SpA1::frame_rgba`, `dc6::to_rgba`), so any frame can be exported in any
//! of these formats.

use crate::CascError;
use image::codecs::{avif::AvifEncoder, jpeg::JpegEncoder, png::PngEncoder};
use image::{ExtendedColorType, ImageEncoder};
use std::str::FromStr;

/// rav1e speed, 1 (slowest) to 10. On D2R icons 6 encodes ~15% faster than
/// cavif's default 4 and the files are at most 4% larger.
const AVIF_SPEED: u8 = 6;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageFormat {
    /// Lossless PNG.
    Png,
    /// Lossy WebP with an alpha channel.
    Webp,
    /// Lossless WebP.
    WebpLossless,
    /// Baseline JPEG. JPEG has no alpha, so transparent pixels turn black.
    Jpeg,
    /// AVIF (AV1, 8-bit) with an alpha channel.
    Avif,
}

impl ImageFormat {
    /// File extension without the dot.
    pub fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Webp | Self::WebpLossless => "webp",
            Self::Jpeg => "jpg",
            Self::Avif => "avif",
        }
    }
}

impl FromStr for ImageFormat {
    type Err = String;

    /// Parses the CLI names `png`, `webp`, `webp-lossless`, `jpeg` (or `jpg`)
    /// and `avif`, case-insensitively.
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_ascii_lowercase().as_str() {
            "png" => Ok(Self::Png),
            "webp" => Ok(Self::Webp),
            "webp-lossless" => Ok(Self::WebpLossless),
            "jpeg" | "jpg" => Ok(Self::Jpeg),
            "avif" => Ok(Self::Avif),
            _ => Err(format!(
                "unknown image format `{s}` (expected png, webp, webp-lossless, jpeg or avif)"
            )),
        }
    }
}

/// Encode a row-major RGBA8 buffer of `width * height` pixels. `quality`
/// (0–100, higher is better) applies to the lossy formats `Webp`, `Jpeg` and
/// `Avif`; `Png` and `WebpLossless` ignore it.
pub fn encode_rgba(
    width: u32,
    height: u32,
    rgba: &[u8],
    format: ImageFormat,
    quality: u8,
) -> Result<Vec<u8>, CascError> {
    if width == 0 || height == 0 {
        return Err(CascError::Backend {
            op: "encode: zero-dimension image",
            code: 0,
        });
    }
    // The encoders below panic on a short buffer, so reject it here.
    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|v| v.checked_mul(4));
    if expected != Some(rgba.len()) {
        return Err(CascError::Backend {
            op: "encode: raw buffer doesn't match dims",
            code: rgba.len() as u32,
        });
    }
    let quality = quality.min(100);

    let mut out = Vec::new();
    let (encoded, op) = match format {
        ImageFormat::Png => (
            PngEncoder::new(&mut out).write_image(rgba, width, height, ExtendedColorType::Rgba8),
            "png encode failed",
        ),
        ImageFormat::Jpeg => (
            JpegEncoder::new_with_quality(&mut out, quality.max(1)).write_image(
                &flatten_on_black(rgba),
                width,
                height,
                ExtendedColorType::Rgb8,
            ),
            "jpeg encode failed",
        ),
        ImageFormat::Avif => {
            (
                AvifEncoder::new_with_speed_quality(&mut out, AVIF_SPEED, quality.max(1))
                    .write_image(rgba, width, height, ExtendedColorType::Rgba8),
                "avif encode failed",
            )
        }
        ImageFormat::Webp | ImageFormat::WebpLossless => {
            return encode_webp(
                width,
                height,
                rgba,
                format == ImageFormat::WebpLossless,
                quality,
            )
        }
    };
    encoded.map_err(|_| CascError::Backend { op, code: 0 })?;
    Ok(out)
}

fn encode_webp(
    width: u32,
    height: u32,
    rgba: &[u8],
    lossless: bool,
    quality: u8,
) -> Result<Vec<u8>, CascError> {
    // In lossless mode libwebp reads `quality` as compression effort; 75 is
    // its default.
    let quality = if lossless { 75.0 } else { f32::from(quality) };
    let mem = webp::Encoder::from_rgba(rgba, width, height)
        .encode_simple(lossless, quality)
        .map_err(|e| CascError::Backend {
            op: "webp encode failed",
            code: e as u32,
        })?;
    Ok(mem.to_vec())
}

/// Composite RGBA onto black and drop alpha.
fn flatten_on_black(rgba: &[u8]) -> Vec<u8> {
    rgba.chunks_exact(4)
        .flat_map(|p| {
            let a = u16::from(p[3]);
            [p[0], p[1], p[2]].map(|c| ((u16::from(c) * a + 127) / 255) as u8)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [ImageFormat; 5] = [
        ImageFormat::Png,
        ImageFormat::Webp,
        ImageFormat::WebpLossless,
        ImageFormat::Jpeg,
        ImageFormat::Avif,
    ];

    /// `w`x`h` gradient whose left half is fully transparent.
    fn sample(w: u32, h: u32) -> Vec<u8> {
        let mut v = Vec::with_capacity((w * h * 4) as usize);
        for y in 0..h {
            for x in 0..w {
                let a = if x < w / 2 { 0 } else { 255 };
                v.extend_from_slice(&[(x * 255 / w) as u8, (y * 255 / h) as u8, 200, a]);
            }
        }
        v
    }

    /// Reads width and height from the first `ispe` box of an AVIF file;
    /// `image` here has no AVIF decoder.
    fn avif_dims(bytes: &[u8]) -> (u32, u32) {
        let at = bytes.windows(4).position(|w| w == b"ispe").unwrap() + 8;
        let be = |o: usize| u32::from_be_bytes(bytes[o..o + 4].try_into().unwrap());
        (be(at), be(at + 4))
    }

    fn decoded_dims(format: ImageFormat, bytes: &[u8]) -> (u32, u32) {
        match format {
            ImageFormat::Png | ImageFormat::Jpeg => {
                let img = image::load_from_memory(bytes).unwrap();
                (img.width(), img.height())
            }
            ImageFormat::Webp | ImageFormat::WebpLossless => {
                let img = webp::Decoder::new(bytes).decode().unwrap();
                (img.width(), img.height())
            }
            ImageFormat::Avif => avif_dims(bytes),
        }
    }

    #[test]
    fn every_format_writes_its_magic_and_keeps_dimensions() {
        let (w, h) = (24, 16);
        for format in ALL {
            let out = encode_rgba(w, h, &sample(w, h), format, 85).unwrap();
            let magic_ok = match format {
                ImageFormat::Png => out.starts_with(&[0x89, b'P', b'N', b'G']),
                ImageFormat::Webp | ImageFormat::WebpLossless => {
                    out.starts_with(b"RIFF") && &out[8..12] == b"WEBP"
                }
                ImageFormat::Jpeg => out.starts_with(&[0xFF, 0xD8, 0xFF]),
                ImageFormat::Avif => &out[4..12] == b"ftypavif",
            };
            assert!(magic_ok, "{format:?}: bad magic");
            assert_eq!(decoded_dims(format, &out), (w, h), "{format:?}");
        }
    }

    #[test]
    fn webp_variants_use_their_bitstreams() {
        let px = sample(8, 8);
        let lossy = encode_rgba(8, 8, &px, ImageFormat::Webp, 85).unwrap();
        let lossless = encode_rgba(8, 8, &px, ImageFormat::WebpLossless, 85).unwrap();
        let format = |b: &[u8]| webp::BitstreamFeatures::new(b).unwrap().format();
        assert!(matches!(format(&lossy), Some(webp::BitstreamFormat::Lossy)));
        assert!(matches!(
            format(&lossless),
            Some(webp::BitstreamFormat::Lossless)
        ));
    }

    #[test]
    fn lossy_webp_keeps_alpha() {
        let (w, h) = (16, 16);
        let out = encode_rgba(w, h, &sample(w, h), ImageFormat::Webp, 75).unwrap();
        let img = webp::Decoder::new(&out).decode().unwrap();
        assert!(img.is_alpha());
        let px = |x: u32, y: u32| img[((y * w + x) * 4 + 3) as usize];
        assert_eq!(px(1, 8), 0, "transparent pixel must stay transparent");
        assert_eq!(px(14, 8), 255, "opaque pixel must stay opaque");
    }

    #[test]
    fn jpeg_flattens_transparency_to_black() {
        let px = [255, 255, 255, 0].repeat(64);
        let out = encode_rgba(8, 8, &px, ImageFormat::Jpeg, 90).unwrap();
        let img = image::load_from_memory(&out).unwrap().to_rgb8();
        assert!(img.pixels().all(|p| p.0.iter().all(|&c| c < 8)));
    }

    #[test]
    fn bad_input_errors_instead_of_panicking() {
        let px = sample(4, 4);
        for format in ALL {
            assert!(encode_rgba(4, 4, &px[..px.len() - 1], format, 85).is_err());
            assert!(encode_rgba(5, 4, &px, format, 85).is_err());
            assert!(encode_rgba(0, 0, &[], format, 85).is_err());
            assert!(encode_rgba(u32::MAX, u32::MAX, &px, format, 85).is_err());
        }
    }

    #[test]
    fn parses_cli_names() {
        assert_eq!("WebP".parse::<ImageFormat>(), Ok(ImageFormat::Webp));
        assert_eq!(
            "webp-lossless".parse::<ImageFormat>(),
            Ok(ImageFormat::WebpLossless)
        );
        assert_eq!("jpg".parse::<ImageFormat>(), Ok(ImageFormat::Jpeg));
        assert_eq!(ImageFormat::Jpeg.extension(), "jpg");
        assert!("gif".parse::<ImageFormat>().is_err());
    }
}
