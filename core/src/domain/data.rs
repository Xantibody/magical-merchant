//! Where `data/` is.
//!
//! Every record lives under it, each kind in its own directory hanging off it, and it
//! is the tree sync carries between devices: what sits outside it (history, conflict
//! copies, the place cache) stays on the device.

use std::path::{Path, PathBuf};

pub const DATA_DIR: &str = "data";

#[must_use]
pub fn data_dir(base_dir: &Path) -> PathBuf {
    base_dir.join(DATA_DIR)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_data_dir_hangs_off_the_base_dir() {
        assert_eq!(data_dir(Path::new("/app")), PathBuf::from("/app/data"));
    }
}
