import { createEffect, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import { Markmap } from "markmap-view";
import { outlineToTree } from "../lib/mindmap";

interface MindmapViewProps {
  source: string;
}

/**
 * d3-zoom が既定で付けるダブルクリック 2 倍拡大だけを外す。
 * markmap はラベル (foreignObject) では dblclick を止めているが、折りたたみの
 * 丸と余白では止めていないので、そこをダブルタップすると意図せず拡大していた。
 * `zoom: false` にするとホイール・ピンチの拡大まで消えてしまうので、
 * リスナーを名前空間 "dblclick.zoom" で狙い撃ちにする。
 */
function disableDoubleClickZoom(mm: Markmap): void {
  mm.svg.on("dblclick.zoom", null);
}

/**
 * 本文の見出し・リスト構造をマインドマップとして描く読み取り専用ビュー。
 * このコンポーネントは Workspace から lazy import される。markmap-view は
 * d3 を連れてくる重い依存なので、mermaid と同じく使うノートだけに払わせる。
 */
export default function MindmapView(props: MindmapViewProps): JSX.Element {
  let svgRef: SVGSVGElement | undefined;
  let markmap: Markmap | undefined;

  createEffect(() => {
    const root = outlineToTree(props.source);
    if (!svgRef) {
      return;
    }
    // duration: 0 — 開いた瞬間に全体が見えてほしい。枝が生えていく
    // アニメーションは読むだけのビューには飾りで、破棄後に d3 の transition が
    // 宙に残る原因にもなる。
    // データは create に渡さない。渡すと markmap の内部で setData → fit が
    // つながり、破棄後でも fit が走って取り外された SVG の寸法を読もうとする
    markmap ??= Markmap.create(svgRef, { duration: 0 });
    const current = markmap;
    disableDoubleClickZoom(current);
    void (async () => {
      // 全消し + 作り直しではなく差分更新。ユーザーが畳んだ枝はここで保たれる
      await current.setData(root);
      // setData にオプションを渡すと markmap が zoom を付け直すので、その後で
      // 改めて外す。今は渡していないが、一行で済む保険なので毎回やっておく
      disableDoubleClickZoom(current);
      if (markmap === current) {
        await current.fit();
      }
    })();
  });

  onCleanup(() => {
    // fit() の遷移が残ったまま SVG を外すと、d3 が取り外された要素の寸法を
    // 読もうとして落ちる。destroy は遷移までは止めてくれない
    markmap?.svg.interrupt();
    markmap?.destroy();
    markmap = undefined;
  });

  return (
    <div class="mindmap-view">
      <svg ref={svgRef} />
    </div>
  );
}
