//! Holds the `JavaVM` and an application `Context` for the life of the process.
//!
//! Rust cannot make an Android `Context` on its own, yet a `Geocoder` and the
//! certificate store are only reachable through one. tao receives the
//! `Activity` from Java when it is created and keeps it in a per-activity
//! table; `init` reads that table once, at startup, and asks the activity for
//! the application context, which the app then owns through its own global
//! reference.
//!
//! The activity itself is not kept. tao's table only holds a raw copy of a
//! reference that wry releases when the activity is destroyed, and a reverse
//! geocode running on a blocking thread has no way to notice. The application
//! context lives as long as the process, so a reference to it cannot go stale.
//!
//! Until tao 0.34 the same pointers were also published through the global
//! `ndk-context` crate. tao 0.35 stopped filling it, so reading it panicked at
//! startup with "android context was not initialized". Filling it ourselves
//! was rejected: it can only be initialised once per process, while the
//! activity is recreated, and nothing else in the workspace reads it.

use std::sync::OnceLock;

use jni::objects::JObject;
use jni::refs::Global;
use jni::{Env, JavaVM, jni_sig, jni_str};
use tauri::tao::platform::android::prelude::main_android_context;

struct AppContext {
    vm: JavaVM,
    context: Global<JObject<'static>>,
}

static CONTEXT: OnceLock<AppContext> = OnceLock::new();

/// Takes the application context from the first activity. Called once from
/// `setup`, which runs after that activity exists; calling it again is a no-op.
pub(crate) fn init() -> Result<(), jni::errors::Error> {
    if CONTEXT.get().is_some() {
        return Ok(());
    }
    let Some(ctx) = main_android_context() else {
        return Err(jni::errors::Error::NullPtr("no activity"));
    };
    // SAFETY: tao copies the process' JavaVM pointer at activity creation; the
    // VM outlives the process.
    let vm = unsafe { JavaVM::from_raw(ctx.java_vm.cast()) };
    let context = vm.attach_current_thread(|env| {
        // SAFETY: a raw copy of the global reference wry keeps until the
        // activity is destroyed. `setup` runs while the first activity is
        // alive, and the reference is only borrowed for this one call.
        let activity = unsafe { JObject::from_raw(env, ctx.context_jobject.cast()) };
        let app = env
            .call_method(
                &activity,
                jni_str!("getApplicationContext"),
                jni_sig!(() -> android.content.Context),
                &[],
            )?
            .l()?;
        env.new_global_ref(app)
    })?;
    let _ = CONTEXT.set(AppContext { vm, context });
    Ok(())
}

/// Runs `f` on the current thread, attached to the VM, with the application
/// context. `None` until `init` has succeeded.
pub(crate) fn with_context<T>(
    f: impl FnOnce(&mut Env<'_>, JObject<'_>) -> jni::errors::Result<T>,
) -> Option<jni::errors::Result<T>> {
    let app = CONTEXT.get()?;
    Some(app.vm.attach_current_thread(|env| {
        // SAFETY: the app's own global reference. `CONTEXT` is never cleared,
        // so it is valid for as long as the process runs.
        let context = unsafe { JObject::from_raw(env, app.context.as_raw()) };
        f(env, context)
    }))
}
