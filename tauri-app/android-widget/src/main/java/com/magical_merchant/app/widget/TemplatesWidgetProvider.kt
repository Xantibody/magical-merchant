package com.magical_merchant.app.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.view.View
import android.widget.RemoteViews
import com.magical_merchant.app.R

/**
 * 4c — templates (4x2): the first four by name, as 2x2 tiles.
 *
 * A tap makes the note and opens it. What decides whether a note is created or
 * an existing one is opened lives in core (`create_note_from_template`): the
 * same template tapped twice in a day opens the first note rather than making a
 * second. Kotlin knows nothing about that rule and must not learn it — the
 * in-app menu and this widget have to agree, and they only can if the decision
 * has one home. The tile's "made today" comes from that same rule (`hasToday`).
 *
 * The tiles are fixed in the layout rather than backed by a RemoteViewsService.
 * There are at most four, and a service exists to keep a long list's read off
 * the main thread.
 */
class TemplatesWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
    ) {
        // Same reason as the capture bar: a throw out of onUpdate kills the
        // broadcast and freezes the widget on its last frame.
        runCatching { render(context, appWidgetManager, appWidgetIds) }
            .onFailure { WidgetLog.error("templates not redrawn", it) }
    }

    private fun render(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
    ) {
        val templates = WidgetBridge.readTemplateRows(context).take(TILES.size)
        val views = RemoteViews(context.packageName, R.layout.widget_templates).apply {
            TILES.forEachIndexed { index, tile ->
                val template = templates.getOrNull(index)
                if (template == null) {
                    // INVISIBLE, not GONE: a lone third tile keeps its column
                    // instead of stretching across the row.
                    setViewVisibility(tile.root, View.INVISIBLE)
                    return@forEachIndexed
                }
                setViewVisibility(tile.root, View.VISIBLE)
                setTextViewText(tile.name, template.name)
                setTextViewText(tile.title, template.todayTitle)
                setViewVisibility(
                    tile.title,
                    if (template.todayTitle.isEmpty()) View.GONE else View.VISIBLE,
                )
                setViewVisibility(tile.create, if (template.hasToday) View.GONE else View.VISIBLE)
                setViewVisibility(tile.open, if (template.hasToday) View.VISIBLE else View.GONE)
                setOnClickPendingIntent(
                    tile.root,
                    deepLinkPendingIntent(
                        context,
                        TILE_REQUEST_BASE + index,
                        WidgetDeepLink.template(template.name),
                    ),
                )
            }

            // Two templates or fewer leave the second row empty; drop it so the
            // first row takes the height.
            setViewVisibility(
                R.id.widget_templates_row_2,
                if (templates.size > 2) View.VISIBLE else View.GONE,
            )
            setViewVisibility(
                R.id.widget_templates_row_1,
                if (templates.isEmpty()) View.GONE else View.VISIBLE,
            )
            // No template at all is the normal state on a new device. An empty
            // frame reads as broken, so offer the way to make one instead.
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

    private data class Tile(
        val root: Int,
        val name: Int,
        val title: Int,
        val create: Int,
        val open: Int,
    )

    private companion object {
        /** Only the first is filled (in the layout), so it reads as the primary action. */
        val TILES = listOf(
            Tile(
                R.id.widget_template_tile_1,
                R.id.widget_template_tile_name_1,
                R.id.widget_template_tile_title_1,
                R.id.widget_template_tile_create_1,
                R.id.widget_template_tile_open_1,
            ),
            Tile(
                R.id.widget_template_tile_2,
                R.id.widget_template_tile_name_2,
                R.id.widget_template_tile_title_2,
                R.id.widget_template_tile_create_2,
                R.id.widget_template_tile_open_2,
            ),
            Tile(
                R.id.widget_template_tile_3,
                R.id.widget_template_tile_name_3,
                R.id.widget_template_tile_title_3,
                R.id.widget_template_tile_create_3,
                R.id.widget_template_tile_open_3,
            ),
            Tile(
                R.id.widget_template_tile_4,
                R.id.widget_template_tile_name_4,
                R.id.widget_template_tile_title_4,
                R.id.widget_template_tile_create_4,
                R.id.widget_template_tile_open_4,
            ),
        )

        // 5 and below belong to the capture bar and the Note widgets
        const val TILE_REQUEST_BASE = 10
        const val MANAGE_REQUEST = 20
    }
}
