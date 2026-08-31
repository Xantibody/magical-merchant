package com.magical_merchant.app

import android.os.Bundle
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Replaces the Tauri-generated stub, which only calls [enableEdgeToEdge].
 *
 * That call sets `decorFitsSystemWindows = false`, and in that state the
 * manifest's `adjustResize` no longer shrinks the window when the keyboard
 * opens (#54). The WebView keeps its full height, the viewport meta
 * `interactive-widget=resizes-content` has nothing to resize, and the markdown
 * toolbar falls back to chasing `visualViewport` from JS — which runs a frame
 * behind the compositor's scrolling, so the toolbar visibly shakes.
 *
 * So resize ourselves: pad the content view by the IME inset, the same recipe
 * [widget.QuickCaptureActivity] uses. The WebView then genuinely ends at the
 * keyboard, the layout viewport follows, and the CSS `position: fixed; bottom`
 * path places the toolbar with no JS involved.
 *
 * The IME inset is 0 while the keyboard is closed, so edge-to-edge is
 * untouched; system bars stay the CSS safe-area's job. On WebViews that
 * report no IME inset the JS fallback in `MarkdownToolbar.tsx` still applies.
 */
class MainActivity : TauriActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)

        val content = findViewById<View>(android.R.id.content)
        ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
            // The IME alone, not plus the navigation bar: the keyboard already
            // reaches the bottom of the screen, so its inset is the full gap.
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            view.setPadding(view.paddingLeft, view.paddingTop, view.paddingRight, ime)
            insets
        }
    }
}
