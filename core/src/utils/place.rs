//! 座標を地名に直した答えの置き場。
//!
//! 変換そのものは OS のジオコーダに任せるので、ここにあるのは「どこまで
//! 近ければ同じ場所とみなすか」と「一度もらった答えをどう残すか」だけ。
//!
//! 記録された座標には手を触れない。地名はあくまで読むための粗い言い換えで、
//! 行末 JSON に書き戻すと、どこにいたかの記録がジオコーダの機嫌に左右される。

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::CoreError;
use crate::utils::fs::write_atomic;

/// キーを丸める小数桁。2 桁 ≒ 1.1km 四方。
///
/// 市区町村より細かく刻んでも同じ地名が返るだけで、ジオコーダを余分に叩く。
/// 粗いほど 1 件の答えを使い回せる。
const KEY_DIGITS: usize = 2;

/// 同じ場所として扱う座標のまとまりを表す文字列。
#[must_use]
pub fn place_key(latitude: f64, longitude: f64) -> String {
    let digits = KEY_DIGITS;
    format!("{latitude:.digits$},{longitude:.digits$}")
}

/// 一度聞いた地名。キーは [`place_key`]。
///
/// 引けなかった座標は覚えない。圏外で失敗しただけの座標を「地名なし」として
/// 残すと、電波の戻った後もその場所だけ座標のまま据え置かれる。
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PlaceCache {
    places: BTreeMap<String, String>,
}

impl PlaceCache {
    /// 読めなければ空で始める。派生物でしかないので、壊れていても
    /// 作り直せばよく、読み出し側を止める理由がない。
    #[must_use]
    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> Result<(), CoreError> {
        let json = serde_json::to_string(&self)
            .map_err(|e| CoreError::Parse(format!("place cache: {e}")))?;
        write_atomic(path, json)
    }

    #[must_use]
    pub fn get(&self, key: &str) -> Option<&str> {
        self.places.get(key).map(String::as_str)
    }

    pub fn insert(&mut self, key: String, place: String) {
        self.places.insert(key, place);
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.places.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn coordinates_within_the_same_grid_share_a_key() {
        assert_eq!(
            place_key(35.676_140_3, 139.546_563_4),
            place_key(35.676_9, 139.546_9)
        );
    }

    #[test]
    fn coordinates_a_town_apart_do_not() {
        assert_ne!(place_key(35.676, 139.546), place_key(35.651, 139.544));
    }

    /// 南半球・西半球の座標が北東側のキーに潰れると、地球の裏の地名が付く。
    #[test]
    fn the_key_keeps_the_hemisphere() {
        assert_eq!(place_key(-33.86, -70.66), "-33.86,-70.66");
    }

    #[test]
    fn an_answer_comes_back_under_its_key() {
        let mut cache = PlaceCache::default();

        cache.insert(place_key(35.676, 139.546), "渋谷区".to_string());

        assert_eq!(cache.get(&place_key(35.676, 139.546)), Some("渋谷区"));
    }

    #[test]
    fn a_coordinate_never_asked_about_is_absent() {
        assert_eq!(PlaceCache::default().get("0.00,0.00"), None);
    }

    #[test]
    fn what_was_saved_survives_a_reload() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("places.json");
        let mut cache = PlaceCache::default();
        cache.insert("35.68,139.55".to_string(), "渋谷区".to_string());

        cache.save(&path).unwrap();

        assert_eq!(PlaceCache::load(&path).get("35.68,139.55"), Some("渋谷区"));
    }

    /// 派生物なので、壊れていたら聞き直せばよい。読めないことを理由に
    /// タイムラインが開けなくなるほうが困る。
    #[test]
    fn an_unreadable_cache_starts_empty() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("places.json");
        std::fs::write(&path, "{ not json").unwrap();

        assert!(PlaceCache::load(&path).is_empty());
    }

    #[test]
    fn a_missing_cache_starts_empty() {
        let tmp = TempDir::new().unwrap();

        assert!(PlaceCache::load(&tmp.path().join("places.json")).is_empty());
    }
}
