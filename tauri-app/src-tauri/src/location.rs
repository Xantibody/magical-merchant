//! macOS の位置情報。
//!
//! `tauri-plugin-geolocation` はデスクトップが実装スタブで、`Position::default()`
//! をそのまま返す。許可を尋ねることすらしないので、Mac で書いた記録には座標が
//! 一度も残っていなかった。CoreLocation を直に叩く。

use std::cell::OnceCell;
use std::sync::Mutex;
use std::time::Duration;

use magical_merchant_core::utils::device::Location;
use objc2::rc::Retained;
use objc2_core_location::{CLLocationManager, kCLLocationAccuracyHundredMeters};
use tauri::AppHandle;

/// 直近に取れた座標。
///
/// `CLLocationManager` はメインスレッドに縛られていて `Send` でもないので、
/// 記録する側とはこの箱越しにやり取りする。
static LAST_FIX: Mutex<Option<Location>> = Mutex::new(None);

/// 何メートル動いたら次の更新を受け取るか。
///
/// どこで書いたかが分かればよく、番地まで当てる必要はない。細かくするほど
/// GPS を回す時間が延びるだけで、記録の読み返しには何も足さない。
const DISTANCE_FILTER_METERS: f64 = 50.0;

/// 座標を箱に写し直す間隔。
///
/// 更新そのものは OS 側が距離で間引くので、この間隔が変えるのは手元の写しが
/// どれだけ古くなりうるかだけ。起動直後の 1 件目にも座標を載せたいので、
/// 分単位まで空けない。
const POLL_INTERVAL: Duration = Duration::from_secs(10);

thread_local! {
    /// メインスレッドだけが触る。落とすと更新も黙って止まるので握り続ける。
    static MANAGER: OnceCell<Retained<CLLocationManager>> = const { OnceCell::new() };
}

/// メインスレッドで、いま分かっている座標を箱に写す。
///
/// # Panics
///
/// しない。許可がなければ `location` が `None` を返すだけで、そのまま戻る。
fn refresh() {
    MANAGER.with(|cell| {
        let manager = cell.get_or_init(|| {
            // SAFETY: run_on_main_thread の中でしか呼ばれない。CoreLocation は
            // 初期化したスレッドの run loop に結果を返すので、Tauri のイベント
            // ループが回っているメインスレッドで作る必要がある。
            unsafe {
                let manager = CLLocationManager::new();
                manager.setDesiredAccuracy(kCLLocationAccuracyHundredMeters);
                manager.setDistanceFilter(DISTANCE_FILTER_METERS);
                manager.requestWhenInUseAuthorization();
                manager.startUpdatingLocation();
                manager
            }
        });

        // SAFETY: 同上。まだ測位できていなければ None が返る。
        let Some(fix) = (unsafe { manager.location() }) else {
            return;
        };
        // SAFETY: 同上。
        let coordinate = unsafe { fix.coordinate() };
        // SAFETY: 同上。測位に失敗した座標は範囲外の値で返ってくる。
        if !unsafe { coordinate.is_valid() } {
            return;
        }

        if let Ok(mut last) = LAST_FIX.lock() {
            *last = Some(Location {
                latitude: coordinate.latitude,
                longitude: coordinate.longitude,
            });
        }
    });
}

/// 記録に載せる座標。まだ 1 度も測位できていなければ `None`。
pub(crate) fn latest() -> Option<Location> {
    LAST_FIX.lock().ok().and_then(|fix| fix.clone())
}

/// 位置情報の受け取りを始める。
///
/// 保存のたびにメインスレッドの応答を待つと、待つ側がメインスレッドだった場合に
/// 固まる。裏で写し続けておいて、保存時は箱を読むだけにする。
pub(crate) fn start(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        // 失敗するのはアプリが畳まれたとき。追いかける相手がいないので降りる。
        while handle.run_on_main_thread(refresh).is_ok() {
            std::thread::sleep(POLL_INTERVAL);
        }
    });
}
