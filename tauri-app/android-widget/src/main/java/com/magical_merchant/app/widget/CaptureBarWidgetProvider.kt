package com.magical_merchant.app.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews
import com.magical_merchant.app.R

/**
 * 2a — the Timeline capture bar (4x1).
 *
 * The whole surface opens [QuickCaptureActivity] over the home screen; the app
 * itself is never started, which is the point of the widget.
 */
class CaptureBarWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
    ) {
        val sheet = Intent(context, QuickCaptureActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val pending = PendingIntent.getActivity(
            context,
            REQUEST_CODE,
            sheet,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val views = RemoteViews(context.packageName, R.layout.widget_capture_bar).apply {
            setOnClickPendingIntent(R.id.widget_capture_root, pending)
        }
        appWidgetIds.forEach { appWidgetManager.updateAppWidget(it, views) }
    }

    private companion object {
        const val REQUEST_CODE = 1
    }
}
