package com.magical_merchant.app.widget

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri

/** Deep links the widgets hand to the app. Hosts are declared in tauri.conf.json. */
internal object WidgetDeepLink {
    const val CAPTURE = "magical-merchant://widget/capture"
    const val NEW_NOTE = "magical-merchant://widget/new-note"
}

/**
 * A PendingIntent that opens [uri] in this app.
 *
 * setPackage pins the target: without it the scheme is resolved system-wide and
 * a tap can surface a chooser (or another app that registered the scheme).
 * requestCode has to differ per widget, otherwise the two providers share one
 * PendingIntent and the second one silently rewrites the first.
 */
internal fun deepLinkPendingIntent(context: Context, requestCode: Int, uri: String): PendingIntent {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(uri)).apply {
        setPackage(context.packageName)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    return PendingIntent.getActivity(
        context,
        requestCode,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
}
