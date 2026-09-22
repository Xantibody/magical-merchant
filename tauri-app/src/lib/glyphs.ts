/**
 * Special characters (glyphs). A small image the user registered carries a short
 * name, and `:name:` in a body is drawn as that image. Meant for symbols that
 * cannot be typed, such as fighting-game command notation (`:236p:`).
 *
 * The stored form is only the `:name:` string. The image is looked up by name at
 * draw time and nothing is written into the body, so the body still reads as
 * text when the image is gone.
 *
 * The name rules are the same as core's `GlyphName`. Fix both when fixing one.
 */

import { createSignal } from "solid-js";
import { typedInvoke } from "./commands";

/**
 * The shape of a name, on the premise that only registered names resolve. So
 * that the `:` of a time like `12:30:45` or of a URL is not picked up, a matched
 * name is checked against the registry before it becomes an image.
 */
const SHORTCODE = /:(?<name>[a-z0-9][a-z0-9_+-]{0,31}):/gu;

export interface GlyphSegment {
  text: string;
  /** The registered name for a glyph. null for plain text. */
  name: string | null;
}

/** Only needs to answer whether a name is registered. A Set or a Map keyed by name both work. */
type GlyphNames = Pick<ReadonlySet<string>, "has" | "size">;

/**
 * Splits a body into glyphs and the rest. A `:foo:` not in `names` stays plain
 * text: treating an unregistered name as an image would eat part of a time or a URL.
 */
export function splitGlyphs(text: string, names: GlyphNames): GlyphSegment[] {
  const segments: GlyphSegment[] = [];
  let last = 0;
  if (names.size > 0 && text.includes(":")) {
    // matchAll clones the regex, so lastIndex cannot be moved back. Loop with exec
    const re = new RegExp(SHORTCODE.source, "gu");
    let match = re.exec(text);
    while (match !== null) {
      const name = match.groups?.name ?? "";
      if (names.has(name)) {
        if (match.index > last) {
          segments.push({ text: text.slice(last, match.index), name: null });
        }
        segments.push({ text: match[0], name });
        last = match.index + match[0].length;
      } else {
        // As in `:foo:236p:`, the closing `:` is also the opening of the next name.
        // When skipping an unregistered candidate, resume the search from that closing `:`
        re.lastIndex = match.index + match[0].length - 1;
      }
      match = re.exec(text);
    }
  }
  if (last < text.length || segments.length === 0) {
    segments.push({ text: text.slice(last), name: null });
  }
  return segments;
}

/** Whether the string passes as a name. Same rules as core's `GlyphName::parse`. */
export function isGlyphName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_+-]{0,31}$/u.test(name);
}

/**
 * Builds a name candidate from an image filename. `236P.png` gives `236p`.
 * Unusable characters collapse to `-` and leading symbols are dropped. It is only
 * a candidate, so it can come out empty; then the user types one.
 */
export function suggestGlyphName(filename: string): string {
  const stem = filename.replace(/\.[^.]*$/u, "").toLowerCase();
  return stem
    .replaceAll(/[^a-z0-9_+-]+/gu, "-")
    .replace(/^[^a-z0-9]+/u, "")
    .slice(0, 32);
}

/** Decides the format from the extension. No other image type is accepted. */
export function glyphFormatOf(filename: string): "png" | "svg" | null {
  const ext = filename.toLowerCase().replace(/^.*\./u, "");
  if (ext === "png" || ext === "svg") {
    return ext;
  }
  return null;
}

/** Same as core's `GLYPH_MAX_BYTES`. Fix both when fixing one. */
const GLYPH_MAX_BYTES = 256 * 1024;

type GlyphSkipReason = "unsupported" | "badName" | "duplicate" | "tooLarge";

/** The plan needs only a name and a size. A `File` or a plain test object both work. */
interface GlyphFileLike {
  name: string;
  size: number;
}

export interface GlyphImportPlan<F extends GlyphFileLike> {
  ready: { name: string; format: "png" | "svg"; file: F }[];
  skipped: { file: F; reason: GlyphSkipReason }[];
}

/** The verdict for one file. A name and format if it can be registered, otherwise the reason. */
function judgeGlyphFile(
  file: GlyphFileLike,
  taken: ReadonlySet<string>,
): { name: string; format: "png" | "svg" } | GlyphSkipReason {
  // A File from a nested folder has only the filename in name, but even when it
  // arrives with a path the name is built from the filename alone
  const basename = file.name.replace(/^.*[\\/]/u, "");
  const format = glyphFormatOf(basename);
  if (!format) {
    return "unsupported";
  }
  const name = suggestGlyphName(basename);
  if (!isGlyphName(name)) {
    return "badName";
  }
  if (file.size > GLYPH_MAX_BYTES) {
    return "tooLarge";
  }
  if (taken.has(name)) {
    return "duplicate";
  }
  return { name, format };
}

/**
 * Splits images picked as a whole folder into the ones to register and the ones
 * to drop. The dropped side carries a reason because a folder also holds a README
 * or a GIF, and counting and showing here is kinder than learning about an image
 * with no possible name, or one over 256 KiB, from a failed IPC. The first of a
 * duplicate name wins: if the later one silently overwrote, nobody could tell
 * which survived.
 */
export function planGlyphImport<F extends GlyphFileLike>(files: readonly F[]): GlyphImportPlan<F> {
  const plan: GlyphImportPlan<F> = { ready: [], skipped: [] };
  const taken = new Set<string>();
  for (const file of files) {
    const verdict = judgeGlyphFile(file, taken);
    if (typeof verdict === "string") {
      plan.skipped.push({ file, reason: verdict });
    } else {
      taken.add(verdict.name);
      plan.ready.push({ ...verdict, file });
    }
  }
  return plan;
}

const [registry, setRegistry] = createSignal<ReadonlyMap<string, string>>(new Map());

/** Name to data URL. The drawing side looks names up here. */
export const glyphs = registry;

/**
 * Re-reads the registry. Called at startup and after a sync or a glyph
 * registration or deletion. When the read fails the previous table is kept:
 * emptying it even for a moment turns drawn images back into text and the layout jumps.
 */
export async function loadGlyphs(): Promise<void> {
  try {
    const assets = await typedInvoke("read_glyphs");
    setRegistry(new Map(assets.map((asset) => [asset.name, asset.url])));
  } catch {
    // An old core without the table, or a failure outside the harness. Text just stays text
  }
}
