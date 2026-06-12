import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

let highlighterPromise: Promise<HighlighterCore> | undefined;

export function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    themes: [
      import("shiki/themes/github-dark-default.mjs"),
      import("shiki/themes/github-light-default.mjs"),
    ],
    langs: [
      import("shiki/langs/javascript.mjs"),
      import("shiki/langs/typescript.mjs"),
      import("shiki/langs/rust.mjs"),
      import("shiki/langs/css.mjs"),
      import("shiki/langs/html.mjs"),
      import("shiki/langs/json.mjs"),
      import("shiki/langs/markdown.mjs"),
      import("shiki/langs/bash.mjs"),
    ],
    engine: createJavaScriptRegexEngine(),
  });
  return highlighterPromise;
}
