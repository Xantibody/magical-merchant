package com.magical_merchant.app.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.util.SizeF
import android.view.View
import android.widget.RemoteViews
import com.magical_merchant.app.R

/**
 * 4a / 4b — one template as a button, 2x1 by default and 1x1 when resized down.
 *
 * One provider for both sizes, so the widget picker lists one entry and
 * `requestPinAppWidget` has one component to name; the layout follows the size
 * the launcher gives it. Which template a button stands for is chosen in
 * [TemplateButtonConfigureActivity] (or handed over by the pin request) and kept
 * in [TemplateButtonSettings].
 *
 * Like the 4x2, a tap only hands `…/widget/template?name=` to the app, and core
 * decides between making today's note and opening it. The button shows which one
 * will happen from the same core rule (`hasToday`), never from its own.
 */
class TemplateButtonWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
    ) {
        // Same reason as the capture bar: a throw out of onUpdate kills the
        // broadcast and freezes the widget on its last frame.
        runCatching { render(context, appWidgetManager, appWidgetIds) }
            .onFailure { WidgetLog.error("template buttons not redrawn", it) }
    }

    /** Below API 31 the layout is picked here, from the size the launcher reports. */
    override fun onAppWidgetOptionsChanged(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetId: Int,
        newOptions: Bundle,
    ) {
        onUpdate(context, appWidgetManager, intArrayOf(appWidgetId))
    }

    override fun onDeleted(context: Context, appWidgetIds: IntArray) {
        TemplateButtonSettings.forget(context, appWidgetIds)
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == ACTION_PINNED) {
            onPinned(context, intent)
            return
        }
        super.onReceive(context, intent)
    }

    /**
     * The launcher accepted a pin request ([WidgetUpdates.requestPinTemplateButton])
     * and filled in the new widget's id. The template came along in the same
     * intent, so the button is ready without a configuration step.
     */
    private fun onPinned(context: Context, intent: Intent) {
        val id = intent.getIntExtra(
            AppWidgetManager.EXTRA_APPWIDGET_ID,
            AppWidgetManager.INVALID_APPWIDGET_ID,
        )
        val name = intent.getStringExtra(EXTRA_TEMPLATE_NAME).orEmpty()
        if (id == AppWidgetManager.INVALID_APPWIDGET_ID || name.isEmpty()) {
            WidgetLog.warn("pinned template button came back without an id or a name")
            return
        }
        TemplateButtonSettings.write(context, id, TemplateButtonSetting(name, showTitle = true))
        onUpdate(context, AppWidgetManager.getInstance(context), intArrayOf(id))
    }

    internal companion object {
        /** The pin request's callback action. Only this app's PendingIntent sends it. */
        const val ACTION_PINNED = "com.magical_merchant.app.widget.TEMPLATE_BUTTON_PINNED"
        const val EXTRA_TEMPLATE_NAME = "com.magical_merchant.app.widget.TEMPLATE_NAME"

        /** Narrower than this and the name, title and square no longer share a row. */
        private const val WIDE_MIN_DP = 110f
        private const val MIN_DP = 40f

        // Request codes below 30 belong to the other widgets. Deep links differ by
        // their URI, so one code serves every button.
        private const val DEEP_LINK_REQUEST = 30

        fun render(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) {
            if (appWidgetIds.isEmpty()) {
                return
            }
            val rows = WidgetBridge.readTemplateRows(context)
            appWidgetIds.forEach { id ->
                val setting = TemplateButtonSettings.read(context, id)
                val row = setting?.let { s -> rows.firstOrNull { it.name == s.name } }
                val tap = if (row == null) {
                    configurePendingIntent(context, id)
                } else {
                    deepLinkPendingIntent(context, DEEP_LINK_REQUEST, WidgetDeepLink.template(row.name))
                }
                val showTitle = setting?.showTitle ?: true
                val wide = wideViews(context, row, showTitle, tap)
                val small = smallViews(context, row, tap)
                manager.updateAppWidget(id, pickViews(manager, id, wide, small))
            }
        }

        /**
         * API 31 and later get both layouts and let the launcher choose while it
         * resizes; before that the choice is made once, from the reported width.
         */
        private fun pickViews(
            manager: AppWidgetManager,
            id: Int,
            wide: RemoteViews,
            small: RemoteViews,
        ): RemoteViews {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                return RemoteViews(
                    mapOf(SizeF(MIN_DP, MIN_DP) to small, SizeF(WIDE_MIN_DP, MIN_DP) to wide),
                )
            }
            val width = manager.getAppWidgetOptions(id)
                .getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0)
            // 0 is "not reported yet"; the default placement is 2x1.
            return if (width == 0 || width >= WIDE_MIN_DP) wide else small
        }

        private fun wideViews(
            context: Context,
            row: TemplateRow?,
            showTitle: Boolean,
            tap: PendingIntent,
        ) = RemoteViews(context.packageName, R.layout.widget_template_button).apply {
            setTextViewText(
                R.id.widget_template_button_name,
                row?.name ?: context.getString(R.string.widget_template_choose),
            )
            val title = row?.todayTitle.orEmpty()
            setViewVisibility(
                R.id.widget_template_button_title,
                if (showTitle && title.isNotEmpty()) View.VISIBLE else View.GONE,
            )
            setTextViewText(R.id.widget_template_button_title, title)
            val hasToday = row?.hasToday == true
            setViewVisibility(R.id.widget_template_button_ok, visibleIf(hasToday))
            setViewVisibility(R.id.widget_template_button_create, visibleIf(!hasToday))
            setViewVisibility(R.id.widget_template_button_open, visibleIf(hasToday))
            setOnClickPendingIntent(R.id.widget_template_button_root, tap)
        }

        private fun smallViews(
            context: Context,
            row: TemplateRow?,
            tap: PendingIntent,
        ) = RemoteViews(context.packageName, R.layout.widget_template_button_small).apply {
            val name = row?.name ?: context.getString(R.string.widget_template_choose)
            setTextViewText(R.id.widget_template_button_name, name)
            setTextViewText(R.id.widget_template_button_glyph, initialOf(row?.name ?: "+"))
            setViewVisibility(R.id.widget_template_button_dot, visibleIf(row?.hasToday == true))
            setOnClickPendingIntent(R.id.widget_template_button_root, tap)
        }

        /** The first character, whole: a surrogate pair or a kana stays one glyph. */
        private fun initialOf(name: String): String {
            if (name.isEmpty()) {
                return ""
            }
            val end = name.offsetByCodePoints(0, 1)
            return name.substring(0, end).uppercase()
        }

        private fun visibleIf(shown: Boolean) = if (shown) View.VISIBLE else View.GONE

        /**
         * Opens the configuration for this one widget. The request code is the
         * widget's id: extras do not tell PendingIntents apart, so a shared code
         * would let the last button drawn hand every button its own id.
         */
        private fun configurePendingIntent(context: Context, appWidgetId: Int): PendingIntent {
            val intent = Intent(context, TemplateButtonConfigureActivity::class.java).apply {
                putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            return PendingIntent.getActivity(
                context,
                appWidgetId,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }
    }
}
