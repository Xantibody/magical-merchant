/**
 * Preview resolution of template variables.
 *
 * The real resolution is done by core (`template/vars.rs`). What lives here is a
 * copy that shows the title and tags being edited as "this is what today would
 * produce", placed so that each keystroke does not round-trip the IPC. The file that
 * gets saved never passes through these functions.
 *
 * The rule that drops a whole line containing `{{prev}}` is not here. The preview
 * shows only one line's value; keeping or dropping lines is the job of the core that
 * writes the body.
 */

import { locale as currentLocale, t } from "./i18n";
import type { Locale } from "./i18n";
import { sameTag } from "./tags";
import { dropExamples } from "./template-examples";

const WEEKDAYS: Record<Locale, string[]> = {
  ja: ["日", "月", "火", "水", "木", "金", "土"],
  en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
};

const pad = (n: number): string => String(n).padStart(2, "0");

/** The same tokens as core's `format_stamp`. */
export function formatStamp(date: Date, pattern: string): string {
  return pattern
    .replaceAll("YYYY", String(date.getFullYear()))
    .replaceAll("MM", pad(date.getMonth() + 1))
    .replaceAll("DD", pad(date.getDate()))
    .replaceAll("HH", pad(date.getHours()))
    .replaceAll("mm", pad(date.getMinutes()))
    .replaceAll("ss", pad(date.getSeconds()));
}

const DEFAULT_DATE = "YYYY-MM-DD";
const DEFAULT_TIME = "HH:mm";

/** A `{{prev}}` token, spaces allowed inside the braces as core allows them. */
const PREV = /\{\{\s*prev\s*\}\}/u;

const PLACEHOLDER = /\{\{(?<inner>[^}]*)\}\}/gu;

/**
 * Resolves the variables of one line. An unknown variable is left as written: a
 * person who misspelled it would only notice that it "vanished", which core avoids
 * for the same reason.
 */
export function resolveLine(line: string, now: Date, locale: Locale, prev = ""): string {
  return line.replaceAll(PLACEHOLDER, (raw, inner: string) => {
    const at = inner.indexOf(":");
    const name = (at === -1 ? inner : inner.slice(0, at)).trim();
    const arg = at === -1 ? "" : inner.slice(at + 1).trim();

    if (name === "date") {
      return formatStamp(now, arg || DEFAULT_DATE);
    }
    if (name === "time") {
      return formatStamp(now, arg || DEFAULT_TIME);
    }
    if (name === "weekday") {
      return WEEKDAYS[locale][now.getDay()] ?? "";
    }
    if (name === "prev") {
      return prev;
    }
    return raw;
  });
}

/**
 * Preview of the whole body. Resolving line by line is the same as core; the only
 * difference is `{{prev}}`. The previous note cannot be read from here, so it is
 * left as written to show "a link goes here". Collapsed to empty, a line of just
 * "prev: " would remain and nobody could read what it waits for.
 *
 * On actual creation it becomes a link if there is a previous note, and the whole
 * line is dropped if there is none (`template/vars.rs`). A caller that knows there is none
 * says `dropPrev`, and the lines go here too.
 */
export function resolveBody(
  body: string,
  now: Date,
  locale: Locale,
  { dropPrev = false }: { dropPrev?: boolean } = {},
): string {
  return dropExamples(body)
    .split("\n")
    .filter((line) => !(dropPrev && PREV.test(line)))
    .map((line) => resolveLine(line, now, locale, "{{prev}}"))
    .join("\n");
}

/** Whether the body links to the previous note anywhere that is written into the note. */
export function usesPrev(body: string): boolean {
  return PREV.test(dropExamples(body));
}

/** Whether the string contains a variable. Used to draw a tag solid or dashed. */
export function hasVariable(text: string): boolean {
  return /\{\{[^}]*\}\}/u.test(text);
}

/**
 * Adds one automatic tag. The spelling is kept as typed.
 *
 * Only the duplicate check differs from note tags (addTag in `note-meta.ts`): one
 * that contains a variable is compared without folding a single character.
 * `{{date:YYYY-MM}}` and `{{date:yyyy-mm}}` are different tokens; folded into one,
 * the one written later silently disappears.
 */
export function addTemplateTag(tags: string[], raw: string): string[] {
  const tag = raw.trim().replace(/^#+/u, "");
  if (!tag) {
    return tags;
  }
  const duplicate = hasVariable(tag)
    ? tags.includes(tag)
    : tags.some((own) => !hasVariable(own) && sameTag(own, tag));
  return duplicate ? tags : [...tags, tag];
}

/** Splits text into variable and non-variable runs, for highlighting. */
export interface TextRun {
  text: string;
  variable: boolean;
}

export function splitVariables(text: string): TextRun[] {
  const runs: TextRun[] = [];
  let at = 0;
  for (const match of text.matchAll(/\{\{[^}]*\}\}/gu)) {
    const start = match.index;
    if (start > at) {
      runs.push({ text: text.slice(at, start), variable: false });
    }
    runs.push({ text: match[0], variable: true });
    at = start + match[0].length;
  }
  if (at < text.length) {
    runs.push({ text: text.slice(at), variable: false });
  }
  return runs;
}

export interface TemplateVar {
  /** The string inserted at the cursor. */
  token: string;
  /** Short description attached to the chip. A function so it redraws after a language switch. */
  label: () => string;
  /** One line on what it becomes, for the list of suggestions. Examples are today's values. */
  hint: () => string;
}

/** Variables shown in the toolbar and the "insert variable" row. The only ones the PoC resolves. */
export const TEMPLATE_VARS: readonly TemplateVar[] = [
  {
    token: "{{date}}",
    label: () => t().templates.varDate,
    hint: () => t().templates.varDateHint(formatStamp(new Date(), DEFAULT_DATE)),
  },
  {
    token: "{{time}}",
    label: () => t().templates.varTime,
    hint: () => t().templates.varTimeHint(formatStamp(new Date(), DEFAULT_TIME)),
  },
  {
    token: "{{weekday}}",
    label: () => t().templates.varWeekday,
    hint: () =>
      t().templates.varWeekdayHint(resolveLine("{{weekday}}", new Date(), currentLocale())),
  },
  {
    token: "{{prev}}",
    label: () => t().templates.varPrev,
    hint: () => t().templates.varPrevHint,
  },
  // The only variable that never becomes a value. It marks the line below it as
  // "an example that is not written into the note"; its job is dropping the line,
  // not resolving (`core/src/template/vars.rs`)
  {
    token: "{{eg}}",
    label: () => t().templates.varExample,
    hint: () => t().templates.varExampleHint,
  },
];
