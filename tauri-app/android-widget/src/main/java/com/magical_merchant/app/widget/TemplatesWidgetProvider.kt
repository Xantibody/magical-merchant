package com.magical_merchant.app.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.view.View
import android.widget.RemoteViews
import com.magical_merchant.app.R

/**
 * 1e — templates (4x3).
 *
 * A tap makes the note and opens it. What decides whether a note is created or
 * an existing one is opened lives in core (`create_note_from_template`): the
 * same template tapped twice in a day opens the first note rather than making a
 * second. Kotlin knows nothing about that rule and must not learn it — the
 * in-app menu and this widget have to agree, and they only can if the decision
 * has one home.
 *
 * The rows are fixed in the layout rather than backed by a RemoteViewsService.
 * There are at most three, and a service exists to keep a long list's read off
 * the main thread — this read only opens the templates directory.
 */
class TemplatesWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
    ) {
        val templates = WidgetBridge.readTemplateRows(context)
        val views = RemoteViews(context.packageName, R.layout.widget_templates).apply {
            SLOTS.forEachIndexed { index, slot ->
                val template = templates.getOrNull(index)
                if (template == null) {
                    setViewVisibility(slot.row, View.GONE)
                    return@forEachIndexed
                }
                setViewVisibility(slot.row, View.VISIBLE)
                setTextViewText(slot.name, template.name)
                setOnClickPendingIntent(
                    slot.row,
                    deepLinkPendingIntent(
                        context,
                        ROW_REQUEST_BASE + index,
                        WidgetDeepLink.template(template.name),
                    ),
                )
            }

            // テンプレを 1 つも作っていない端末が普通の状態。空の枠だけを
            // 置くと壊れて見えるので、作りに行く先を出す
            setViewVisibility(
                R.id.widget_templates_empty,
                if (templates.isEmpty()) View.VISIBLE else View.GONE,
            )
            setOnClickPendingIntent(
                R.id.widget_templates_empty,
                deepLinkPendingIntent(context, MANAGE_REQUEST, WidgetDeepLink.TEMPLATES),
            )
            setOnClickPendingIntent(
                R.id.widget_templates_header,
                deepLinkPendingIntent(context, MANAGE_REQUEST, WidgetDeepLink.TEMPLATES),
            )
        }
        appWidgetIds.forEach { appWidgetManager.updateAppWidget(it, views) }
    }

    private data class Slot(val row: Int, val name: Int)

    private companion object {
        /** 先頭だけ塗りつぶし。押す先が 1 つ目だと分かるようにする。 */
        val SLOTS = listOf(
            Slot(R.id.widget_template_row_1, R.id.widget_template_name_1),
            Slot(R.id.widget_template_row_2, R.id.widget_template_name_2),
            Slot(R.id.widget_template_row_3, R.id.widget_template_name_3),
        )

        // 5 まではキャプチャバーとノートのウィジェットが使っている
        const val ROW_REQUEST_BASE = 10
        const val MANAGE_REQUEST = 20
    }
}
