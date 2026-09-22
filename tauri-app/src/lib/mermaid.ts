import type { MermaidConfig, Mermaid } from "mermaid";

/**
 * mermaid is by far the heaviest dependency in this app. So that a note with no diagram
 * does not pay that weight, it is not imported until the first diagram is met.
 */
let mermaidPromise: Promise<Mermaid> | undefined;

/** An id unique to each diagram. mermaid scopes the <style> inside the SVG by this id */
let diagramCount = 0;

async function importMermaid(): Promise<Mermaid> {
  const module = await import("mermaid");
  return module.default;
}

/**
 * Read the diagram's colours from the app's tokens. A custom property's computed value has
 * var() already resolved, so reading it after a theme switch returns the colours as of
 * that moment. Where the tokens cannot be read, mermaid's default single-colour theme
 * takes over. Passing an empty string makes mermaid throw while parsing the colour, and
 * the whole diagram disappears.
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
    // On a syntax error mermaid leaves the half-built diagram behind in the body
    document.querySelector(`#d${id}`)?.remove();
    return null;
  }
}

/**
 * Draw mermaid sources into SVG. Anything that could not be drawn returns null, so the
 * caller can fall back to showing the source.
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
    // A note can also come down from the sync target. The label HTML goes through DOMPurify
    securityLevel: "strict",
    // Draw labels with SVG text rather than a foreignObject (HTML). A browser does not
    // draw a foreignObject inside an SVG loaded as an <img>, so if one is left the text
    // alone vanishes from the PNG. How <br/> and bold look inside a label does change.
    // AIDEV-NOTE: per-diagram htmlLabels (flowchart.htmlLabels) is dead in mermaid 11. Only this root one works
    htmlLabels: false,
    // A key listed in `secure` cannot be rewritten by a `%%{init: ...}%%` inside the
    // diagram. mermaid's sanitize descends into nested objects under the same name, so
    // flowchart.htmlLabels falls with it.
    // AIDEV-NOTE: the default secure is an array. initialize merges arrays as a union, not a replacement, so the default keys stay
    secure: ["htmlLabels"],
    ...themeConfig(),
  });

  const svgs: (string | null)[] = [];
  for (const source of sources) {
    // mermaid borrows the config and the DOM globally on every render. Lined up with
    // Promise.all they tread on each other's state, so these are awaited in order
    // oxlint-disable-next-line no-await-in-loop
    svgs.push(await renderOne(mermaid, source));
  }
  return svgs;
}
