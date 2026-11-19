//! What the running app asks of the Android home screen widgets.
//!
//! The widgets poll every 30 minutes, the platform minimum. A template saved or
//! a note made from one in the app would otherwise leave a button showing a stale
//! title (or a stale `{{prev}}`) for up to that long, so the commands that write
//! those tell the widgets at once. Pinning a template button is the
//! other direction: the app asks the launcher to place one.
//!
//! Both go through `WidgetUpdates` in Kotlin
//! (`android-widget/…/widget/WidgetUpdates.kt`), looked up by name. Off Android
//! there are no widgets: refreshing does nothing and pinning is unsupported.

use magical_merchant_core::NoteFilename;

/// Redraws every template widget. Never fails the caller: the write it follows
/// already happened, and a widget that missed this catches up on its next poll.
// Empty off Android, where clippy would have it const; the Android body is not.
#[cfg_attr(not(target_os = "android"), allow(clippy::missing_const_for_fn))]
pub(crate) fn refresh_templates() {
    #[cfg(target_os = "android")]
    platform::refresh_templates();
}

/// Whether this device's launcher can place a widget on request.
// Empty off Android, where clippy would have it const; the Android body is not.
#[cfg_attr(not(target_os = "android"), allow(clippy::missing_const_for_fn))]
#[tauri::command]
pub(crate) fn template_widget_pinnable() -> bool {
    #[cfg(target_os = "android")]
    {
        platform::can_pin()
    }
    #[cfg(not(target_os = "android"))]
    {
        false
    }
}

/// Asks the launcher to place a button for the template `filename`.
///
/// `true` means the request went out; the system shows its own confirmation, and
/// declining there is not reported back. `false` means this device cannot pin.
#[tauri::command]
pub(crate) fn pin_template_widget(filename: String) -> Result<bool, String> {
    let filename = NoteFilename::parse(&filename).map_err(|e| e.to_string())?;
    let name = template_name(&filename);
    #[cfg(target_os = "android")]
    {
        Ok(platform::request_pin(name))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = name;
        Ok(false)
    }
}

/// The name a widget stores and puts on its deep link: the filename minus `.md`,
/// the same value a note made from the template records.
fn template_name(filename: &NoteFilename) -> &str {
    let name = filename.as_str();
    name.strip_suffix(".md").unwrap_or(name)
}

#[cfg(target_os = "android")]
mod platform {
    use jni::objects::{JClass, JClassLoader, JObject, JValue};
    use jni::refs::LoaderContext;
    use jni::{Env, jni_sig, jni_str};

    /// Loaded through `Context.getClassLoader()`, the loader that holds the app's
    /// own classes. `FindClass` from a thread Rust attached sees only the system
    /// classes, and the context object's class is the framework's
    /// `android.app.Application`, whose loader knows nothing of this app either.
    fn class<'local>(
        env: &mut Env<'local>,
        context: &JObject<'_>,
    ) -> jni::errors::Result<JClass<'local>> {
        let loader = env
            .call_method(
                context,
                jni_str!("getClassLoader"),
                jni_sig!(() -> java.lang.ClassLoader),
                &[],
            )?
            .l()?;
        let loader = env.cast_local::<JClassLoader<'_>>(loader)?;
        LoaderContext::Loader(&loader).load_class(
            env,
            jni_str!("com.magical_merchant.app.widget.WidgetUpdates"),
            true,
        )
    }

    /// Runs `f` with the widget class and the application context. A Java
    /// exception left pending would fail the next, unrelated JNI call, so any
    /// error clears it here. `None` before the context exists or on failure.
    fn with_widgets<T>(
        f: impl FnOnce(&mut Env<'_>, &JClass<'_>, &JObject<'_>) -> jni::errors::Result<T>,
    ) -> Option<T> {
        let result = crate::android_context::with_context(|env, context| {
            let outcome = class(env, &context).and_then(|class| f(env, &class, &context));
            if outcome.is_err() {
                let _ = env.exception_clear();
            }
            outcome
        })?;
        result
            .inspect_err(|e| log::warn!("WidgetUpdates call failed: {e}"))
            .ok()
    }

    pub(super) fn refresh_templates() {
        with_widgets(|env, class, context| {
            env.call_static_method(
                class,
                jni_str!("refreshTemplates"),
                jni_sig!((context: android.content.Context) -> void),
                &[JValue::Object(context)],
            )?;
            Ok(())
        });
    }

    pub(super) fn can_pin() -> bool {
        with_widgets(|env, class, context| {
            env.call_static_method(
                class,
                jni_str!("canPinTemplateButton"),
                jni_sig!((context: android.content.Context) -> boolean),
                &[JValue::Object(context)],
            )?
            .z()
        })
        .unwrap_or(false)
    }

    pub(super) fn request_pin(name: &str) -> bool {
        with_widgets(|env, class, context| {
            let name = env.new_string(name)?;
            env.call_static_method(
                class,
                jni_str!("requestPinTemplateButton"),
                jni_sig!((context: android.content.Context, name: java.lang.String) -> boolean),
                &[JValue::Object(context), JValue::Object(&name)],
            )?
            .z()
        })
        .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_widget_is_told_the_name_not_the_filename() {
        let filename = NoteFilename::parse("daily.md").unwrap();
        assert_eq!(template_name(&filename), "daily");
    }

    /// Off Android there is nothing to pin to; the menu entry reads this to hide itself.
    #[test]
    fn pinning_is_unsupported_off_android() {
        assert!(!template_widget_pinnable());
        assert_eq!(pin_template_widget("daily.md".to_string()), Ok(false));
    }

    #[test]
    fn a_bad_filename_is_refused() {
        assert!(pin_template_widget("../x.md".to_string()).is_err());
    }
}
