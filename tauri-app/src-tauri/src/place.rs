//! 座標から地名を引く。
//!
//! 記録に残るのは座標のままで、これは読むときだけの言い換え。市区町村が
//! 分かれば十分なので、番地や建物名は捨てて上の行政区画へ落とす。
//!
//! 自前の地名データは持たない。数 MB の辞書を同梱しても OS が既に持っている
//! ものの劣化版にしかならず、住所の言い方は国ごとに違う。

use magical_merchant_core::utils::paths::place_cache_path;
use magical_merchant_core::utils::place::{PlaceCache, cache_key, place_key};
use std::path::Path;

/// 地名の分かった座標だけを、[`place_key`] 付きで返す。
///
/// 引けなかった座標は結果に現れない。呼び出し側は座標のまま見せる。
///
/// `locale` は画面がいま使っている言語(`ja` / `en`)。OS は言語ごとに違う
/// 名前を返すので、控えも言語ごとに分けて持つ。
pub(crate) fn resolve(
    base_dir: &Path,
    coordinates: &[(f64, f64)],
    locale: &str,
) -> Vec<(String, String)> {
    let path = place_cache_path(base_dir);
    let mut cache = PlaceCache::load(&path);
    let mut resolved = Vec::new();
    let mut asked = false;

    for &(latitude, longitude) in coordinates {
        let key = place_key(latitude, longitude);
        if resolved.iter().any(|(k, _): &(String, String)| *k == key) {
            continue;
        }
        // 返すのは座標だけのキー。画面が引き当てるのはそちらで、
        // 言語を混ぜるのは控えの中だけに閉じる
        let cached = cache_key(locale, &key);
        if let Some(place) = cache.get(&cached) {
            resolved.push((key, place.to_string()));
            continue;
        }
        // 圏外なら全件そろって失敗する。1 件目で分かったことに 30 件つき合わせない。
        let Some(place) = geocode(latitude, longitude, locale) else {
            break;
        };
        cache.insert(cached, place.clone());
        asked = true;
        resolved.push((key, place));
    }

    if asked {
        // 書けなくても引けた地名は返す。次に開いたとき聞き直すだけで済む。
        let _ = cache.save(&path);
    }
    resolved
}

/// 住所の各段から、地図で指させるいちばん細かいものを選ぶ。
///
/// 市区町村 → 郡 → 都道府県/州 → 国。市の付かない土地でも空にならないよう
/// 上へ落としていく。
///
/// ジオコーダを持たない Linux では呼ぶ側が居なくなるが、ビルドは全 OS でする:
/// CI は Linux で走り、どの段を選ぶかはここのテストが確かめている部分。
#[cfg_attr(not(any(target_os = "macos", target_os = "android")), allow(dead_code))]
fn coarsest_name(
    locality: Option<String>,
    sub_administrative_area: Option<String>,
    administrative_area: Option<String>,
    country: Option<String>,
) -> Option<String> {
    [
        locality,
        sub_administrative_area,
        administrative_area,
        country,
    ]
    .into_iter()
    .flatten()
    .find(|name| !name.trim().is_empty())
}

#[cfg(target_os = "macos")]
mod platform {
    //! macOS 26 SDK は `CLGeocoder` を非推奨にし、MapKit を指している。乗り換えない
    //! のは、MapKit が地図描画のフレームワーク一式を道連れにするため。番地も要らず
    //! 地名 1 つ引くだけの用途に、UI フレームワークを積む釣り合いがない。
    //! 消えたら地名が引けなくなるだけで、座標表示に落ちて記録は失われない。
    #![allow(deprecated)]

    use super::coarsest_name;
    use block2::RcBlock;
    use objc2::AnyThread as _;
    use objc2_core_location::{CLGeocoder, CLLocation, CLPlacemark};
    use objc2_foundation::{NSArray, NSError, NSLocale, NSString};
    use std::sync::mpsc;
    use std::time::Duration;

    /// ジオコーダの返事を待つ上限。
    ///
    /// `CLGeocoder` は圏外でもすぐには諦めず、待たせたぶんだけ IPC が返らない。
    /// 実測では 1 件 100ms を切るので、これを使い切るのは引けないときだけ。
    /// 座標のまま出す用意はあるので、待つより先に諦める。
    const TIMEOUT: Duration = Duration::from_secs(8);

