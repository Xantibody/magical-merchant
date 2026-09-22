/**
 * Milkdown saves an empty paragraph (a blank line as it looks) into Markdown as an HTML
 * line, `<br />`, and restores it to a blank line on the way back
 * (remark-preserve-empty-line). The test is gathered in one place so that outside the
 * editor, the preview and the titles in the list, that line is not shown literally as
 * `<br />`.
 *
 * The variants (`<br>` `<br/>` `<br >`) count as a blank line too, as Milkdown reads them.
 */
export function isPreservedEmptyLine(line: string): boolean {
  return /^<br[ \t]*\/?[ \t]*>$/iu.test(line.trim());
}
