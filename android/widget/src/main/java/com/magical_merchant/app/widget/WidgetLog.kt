package com.magical_merchant.app.widget

import android.util.Log

/**
 * The widgets' only channel back to whoever has to explain a blank bar.
 *
 * A widget callback has no UI of its own: a read that comes back empty draws an
 * empty bar and a save that fails shows one generic toast, so "the data tree is
 * not there yet", "the native library never loaded" and "core refused the
 * write" all look identical on the home screen. One line in logcat is the whole
 * difference.
 *
 * `android.util.Log`, not the Rust side's `log` crate: `android_logger::init_once`
 * runs in Tauri's `setup`, which never happens when the launcher binds a widget,
 * so anything Rust logs from a widget process is dropped. Kotlin's Log needs no
 * initialisation and is already in the process.
 *
 * ```sh
 * adb logcat -s MagicalWidget
 * ```
 */
// AIDEV-NOTE: android.util.Log, not android_logger — Rust's logger inits in Tauri setup, which widgets never run.
internal object WidgetLog {
    /** One tag for every widget, so a single `logcat -s` filter catches them all. */
    private const val TAG = "MagicalWidget"

    /** Something the user asked for did not happen. */
    fun error(message: String, cause: Throwable? = null) {
        if (cause == null) {
            Log.e(TAG, message)
        } else {
            Log.e(TAG, message, cause)
        }
    }

    /** Something came back empty or refused, without throwing. */
    fun warn(message: String) {
        Log.w(TAG, message)
    }
}
