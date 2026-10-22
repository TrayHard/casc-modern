//! Per-format decoders that produce displayable images from CASC payloads,
//! plus [`encode`] to write those images as PNG, WebP, JPEG or AVIF.

pub mod dc6;
pub mod encode;
pub mod spa1;
