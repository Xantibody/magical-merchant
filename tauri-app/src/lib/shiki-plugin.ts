import { $prose } from "@milkdown/kit/utils";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegExpEngine } from "shiki/engine/javascript";

const shikiPluginKey = new PluginKey("shiki-highlight");

function getDecorations(
  doc: any,
  highlighter: Awaited<ReturnType<typeof createHighlighterCore>> | null,
) {
  if (!highlighter) return DecorationSet.empty;

  const decorations: Decoration[] = [];

  doc.descendants((node: any, pos: number) => {
    if (node.type.name !== "code_block") return;

    const lang = node.attrs?.language || "";
    const code = node.textContent;
    if (!code) return;

    const loadedLangs = highlighter.getLoadedLanguages();
    if (!loadedLangs.includes(lang)) return;

    try {
      const tokens = highlighter.codeToTokens(code, {
        lang,
        theme: "github-dark-default",
      });

      let offset = pos + 1;
      for (const line of tokens.tokens) {
        for (const token of line) {
          const from = offset + token.offset;
          const to = from + token.content.length;
          if (token.color) {
            decorations.push(
              Decoration.inline(from, to, {
                style: `color: ${token.color}`,
              }),
            );
          }
        }
        offset += 1; // newline
      }
    } catch {
      // skip if highlighting fails
    }
  });

  return DecorationSet.create(doc, decorations);
}

export const shikiPlugin = $prose(() => {
  let highlighter: Awaited<ReturnType<typeof createHighlighterCore>> | null =
    null;

  createHighlighterCore({
    themes: [import("shiki/themes/github-dark-default.mjs")],
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
    engine: createJavaScriptRegExpEngine(),
  }).then((h) => {
    highlighter = h;
  });

  return new Plugin({
    key: shikiPluginKey,
    state: {
      init(_, { doc }) {
        return getDecorations(doc, highlighter);
      },
      apply(tr, old) {
        if (tr.docChanged || !highlighter) {
          return getDecorations(tr.doc, highlighter);
        }
        return old.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
  });
});
