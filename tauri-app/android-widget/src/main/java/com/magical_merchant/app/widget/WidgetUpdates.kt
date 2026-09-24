package com.magical_merchant.app.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.annotation.Keep

/**
 * What the app (Rust, through JNI) asks of the widgets while it runs.
 *
 * Called from `src-tauri/src/widget_updates.rs` by class and method name, and
 * nothing in Kotlin calls it, so R8 would strip it from a release build; `@Keep`
 * is what the default ProGuard file honours to prevent that. Renaming anything
 * here breaks the Rust side at run time, not at build time.
 *
 * Nothing here may throw into the caller: a failure is one logged line and a
 * widget that catches up on its next 30-minute poll.
 */
// AIDEV-NOTE: looked up by name from widget_updates.rs; @Keep and the names are load-bearing.
@Keep
object WidgetUpdates {
    /**
     * Redraws every template widget, after the app wrote a template or a note
     * made from one. A broadcast rather than a direct draw: the redraw reads the
     * notes tree, and the command that wrote should not wait on it.
     */
    @JvmStatic
    fun refreshTemplates(context: Context) {
        runCatching {
            val manager = AppWidgetManager.getInstance(context)
            listOf(
                TemplatesWidgetProvider::class.java,
                TemplateButtonWidgetProvider::class.java,
            ).forEach { provider ->
                val ids = manager.getAppWidgetIds(ComponentName(context, provider))
                if (ids.isNotEmpty()) {
                    context.sendBroadcast(
                        Intent(context, provider)
                            .setAction(AppWidgetManager.ACTION_APPWIDGET_UPDATE)
                            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids),
                    )
                }
            }
        }.onFailure { WidgetLog.error("template widgets not refreshed", it) }
    }

    /** Whether this launcher can place a widget on request (API 26+, and the launcher agrees). */
    @JvmStatic
    fun canPinTemplateButton(context: Context): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            runCatching { AppWidgetManager.getInstance(context).isRequestPinAppWidgetSupported }
                .getOrDefault(false)

    /**
     * Asks the launcher to place a button for the template [name]. True when the
     * request went out — the system's own confirmation follows, and a refusal
     * there is silent. The name rides on the callback intent, which the launcher
     * sends back with the new widget's id ([TemplateButtonWidgetProvider.ACTION_PINNED]).
     */
    @JvmStatic
    fun requestPinTemplateButton(context: Context, name: String): Boolean {
        if (!canPinTemplateButton(context) || name.isEmpty()) {
            return false
        }
        return runCatching {
            val callback = Intent(context, TemplateButtonWidgetProvider::class.java)
                .setAction(TemplateButtonWidgetProvider.ACTION_PINNED)
                .putExtra(TemplateButtonWidgetProvider.EXTRA_TEMPLATE_NAME, name)
            // Mutable because the system writes EXTRA_APPWIDGET_ID into it. The
            // intent is explicit, so nothing else can receive it.
            val mutable = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                PendingIntent.FLAG_MUTABLE
            } else {
                0
            }
            val pending = PendingIntent.getBroadcast(
                context,
                PIN_REQUEST,
                callback,
                PendingIntent.FLAG_UPDATE_CURRENT or mutable,
            )
            AppWidgetManager.getInstance(context).requestPinAppWidget(
                ComponentName(context, TemplateButtonWidgetProvider::class.java),
                null,
                pending,
            )
        }.getOrElse {
            WidgetLog.error("pin request for a template button failed", it)
            false
        }
    }

    private const val PIN_REQUEST = 50
}
