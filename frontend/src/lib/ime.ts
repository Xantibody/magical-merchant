/**
 * Whether a keydown arrived during IME composition.
 *
 * WKWebView on macOS delivers the Enter that confirms a Japanese IME conversion as
 * a normal keydown too, so handling Enter as confirmation without checking this
 * makes the kanji conversion impossible to complete.
 * keyCode 229 is the compatibility value for old WebKit builds that never set isComposing.
 */
export function isImeComposing(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229;
}
