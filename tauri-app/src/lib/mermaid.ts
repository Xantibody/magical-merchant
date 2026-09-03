import type { MermaidConfig, Mermaid } from "mermaid";

/**
 * mermaid はこのアプリの依存の中で飛び抜けて重い。図を含まないノートにその重さを
 * 払わせないよう、最初の図に出会うまで import しない。
 */
let mermaidPromise: Promise<Mermaid> | undefined;

/** 図ごとに固有の id。mermaid は SVG 内の <style> をこの id で絞り込む */
let diagramCount = 0;

async function importMermaid(): Promise<Mermaid> {
  const module = await import("mermaid");
  return module.default;
}

/**
 * 図の配色をアプリのトークンから引く。カスタムプロパティの計算値は var() が
 * 解決済みなので、テーマを切り替えた後に読めばその時点の色がそのまま返る。
 * トークンが読めない場面では mermaid 既定の単色テーマに任せる。空文字を渡すと
 * mermaid は色の解析で例外を投げ、図がまるごと出なくなる。
 */
function themeConfig(): MermaidConfig {
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string): string => styles.getPropertyValue(name).trim();

  const surface = token("--app-surface");
  const surface2 = token("--app-surface-2");
  const text = token("--app-text");
  const muted = token("--app-text-muted");
  const border = token("--app-border");
  const font = token("--font-sans");

  if (!surface || !surface2 || !text || !muted || !border) {
    return { theme: "neutral" };
  }

  return {
    theme: "base",
    themeVariables: {
      background: surface,
      primaryColor: surface2,
      primaryTextColor: text,
      primaryBorderColor: border,
      secondaryColor: surface2,
      secondaryTextColor: text,
      secondaryBorderColor: border,
      tertiaryColor: surface,
      tertiaryTextColor: text,
      tertiaryBorderColor: border,
      mainBkg: surface2,
      nodeBorder: border,
      nodeTextColor: text,
      clusterBkg: surface,
      clusterBorder: border,
      lineColor: muted,
      textColor: text,
      edgeLabelBackground: surface,
      fontSize: "14px",
      ...(font ? { fontFamily: font } : {}),
    },
  };
}

async function renderOne(mermaid: Mermaid, source: string): Promise<string | null> {
  diagramCount += 1;
  const id = `mermaid-${diagramCount}`;
  try {
    const { svg } = await mermaid.render(id, source);
    return svg;
  } catch {
    // 構文エラーのときは mermaid が作りかけの図を body に置き去りにする
    document.querySelector(`#d${id}`)?.remove();
    return null;
  }
}

/**
 * mermaid のソースを SVG に描く。描けなかったものは null を返し、
 * 呼び出し側がソースを見せる側に倒せるようにする。
 */
export async function renderDiagrams(sources: string[]): Promise<(string | null)[]> {
  if (sources.length === 0) {
    return [];
  }

  let mermaid: Mermaid;
  try {
    mermaidPromise ??= importMermaid();
    mermaid = await mermaidPromise;
  } catch {
    return sources.map(() => null);
  }

  mermaid.initialize({
    startOnLoad: false,
    // ノートは同期先から降ってくることもある。ラベルの HTML は DOMPurify に通す
    securityLevel: "strict",
    // ラベルを foreignObject(HTML)ではなく SVG の text で描く。foreignObject が
    // あると PNG に描くときに canvas が汚染されて書き出せない。ラベル内の
    // <br/> や太字の見え方は変わる
    flowchart: { htmlLabels: false },
    ...themeConfig(),
  });

  const svgs: (string | null)[] = [];
  for (const source of sources) {
    // mermaid は描画のたびに設定と DOM をグローバルに借りる。Promise.all で
    // 並べると互いの状態を踏み合うので、ここは順番に待つ
    // oxlint-disable-next-line no-await-in-loop
    svgs.push(await renderOne(mermaid, source));
  }
  return svgs;
}
