//! Decoder for D2R's `.sprite` (SpA1 magic) format.
//!
//! Reverse-engineered from samples in the live storage (see `vendor/SpA1.md`
//! for the byte-level notes). Replaces the closed-source D2RSpriteConverter.
//!
//! Layout, header is 40 bytes:
//!
//! ```text
//! +--------+---------------------+-----------------------------------+
//! | offset | type                | meaning                           |
//! +--------+---------------------+-----------------------------------+
//! | 0x00   | u8[4]               | magic "SpA1"                      |
//! | 0x04   | u16                 | version (observed: 0x001F = 31)   |
//! | 0x06   | u16                 | (unknown, often frame-width-ish)  |
//! | 0x08   | u32 LE              | total atlas width in pixels       |
//! | 0x0C   | u32 LE              | total atlas height in pixels      |
//! | 0x10   | u32                 | reserved (zero)                   |
//! | 0x14   | u32 LE              | frame count                       |
//! | 0x18   | u32                 | reserved (zero)                   |
//! | 0x1C   | u32                 | reserved (varies, ignored)        |
//! | 0x20   | u32 LE              | data size in bytes                |
//! | 0x24   | u32 LE              | bytes per pixel (4 = RGBA8)       |
//! | 0x28   | u8[data_size]       | pixel data, row-major RGBA8       |
//! +--------+---------------------+-----------------------------------+
//! ```
//!
//! Animated sprites store frames as a horizontal strip in the atlas: the
//! atlas width equals `frame_count * frame_width`. Each frame can be
//! cropped from the decoded RGBA buffer in O(1) per row.

use crate::CascError;
use std::io::Cursor;

const MAGIC: &[u8; 4] = b"SpA1";
const HEADER_SIZE: usize = 0x28;

#[derive(Debug, Clone)]
pub struct SpA1 {
    pub version: u16,
    pub width: u32,
    pub height: u32,
    pub frame_count: u32,
    pub bpp: u32,
    /// Row-major RGBA8. Length = `width * height * 4`.
    pub pixels: Vec<u8>,
}

impl SpA1 {
    /// Per-frame width, assuming the standard horizontal-strip layout.
    pub fn frame_width(&self) -> u32 {
        if self.frame_count == 0 {
            self.width
        } else {
            self.width / self.frame_count
        }
    }

    /// Per-frame height (= atlas height in this layout).
    pub fn frame_height(&self) -> u32 {
        self.height
    }

    /// Encode the full atlas as PNG. Cheapest path for "just show me the image".
    pub fn to_png(&self) -> Result<Vec<u8>, CascError> {
        encode_png(&self.pixels, self.width, self.height)
    }

    /// Encode a single frame as PNG. Frame indices are 0-based.
    pub fn frame_to_png(&self, frame: u32) -> Result<Vec<u8>, CascError> {
        let fw = self.frame_width();
        let fh = self.frame_height();
        if frame >= self.frame_count {
            return Err(CascError::Backend {
                op: "frame index out of range",
                code: frame,
            });
        }
        let mut out = vec![0u8; (fw * fh * 4) as usize];
        let row_stride_src = (self.width * 4) as usize;
        let row_stride_dst = (fw * 4) as usize;
        let x_offset = (frame * fw * 4) as usize;
        for y in 0..fh as usize {
            let src = &self.pixels[y * row_stride_src + x_offset
                ..y * row_stride_src + x_offset + row_stride_dst];
            out[y * row_stride_dst..(y + 1) * row_stride_dst].copy_from_slice(src);
        }
        encode_png(&out, fw, fh)
    }
}

