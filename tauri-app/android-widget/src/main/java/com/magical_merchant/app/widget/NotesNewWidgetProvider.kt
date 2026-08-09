package com.magical_merchant.app.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.widget.RemoteViews
import com.magical_merchant.app.R

/**
 * 2b (top bar) — "new note" (4x1).
 *
 * Presentation only: a tap opens the app on the new-note deep link. The recent
 * notes list (RemoteViewsService + ListView) is phase 3 and is not here.
 */
class NotesNewWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
    ) {
        val views = RemoteViews(context.packageName, R.layout.widget_notes_new).apply {
            setOnClickPendingIntent(
                R.id.widget_notes_new_root,
                deepLinkPendingIntent(context, REQUEST_CODE, WidgetDeepLink.NEW_NOTE),
            )
        }
        appWidgetIds.forEach { appWidgetManager.updateAppWidget(it, views) }
    }

    private companion object {
        const val REQUEST_CODE = 2
    }
}
