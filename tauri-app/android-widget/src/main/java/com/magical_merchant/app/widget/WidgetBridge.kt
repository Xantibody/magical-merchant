package com.magical_merchant.app.widget

import android.content.Context
import org.json.JSONObject

/** 一覧に出すノート 1 件。 */
internal data class NoteRow(val title: String, val filename: String, val date: String)

/** ウィジェットのボタン 1 つぶんのテンプレ。名前がそのまま起動の引数になる。 */
internal data class TemplateRow(val name: String)

/** キャプチャバーとシートが描くぶん。読めなければ空。 */
internal data class CaptureData(
    val lastTime: String = "",
    val lastText: String = "",
    val tags: List<String> = emptyList(),
) {
    val hasLastEntry: Boolean get() = lastText.isNotEmpty()
}

/**
 * The Rust side of the widgets.
 *
 * The library name is the `[lib] name` in src-tauri/Cargo.toml, and the symbols
 * behind the `external fun`s are spelled out in src-tauri/src/widget_bridge.rs —
 * renaming this object or its package breaks the link at the first tap, not at
 * build time.
 *
 * Release builds minify, and nothing in the manifest points here. What keeps R8
 * from renaming the class out from under the symbols is the default
 * `proguard-android-optimize.txt` rule for `native <methods>`; dropping the
 * default proguard file from build.gradle.kts would break this silently.
 */
internal object WidgetBridge {
    init {
        System.loadLibrary("magical_merchant_app_lib")
    }

    /**
     * Appends [text] to today's timeline file under [baseDir]. False on failure.
     *
     * [clientJson] is [WidgetContext]'s output — what Kotlin could see of the
     * device. Call [saveCapture] rather than this: forgetting the JSON here
     * still compiles and still saves, it just silently drops the metadata.
     */
    external fun saveQuickCapture(baseDir: String, text: String, clientJson: String): Boolean

    /** Today's last entry and tags, as JSON. Reads one day file. */
    external fun readCaptureData(baseDir: String): String?

    /** The most recent notes, as JSON. Reads the whole notes tree. */
    external fun readNotes(baseDir: String): String?

    /** The templates to offer, as JSON. Reads only the templates directory. */
    external fun readTemplates(baseDir: String): String?

    /**
     * The directory Tauri's `app_data_dir()` resolves to, so the widget and the
     * app read and write the same tree.
     *
     * This is `dataDir`, not `filesDir`: Tauri's PathPlugin answers `getDataDir`
     * with `Context.getDataDir()`, and `filesDir` is the `files/` subdirectory of
     * it — writing there would produce a second, invisible timeline that the app
     * never reads and sync never uploads.
     */
    fun baseDir(context: Context): String = context.applicationContext.dataDir.absolutePath

    /**
     * Saves [text] with everything [WidgetContext] could gather. False on failure.
     *
     * The three reads have always been wrapped; this one used to call across JNI
     * bare, and it is the single call whose input cannot be reconstructed. An
     * `UnsatisfiedLinkError` — the failure the KDoc above warns about — took the
     * sheet down with the typed line still in it. As `false` it reaches the
     * caller's toast instead, which leaves the sheet open so the line can be
     * sent again.
     */
    // AIDEV-NOTE: never let this throw — the sheet is the only copy of the text; a crash here loses what the user wrote.
    fun saveCapture(context: Context, text: String): Boolean {
        val saved = runCatching {
            saveQuickCapture(baseDir(context), text, WidgetContext.collect(context))
        }.getOrElse { error ->
            WidgetLog.error("saveQuickCapture threw; the sheet keeps the text", error)
            false
        }

        // Rust answers false for every kind of refusal (`widget_bridge.rs` folds
        // the Err into a bool), so say at least that the call was reached.
        if (!saved) {
            WidgetLog.warn("timeline entry not written (${text.length} chars); the sheet stays open")
        }
        return saved
    }

    /**
     * Reads and parses. Never throws: these run from widget callbacks that have
     * a few seconds to draw something, and a torn or absent data tree is a
     * normal state — the app may simply not have been opened yet.
     *
     * Normal, but not silent: an empty result is logged because it is also what
     * a broken JNI link and an unparseable payload look like from here.
     */
    fun readCapture(context: Context): CaptureData =
        runCatching { parseCapture(read(context, ::readCaptureData)) }
            .getOrElse { failed("capture data", it, CaptureData()) }

    fun readNoteRows(context: Context): List<NoteRow> =
        runCatching { parseNotes(read(context, ::readNotes)) }
            .getOrElse { failed("notes", it, emptyList()) }

    fun readTemplateRows(context: Context): List<TemplateRow> =
        runCatching { parseTemplates(read(context, ::readTemplates)) }
            .getOrElse { failed("templates", it, emptyList()) }

    private fun <T> failed(what: String, error: Throwable, fallback: T): T {
        WidgetLog.error("could not read $what; the widget draws empty", error)
        return fallback
    }

    private fun read(context: Context, call: (String) -> String?): String =
        runCatching { call(baseDir(context)) }
            .onFailure { WidgetLog.error("JNI read failed", it) }
            .getOrNull().orEmpty().ifEmpty { "{}" }

    private fun parseCapture(raw: String): CaptureData {
        val root = JSONObject(raw)
        val last = root.optJSONObject("last")
        val tags = root.optJSONArray("tags")

        return CaptureData(
            lastTime = last?.optString("time").orEmpty(),
            lastText = last?.optString("text").orEmpty(),
            tags = List(tags?.length() ?: 0) { tags?.optString(it).orEmpty() }
                .filter { it.isNotEmpty() },
        )
    }

    private fun parseTemplates(raw: String): List<TemplateRow> {
        val templates = JSONObject(raw).optJSONArray("templates")
        return List(templates?.length() ?: 0) { index ->
            TemplateRow(name = templates?.optJSONObject(index)?.optString("name").orEmpty())
        }.filter { it.name.isNotEmpty() }
    }

    private fun parseNotes(raw: String): List<NoteRow> {
        val notes = JSONObject(raw).optJSONArray("notes")
        return List(notes?.length() ?: 0) { index ->
            val note = notes?.optJSONObject(index)
            NoteRow(
                title = note?.optString("title").orEmpty(),
                filename = note?.optString("filename").orEmpty(),
                date = note?.optString("date").orEmpty(),
            )
        }.filter { it.filename.isNotEmpty() }
    }
}
