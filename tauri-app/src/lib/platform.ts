/**
 * 実行している OS の見分け。Rust 側に聞けば確実だが、設定画面の出し分けの
 * ために IPC を往復させるほどのことではない。WebView の UA で足りる。
 */

/**
 * macOS のデスクトップ版か。iPad の Safari も "Mac OS X" を名乗るので、
 * "Macintosh" を見たうえでモバイルの印を除く。
 */
export function isMacDesktop(userAgent: string = navigator.userAgent): boolean {
  return (
    userAgent.includes("Macintosh") &&
    !userAgent.includes("Android") &&
    !userAgent.includes("iPhone") &&
    !userAgent.includes("iPad")
  );
}
