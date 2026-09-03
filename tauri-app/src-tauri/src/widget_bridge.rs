//! JNI entry point for the Android home screen widget.
//!
//! The widget's capture sheet runs outside the `WebView`, so it cannot go through
//! `#[tauri::command]`. It calls straight into the same core function the
//! in-app capture bar uses — reimplementing the append in Kotlin would mean
//! reimplementing the `DayLog` frontmatter and the row-level JSON, and any
//! disagreement there shows up as a sync conflict rather than as a crash.
//!
//! jni 0.22 hands native methods an [`EnvUnowned`], which carries no JNI API of
//! its own; the real [`Env`](jni::Env) only exists inside `with_env`, which also
//! catches panics. Every entry point here resolves with [`LogErrorAndDefault`]
//! rather than the throwing policy — see the note on `saveQuickCapture`.

use jni::EnvUnowned;
use jni::errors::LogErrorAndDefault;
use jni::objects::{JClass, JString};
use jni::sys::{JNI_FALSE, JNI_TRUE, jboolean};
use magical_merchant_core::Source;
use std::path::Path;

use crate::device;
use crate::widget_summary;

/// Anything arriving through this file was written from the home screen
/// widget, so the value is fixed here rather than read out of `client_json`.
/// Putting it in the Kotlin payload would let a JSON the app never wrote
/// claim to be a widget entry, and it would mean a JNI signature change for
/// a value the Rust side already knows.
const WIDGET_SOURCE: Source = Source::Widget;

/// Appends `text` to today's timeline file under `base_dir`.
///
/// The symbol name is the JNI mangling of
/// `com.magical_merchant.app.widget.WidgetBridge.saveQuickCapture`: dots become
/// underscores and an underscore in a package component escapes to `_1`.
/// Renaming the Kotlin package or object without renaming this function leaves
/// the `external fun` unresolved until the first tap.
///
/// `client_json` is what Kotlin could gather (`WidgetContext.collect`), in the
/// same shape the `WebView` sends. Android's native side sees neither battery
/// nor network, so without it a widget entry would carry only `os` and `arch`.
///
/// Returns false rather than throwing: the caller keeps the sheet open on
/// failure so the typed text is not lost, and a Java exception crossing back
/// through an `AppWidgetProvider` tap would take the launcher's process with it.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_magical_1merchant_app_widget_WidgetBridge_saveQuickCapture(
    mut unowned_env: EnvUnowned<'_>,
    _class: JClass<'_>,
    base_dir: JString<'_>,
    text: JString<'_>,
    client_json: JString<'_>,
) -> jboolean {
    unowned_env
        .with_env(|env| -> jni::errors::Result<jboolean> {
            let (Ok(base_dir), Ok(text)) = (base_dir.try_to_string(env), text.try_to_string(env))
            else {
                return Ok(JNI_FALSE);
            };

            // An unreadable string is the same as an unreadable JSON: the entry is
            // saved without the metadata rather than not saved at all.
            let client = client_json
                .try_to_string(env)
                .map(|json| device::parse_client_context(&json))
                .unwrap_or_default();
            let context = device::get_context(client);
            let saved = magical_merchant_core::save_timeline_entry(
                Path::new(&base_dir),
                &text,
                &context,
                WIDGET_SOURCE,
            );

            Ok(if saved.is_ok() { JNI_TRUE } else { JNI_FALSE })
        })
        .resolve::<LogErrorAndDefault>()
}

/// Today's last entry and tags, as JSON. Reads one day file.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_magical_1merchant_app_widget_WidgetBridge_readCaptureData<
    'local,
>(
    mut unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
    base_dir: JString<'local>,
) -> JString<'local> {
    unowned_env
        .with_env(|env| -> jni::errors::Result<JString<'local>> {
            Ok(read_json(env, base_dir, widget_summary::collect_capture))
        })
        .resolve::<LogErrorAndDefault>()
}

/// The most recent notes, as JSON. Reads the whole notes tree, which is why it
/// is not folded into `readCaptureData`.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_magical_1merchant_app_widget_WidgetBridge_readNotes<'local>(
    mut unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
    base_dir: JString<'local>,
) -> JString<'local> {
    unowned_env
        .with_env(|env| -> jni::errors::Result<JString<'local>> {
            Ok(read_json(env, base_dir, widget_summary::collect_notes))
        })
        .resolve::<LogErrorAndDefault>()
}

/// The templates the widget offers, as JSON. Reads only the templates
/// directory, so the buttons do not wait on the whole notes tree.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_magical_1merchant_app_widget_WidgetBridge_readTemplates<'local>(
    mut unowned_env: EnvUnowned<'local>,
    _class: JClass<'local>,
    base_dir: JString<'local>,
) -> JString<'local> {
    unowned_env
        .with_env(|env| -> jni::errors::Result<JString<'local>> {
            Ok(read_json(env, base_dir, widget_summary::collect_templates))
        })
        .resolve::<LogErrorAndDefault>()
}

/// Serializes whatever `collect` gathers under `base_dir`.
///
/// An unreadable path yields `{}`, not an exception: a Java exception crossing
/// back through a widget callback would take the launcher's process with it.
fn read_json<'local, T: serde::Serialize>(
    env: &mut jni::Env<'local>,
    base_dir: JString<'local>,
    collect: impl Fn(&Path) -> T,
) -> JString<'local> {
    let json = base_dir
        .try_to_string(env)
        .ok()
        .map(|dir| collect(Path::new(&dir)))
        .and_then(|data| serde_json::to_string(&data).ok())
        .unwrap_or_else(|| "{}".to_string());

    // A failed allocation leaves nothing to return but a null JString, which
    // Kotlin sees as null and treats as "no data".
    env.new_string(json).unwrap_or_default()
}
