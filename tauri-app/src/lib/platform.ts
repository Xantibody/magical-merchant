/**
 * Telling apart the OS we run on. Asking the Rust side would be certain, but a round
 * trip over IPC is more than deciding what the settings screen shows is worth. The
 * WebView user agent is enough.
 */

/** Whether this is a desktop build of any OS: one with a keyboard, not a phone or tablet. */
export function isDesktop(userAgent: string = navigator.userAgent): boolean {
  return (
    !userAgent.includes("Android") && !userAgent.includes("iPhone") && !userAgent.includes("iPad")
  );
}

/**
 * Whether this is desktop macOS. Safari on an iPad also calls itself "Mac OS X", so
 * we look for "Macintosh" and then rule out the mobile markers.
 */
export function isMacDesktop(userAgent: string = navigator.userAgent): boolean {
  return userAgent.includes("Macintosh") && isDesktop(userAgent);
}
