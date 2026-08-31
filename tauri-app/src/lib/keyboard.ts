/**
 * 画面の下に貼り付くものを、ソフトキーボードの上に逃がすための道具。
 *
 * 下端に置いた道具立て(記法のツールバー・変数の挿入列)は、キーボードが
 * 出た瞬間にその裏へ隠れる。隠れたら押せないので、開いているあいだだけ
 * 上端に合わせて持ち上げる。
 */

import { createSignal, onCleanup, onMount } from "solid-js";
import type { Accessor } from "solid-js";

/** これ以下の縮みはスクロールバーや URL バーの誤差で、キーボードとは見なさない。 */
const KEYBOARD_MIN_HEIGHT = 100;

/**
 * キーボードの上端。閉じているあいだは `undefined` を返し、CSS の
 * `bottom: var(--safe-bottom)` に任せる。
 *
 * Android では閉じていても `visualViewport.height` がナビゲーションバーを含んだ
 * 全高になるため、その値で `top` を固定すると道具立てがバーの裏に潜り込む。
 */
export function keyboardTop(
  viewport: { offsetTop: number; height: number },
  windowHeight: number,
): number | undefined {
  if (viewport.height >= windowHeight - KEYBOARD_MIN_HEIGHT) {
    return undefined;
  }
  return viewport.offsetTop + viewport.height;
}

/** 開いているあいだだけキーボードの上端を返す。閉じていれば `undefined`。 */
export function createKeyboardTop(): Accessor<number | undefined> {
  const [top, setTop] = createSignal<number | undefined>();

  onMount(() => {
    const vv = window.visualViewport;
    if (!vv) {
      return;
    }
    const update = (): void => {
      setTop(keyboardTop(vv, window.innerHeight));
    };

    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    onCleanup(() => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    });
  });

  return top;
}

/**
 * キーボードの上に貼り付けるための style。閉じているあいだは何も返さず、
 * 貼り付く場所を CSS の `bottom` に預ける。
 */
export function keyboardTopStyle(
  top?: number,
): { top: string; bottom: string; transform: string } | undefined {
  return top === undefined
    ? undefined
    : { top: `${top}px`, bottom: "auto", transform: "translateY(-100%)" };
}
