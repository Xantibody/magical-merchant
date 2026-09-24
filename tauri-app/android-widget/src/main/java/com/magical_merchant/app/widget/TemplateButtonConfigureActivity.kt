package com.magical_merchant.app.widget

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.AbsoluteSizeSpan
import android.text.style.ForegroundColorSpan
import android.view.View
import android.widget.Button
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.TextView
import com.magical_merchant.app.R

/**
 * 4d — chooses the template a [TemplateButtonWidgetProvider] stands for, and
 * whether it shows today's title.
 *
 * The launcher opens this when the button is placed from the widget picker, and
 * a button whose template is gone opens it on tap. A pinned button skips it: the
 * app already said which template ([WidgetUpdates.requestPinTemplateButton]).
 *
 * Titles come from core like everywhere else; this screen only lists them.
 */
class TemplateButtonConfigureActivity : Activity() {
    private var appWidgetId = AppWidgetManager.INVALID_APPWIDGET_ID

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Backing out places nothing: a launcher drops the widget on CANCELED.
        setResult(RESULT_CANCELED)

        appWidgetId = intent.getIntExtra(
            AppWidgetManager.EXTRA_APPWIDGET_ID,
            AppWidgetManager.INVALID_APPWIDGET_ID,
        )
        if (!ownsWidget(appWidgetId)) {
            finish()
            return
        }

        setContentView(R.layout.activity_template_button_configure)
        val current = TemplateButtonSettings.read(this, appWidgetId)
        findViewById<RadioGroup>(R.id.template_configure_display).check(
            if (current?.showTitle == false) {
                R.id.template_configure_name_only
            } else {
                R.id.template_configure_with_title
            },
        )
        findViewById<Button>(R.id.template_configure_cancel).setOnClickListener { finish() }
        findViewById<Button>(R.id.template_configure_add).setOnClickListener { confirm() }

        // The read walks the notes tree for "made today"; keep it off the thread
        // that draws this window.
        val app = applicationContext
        Thread {
            val rows = WidgetBridge.readTemplateRows(app)
            runOnUiThread {
                if (!isFinishing && !isDestroyed) {
                    showTemplates(rows, current?.name)
                }
            }
        }.start()
    }

    /**
     * The activity is exported so any launcher can start it; this keeps a caller
     * from pointing it at a widget id that is not one of ours.
     */
    private fun ownsWidget(id: Int): Boolean {
        if (id == AppWidgetManager.INVALID_APPWIDGET_ID) {
            return false
        }
        val info = AppWidgetManager.getInstance(this).getAppWidgetInfo(id) ?: return false
        return info.provider.packageName == packageName
    }

    private fun showTemplates(rows: List<TemplateRow>, selected: String?) {
        val list = findViewById<RadioGroup>(R.id.template_configure_list)
        list.removeAllViews()
        findViewById<TextView>(R.id.template_configure_empty).visibility =
            if (rows.isEmpty()) View.VISIBLE else View.GONE

        rows.forEach { row ->
            list.addView(
                RadioButton(this).apply {
                    id = View.generateViewId()
                    tag = row.name
                    text = label(row)
                    minHeight = dp(48)
                    setTextColor(getColor(R.color.widget_text))
                    textSize = 14f
                },
            )
        }
        val initial = rows.indexOfFirst { it.name == selected }.takeIf { it >= 0 } ?: 0
        list.getChildAt(initial)?.let { list.check(it.id) }
        findViewById<Button>(R.id.template_configure_add).isEnabled = rows.isNotEmpty()
    }

    /** The name, and under it the title a tap would give today's note. */
    private fun label(row: TemplateRow): CharSequence {
        val text = SpannableStringBuilder(row.name)
        if (row.todayTitle.isNotEmpty()) {
            val start = text.length
            text.append('\n').append(row.todayTitle)
            text.setSpan(
                ForegroundColorSpan(getColor(R.color.widget_faint)),
                start,
                text.length,
                Spanned.SPAN_EXCLUSIVE_EXCLUSIVE,
            )
            text.setSpan(
                AbsoluteSizeSpan(12, true),
                start,
                text.length,
                Spanned.SPAN_EXCLUSIVE_EXCLUSIVE,
            )
        }
        return text
    }

    private fun confirm() {
        val list = findViewById<RadioGroup>(R.id.template_configure_list)
        val name = list.findViewById<RadioButton>(list.checkedRadioButtonId)?.tag as? String
            ?: return
        val showTitle = findViewById<RadioGroup>(R.id.template_configure_display)
            .checkedRadioButtonId == R.id.template_configure_with_title
        TemplateButtonSettings.write(this, appWidgetId, TemplateButtonSetting(name, showTitle))

        // A configuration activity is expected to draw the widget itself; the
        // launcher does not send the first update when there is one.
        runCatching {
            TemplateButtonWidgetProvider.render(
                this,
                AppWidgetManager.getInstance(this),
                intArrayOf(appWidgetId),
            )
        }.onFailure { WidgetLog.error("template button not drawn after configuring", it) }

        setResult(
            RESULT_OK,
            Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId),
        )
        finish()
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
