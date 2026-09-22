import { describe, it, expect } from "vitest";

/**
 * There is only one motion rule.
 *
 * Only transform and opacity move, over 120 to 350ms, the easing is the single
 * `--app-ease`, and the keyframes are only the two `mm-rise` and `mm-pop`. The CSS is
 * split per surface, so a value outside the rule creeps in as "only this surface feels
 * different" and cannot be noticed without putting them side by side. This reads the CSS
 * of every surface as text and fails whatever is outside the rule, by name.
 *
 * An exception is written in `EXCEPTIONS` together with its reason. It is the place to
 * think each time about whether to add one, and the hope is that it does not grow.
 */

const sources = import.meta.glob("./*.css", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** What this rule may move. Each one is in the transition breakdown of the handoff. */
const ANIMATABLE = new Set([
  // The main pair. Only these can move on any surface
  "transform",
  "opacity",
  // Hover color, the mark that a save landed, the background color of a comparison
  "background",
  "background-color",
  "border-color",
  "color",
  // The rail's current-location line. It is absolutely positioned inside the rail, so
  // moving it does not push its neighbours around
  "top",
  // The body column. The room a panel frees is taken up by width: transform cannot re-wrap
  "width",
  "padding",
  // The gate for hit testing. It only switches at 0s, so it is not motion
  "visibility",
  // Cancellation
  "none",
]);

/** What was decided to lie outside the rule. The reason to keep it is in the CSS comment too. */
const EXCEPTIONS = [
  {
    file: "./workspace.css",
    declaration: "animation: spin 1s linear infinite",
    why: "保存している「あいだ」の合図。入ってくる動きではないので mm-rise では代用できず、回るものは linear でなければ脈打つ",
  },
  {
    file: "./editor.css",
    declaration: "animation: ProseMirror-cursor-blink 1.1s steps(2, start) infinite",
    why: "ProseMirror の gapcursor。キャレットの点滅は OS の作法で、値も上流のもの",
  },
];

/** Forms that name no curve (`transition-property` and the like). */
const NO_CURVE = new Set(["transition-property", "animation-name"]);

interface Declaration {
  file: string;
  property: string;
  value: string;
}

/** Do not count the examples written inside comments. */
function code(css: string): string {
  return css.replaceAll(/\/\*.*?\*\//gsu, "");
}

function declarations(): Declaration[] {
  const found: Declaration[] = [];
  const pattern =
    /(?<prop>transition|animation)(?<long>-duration|-delay|-timing-function|-property|-name)?\s*:\s*(?<value>[^;}]+)/gu;
  for (const [file, css] of Object.entries(sources)) {
    for (const match of code(css).matchAll(pattern)) {
      found.push({
        file,
        property: `${match.groups?.prop ?? ""}${match.groups?.long ?? ""}`,
        value: (match.groups?.value ?? "").replaceAll(/\s+/gu, " ").trim(),
      });
    }
  }
  return found;
}

function isException(declaration: Declaration): boolean {
  return EXCEPTIONS.some(
    (exception) =>
      exception.file === declaration.file &&
      `${declaration.property}: ${declaration.value}` === exception.declaration,
  );
}

/**
 * One entry of `transition: a 150ms, b 220ms`. Only one `animation` is ever written.
 * The commas inside `cubic-bezier(.2,.8,.2,1)` must not split it, so what is in the
 * parentheses is folded away first.
 */
function parts(declaration: Declaration): string[] {
  const folded = declaration.value.replaceAll(/\([^()]*\)/gu, (group) =>
    group.replaceAll(",", "\u0000"),
  );
  return folded
    .split(",")
    .map((part) => part.replaceAll("\u0000", ",").trim())
    .filter((part) => part.length > 0);
}

/** Return `220ms` / `0.22s` / `0s` as written, in order. The first is the duration, the second the delay. */
function times(part: string): string[] {
  return [...part.matchAll(/(?<![\w.])\d*\.?\d+m?s\b/gu)].map((match) => match[0]);
}

function milliseconds(time: string): number {
  return time.endsWith("ms") ? Number.parseFloat(time) : Number.parseFloat(time) * 1000;
}

/** How long it moves. 0 when nothing is written, and when it is 0s. */
function duration(part: string): number {
  const written = times(part).at(0);
  return written === undefined ? 0 : milliseconds(written);
}

function subject(declaration: Declaration, part: string): string {
  return `${declaration.file} { ${declaration.property}: ${part} }`;
}

/**
 * Return every declaration outside the rule, named with its place in the CSS.
 * Pass `properties` to look at only that form (`transition` and the like).
 */
function offenders(
  wrong: (part: string) => boolean,
  properties?: (property: string) => boolean,
): string[] {
  return declarations()
    .filter((declaration) => !isException(declaration))
    .filter((declaration) => properties?.(declaration.property) ?? true)
    .flatMap((declaration) =>
      parts(declaration)
        .filter((part) => wrong(part))
        .map((part) => subject(declaration, part)),
    );
}

function writtenInSeconds(part: string): boolean {
  return times(part).some((time) => !time.endsWith("ms") && time !== "0s");
}

function offTheOneEase(part: string): boolean {
  return duration(part) > 0 && !part.includes("var(--app-ease)");
}

function outOfRange(part: string): boolean {
  const ms = duration(part);
  return ms > 0 && (ms < 120 || ms > 350);
}

function movesSomethingElse(part: string): boolean {
  return !ANIMATABLE.has(part.split(" ").at(0) ?? "");
}

function keyframeNames(): string[] {
  const names = new Set<string>();
  for (const css of Object.values(sources)) {
    for (const match of code(css).matchAll(/@keyframes\s+(?<name>[\w-]+)/gu)) {
      names.add(match.groups?.name ?? "");
    }
  }
  return [...names].toSorted();
}

function filesSwitchingMotionOff(): string[] {
  return Object.entries(sources)
    .filter(([, css]) => css.includes("prefers-reduced-motion"))
    .map(([file]) => file);
}

describe("the motion rules", () => {
  it("has something to read", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    expect(declarations().length).toBeGreaterThan(10);
  });

  // Mixing 0.22s and 220ms means converting every time to check whether it is the same
  // value as the rule's "220ms". The rule is written in ms, so the CSS is written in ms
  it("spells every duration in milliseconds", () => {
    expect(offenders(writtenInSeconds)).toStrictEqual([]);
  });

  // Without one shared feel, one screen looks as if "a different app is moving inside it"
  it("routes every curve through --app-ease", () => {
    expect(offenders(offTheOneEase, (property) => !NO_CURVE.has(property))).toStrictEqual([]);
  });

  // Faster than that goes unnoticed; slower than that keeps people waiting
  it("keeps every duration between 120ms and 350ms", () => {
    expect(offenders(outOfRange)).toStrictEqual([]);
  });

  // The more things move, the thinner the meaning of each movement gets
  it("moves only what the handoff lists", () => {
    expect(offenders(movesSomethingElse, (property) => property === "transition")).toStrictEqual(
      [],
    );
  });

  it("has only the two keyframes, and the two it made an exception for", () => {
    expect(keyframeNames()).toStrictEqual([
      "ProseMirror-cursor-blink",
      "mm-pop",
      "mm-rise",
      "spin",
    ]);
  });

  // Written per surface, one gets forgotten on the day a new surface is added. Forgetting
  // it does not stop the motion, so only someone who dislikes motion ever notices
  it("switches motion off from one place", () => {
    expect(filesSwitchingMotionOff()).toStrictEqual(["./base.css"]);
  });
});
