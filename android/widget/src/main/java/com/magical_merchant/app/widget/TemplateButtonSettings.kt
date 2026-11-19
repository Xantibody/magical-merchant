package com.magical_merchant.app.widget

import android.content.Context

/** What one placed template button shows: which template, and whether today's title too. */
internal data class TemplateButtonSetting(val name: String, val showTitle: Boolean)

/**
 * Per-widget choices of [TemplateButtonWidgetProvider], keyed by `appWidgetId`.
 *
 * Only the template's name is kept, never its title: the title changes with the
 * day and is resolved in core on every draw. A name that no longer matches a
 * template (renamed or deleted, here or on another device) draws the "choose a
 * template" state rather than a button that would fail on tap.
 *
 * These live in this device's SharedPreferences, not under `data/`: a widget id
 * means nothing on another device, so syncing it would only carry noise.
 */
internal object TemplateButtonSettings {
    private const val PREFS = "template_buttons"
    private const val NAME = "name_"
    private const val SHOW_TITLE = "show_title_"

    fun read(context: Context, appWidgetId: Int): TemplateButtonSetting? {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val name = prefs.getString(NAME + appWidgetId, null) ?: return null
        return TemplateButtonSetting(name, prefs.getBoolean(SHOW_TITLE + appWidgetId, true))
    }

    fun write(context: Context, appWidgetId: Int, setting: TemplateButtonSetting) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(NAME + appWidgetId, setting.name)
            .putBoolean(SHOW_TITLE + appWidgetId, setting.showTitle)
            .apply()
    }

    fun forget(context: Context, appWidgetIds: IntArray) {
        val editor = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
        appWidgetIds.forEach { id ->
            editor.remove(NAME + id)
            editor.remove(SHOW_TITLE + id)
        }
        editor.apply()
    }
}
