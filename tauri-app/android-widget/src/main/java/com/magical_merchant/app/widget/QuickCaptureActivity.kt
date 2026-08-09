package com.magical_merchant.app.widget

import android.app.Activity
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.widget.EditText
import android.widget.ImageButton
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
        finish()
    }
}
