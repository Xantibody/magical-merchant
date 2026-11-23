// Making a page hold still for a picture: motion ends at once, nothing blinks, and the shot waits
// until the page stops changing.

/**
 * Durations go to 0s rather than `none`: a component that waits for its own animation to end
 * still sees one end. The same rule the app keeps under prefers-reduced-motion, which WebDriver
 * cannot ask WebKit to report.
 */
const STILL_CSS = `
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  animation-iteration-count: 1 !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  scroll-behavior: auto !important;
  caret-color: transparent !important;
}
::-webkit-scrollbar { display: none !important; }
`;

export async function stopMotion(browser: WebdriverIO.Browser): Promise<void> {
  await browser.execute((css: string) => {
    const style = document.createElement("style");
    style.dataset["screens"] = "still";
    style.textContent = css;
    document.head.append(style);
  }, STILL_CSS);
}

/** Waits for the fonts, then for two looks at the DOM a moment apart to match. */
export async function settle(browser: WebdriverIO.Browser, timeout = 10_000): Promise<void> {
  await browser.execute(async () => {
    // Resolves to the FontFaceSet, which WebDriver cannot carry back
    await document.fonts.ready;
    return true;
  });
  let last = "";
  await browser.waitUntil(
    async () => {
      const now = await browser.execute(() => document.body.innerHTML);
      const same = now === last;
      last = now;
      return same;
    },
    { timeout, interval: 300, timeoutMsg: "the page kept changing" },
  );
}
