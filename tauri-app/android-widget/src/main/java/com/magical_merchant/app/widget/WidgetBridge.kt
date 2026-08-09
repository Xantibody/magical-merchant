package com.magical_merchant.app.widget

import android.content.Context

/**
 * The Rust side of the capture sheet.
 *
 * The library name is the `[lib] name` in src-tauri/Cargo.toml, and the symbol
 * behind [saveQuickCapture] is spelled out in src-tauri/src/widget_bridge.rs —
 * renaming this object or its package breaks the link at the first tap, not at
 * build time.
 *
 * Release builds minify, and nothing in the manifest points here. What keeps R8
 * from renaming the class out from under the symbol is the default
 * `proguard-android-optimize.txt` rule for `native <methods>`; dropping the
 * default proguard file from build.gradle.kts would break this silently.
 */
internal object WidgetBridge {
    init {
        System.loadLibrary("magical_merchant_app_lib")
    }

    /** Appends [text] to today's timeline file under [baseDir]. False on failure. */
    external fun saveQuickCapture(baseDir: String, text: String): Boolean

    /**
     * The directory Tauri's `app_data_dir()` resolves to, so the widget and the
     * app write to the same tree.
     *
     * This is `dataDir`, not `filesDir`: Tauri's PathPlugin answers `getDataDir`
     * with `Context.getDataDir()`, and `filesDir` is the `files/` subdirectory of
     * it — writing there would produce a second, invisible timeline that the app
     * never reads and sync never uploads.
     */
    fun baseDir(context: Context): String = context.applicationContext.dataDir.absolutePath
}
