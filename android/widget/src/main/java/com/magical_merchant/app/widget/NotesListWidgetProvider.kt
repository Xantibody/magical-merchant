package com.magical_merchant.app.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews
import com.magical_merchant.app.R

/**
 * 2b — recent notes (4x2).
 *
 * Rows open their note through the widget deep link; the header's plus opens a
 * fresh draft. Nothing is read here — [NotesRemoteViewsService] does that off
 * the main thread.
 */
class NotesListWidgetProvider : AppWidgetProvider() {
    // The replacements (RemoteViews.RemoteCollectionItems) arrived in API 31 and
    // want the whole collection built inline — which would move the notes read
    // onto the main thread. minSdk is 24, so the service-backed adapter is both
    // the only option here and the better one.
    @Suppress("DEPRECATION")
    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
    ) {
        appWidgetIds.forEach { id ->
            val views = RemoteViews(context.packageName, R.layout.widget_notes_list).apply {
                setRemoteAdapter(R.id.widget_notes_items, adapterIntent(context, id))
                setEmptyView(R.id.widget_notes_items, R.id.widget_notes_empty)
                setOnClickPendingIntent(
                    R.id.widget_notes_new,
                    deepLinkPendingIntent(context, NEW_NOTE_REQUEST, WidgetDeepLink.NEW_NOTE),
                )
                setPendingIntentTemplate(R.id.widget_notes_items, rowTemplate(context))
            }
            appWidgetManager.updateAppWidget(id, views)
            // The adapter caches; without this the list keeps whatever it drew
            // before an update it was told nothing about.
            appWidgetManager.notifyAppWidgetViewDataChanged(id, R.id.widget_notes_items)
        }
    }

    /**
     * The widget id has to be in the intent's *data*, not just its extras: the
     * platform dedupes RemoteViews adapters by intent identity, and extras are
     * not part of it, so two placed widgets would otherwise share one factory.
     */
    private fun adapterIntent(context: Context, widgetId: Int): Intent =
        Intent(context, NotesRemoteViewsService::class.java).apply {
            putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
            data = Uri.parse(toUri(Intent.URI_INTENT_SCHEME))
        }

    /**
     * Deliberately carries no data — each row fills that in. Mutable for the
     * same reason: an immutable template cannot be filled in.
     */
    private fun rowTemplate(context: Context): PendingIntent {
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setPackage(context.packageName)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        return PendingIntent.getActivity(
            context,
            ROW_REQUEST,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
        )
    }

    private companion object {
        const val NEW_NOTE_REQUEST = 3
        const val ROW_REQUEST = 4
    }
}
