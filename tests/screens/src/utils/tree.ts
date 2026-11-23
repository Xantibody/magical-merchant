// An accessibility tree as text, one node a line, indented by depth, and the DOM walk that
// approximates one where no engine exposes its own (WebKit's WebDriver has no tree endpoint).

export interface TreeNode {
  role: string;
  name: string;
  states?: string[];
  children: TreeNode[];
}

function line(node: TreeNode): string {
  const name = node.name === "" ? "" : ` ${JSON.stringify(node.name)}`;
  const states =
    node.states === undefined || node.states.length === 0 ? "" : ` [${node.states.join(" ")}]`;
  return `${node.role}${name}${states}`;
}

function lines(nodes: TreeNode[], indent: string): string[] {
  return nodes.flatMap((node) => [
    `${indent}${line(node)}`,
    ...lines(node.children, `${indent}  `),
  ]);
}

export function treeText(nodes: TreeNode[]): string {
  return lines(nodes, "")
    .map((text) => `${text}\n`)
    .join("");
}

/**
 * Runs inside the page (WebDriver sends its source), so it refers to nothing outside itself.
 * Roles come from `role` or the tag, names from the ARIA attributes or, for the roles named by
 * their content, the text; an element without a role passes its children up, and loose text
 * becomes a `text` node. Hidden subtrees are left out.
 */
export function collectTree(root: Element): TreeNode[] {
  const tags: Record<string, string> = {
    A: "link",
    ARTICLE: "article",
    ASIDE: "complementary",
    BUTTON: "button",
    DIALOG: "dialog",
    FORM: "form",
    H1: "heading",
    H2: "heading",
    H3: "heading",
    H4: "heading",
    H5: "heading",
    H6: "heading",
    IMG: "img",
    LI: "listitem",
    MAIN: "main",
    NAV: "navigation",
    OL: "list",
    SELECT: "combobox",
    TABLE: "table",
    TD: "cell",
    TEXTAREA: "textbox",
    TH: "columnheader",
    TR: "row",
    UL: "list",
  };
  const inputs: Record<string, string> = {
    button: "button",
    checkbox: "checkbox",
    radio: "radio",
    range: "slider",
    search: "searchbox",
    submit: "button",
  };
  const namedByContent = new Set([
    "button",
    "cell",
    "checkbox",
    "columnheader",
    "heading",
    "link",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "radio",
    "switch",
    "tab",
  ]);
  const spaces = /\s+/gu;
  const flat = (text: string | null): string => (text ?? "").replaceAll(spaces, " ").trim();
  /** Every piece of text under an element, a space between pieces, as a reader hears it. */
  const words = (element: Element): string => {
    const pieces: string[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text !== null; text = walker.nextNode()) {
      pieces.push(text.textContent ?? "");
    }
    return flat(pieces.join(" "));
  };

  const roleOf = (element: Element): string => {
    const explicit = element.getAttribute("role");
    if (
      explicit !== null &&
      explicit !== "" &&
      explicit !== "presentation" &&
      explicit !== "none"
    ) {
      return explicit;
    }
    if (element instanceof HTMLInputElement) {
      return inputs[element.type] ?? "textbox";
    }
    if (element instanceof HTMLAnchorElement && !element.hasAttribute("href")) {
      return "";
    }
    if (
      element instanceof HTMLElement &&
      element.isContentEditable &&
      !element.parentElement?.isContentEditable
    ) {
      return "textbox";
    }
    return tags[element.tagName] ?? "";
  };

  const nameOf = (element: Element, role: string): string => {
    const label = element.getAttribute("aria-label");
    if (label !== null && label !== "") {
      return flat(label);
    }
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy !== null) {
      return flat(
        labelledBy
          .split(spaces)
          .filter((id) => id !== "")
          .map((id) => document.querySelector(`#${CSS.escape(id)}`)?.textContent ?? "")
          .join(" "),
      );
    }
    if (element instanceof HTMLImageElement) {
      return flat(element.alt);
    }
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return flat(element.placeholder);
    }
    if (namedByContent.has(role)) {
      // textContent would glue "Scrawl" and "3 records" into one word
      return words(element);
    }
    return flat(element.getAttribute("title"));
  };

  const ariaStates = ["expanded", "selected", "checked", "pressed", "current", "disabled"];
  // A checkbox's value is "on" whether or not it is checked; only typed text is worth reading
  const typed = new Set(["email", "number", "password", "search", "tel", "text", "url"]);
  const statesOf = (element: Element): string[] => {
    const states: string[] = [];
    for (const state of ariaStates) {
      const value = element.getAttribute(`aria-${state}`);
      if (value !== null && value !== "false") {
        states.push(value === "true" ? state : `${state}=${value}`);
      }
    }
    if (element instanceof HTMLInputElement && element.checked) {
      states.push("checked");
    }
    if (element.hasAttribute("disabled")) {
      states.push("disabled");
    }
    if (
      (element instanceof HTMLTextAreaElement ||
        (element instanceof HTMLInputElement && typed.has(element.type))) &&
      element.value !== ""
    ) {
      states.push(`value=${JSON.stringify(element.value)}`);
    }
    return [...new Set(states)];
  };

  // An element laid out as `display: contents` has no box of its own, so checkVisibility()
  // answers false for it while its children show; it is judged by its children instead
  const unread = new Set(["SCRIPT", "STYLE", "TEMPLATE"]);
  const hidden = (element: Element): boolean =>
    element.getAttribute("aria-hidden") === "true" ||
    unread.has(element.tagName) ||
    (getComputedStyle(element).display !== "contents" &&
      !element.checkVisibility({ visibilityProperty: true }));

  const walk = (node: Node, textToo: boolean): TreeNode[] => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = flat(node.textContent);
      return textToo && text !== "" ? [{ role: "text", name: text, children: [] }] : [];
    }
    if (!(node instanceof Element) || hidden(node)) {
      return [];
    }
    const role = roleOf(node);
    const children = [...node.childNodes].flatMap((child) =>
      walk(child, textToo && !namedByContent.has(role)),
    );
    if (role === "") {
      return children;
    }
    return [{ role, name: nameOf(node, role), states: statesOf(node), children }];
  };

  return walk(root, true);
}
