//! Special characters (glyphs).
//!
//! A small image the user registers gets a short name, and writing `:name:` in the body
//! draws it like an emoji. It is for symbols that cannot be typed, such as fighting game
//! command notation (`:236p:`).
//!
//! Images live at `data/glyphs/<name>.<png|svg>` and sync by the same path as notes. The
//! body side stays the string `:name:`; the name is only looked up at draw time, so on a
//! device the image has not reached, it shows as text.

mod image;

pub use image::{GLYPH_MAX_BYTES, GlyphData, GlyphFormat, GlyphName, GlyphSummary};
pub(crate) use image::{filename, glyphs_dir, summarize_filename, validate};
