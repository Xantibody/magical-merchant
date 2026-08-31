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
