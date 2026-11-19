/**
 * Renders a ```` ```diff ```` fence line by line. Shiki has no diff grammar, and passing it
 * one falls back to plain text (it is not among the 8 languages in highlighter.ts).
 * What a diff has to say is only which lines were added and removed, so laying colour on the
 * line itself fits the purpose better than colouring inside it by syntax.
 *
 * The output goes in the same `<pre><code>` frame as any other code block. A different frame
 * would drift in background, padding and letter advance, and the diff alone would look like
 * something else inside the same note.
 */

/** The same 4 characters as markdown-it's escapeHtml. This function does not depend on markdown-it */
function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Wraps only the leading +/- in a span. The colour comes from the parent diff-add / diff-del.
 * Putting colour on the sign as well as the background keeps the two apart where the
 * difference in background cannot be read
 */
function signed(line: string): string {
  return `<span class="diff-sign">${line.slice(0, 1)}</span>${escapeHtml(line.slice(1))}`;
}

function renderLine(line: string): string {
  // +++ / --- are the filename headers, not the diff body. Painting them as added and
  // removed would hide where the diff starts
  if (line.startsWith("+++") || line.startsWith("---")) {
    return `<div class="diff-line">${escapeHtml(line)}</div>`;
  }
  if (line.startsWith("@@")) {
    return `<div class="diff-line diff-hunk">${escapeHtml(line)}</div>`;
  }
  if (line.startsWith("+")) {
    return `<div class="diff-line diff-add">${signed(line)}</div>`;
  }
  if (line.startsWith("-")) {
    return `<div class="diff-line diff-del">${signed(line)}</div>`;
  }
  // An empty line as an empty div raises no line box and has height 0.
  // Under white-space: pre, a single space brings one line of height back
  return `<div class="diff-line">${line === "" ? " " : escapeHtml(line)}</div>`;
}

export function renderDiffBlock(code: string): string {
  // The content of a fence always ends with a newline. Splitting it as it is would add one
  // empty line at the end
  const lines = code.replace(/\n$/u, "").split("\n");
  // No newline is put between the lines. Inside a pre, a newline is drawn as a line of its own
  return `<pre><code>${lines.map((line) => renderLine(line)).join("")}</code></pre>`;
}
