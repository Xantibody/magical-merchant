//! JNI entry point for the Android home screen widget.
//!
//! The widget's capture sheet runs outside the `WebView`, so it cannot go through
//! `#[tauri::command]`. It calls straight into the same core function the
//! in-app capture bar uses — reimplementing the append in Kotlin would mean
//! reimplementing the `DayLog` frontmatter and the row-level JSON, and any
//! disagreement there shows up as a sync conflict rather than as a crash.

use jni::JNIEnv;
use jni::objects::{JClass, JString};
use jni::sys::{JNI_FALSE, JNI_TRUE, jboolean};
use std::path::Path;

use crate::device::{self, ClientContext};
use crate::widget_summary;

/// Appends `text` to today's timeline file under `base_dir`.
///
/// The symbol name is the JNI mangling of
/// `com.magical_merchant.app.widget.WidgetBridge.saveQuickCapture`: dots become
/// underscores and an underscore in a package component escapes to `_1`.
/// Renaming the Kotlin package or object without renaming this function leaves
/// the `external fun` unresolved until the first tap.
///
/// Returns false rather than throwing: the caller keeps the sheet open on
/// failure so the typed text is not lost, and a Java exception crossing back
/// through an `AppWidgetProvider` tap would take the launcher's process with it.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_magical_1merchant_app_widget_WidgetBridge_saveQuickCapture(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    base_dir: JString<'_>,
    text: JString<'_>,
) -> jboolean {
    let (Ok(base_dir), Ok(text)) = (env.get_string(&base_dir), env.get_string(&text)) else {
        return JNI_FALSE;
    };

    // The widget has no WebView to ask, so battery, network, and location stay
    // empty here while the in-app bar fills them. Nothing downstream requires
    // them — `Context` skips absent fields when it serializes.
    let context = device::get_context(ClientContext::default());
    let saved = magical_merchant_core::save_timeline_entry(
        Path::new(&String::from(base_dir)),
        &String::from(text),
        &context,
    );

    if saved.is_ok() { JNI_TRUE } else { JNI_FALSE }
}

/// Today's last entry and tags, as JSON. Reads one day file.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_magical_1merchant_app_widget_WidgetBridge_readCaptureData<
    'local,
>(
    env: JNIEnv<'local>,
    _class: JClass<'local>,
    base_dir: JString<'local>,
) -> JString<'local> {
    read_json(env, base_dir, widget_summary::collect_capture)
}

/// The most recent notes, as JSON. Reads the whole notes tree, which is why it
/// is not folded into `readCaptureData`.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_magical_1merchant_app_widget_WidgetBridge_readNotes<'local>(
    env: JNIEnv<'local>,
    _class: JClass<'local>,
    base_dir: JString<'local>,
) -> JString<'local> {
    read_json(env, base_dir, widget_summary::collect_notes)
}

/// Serializes whatever `collect` gathers under `base_dir`.
///
/// An unreadable path yields `{}`, not an exception: a Java exception crossing
/// back through a widget callback would take the launcher's process with it.
fn read_json<'local, T: serde::Serialize>(
    mut env: JNIEnv<'local>,
    base_dir: JString<'local>,
    collect: impl Fn(&Path) -> T,
) -> JString<'local> {
    let json = env
        .get_string(&base_dir)
        .ok()
        .map(|dir| collect(Path::new(&String::from(dir))))
        .and_then(|data| serde_json::to_string(&data).ok())
        .unwrap_or_else(|| "{}".to_string());

    // A failed allocation leaves nothing to return but a null JString, which
    // Kotlin sees as null and treats as "no data".
    env.new_string(json).unwrap_or_default()
}
