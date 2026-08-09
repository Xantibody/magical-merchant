package com.magical_merchant.app.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.widget.RemoteViews
import com.magical_merchant.app.R

/**
 * 2a — the Timeline capture bar (4x1).
 *
 * Presentation only: the bar is static and the whole surface opens the app on
 * the Timeline. The in-place capture sheet (QuickCaptureActivity writing through
 * a JNI bridge into magical_merchant_core) is phase 2 and is not wired up here.
 */
class CaptureBarWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
    ) {
        val views = RemoteViews(context.packageName, R.layout.widget_capture_bar).apply {
            setOnClickPendingIntent(
                R.id.widget_capture_root,
                deepLinkPendingIntent(context, REQUEST_CODE, WidgetDeepLink.CAPTURE),
            )
        }
        appWidgetIds.forEach { appWidgetManager.updateAppWidget(it, views) }
    }

    private companion object {
        const val REQUEST_CODE = 1
    }
}
