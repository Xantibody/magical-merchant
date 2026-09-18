import { splitTitle } from "./note-title";

/**
 * 版と下書きの unified diff を、本文の行ごとの印に変える。
 *
 * 履歴を開いても本文を差分の枠に置き換えない — 下書きの本文そのものに
 * 「増えた」「消えた」の印を欄外に立てる。消えた行は選んだ版にしか無いので、
 * 下書きの該当位置へ差し込んだ 1 つの文書(合わせた本文)を作り、その行に
 * 印を添える。描くのは MarkdownPreview で、印はブロックごとに class になる
 * (`lib/markdown.ts` の lineMarksPlugin)。
 */

export type LineMark = "add" | "del";

export interface MarkedBody {
  /** 下書きに、消えた行を元の位置へ差し込んだ本文。 */
  source: string;
  /** `source` の行ごとの印。変わっていない行は undefined。 */
  marks: readonly (LineMark | undefined)[];
}

const HUNK = /^@@ -(?<oldStart>\d+)(?:,(?<oldLen>\d+))? \+(?<newStart>\d+)(?:,(?<newLen>\d+))? @@/u;

/** 行に切る。末尾の改行は「最後の行の終わり」であって空行ではない。 */
function linesOf(text: string): string[] {
  if (text === "") {
    return [];
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

/**
 * 下書き + diff → 合わせた本文と行ごとの印。diff が空(同じ内容)なら
 * 下書きそのままで印は無い。
 *
 * ハンクの `+c,d` は下書き側の 1 始まりの行番号。`d` が 0(消えただけの
 * ハンク)のときの `c` は「その行の後ろ」を指す。
 */
export function markLines(draft: string, diff: string): MarkedBody {
  const source = linesOf(draft);
  const out: string[] = [];
  const marks: (LineMark | undefined)[] = [];
  let cursor = 0;
  const take = (upTo: number): void => {
    while (cursor < upTo && cursor < source.length) {
      out.push(source[cursor] ?? "");
      marks.push(undefined);
      cursor += 1;
    }
  };

  /** 最初のハンクより前は `+++` / `---` のヘッダ。本文の行ではない。 */
  let inHunk = false;

  for (const line of linesOf(diff)) {
    const hunk = HUNK.exec(line);
    if (hunk?.groups) {
      const start = Number(hunk.groups.newStart);
      const length = hunk.groups.newLen === undefined ? 1 : Number(hunk.groups.newLen);
      take(length === 0 ? start : start - 1);
      inHunk = true;
    }
    // ハンクの中では `+---`(罫線が増えた)も本文の行。ヘッダと見分けるのは
    // 位置であって綴りではない
    switch (hunk || !inHunk ? "@" : line[0]) {
      case " ": {
        out.push(line.slice(1));
        marks.push(undefined);
        cursor += 1;
        break;
      }
      case "+": {
        out.push(line.slice(1));
        marks.push("add");
        cursor += 1;
        break;
      }
      case "-": {
        out.push(line.slice(1));
        marks.push("del");
        break;
      }
      default: {
        // `\ No newline at end of file` は行ではない
        break;
      }
    }
  }
  take(source.length);
  return { source: out.join("\n"), marks };
}

/**
 * 画面に出す形。先頭の H1 はタイトル欄が持つので、`splitTitle` と同じ規則で
 * 合わせた本文からも外す。題が変わっていれば古い題(消えた行)が先頭に
 * 来るのでそれが外れ、新しい題は `+` の付いた H1 として本文に残る —
 * 題が変わったことは読める。
 */
export function markedBody(draft: string, diff: string): MarkedBody {
  const marked = markLines(draft, diff);
  const lines = marked.source.split("\n");
  const { title } = splitTitle(marked.source);
  if (title === "" && !/^#[ \t]+/u.test(lines[0] ?? "")) {
    return marked;
  }
  let dropped = 1;
  if (lines[1] === "") {
    dropped = 2;
  }
  return {
    source: lines.slice(dropped).join("\n"),
    marks: marked.marks.slice(dropped),
  };
}

/**
 * ブロック 1 つぶんの印。範囲の全行が消えていれば `del`、増えた行か消えた行を
 * 1 つでも含めば `add`(変わった)、どちらも無ければ印なし。
 */
export function blockMark(
  marks: readonly (LineMark | undefined)[],
  from: number,
  to: number,
): LineMark | undefined {
  if (to <= from) {
    return undefined;
  }
  let touched = false;
  let allDeleted = true;
  for (let line = from; line < to; line += 1) {
    const mark = marks[line];
    if (mark !== undefined) {
      touched = true;
    }
    if (mark !== "del") {
      allDeleted = false;
    }
  }
  if (!touched) {
    return undefined;
  }
  return allDeleted ? "del" : "add";
}