pub fn decode(bytes: &[u8]) -> Result<SpA1, CascError> {
    if bytes.len() < HEADER_SIZE {
        return Err(CascError::Backend {
            op: "spa1: file shorter than header",
            code: bytes.len() as u32,
        });
    }
    if &bytes[0..4] != MAGIC {
        return Err(CascError::Backend {
            op: "spa1: bad magic (not SpA1)",
            code: 0,
        });
    }
    let version = u16_le(&bytes[0x04..0x06]);
    let width = u32_le(&bytes[0x08..0x0C]);
    let height = u32_le(&bytes[0x0C..0x10]);
    let frame_count = u32_le(&bytes[0x14..0x18]).max(1);
    // 0x20 reports data_size; we trust the dimensions instead and use it only
    // as a sanity-check signal during inspection. Read but don't validate.
    let _data_size = u32_le(&bytes[0x20..0x24]) as usize;
    let bpp = u32_le(&bytes[0x24..0x28]);

    if bpp != 4 {
        return Err(CascError::Backend {
            op: "spa1: unsupported bytes-per-pixel (only RGBA8 supported)",
            code: bpp,
        });
    }

    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|v| v.checked_mul(4))
        .ok_or(CascError::Backend {
            op: "spa1: width*height overflow",
            code: 0,
        })?;

    let data = &bytes[HEADER_SIZE..];
    if data.len() < expected {
        return Err(CascError::Backend {
            op: "spa1: pixel data truncated",
            code: data.len() as u32,
        });
    }

    Ok(SpA1 {
        version,
        width,
        height,
        frame_count,
        bpp,
        pixels: data[..expected].to_vec(),
    })
}

fn encode_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, CascError> {
    let img = image::RgbaImage::from_raw(width, height, rgba.to_vec()).ok_or(
        CascError::Backend {
            op: "spa1: raw buffer doesn't match dims",
            code: 0,
        },
    )?;
    let mut out = Vec::with_capacity((width * height * 4) as usize / 2);
    img.write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|_| CascError::Backend { op: "png encode failed", code: 0 })?;
    Ok(out)
}

#[inline]
fn u16_le(b: &[u8]) -> u16 {
    u16::from_le_bytes([b[0], b[1]])
}

#[inline]
fn u32_le(b: &[u8]) -> u32 {
    u32::from_le_bytes([b[0], b[1], b[2], b[3]])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2x2 RGBA8 atlas, 1 frame. Each pixel is solid color.
    fn synth_spa1(w: u32, h: u32, frames: u32, pixels: &[u8]) -> Vec<u8> {
        let mut v = Vec::with_capacity(HEADER_SIZE + pixels.len());
        v.extend_from_slice(MAGIC);
        v.extend_from_slice(&0x001Fu16.to_le_bytes()); // version
        v.extend_from_slice(&(w as u16).to_le_bytes()); // unknown
        v.extend_from_slice(&w.to_le_bytes());
        v.extend_from_slice(&h.to_le_bytes());
        v.extend_from_slice(&0u32.to_le_bytes());
        v.extend_from_slice(&frames.to_le_bytes());
        v.extend_from_slice(&0u32.to_le_bytes());
        v.extend_from_slice(&0u32.to_le_bytes());
        v.extend_from_slice(&(pixels.len() as u32).to_le_bytes());
        v.extend_from_slice(&4u32.to_le_bytes());
        v.extend_from_slice(pixels);
        v
    }

    #[test]
    fn decode_single_frame() {
        let px = [
            255, 0, 0, 255, // red
            0, 255, 0, 255, // green
            0, 0, 255, 255, // blue
            255, 255, 255, 128, // white half-alpha
        ];
        let raw = synth_spa1(2, 2, 1, &px);
        let s = decode(&raw).unwrap();
        assert_eq!(s.width, 2);
        assert_eq!(s.height, 2);
        assert_eq!(s.frame_count, 1);
        assert_eq!(s.pixels, px);
        let png = s.to_png().unwrap();
        assert!(png.starts_with(&[0x89, b'P', b'N', b'G']));
    }

    #[test]
    fn decode_strip_then_extract_frame() {
        // 4x2 atlas, 2 frames of 2x2 each (left frame red, right frame blue)
        let px = [
            // row 0
            255, 0, 0, 255, // frame0 (0,0)
            255, 0, 0, 255, // frame0 (1,0)
            0, 0, 255, 255, // frame1 (0,0)
            0, 0, 255, 255, // frame1 (1,0)
            // row 1
            255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255,
        ];
        let raw = synth_spa1(4, 2, 2, &px);
        let s = decode(&raw).unwrap();
        assert_eq!(s.frame_width(), 2);
        assert_eq!(s.frame_height(), 2);
        let frame1 = s.frame_to_png(1).unwrap();
        assert!(frame1.starts_with(&[0x89, b'P', b'N', b'G']));
    }
}
