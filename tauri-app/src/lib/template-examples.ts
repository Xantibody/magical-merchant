/**
 * Pull the examples written into a template out, heading by heading.
 *
 * An example is never written into a note file: core drops the `{{eg}}` block when it
 * writes (`core/src/template/vars.rs`). So this does not "read from the saved body". It
 * re-reads the template the note claims (`template:` in frontmatter) and builds a copy
 * whose only purpose is to show the writer, in faint type. The rules for the delimiters
 * are written twice, the same as in core: a block ends at a blank line or at the next
 * heading, and there is no closing marker.
 */

import { createSignal } from "solid-js";

const MARKER = /^\{\{\s*eg\s*(?::(?<example>[^}]*))?\}\}$/u;

/** A list marker at the head of a line. An example is a prompt, not content, so the marker is stripped before it is shown. */
const LIST_MARKER = /^(?:[-*+]|\d+\.)\s+/u;

function headingText(line: string): string {
  return line.replace(/^#+/u, "").trim();
}

/** Whether the line closes the block. The closing line itself is kept. */
function endsExample(line: string): boolean {
  return line === "" || line.startsWith("#");
}

/** What a line of a template body is, as far as examples go. */
export type LineKind = "text" | "marker" | "example";

/**
 * Sort each line of the body: the `{{eg}}` marker, a line of the example block under it,
 * or ordinary text. The editor draws the example lines faint with this, so they have to be
 * exactly the lines core leaves out of a note.
 */
export function classifyLines(body: string): LineKind[] {
  const kinds: LineKind[] = [];
  let inBlock = false;

  for (const raw of body.split("\n")) {
    const line = raw.trim();
    // The closing line is outside the block
    if (inBlock && !endsExample(line)) {
      kinds.push("example");
    } else {
      inBlock = MARKER.test(line);
      kinds.push(inBlock ? "marker" : "text");
    }
  }

  return kinds;
}

/**
 * Drop the example lines. This is the path the `todayPreview` preview takes, and it exists
 * to show the same shape that core writes out.
 */
export function dropExamples(body: string): string {
  const kept: string[] = [];
  let dropping = false;

  for (const raw of body.split("\n")) {
    const line = raw.trim();
    // Keep nothing while inside the block. The closing line is outside it
    const inside = dropping && !endsExample(line);
    if (!inside) {
      dropping = MARKER.test(line);
      if (!dropping) {
        kept.push(raw);
      }
    }
  }

  return kept.join("\n");
}

const STORAGE_KEY = "show-examples";

const [shown, setShown] = createSignal(localStorage.getItem(STORAGE_KEY) !== "false");

/**
 * Whether to show the examples. Like the theme (`theme.ts`) and the language it is a
 * per-device preference, so it is kept in localStorage: it does not belong on sync. The
 * default is to show them, because a template you wrote having no effect at all is harder
 * to understand.
 */
export const examplesShown = shown;

export function setExamplesShown(on: boolean): void {
  setShown(on);
  localStorage.setItem(STORAGE_KEY, String(on));
}

/** Heading to the example lines written under it. What comes before any heading is keyed by the empty string. */
export function extractExamples(body: string): ReadonlyMap<string, string[]> {
  const examples = new Map<string, string[]>();
  let heading = "";
  /** The block being collected. It stands until the block closes. */
  let block: string[] | undefined;
  /** The heading that block belongs to, so closing on the next heading does not mix them up. */
  let owner = "";

  const close = (): void => {
    if (block && block.length > 0) {
      examples.set(owner, block);
    }
    block = undefined;
  };

  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (block && !endsExample(line)) {
      block.push(line.replace(LIST_MARKER, ""));
    } else {
      close();
      const marker = MARKER.exec(line);
      if (marker) {
        owner = heading;
        const inline = marker.groups?.example?.trim() ?? "";
        block = inline === "" ? [] : [inline];
      } else if (line.startsWith("#")) {
        heading = headingText(line);
      }
    }
  }
  close();

  return examples;
}
