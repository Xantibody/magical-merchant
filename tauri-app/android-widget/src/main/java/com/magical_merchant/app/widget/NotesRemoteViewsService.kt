package com.magical_merchant.app.widget

import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import com.magical_merchant.app.R

/** Feeds the 2b list. The launcher binds this; see the manifest permission. */
class NotesRemoteViewsService : RemoteViewsService() {
    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory = NotesFactory(this)
}

private class NotesFactory(
    private val service: NotesRemoteViewsService,
) : RemoteViewsService.RemoteViewsFactory {
    private var rows: List<NoteRow> = emptyList()

    override fun onCreate() = Unit

    /**
     * Called off the main thread, which is why the whole notes tree is read
     * here rather than while the provider builds its RemoteViews.
     */
    override fun onDataSetChanged() {
        rows = WidgetBridge.readNoteRows(service)
    }

    override fun onDestroy() {
        rows = emptyList()
    }

    override fun getCount(): Int = rows.size

    override fun getViewAt(position: Int): RemoteViews {
        val row = rows[position]
        return RemoteViews(service.packageName, R.layout.widget_notes_row).apply {
            setTextViewText(R.id.widget_notes_row_title, row.title)
            setTextViewText(R.id.widget_notes_row_date, row.date)
            // Only the data; the rest comes from the provider's template. A
            // fill-in intent can add fields but not replace ones already set.
            setOnClickFillInIntent(
                R.id.widget_notes_row,
                Intent().setData(Uri.parse("${WidgetDeepLink.NOTE}?file=${Uri.encode(row.filename)}")),
            )
        }
    }

    override fun getLoadingView(): RemoteViews? = null

    override fun getViewTypeCount(): Int = 1

    /**
     * Position, not a filename hash: the list is small and fully rebuilt on
     * every change, so a stable id buys nothing and a colliding one would show
     * the wrong note.
     */
    override fun getItemId(position: Int): Long = position.toLong()

    override fun hasStableIds(): Boolean = false
}