    /// # Panics
    ///
    /// しない。返事が来なければ時間切れで `None` を返す。
    ///
    /// メインスレッドから呼んではいけない。`CLGeocoder` は完了ブロックを
    /// メインキューに載せるので、そこで待つと自分の返事を自分で塞ぎ、必ず
    /// 時間切れになる。呼び出し元の `resolve_places` はそのために `async`。
    pub(super) fn geocode(latitude: f64, longitude: f64, locale: &str) -> Option<String> {
        // SAFETY: どちらもただのオブジェクト生成で、スレッドの制約を持たない。
        let (location, geocoder) = unsafe {
            (
                CLLocation::initWithLatitude_longitude(CLLocation::alloc(), latitude, longitude),
                CLGeocoder::new(),
            )
        };
        // 言語を渡さないと OS の設定で返る。画面が英語でも地名だけ日本語になる
        let preferred = NSLocale::localeWithLocaleIdentifier(&NSString::from_str(locale));
        let (tx, rx) = mpsc::channel();

        // ジオコーダ自身をブロックに持たせて、返事が来るまで生かしておく。
        let held = geocoder.clone();
        let handler = RcBlock::new(
            move |placemarks: *mut NSArray<CLPlacemark>, _: *mut NSError| {
                let _ = &held;
                // SAFETY: CoreLocation が渡してくるのは自分の持ち物で、ブロックが
                // 戻るまでは生きている。住所の各段を読むのもその間だけ。
                let name = unsafe {
                    placemarks
                        .as_ref()
                        .and_then(NSArray::firstObject)
                        .and_then(|mark| {
                            coarsest_name(
                                mark.locality().map(|s| s.to_string()),
                                mark.subAdministrativeArea().map(|s| s.to_string()),
                                mark.administrativeArea().map(|s| s.to_string()),
                                mark.country().map(|s| s.to_string()),
                            )
                        })
                };
                let _ = tx.send(name);
            },
        );

        // SAFETY: 完了ブロックを渡すだけ。CLGeocoder は受け取ったブロックを自分で
        // 複製して持つので、時間切れでこちらが手放しても呼び出し先は生きている。
        unsafe {
            geocoder.reverseGeocodeLocation_preferredLocale_completionHandler(
                &location,
                Some(&preferred),
                RcBlock::as_ptr(&handler),
            );
        }

        rx.recv_timeout(TIMEOUT).ok().flatten()
    }
}

#[cfg(target_os = "android")]
mod platform {
    use super::coarsest_name;
    use jni::objects::{JObject, JString, JValue};
    use jni::strings::JNIStr;
    use jni::{Env, JavaVM, jni_sig, jni_str};

