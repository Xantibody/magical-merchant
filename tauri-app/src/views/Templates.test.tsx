import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@solidjs/testing-library";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { MemoryRouter, Route } from "@solidjs/router";
import { ShellProvider } from "../lib/shell";
import UndoToast from "../components/UndoToast";
import Templates from "./Templates";

// The reason for mockIPC rather than vi.mock is written in commands.test.ts
const DAILY = {
  filename: "daily.md",
  name: "daily",
  tags: ["daily"],
  preview: "Daily {{date}}",
};

interface SavedTemplate {
  filename: string;
  body: string;
  tags: string[];
}

const saved: SavedTemplate[] = [];
const deleted: string[] = [];

function mockCommands(): void {
  mockIPC((cmd, args) => {
    if (cmd === "list_templates") {
      return [DAILY];
    }
    if (cmd === "read_template") {
      return { body: "# Daily {{date}}\n\n## メモ", tags: ["daily"] };
    }
    if (cmd === "save_template") {
      saved.push(args as unknown as SavedTemplate);
      return;
    }
    if (cmd === "delete_template") {
      deleted.push((args as { filename: string }).filename);
      return;
    }
    throw new Error(`unexpected command ${cmd}`);
  });
}

// AppLayout draws the toast. The test should reach as far as reporting the discard, so it
// lines up the same pair
function renderTemplates() {
  return render(() => (
    <ShellProvider>
      <MemoryRouter>
        <Route path="/" component={Templates} />
      </MemoryRouter>
      <UndoToast />
    </ShellProvider>
  ));
}

/** Advance until the list has arrived and the first entry is open. */
async function openDaily() {
  const rendered = renderTemplates();
  await waitFor(() => expect(screen.getByText("daily")).toBeDefined());
  fireEvent.click(screen.getByText("daily"));
  await waitFor(() =>
    expect(screen.getByLabelText<HTMLInputElement>("タイトル").value).toBe("Daily {{date}}"),
  );
  return rendered;
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>("button", { name: "保存" });
}

function bodyInput(container: HTMLElement): HTMLTextAreaElement {
  const el = container.querySelector<HTMLTextAreaElement>(".templates-body-input");
  if (!el) {
    throw new Error("templates-body-input not found");
  }
  return el;
}

