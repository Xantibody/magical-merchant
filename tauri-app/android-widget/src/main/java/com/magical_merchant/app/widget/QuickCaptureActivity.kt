package com.magical_merchant.app.widget

import android.app.Activity
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.EditText
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import com.magical_merchant.app.R

/**
 * The capture sheet the Timeline widget opens (design 1b).
 *
 * A translucent activity rather than something inside the widget: RemoteViews
 * cannot host an EditText, so typing has to happen in a real window. It stays
 * out of the recents list and off the back stack so it behaves like a sheet
 * over the home screen instead of like a second copy of the app.
 *
 * Plain [Activity], not AppCompatActivity: nothing here needs the compat
 * widgets, and the sheet should not pay for inflating a Material theme.
 */
class QuickCaptureActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_quick_capture)

        val input = findViewById<EditText>(R.id.quick_capture_input)
        input.requestFocus()
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE)

        // The scrim dismisses; the sheet swallows the tap so it does not.
        findViewById<View>(R.id.quick_capture_scrim).setOnClickListener { finish() }
        findViewById<View>(R.id.quick_capture_sheet).setOnClickListener { }
        findViewById<ImageButton>(R.id.quick_capture_send).setOnClickListener { save(input) }

        showTagChips(input)
    }

    /**
     * Today's most-used tags, as chips that insert themselves.
     *
     * Typing `#` on a phone keyboard costs a layout switch, and the tags worth
     * reusing are almost always ones already used today.
     */
    private fun showTagChips(input: EditText) {
        val tags = WidgetBridge.readCapture(this).tags
        if (tags.isEmpty()) {
            return
        }

        val row = findViewById<LinearLayout>(R.id.quick_capture_tags)
        tags.forEach { tag -> row.addView(chip(tag, input)) }
        row.visibility = View.VISIBLE
    }

    private fun chip(tag: String, input: EditText): TextView = TextView(this).apply {
        text = tag
        textSize = CHIP_TEXT_SP
        setTextColor(context.getColor(R.color.widget_muted))
        setBackgroundResource(R.drawable.quick_capture_chip_bg)
        gravity = Gravity.CENTER
        setPadding(dp(CHIP_PADDING_H), dp(CHIP_PADDING_V), dp(CHIP_PADDING_H), dp(CHIP_PADDING_V))
        layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        ).apply { marginEnd = dp(CHIP_GAP) }
        setOnClickListener { insertTag(input, tag) }
    }

    /** Inserts at the caret, not at the end: a tag often belongs mid-sentence. */
    private fun insertTag(input: EditText, tag: String) {
        val at = input.selectionEnd.coerceAtLeast(0)
        val body = input.text
        val needsSpace = at > 0 && body[at - 1] != ' '
        val insert = if (needsSpace) " $tag " else "$tag "
        body.insert(at, insert)
    }

    private fun save(input: EditText) {
        val text = input.text.toString().trim()
        if (text.isEmpty()) {
            finish()
            return
        }

        // The sheet stays open on failure: dismissing would throw away text the
        // user cannot retype from anywhere, and the widget has no drafts.
        if (!WidgetBridge.saveQuickCapture(WidgetBridge.baseDir(this), text)) {
            Toast.makeText(this, R.string.quick_capture_failed, Toast.LENGTH_SHORT).show()
            return
        }
        CaptureBarWidgetProvider.refresh(this)
        finish()
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private companion object {
        const val CHIP_TEXT_SP = 12f
        const val CHIP_PADDING_H = 10
        const val CHIP_PADDING_V = 4
        const val CHIP_GAP = 6
    }
}
