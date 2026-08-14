/**
 * IME の変換中に届いた keydown かどうか。
 *
 * macOS の WKWebView は日本語 IME の変換確定 Enter も通常の keydown として
 * 届けるため、これを見ずに Enter で確定処理をすると漢字変換が完了できない。
 * keyCode 229 は isComposing が立たない古い WebKit 実装のための互換値。
 */
export function isImeComposing(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229;
}