describe("Templates", () => {
  beforeEach(() => {
    saved.length = 0;
    deleted.length = 0;
    mockCommands();
  });

  afterEach(() => {
    clearMocks();
    cleanup();
    document.body.innerHTML = "";
  });

  it("lists what is on disk", async () => {
    renderTemplates();

    await waitFor(() => expect(screen.getByText("daily")).toBeDefined());
    expect(screen.getByText("Daily {{date}}")).toBeDefined();
  });

  // The edit screen shows it exactly as written. If the variables were resolved here, an
  // intended correction would write a fixed date in
  it("shows the body with its variables unresolved", async () => {
    const { container } = await openDaily();

    expect(bodyInput(container).value).toBe("## メモ");
    expect(screen.getByLabelText<HTMLInputElement>("タイトル").value).toBe("Daily {{date}}");
  });

  it("puts a variable where the cursor is", async () => {
    const { container } = await openDaily();
    const body = bodyInput(container);
    body.setSelectionRange(2, 2);

    fireEvent.click(screen.getByText("日付"));

    await waitFor(() => expect(body.value).toBe("##{{date}} メモ"));
  });

  // A variable goes into the field touched last. Dropping into the body while the title is
  // being typed would leave no way to put a variable in the title
  it("puts a variable into the title while the title has the focus", async () => {
    await openDaily();
    const title = screen.getByLabelText<HTMLInputElement>("タイトル");
    fireEvent.focus(title);
    title.setSelectionRange(0, 0);

    fireEvent.click(screen.getByText("日付"));

    await waitFor(() => expect(title.value).toBe("{{date}}Daily {{date}}"));
  });

  it("puts a variable into the tag field while the tag field has the focus", async () => {
    const { container } = await openDaily();
    const tagInput = screen.getByLabelText<HTMLInputElement>("タグを追加");
    fireEvent.focus(tagInput);

    fireEvent.click(screen.getByText("日付"));

    await waitFor(() => expect(tagInput.value).toBe("{{date}}"));
    expect(bodyInput(container).value).toBe("## メモ");
  });

  // Come back to the body and the insertion target returns to the body too
  it("goes back to the body once the body has the focus again", async () => {
    const { container } = await openDaily();
    const body = bodyInput(container);
    fireEvent.focus(screen.getByLabelText("タイトル"));
    fireEvent.focus(body);
    body.setSelectionRange(2, 2);

    fireEvent.click(screen.getByText("日付"));

    await waitFor(() => expect(body.value).toBe("##{{date}} メモ"));
  });

  // "This is what it becomes made today". Whether a variable is written right is seen here
  it("previews the title as it will be written today", async () => {
    const { container } = await openDaily();
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    const preview = container.querySelector(".templates-preview");

    expect(preview?.textContent).toContain(`Daily ${today}`);
  });

  // Without seeing the body too, there is no way to check that a line with a variable comes out as intended
  it("previews the body once the preview is opened", async () => {
    const { container } = await openDaily();
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

    fireEvent.input(bodyInput(container), { target: { value: "## {{date}} のメモ" } });
    fireEvent.click(container.querySelector(".templates-preview-summary") as HTMLElement);

    const body = container.querySelector(".templates-preview-body");
    await waitFor(() => expect(body?.textContent).toContain(`## ${today} のメモ`));
  });

  // The example block is not written into a note. "Made today" is where the written shape is
  // shown, so leaving it here would read as something that does not go away
  it("keeps the example block out of the preview", async () => {
    const { container } = await openDaily();

    fireEvent.input(bodyInput(container), {
      target: { value: "## 状況\n{{eg}}\n- 何があったか?\n\n## 次" },
    });
    fireEvent.click(container.querySelector(".templates-preview-summary") as HTMLElement);

    const body = container.querySelector(".templates-preview-body");
    await waitFor(() => expect(body?.textContent).toContain("## 状況"));
    expect(body?.textContent).not.toContain("何があったか?");
    expect(body?.textContent).not.toContain("{{eg}}");
  });

  // The syntax can be typed by hand, but being typeable alone does not make it discoverable
  it("offers the example marker as a chip", async () => {
    const { container } = await openDaily();

    const chips = [...container.querySelectorAll(".templates-var-chip")].map(
      (chip) => chip.textContent,
    );

    expect(chips).toContain("{{eg}}記入例");
  });

  it("marks a tag that holds a variable apart from a fixed one", async () => {
    const { container } = await openDaily();
    const tagInput = screen.getByLabelText("タグを追加");

    fireEvent.input(tagInput, { target: { value: "{{date:YYYY-MM}}" } });
    fireEvent.keyDown(tagInput, { key: "Enter" });

    await waitFor(() =>
      expect(container.querySelectorAll(".templates-tags .tag-badge--var")).toHaveLength(1),
    );
    // The fixed tag keeps its solid border
    expect(container.querySelectorAll(".templates-tags .tag-badge")).toHaveLength(2);
  });

  // If the Enter that confirms a conversion added a tag, a kanji tag could never be finished (#102)
  it("does not add a tag while the IME is composing", async () => {
    const { container } = await openDaily();
    const tagInput = screen.getByLabelText("タグを追加");

    fireEvent.input(tagInput, { target: { value: "打ち合わせ" } });
    fireEvent.keyDown(tagInput, { key: "Enter", isComposing: true });

    expect(container.querySelectorAll(".templates-tags .tag-badge")).toHaveLength(1);
  });

  // Saving under the same name would silently overwrite the template that already exists
  it("refuses to save a new template onto an existing name", async () => {
    renderTemplates();
    await waitFor(() => expect(screen.getByText("daily")).toBeDefined());

    fireEvent.click(screen.getByText("新規"));
    fireEvent.input(screen.getByLabelText("テンプレート名"), { target: { value: "daily" } });

    await waitFor(() => expect(screen.getByText("同じ名前のテンプレートがあります")).toBeDefined());
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(saveButton());
    expect(saved).toHaveLength(0);
  });

  // Nothing can be saved until the name is settled. Take the user there first
  it("puts the cursor in the name field when a new template starts", async () => {
    renderTemplates();
    await waitFor(() => expect(screen.getByText("daily")).toBeDefined());

    fireEvent.click(screen.getByText("新規"));

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("テンプレート名")),
    );
  });

  it("writes a new template under the name that was typed", async () => {
    renderTemplates();
    await waitFor(() => expect(screen.getByText("daily")).toBeDefined());

    fireEvent.click(screen.getByText("新規"));
    fireEvent.input(screen.getByLabelText("テンプレート名"), { target: { value: "weekly" } });
    fireEvent.input(screen.getByLabelText("タイトル"), { target: { value: "週次 {{date}}" } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].filename).toBe("weekly.md");
    // What is saved is exactly what was written. Resolving is the job of the core that makes the note
    expect(saved[0].body).toBe("# 週次 {{date}}\n");
  });

  // A template left half-written breaks the notes made from it as well. A shape that is
  // still being typed never goes out to disk
  it("writes nothing until save is pressed", async () => {
    const { container } = await openDaily();

    fireEvent.input(bodyInput(container), { target: { value: "書きかけ" } });

    expect(saved).toHaveLength(0);
    expect(saveButton().disabled).toBe(false);
  });

  it("has nothing to save until something changes", async () => {
    await openDaily();

    expect(saveButton().disabled).toBe(true);
  });

  it("goes back to having nothing to save right after a save", async () => {
    const { container } = await openDaily();

    fireEvent.input(bodyInput(container), { target: { value: "直した" } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(saved).toHaveLength(1));
    await waitFor(() => expect(saveButton().disabled).toBe(true));
  });

  it("saves on ⌘S while the body is being written", async () => {
    const { container } = await openDaily();

    fireEvent.input(bodyInput(container), { target: { value: "直した" } });
    fireEvent.keyDown(bodyInput(container), { key: "s", metaKey: true });

    await waitFor(() => expect(saved).toHaveLength(1));
  });

  // ⌘⇧S is the app-wide "sync now". If a save ran here too, one press meant as a sync would
  // send half-written text out to disk
  it("leaves ⌘⇧S to the sync shortcut", async () => {
    const { container } = await openDaily();

    fireEvent.input(bodyInput(container), { target: { value: "書きかけ" } });
    fireEvent.keyDown(bodyInput(container), { key: "S", metaKey: true, shiftKey: true });

    expect(saved).toHaveLength(0);
  });

  // Unsaved changes go when leaving. The discard is reported, and a way back is left open
  it("discards unsaved changes on the way back, and can put them back", async () => {
    const { container } = await openDaily();
    fireEvent.input(bodyInput(container), { target: { value: "書きかけ" } });

    fireEvent.click(screen.getByLabelText("一覧に戻る"));

    await waitFor(() => expect(screen.getByText("保存していない変更を破棄しました")).toBeDefined());
    expect(saved).toHaveLength(0);

    fireEvent.click(screen.getByText("元に戻す"));

    await waitFor(() => expect(bodyInput(container).value).toBe("書きかけ"));
  });

  it("says nothing when leaving a template it did not change", async () => {
    await openDaily();

    fireEvent.click(screen.getByLabelText("一覧に戻る"));

    expect(screen.queryByText("保存していない変更を破棄しました")).toBeNull();
  });
});
