package com.magical_merchant.app.widget

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri

/** Deep links the widgets hand to the app. Hosts are declared in tauri.conf.json. */
internal object WidgetDeepLink {
    const val NEW_NOTE = "magical-merchant://widget/new-note"
    const val NOTE = "magical-merchant://widget/note"

    /** テンプレの管理画面。ボタンが 1 つも無いウィジェットの行き先でもある。 */
    const val TEMPLATES = "magical-merchant://widget/templates"

    /**
     * [name] のテンプレからノートを作って開く。
     *
     * 名前は人が付けたファイル名で、空白も日本語も入る。素で繋ぐと
     * クエリとして壊れるので必ず通す。
     */
    fun template(name: String): String =
        "magical-merchant://widget/template?name=" + Uri.encode(name)
}

/**
 * A PendingIntent that opens [uri] in this app.
 *
 * setPackage pins the target: without it the scheme is resolved system-wide and
 * a tap can surface a chooser (or another app that registered the scheme).
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
