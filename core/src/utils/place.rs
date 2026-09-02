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

    /// 言語の希望つきで引く。希望の言語に無ければ他の言語、それも無ければ
    /// 言語を付けて書く前の控えを見る。
    ///
    /// 画面(`resolve`)はこれを使わない。あちらは希望の言語に無ければ
    /// ジオコーダに聞き直せるが、MCP のように聞き直す手段のない読み手には、
    /// 別の言語の名前でも座標だけよりは役に立つ。
    #[must_use]
    pub fn lookup(&self, locale: &str, key: &str) -> Option<&str> {
        let suffix = format!(":{key}");
        self.get(&cache_key(locale, key))
            .or_else(|| {
                self.places
                    .iter()
                    .find(|(k, _)| k.ends_with(&suffix))
                    .map(|(_, v)| v.as_str())
            })
            .or_else(|| self.get(key))
    }
}

/// 控えの中でのキー。言語を変えると同じ座標に別の名前が付くので、
/// 座標だけで引くと前の言語の名前をそのまま出してしまう。
///
/// この変更より前に書かれた控え(言語の付かないキー)はもう一致しない。
/// 派生ファイルなので消しには行かず、次に同じ場所を通ったときに
/// 言語付きで書き直されるに任せる。
#[must_use]
pub fn cache_key(locale: &str, place_key: &str) -> String {
    format!("{locale}:{place_key}")
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
    /// 画面の言語で聞いた名前があればそれ。無ければ別の言語のものでも、
    /// 座標だけ見せられるより読める。
    #[test]
    fn lookup_prefers_the_asked_language_and_falls_back_to_any() {
        let mut cache = PlaceCache::default();
        cache.insert(cache_key("ja", "35.68,139.55"), "渋谷区".to_string());
        cache.insert(cache_key("en", "35.68,139.55"), "Shibuya".to_string());
        cache.insert(cache_key("ja", "43.06,141.35"), "札幌市".to_string());

        assert_eq!(cache.lookup("en", "35.68,139.55"), Some("Shibuya"));
        assert_eq!(cache.lookup("en", "43.06,141.35"), Some("札幌市"));
        assert_eq!(cache.lookup("en", "0.00,0.00"), None);
    }

    /// 言語を付けて書く前の控え。消しには行かないので、読めるうちは読む。
    #[test]
    fn lookup_reads_a_legacy_key_without_a_language() {
        let mut cache = PlaceCache::default();
        cache.insert("35.68,139.55".to_string(), "渋谷区".to_string());

        assert_eq!(cache.lookup("ja", "35.68,139.55"), Some("渋谷区"));
    }

    #[test]
    fn the_cache_remembers_which_language_it_asked_in() {
        assert_eq!(cache_key("en", "35.68,139.55"), "en:35.68,139.55");
        assert_ne!(
            cache_key("en", "35.68,139.55"),
            cache_key("ja", "35.68,139.55")
        );
    }
}
