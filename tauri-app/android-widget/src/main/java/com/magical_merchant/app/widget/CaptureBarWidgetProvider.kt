package com.magical_merchant.app.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.view.View
import android.widget.RemoteViews
import com.magical_merchant.app.R

/**
 * 2a — the Timeline capture bar (4x1).
 *
 * The whole surface opens [QuickCaptureActivity] over the home screen; the app
 * itself is never started, which is the point of the widget. Once the day has
 * an entry the bar shows its tail, so the prompt reads as continuing rather
 * than starting over.
 */
class CaptureBarWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
    ) {
        val views = render(context)
        appWidgetIds.forEach { appWidgetManager.updateAppWidget(it, views) }
    }

    companion object {
        private const val REQUEST_CODE = 1

        /**
         * Redraws every placed bar.
         *
         * Called after a capture so the tail is current without waiting for the
         * next scheduled update — the user just wrote the line they are looking at.
         */
        fun refresh(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(
                ComponentName(context, CaptureBarWidgetProvider::class.java),
            )
            if (ids.isEmpty()) {
                return
            }
            val views = render(context)
            ids.forEach { manager.updateAppWidget(it, views) }
        }

        private fun render(context: Context): RemoteViews {
            val sheet = Intent(context, QuickCaptureActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            val pending = PendingIntent.getActivity(
                context,
                REQUEST_CODE,
                sheet,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )

            val data = WidgetBridge.readCapture(context)
            return RemoteViews(context.packageName, R.layout.widget_capture_bar).apply {
                setOnClickPendingIntent(R.id.widget_capture_root, pending)
                if (data.hasLastEntry) {
                    setTextViewText(
                        R.id.widget_capture_prompt,
                        context.getString(R.string.widget_capture_continue),
                    )
                    setTextViewText(
                        R.id.widget_capture_last,
                        listOf(data.lastTime, data.lastText)
                            .filter { it.isNotEmpty() }
                            .joinToString("  "),
                    )
                    setViewVisibility(R.id.widget_capture_last, View.VISIBLE)
                } else {
                    setTextViewText(
                        R.id.widget_capture_prompt,
                        context.getString(R.string.widget_capture_placeholder),
                    )
                    setViewVisibility(R.id.widget_capture_last, View.GONE)
                }
            }
        }
    }
}
