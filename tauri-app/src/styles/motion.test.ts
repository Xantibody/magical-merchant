import { describe, it, expect } from "vitest";

/**
 * 動きの規則は 1 つしかない。
 *
 * transform と opacity だけを 120〜350ms 動かし、イージングは `--app-ease` の
 * 1 本、keyframes は `mm-rise` と `mm-pop` の 2 つだけ。面ごとに CSS を分けて
 * あるので、規則から外れた値は「その面だけ癖が違う」という形で入り込み、
 * 並べて見ないと気づけない。ここで全部の面の CSS を文字として読み、外れて
 * いるものを名指しで落とす。
 *
 * 例外は `EXCEPTIONS` に理由ごと書く。数を増やすかどうかを毎回考えるための
 * 場所で、増えないことを期待している。
 */

const sources = import.meta.glob("./*.css", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** この規則で動かしていいもの。どれもハンドオフの transition の内訳にある。 */
const ANIMATABLE = new Set([
  // 本命。これだけは面を問わず動かせる
  "transform",
  "opacity",
  // ホバー色・保存できた印・比較の地色
  "background",
  "background-color",
  "border-color",
  "color",
  // レールの現在地の線。レールの中で絶対配置なので、動いても隣は流れない
  "top",
  // 本文の列。パネルが空けるぶんを詰めるのは幅で — transform では折り返せない
  "width",
  "padding",
  // 当たり判定の門。0s で切り替えるだけで、動きではない
  "visibility",
  // 打ち消し
  "none",
]);

/** 規則の外に置くと決めたもの。残す理由は CSS 側のコメントにも書いてある。 */
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

/** 曲線を名乗らない書き方(`transition-property` など)。 */
const NO_CURVE = new Set(["transition-property", "animation-name"]);

interface Declaration {
  file: string;
  property: string;
  value: string;
}

/** コメントの中の例示を数えない。 */
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
 * `transition: a 150ms, b 220ms` の 1 つぶん。`animation` は 1 つしか書かない。
 * `cubic-bezier(.2,.8,.2,1)` の中のカンマでは切らないので、括弧の中を先に畳む。
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

/** `220ms` / `0.22s` / `0s` を、書かれたまま順に返す。1 つめが長さ、2 つめが待ち。 */
function times(part: string): string[] {
  return [...part.matchAll(/(?<![\w.])\d*\.?\d+m?s\b/gu)].map((match) => match[0]);
}

function milliseconds(time: string): number {
  return time.endsWith("ms") ? Number.parseFloat(time) : Number.parseFloat(time) * 1000;
}

/** 動いている長さ。書いていなければ、そして 0s なら 0。 */
function duration(part: string): number {
  const written = times(part).at(0);
  return written === undefined ? 0 : milliseconds(written);
}

function subject(declaration: Declaration, part: string): string {
  return `${declaration.file} { ${declaration.property}: ${part} }`;
}

/**
 * 規則から外れている書き方を、CSS の中の場所ごと名指しで返す。
 * `properties` を渡すと、その書き方(`transition` など)だけを見る。
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

  // 0.22s と 220ms が混ざると、規則の「220ms」と同じ値なのかを毎回換算して
  // 確かめることになる。規則が ms で書かれているので CSS も ms で書く
  it("spells every duration in milliseconds", () => {
    expect(offenders(writtenInSeconds)).toStrictEqual([]);
  });

  // 癖が揃っていないと、同じ画面の中で「別のアプリが動いている」ように見える
  it("routes every curve through --app-ease", () => {
    expect(offenders(offTheOneEase, (property) => !NO_CURVE.has(property))).toStrictEqual([]);
  });

  // 速いほうは気づかれず、遅いほうは待たされる
  it("keeps every duration between 120ms and 350ms", () => {
    expect(offenders(outOfRange)).toStrictEqual([]);
  });

  // 動かすものを増やすほど、その動きが何を意味するのかが薄まる
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

  // 面ごとに書いていると、新しい面が足された日に 1 つだけ忘れられる。忘れても
  // 動きは止まらないので、気づくのは動きを嫌う人の手元だけ
  it("switches motion off from one place", () => {
    expect(filesSwitchingMotionOff()).toStrictEqual(["./base.css"]);
  });
});