    /// `Geocoder` は端末の Context と結び付いているので、Rust から素で作れない。
    /// `ndk_context` が握っている VM と Activity を借りて Java 側を呼ぶ。
    pub(super) fn geocode(latitude: f64, longitude: f64, locale: &str) -> Option<String> {
        let ctx = ndk_context::android_context();
        // SAFETY: tao がアプリ起動時に入れたポインタ。プロセスが生きている間有効。
        let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) };
        // jni 0.22 の attach は `Env` を閉包の中にしか出さない。借りた寿命が
        // スタックの一区間に固定され、アタッチ解除後に持ち出せなくなる
        vm.attach_current_thread(|env| -> jni::errors::Result<Option<String>> {
            // SAFETY: 同上。Activity の参照で、借りている間だけ使う。
            let context = unsafe { JObject::from_raw(env, ctx.context().cast()) };

            let name = lookup(env, &context, latitude, longitude, locale);
            if name.is_none() {
                // 圏外の `getFromLocation` は IOException を投げる。積んだままにすると
                // 次に JNI を跨いだところで無関係な呼び出しが落ちる。
                let _ = env.exception_clear();
            }
            Ok(name)
        })
        .ok()
        .flatten()
    }

    fn lookup(
        env: &mut Env<'_>,
        context: &JObject<'_>,
        latitude: f64,
        longitude: f64,
        language: &str,
    ) -> Option<String> {
        // 端末の既定ではなく画面の言語で聞く。`Locale.getDefault()` だと、
        // 英語にしたアプリの中で地名だけ端末の言語で返る
        let tag = env.new_string(language).ok()?;
        let locale = env
            .new_object(
                jni_str!("java/util/Locale"),
                jni_sig!((tag: java.lang.String) -> void),
                &[JValue::Object(&tag)],
            )
            .ok()?;
        let geocoder = env
            .new_object(
                jni_str!("android/location/Geocoder"),
                jni_sig!((context: android.content.Context, locale: java.util.Locale) -> void),
                &[JValue::Object(context), JValue::Object(&locale)],
            )
            .ok()?;

        // 1 件だけ求める。2 件目以降は同じ場所の別の言い方でしかない。
        let addresses = env
            .call_method(
                &geocoder,
                jni_str!("getFromLocation"),
                jni_sig!((latitude: double, longitude: double, max: int) -> java.util.List),
                &[
                    JValue::Double(latitude),
                    JValue::Double(longitude),
                    JValue::Int(1),
                ],
            )
            .ok()?
            .l()
            .ok()?;
        if addresses.is_null()
            || env
                .call_method(&addresses, jni_str!("size"), jni_sig!(() -> int), &[])
                .ok()?
                .i()
                .ok()?
                == 0
        {
            return None;
        }
        let address = env
            .call_method(
                &addresses,
                jni_str!("get"),
                jni_sig!((index: int) -> java.lang.Object),
                &[JValue::Int(0)],
            )
            .ok()?
            .l()
            .ok()?;

        coarsest_name(
            string_getter(env, &address, jni_str!("getLocality")),
            string_getter(env, &address, jni_str!("getSubAdminArea")),
            string_getter(env, &address, jni_str!("getAdminArea")),
            string_getter(env, &address, jni_str!("getCountryName")),
        )
    }

    /// `Address` の getter は、その段が無ければ null を返す。
    fn string_getter(env: &mut Env<'_>, address: &JObject<'_>, name: &JNIStr) -> Option<String> {
        let value = env
            .call_method(address, name, jni_sig!(() -> java.lang.String), &[])
            .ok()?
            .l()
            .ok()?;
        if value.is_null() {
            return None;
        }
        let text = env.cast_local::<JString<'_>>(value).ok()?;
        text.try_to_string(env).ok()
    }
}

/// Windows と Linux には、追加の依存なしに叩ける逆ジオコーダが無い。
/// 座標のまま見せる道が残っているので、ここでは黙って諦める。
#[cfg(not(any(target_os = "macos", target_os = "android")))]
mod platform {
    pub(super) const fn geocode(_latitude: f64, _longitude: f64, _locale: &str) -> Option<String> {
        None
    }
}

use platform::geocode;

#[cfg(test)]
mod tests {
    use super::*;

    /// 住所の 4 段を、無い段は `""` で。ジオコーダが空文字で返す段と
    /// そもそも返さない段は、どちらも「名乗れなかった」で区別しない。
    fn named(areas: [&str; 4]) -> Option<String> {
        let [locality, sub, admin, country] =
            areas.map(|area| (!area.is_empty()).then(|| area.to_string()));
        coarsest_name(locality, sub, admin, country)
    }

    #[test]
    fn a_municipality_beats_the_wider_areas_around_it() {
        assert_eq!(
            named(["渋谷区", "東京都", "東京都", "日本"]).as_deref(),
            Some("渋谷区")
        );
    }

    /// 市の付かない土地では郡や州しか返らない。そこで諦めると、記録が
    /// 「どこか」を名乗れなくなる。
    #[test]
    fn it_falls_back_through_the_wider_areas() {
        assert_eq!(
            named(["", "上川郡", "北海道", "日本"]).as_deref(),
            Some("上川郡")
        );
        assert_eq!(named(["", "", "北海道", "日本"]).as_deref(), Some("北海道"));
        assert_eq!(named(["", "", "", "日本"]).as_deref(), Some("日本"));
    }

    /// ジオコーダは分からない段を空白だけの文字列で返すことがある。
    /// 空の名札は座標より役に立たない。
    #[test]
    fn a_blank_name_counts_as_missing() {
        assert_eq!(named(["  ", "", "北海道", ""]).as_deref(), Some("北海道"));
    }

    #[test]
    fn a_coordinate_no_one_can_name_stays_unnamed() {
        assert_eq!(named(["", "", "", ""]), None);
    }
}
