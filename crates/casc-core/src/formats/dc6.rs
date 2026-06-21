//! Decoder for Diablo II's classic `.dc6` graphics (still shipped in D2R's
//! legacy `data/global` tree — fonts, classic UI, item icons).
//!
//! DC6 stores palette *indices* only; callers supply a 768-byte RGB palette
//! (e.g. `data/global/palette/units/pal.dat`). Index 0 is transparent.
//!
//! Ported from the OpenDiablo2/dc6 (MIT) and qdc6 reference decoders.

use crate::CascError;

const END_OF_SCANLINE: u8 = 0x80;
const RUN_MASK: u8 = 0x7f;

#[derive(Debug, Clone)]
pub struct Dc6Frame {
    pub flip: i32,
    pub width: u32,
    pub height: u32,
    pub offset_x: i32,
    pub offset_y: i32,
    /// width*height palette indices, top-left origin (flip already applied).
    pub indices: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct Dc6 {
    pub version: i32,
    pub directions: u32,
    pub frames_per_dir: u32,
    /// Flat list, direction-major (`dir = i / frames_per_dir`).
    pub frames: Vec<Dc6Frame>,
}

fn err(op: &'static str) -> CascError {
    CascError::Backend { op, code: 0 }
}

#[inline]
fn rd_i32(b: &[u8], o: usize) -> Result<i32, CascError> {
    b.get(o..o + 4)
        .map(|s| i32::from_le_bytes([s[0], s[1], s[2], s[3]]))
        .ok_or(err("dc6: truncated i32"))
}
#[inline]
fn rd_u32(b: &[u8], o: usize) -> Result<u32, CascError> {
    Ok(rd_i32(b, o)? as u32)
}

pub fn decode(bytes: &[u8]) -> Result<Dc6, CascError> {
    if bytes.len() < 24 {
        return Err(err("dc6: shorter than header"));
    }
    let version = rd_i32(bytes, 0x00)?;
    // flags @0x04, encoding @0x08, termination[4] @0x0C — unused by a viewer.
    let directions = rd_u32(bytes, 0x10)?;
    let frames_per_dir = rd_u32(bytes, 0x14)?;

    let total = (directions as usize)
        .checked_mul(frames_per_dir as usize)
        .ok_or(err("dc6: dir*frames overflow"))?;
    // Sanity cap — a real DC6 has a handful to a few hundred frames.
    if total > 100_000 {
        return Err(err("dc6: implausible frame count"));
    }

    // Frame-pointer table: `total` u32 absolute offsets to each frame header.
    // Seek by these rather than guessing terminator sizes.
    let mut ptrs = Vec::with_capacity(total);
    for k in 0..total {
        ptrs.push(rd_u32(bytes, 0x18 + k * 4)? as usize);
    }

    let mut frames = Vec::with_capacity(total);
    for &p in &ptrs {
        if p + 32 > bytes.len() {
            return Err(err("dc6: frame header out of range"));
        }
        let flip = rd_i32(bytes, p)?;
        let width = rd_u32(bytes, p + 4)?;
        let height = rd_u32(bytes, p + 8)?;
        let offset_x = rd_i32(bytes, p + 12)?;
        let offset_y = rd_i32(bytes, p + 16)?;
        // allocsize @+20, next_block @+24
        let length = rd_u32(bytes, p + 28)? as usize;

        let data = bytes
            .get(p + 32..p + 32 + length)
            .ok_or(err("dc6: truncated frame data"))?;
        let indices = decode_frame(data, width, height, flip)?;
        frames.push(Dc6Frame {
            flip,
            width,
            height,
            offset_x,
            offset_y,
            indices,
        });
    }

    Ok(Dc6 {
        version,
        directions,
        frames_per_dir,
        frames,
    })
}

/// Decode one frame's RLE scanlines into a top-left-origin index buffer.
fn decode_frame(data: &[u8], width: u32, height: u32, flip: i32) -> Result<Vec<u8>, CascError> {
    let (w, h) = (width as usize, height as usize);
    let n = w.checked_mul(h).ok_or(err("dc6: w*h overflow"))?;
    if n > 64 * 1024 * 1024 {
        return Err(err("dc6: frame too large"));
    }
    let mut out = vec![0u8; n];
    if n == 0 {
        return Ok(out);
    }

    // flip == 0 (typical) => scanlines stored bottom-up; the first decoded row
    // is the bottom of the upright image.
    let mut x: usize = 0;
    let mut row: usize = if flip == 0 { h - 1 } else { 0 };
    let mut i = 0usize;

    while let Some(&b) = data.get(i) {
        i += 1;
        if b == END_OF_SCANLINE {
            x = 0;
            if flip == 0 {
                if row == 0 {
                    break;
                }
                row -= 1;
            } else {
                row += 1;
                if row >= h {
                    break;
                }
            }
        } else if b & 0x80 != 0 {
            x += (b & RUN_MASK) as usize; // transparent skip
        } else {
            let run = b as usize;
            let src = data.get(i..i + run).ok_or(err("dc6: malformed RLE run"))?;
            i += run;
            // Copy only what fits in the current row; ignore overrun on a
            // malformed frame rather than spilling into the next row.
            if row < h && x < w {
                let copy_n = run.min(w - x);
                let base = row * w + x;
                out[base..base + copy_n].copy_from_slice(&src[..copy_n]);
            }
            x += run;
        }
    }
    Ok(out)
}

/// Palette index buffer -> RGBA8. `palette` is 256*3 bytes in R,G,B order.
/// Index 0 -> fully transparent.
pub fn to_rgba(frame: &Dc6Frame, palette: &[u8; 768]) -> Vec<u8> {
    let mut rgba = Vec::with_capacity(frame.indices.len() * 4);
    for &idx in &frame.indices {
        if idx == 0 {
            rgba.extend_from_slice(&[0, 0, 0, 0]);
        } else {
            let p = idx as usize * 3;
            rgba.extend_from_slice(&[palette[p], palette[p + 1], palette[p + 2], 255]);
        }
    }
    rgba
}

/// Parse a 768-byte D2 `.dat` palette (256 * B,G,R) into R,G,B-ordered bytes.
pub fn parse_dat_palette(bytes: &[u8]) -> Result<[u8; 768], CascError> {
    if bytes.len() < 768 {
        return Err(err("palette: .dat shorter than 768 bytes"));
    }
    let mut pal = [0u8; 768];
    for i in 0..256 {
        pal[i * 3] = bytes[i * 3 + 2]; // R  (.dat stores B,G,R)
        pal[i * 3 + 1] = bytes[i * 3 + 1]; // G
        pal[i * 3 + 2] = bytes[i * 3]; // B
    }
    Ok(pal)
}

/// Grayscale fallback when no palette file is available.
pub fn grayscale_palette() -> [u8; 768] {
    let mut p = [0u8; 768];
    for i in 0..256 {
        p[i * 3] = i as u8;
        p[i * 3 + 1] = i as u8;
        p[i * 3 + 2] = i as u8;
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    fn le(v: i32) -> [u8; 4] {
        v.to_le_bytes()
    }

    #[test]
    fn decodes_one_frame_bottom_up_and_transparent_index0() {
        // 2x2 frame, flip=0 (bottom-up). RLE per scanline:
        //   bottom row: copy 2 -> [1,2]
        //   top row:    skip 1 transparent, copy 1 -> [0,3]
        let w = 2i32;
        let h = 2i32;
        // frame data: 0x02,1,2, 0x80, 0x81, 0x01,3, 0x80
        let frame_data: Vec<u8> = vec![0x02, 1, 2, 0x80, 0x81, 0x01, 3, 0x80];

        let mut buf = Vec::new();
        // header
        buf.extend_from_slice(&le(6)); // version
        buf.extend_from_slice(&le(1)); // flags
        buf.extend_from_slice(&le(0)); // encoding
        buf.extend_from_slice(&[0xEE, 0xEE, 0xEE, 0xEE]);
        buf.extend_from_slice(&le(1)); // directions
        buf.extend_from_slice(&le(1)); // frames_per_dir
                                       // pointer table: one entry, points to the frame header that follows it
        let frame_hdr_off = (0x18 + 4) as u32;
        buf.extend_from_slice(&frame_hdr_off.to_le_bytes());
        // frame header
        buf.extend_from_slice(&le(0)); // flip
        buf.extend_from_slice(&le(w)); // width
        buf.extend_from_slice(&le(h)); // height
        buf.extend_from_slice(&le(0)); // offset_x
        buf.extend_from_slice(&le(0)); // offset_y
        buf.extend_from_slice(&le(0)); // allocsize
        buf.extend_from_slice(&le(0)); // next_block
        buf.extend_from_slice(&(frame_data.len() as u32).to_le_bytes());
        buf.extend_from_slice(&frame_data);

        let dc6 = decode(&buf).unwrap();
        assert_eq!(dc6.frames.len(), 1);
        let f = &dc6.frames[0];
        assert_eq!((f.width, f.height), (2, 2));
        // top-left origin: top row first, then bottom row.
        assert_eq!(f.indices, vec![0, 3, /*bottom*/ 1, 2]);

        let pal = grayscale_palette();
        let rgba = to_rgba(f, &pal);
        // index 0 -> transparent
        assert_eq!(&rgba[0..4], &[0, 0, 0, 0]);
        // index 3 -> (3,3,3,255) in grayscale
        assert_eq!(&rgba[4..8], &[3, 3, 3, 255]);
    }

    #[test]
    fn rejects_truncated() {
        assert!(decode(&[0u8; 4]).is_err());
    }
}
