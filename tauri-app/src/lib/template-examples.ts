/**
 * テンプレに書かれた記入例を、見出しごとに取り出す。
 *
 * 記入例はノートのファイルには一度も書かれない — 書き出す core が
 * `{{eg}}` のブロックを落とす(`core/src/template/vars.rs`)。だからここは
 * 「保存された本文から読む」のではなく、ノートが名乗るテンプレ
 * (frontmatter の `template:`)を読み直して、書く人に薄字で見せるためだけの
 * 写しを作る。区切りの規則は core と同じものを二度書いている: ブロックは
 * 空行か次の見出しで終わり、閉じ印は無い。
 */

import { createSignal } from "solid-js";

const MARKER = /^\{\{\s*eg\s*(?::(?<example>[^}]*))?\}\}$/u;

/** 行頭の箇条書き記号。記入例は内容ではなく問いかけなので、印は外して見せる。 */
const LIST_MARKER = /^(?:[-*+]|\d+\.)\s+/u;

function headingText(line: string): string {
  return line.replace(/^#+/u, "").trim();
}

/** ブロックを閉じる行か。閉じる行そのものは残る。 */
function endsExample(line: string): boolean {
  return line === "" || line.startsWith("#");
}

/**
 * 記入例の行を落とす。「今日作ると」のプレビューが通る道で、書き出す core と
 * 同じ姿を見せるためにある。
 */
export function dropExamples(body: string): string {
  const kept: string[] = [];
  let dropping = false;

  for (const raw of body.split("\n")) {
    const line = raw.trim();
    // ブロックの中にいるあいだは何も残さない。閉じる行はブロックの外
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
 * 記入例を出すか。テーマ(`theme.ts`)や言語と同じく端末ごとの好みなので
 * localStorage に残す — 同期に乗せるものではない。既定は「出す」で、
 * 書いたテンプレがいきなり効かないほうが分かりにくい。
 */
export const examplesShown = shown;

export function setExamplesShown(on: boolean): void {
  setShown(on);
  localStorage.setItem(STORAGE_KEY, String(on));
}

/** 見出し → その下に書かれた記入例の行。見出しの前に書かれた分は空文字の鍵。 */
export function extractExamples(body: string): ReadonlyMap<string, string[]> {
  const examples = new Map<string, string[]>();
  let heading = "";
  /** 集めている最中のブロック。閉じるまでこれが立つ。 */
  let block: string[] | undefined;
  /** そのブロックが属する見出し。次の見出しで閉じたときに取り違えない。 */
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
