/**
 * 特殊文字(グリフ)。ユーザーが登録した小さな画像に短い名前が付いていて、
 * 本文の `:name:` がその画像として描かれる。格闘ゲームのコマンド表記
 * (`:236p:`)のような、文字では書けない記号のためのもの。
 *
 * 保存形はあくまで `:name:` の文字列。画像は描くときに名前で引くだけで、
 * 本文には何も書き込まない — 画像が消えても本文は文字として読める。
 *
 * 名前の規則は core の `GlyphName` と同じ。片方を直したらもう片方も直すこと。
 */

import { createSignal } from "solid-js";
import { typedInvoke } from "./commands";

/**
 * 登録された名前しか解決しない前提のための、名前の形。`12:30:45` のような
 * 時刻や URL の `:` を拾わないよう、一致した名前を登録表で確かめてから
 * 画像にする。
 */
const SHORTCODE = /:([a-z0-9][a-z0-9_+-]{0,31}):/g;

export interface GlyphSegment {
  text: string;
  /** グリフなら登録名。地の文なら null。 */
  name: string | null;
}

/** 登録の有無を答えられればよい。Set でも、名前をキーにした Map でも通る。 */
type GlyphNames = Pick<ReadonlySet<string>, "has" | "size">;

/**
 * 本文をグリフとそれ以外に切り分ける。`names` に無い `:foo:` は地の文の
 * まま — 登録の無い名前を画像扱いすると、時刻や URL の一部が消える。
 */
export function splitGlyphs(text: string, names: GlyphNames): GlyphSegment[] {
  const segments: GlyphSegment[] = [];
  let last = 0;
  if (names.size > 0 && text.includes(":")) {
    // matchAll は正規表現を複製するので lastIndex を戻せない。exec で回す
    const re = new RegExp(SHORTCODE.source, "g");
    let match = re.exec(text);
    while (match !== null) {
      if (names.has(match[1])) {
        if (match.index > last) {
          segments.push({ text: text.slice(last, match.index), name: null });
        }
        segments.push({ text: match[0], name: match[1] });
        last = match.index + match[0].length;
      } else {
        // `:foo:236p:` のように、閉じの `:` が次の名前の開きでもある。
        // 登録の無い候補を読み飛ばすときは、その閉じから探し直す
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

/** 名前として通る形かどうか。core の `GlyphName::parse` と同じ規則。 */
export function isGlyphName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_+-]{0,31}$/.test(name);
}

/**
 * 画像ファイル名から名前の候補を作る。`236P.png` なら `236p`。
 * 使えない文字は `-` に寄せ、先頭の記号は落とす。候補でしかないので、
 * 空になることもある — そのときは書いてもらう。
 */
export function suggestGlyphName(filename: string): string {
  const stem = filename.replace(/\.[^.]*$/, "").toLowerCase();
  return stem
    .replaceAll(/[^a-z0-9_+-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 32);
}

/** 拡張子から形式を決める。それ以外の画像は受けない。 */
export function glyphFormatOf(filename: string): "png" | "svg" | null {
  const ext = filename.toLowerCase().replace(/^.*\./, "");
  if (ext === "png" || ext === "svg") {
    return ext;
  }
  return null;
}

/** core の `GLYPH_MAX_BYTES` と同じ。片方を直したらもう片方も直すこと。 */
const GLYPH_MAX_BYTES = 256 * 1024;

type GlyphSkipReason = "unsupported" | "badName" | "duplicate" | "tooLarge";

/** 計画に要るのは名前と大きさだけ。`File` でもテストの素朴な object でも通る。 */
interface GlyphFileLike {
  name: string;
  size: number;
}

export interface GlyphImportPlan<F extends GlyphFileLike> {
  ready: { name: string; format: "png" | "svg"; file: F }[];
  skipped: { file: F; reason: GlyphSkipReason }[];
}

/** 一枚ぶんの判定。登録できるなら名前と形式、できないなら理由。 */
function judgeGlyphFile(
  file: GlyphFileLike,
  taken: ReadonlySet<string>,
): { name: string; format: "png" | "svg" } | GlyphSkipReason {
  // 入れ子のフォルダから来た File は name がファイル名だけだが、
  // パス付きで来ても名前はファイル名からしか作らない
  const basename = file.name.replace(/^.*[\\/]/, "");
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
 * フォルダごと選ばれた画像を、登録するものと落とすものに分ける。
 * 落とす側に理由を添えるのは、フォルダには README や GIF も混ざるし、
 * 名前が作れない画像や 256 KiB 超えを IPC の失敗で知るより、ここで
 * 数えて見せる方が親切だから。同じ名前は先勝ち — 後の方が黙って
 * 上書きすると、どちらが残ったか分からない。
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

/** 名前 → データ URL。描く側はこれを引く。 */
export const glyphs = registry;

/**
 * 登録表を読み直す。起動時と、同期やグリフの登録・削除のあとに呼ぶ。
 * 読めなかったときは前の表を保つ — 一瞬でも空にすると、描いてある画像が
 * 文字に戻ってレイアウトが跳ねる。
 */
export async function loadGlyphs(): Promise<void> {
  try {
    const assets = await typedInvoke("read_glyphs");
    setRegistry(new Map(assets.map((asset) => [asset.name, asset.url])));
  } catch {
    // 表を持たない旧いコアや、ハーネス外での失敗。文字のまま出るだけ
  }
}
