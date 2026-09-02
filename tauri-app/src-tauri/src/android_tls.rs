//! Hands Android's certificate store to rustls, once, at startup.
//!
//! reqwest 0.13 verifies server certificates through `rustls-platform-verifier`
//! rather than a CA bundle compiled into the binary. On every other platform the
//! verifier reads the OS trust store on its own; on Android the trust store is
//! only reachable through Java, so the crate needs the process' `JavaVM` and an
//! app `Context` handed to it before the first request. Without this the first
//! sync fails with a certificate error and nothing says why.
//!
//! This has to happen before any HTTPS request, but a `Context` only exists once
//! the activity is up — hence `setup`, not a `ctor`.

use std::sync::OnceLock;

use jni::JavaVM;
use jni::objects::JObject;

static DONE: OnceLock<()> = OnceLock::new();

/// Idempotent: the verifier keeps a process-wide global and re-initialising it
/// is not defined, while `setup` can run again after the activity is recreated.
pub(crate) fn init() {
    DONE.get_or_init(|| {
        if let Err(e) = install() {
            // 落とさない。同期は使えなくなるが、書き留めるだけなら動く。
            // Android では tao が stderr を logcat へ流している
            eprintln!("rustls platform verifier init failed: {e}");
        }
    });
}

/// 同期クライアント用の TLS 設定。端末の検証器を迂回し、Mozilla のルート束で
/// 検証する。
///
/// 端末の検証器 (rustls-platform-verifier の Kotlin 側) は失効チェック付きで
/// PKIX 検証を走らせ、`CertPathValidatorException` を理由を見ずに Revoked に
/// 写す。Android の RevocationChecker は OCSP 応答者の無い証明書で
/// 「Certificate does not specify OCSP responder」を投げ、CRL への切り替えは
/// 平文 HTTP が既定で禁止されているので届かない。Let's Encrypt・Google Trust
/// Services・SSL.com は 2025 年に OCSP をやめたので、Cloudflare で選べる CA は
/// 全部この経路で落ちる。同期先の証明書は失効していない (CRL で確認済み)。
/// 上流: rustls/rustls-platform-verifier#221 (症状)、#179 (対処の議論)。
///
/// 上流の恒久策は CRL 配布ホストの許可リストを .aar の manifest に同梱する
/// こと。それが出たらこの関数と Cargo.toml の rustls / webpki-roots を消して
/// `reqwest::Client::new()` に戻す。`init` と Gradle 側の配線はそのために残す。
///
/// 失うもの: 端末に入れた独自 CA と失効チェック。同期先は自分の Worker 1 台で、
/// 失効チェックは端末の検証器でも実質 OCSP 頼みだったので、どちらも要らない。
pub(crate) fn sync_tls_config() -> Result<rustls::ClientConfig, rustls::Error> {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    // reqwest 0.13 の rustls feature が選ぶ provider と同じものを明示する。
    // `ClientConfig::builder()` は provider が 2 つ入っていると panic する
    let provider = std::sync::Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    Ok(rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .with_root_certificates(roots)
        .with_no_client_auth())
}

fn install() -> Result<(), jni::errors::Error> {
    let ctx = ndk_context::android_context();
    // SAFETY: tao がアプリ起動時に入れたポインタ。プロセスが生きている間有効。
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) };
    vm.attach_current_thread(|env| {
        // SAFETY: 同上。Activity の参照で、借りている間だけ使う。
        let context = unsafe { JObject::from_raw(env, ctx.context().cast()) };
        rustls_platform_verifier::android::init_with_env(env, context)
    })
}
