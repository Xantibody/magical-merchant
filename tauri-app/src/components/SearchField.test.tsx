import { describe, it, expect, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup, screen, waitFor } from "@solidjs/testing-library";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import SearchField from "./SearchField";
import type { SearchFieldCommand } from "./SearchField";
import type { SearchHit } from "../lib/commands";

function hit(title: string, change: Partial<SearchHit> = {}): SearchHit {
  return {
    kind: "note",
    title,
    snippet: title,
    date: "2026-09-01",
    filename: `${title}.md`,
    index: null,
    tags: [],
    match_start: null,
    match_len: null,
    ...change,
  };
}

interface Search {
  query: string;
  tags: string[];
  filter: { kind: string | null; from: string | null; to: string | null };
}

function renderField(hits: SearchHit[], tags: string[] = [], commands: SearchFieldCommand[] = []) {
  const searches: Search[] = [];
  mockIPC((cmd, args) => {
    if (cmd === "search_records") {
      searches.push(args as unknown as Search);
      return hits;
    }
    return cmd === "browse_all" ? hits : [];
  });
  const onOpen = vi.fn<(hit: SearchHit) => void>();
  const onClose = vi.fn<() => void>();
  render(() => (
    <SearchField seed={{ tags }} commands={commands} onOpen={onOpen} onClose={onClose} />
  ));
  const input = screen.getByRole<HTMLInputElement>("searchbox");
  return { searches, onOpen, onClose, input };
}

function typed(input: HTMLInputElement, value: string): void {
  fireEvent.input(input, { target: { value } });
}

describe("SearchField", () => {
  afterEach(() => {
    cleanup();
    clearMocks();
  });

  it("takes the keys the moment it opens", () => {
    const { input } = renderField([]);

    expect(document.activeElement).toBe(input);
  });

  it("opens on the newest records and the chips, without searching", async () => {
    const { searches } = renderField([hit("買い物")]);

    await screen.findByText("買い物");
    expect(screen.queryByRole("group", { name: "種類" })).not.toBeNull();
    expect(searches).toHaveLength(0);
  });

  it("stops the newest records at twenty", async () => {
    const many = Array.from({ length: 25 }, (_, i) => hit(`記録${String(i)}`));
    renderField(many);

    await screen.findByText("記録19");
    expect(screen.queryByText("記録20")).toBeNull();
  });

  it("says nothing is found only when something was asked", async () => {
    const { input } = renderField([]);

    await waitFor(() => expect(screen.queryByText(/見つかりません/u)).toBeNull());
    typed(input, "ない");

    await screen.findByText(/見つかりません/u);
  });

  // WKWebView gives a button no focus on click, so the field would see focus go nowhere and
  // close under the pointer before the click arrived
  it("keeps the focus when a chip is pressed with the mouse", () => {
    renderField([]);

    const notPrevented = fireEvent.mouseDown(screen.getByRole("button", { name: "Note" }));

    expect(notPrevented).toBe(false);
  });

  it("lists on its own once a word is typed, and brings the chips", async () => {
    const { input } = renderField([hit("買い物")]);

    typed(input, "kai");

    await screen.findByText("買い物");
    expect(screen.queryByRole("button", { name: "今週" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Codex" })).not.toBeNull();
  });

  it("opens with the tag it was given", async () => {
    const { searches } = renderField([hit("買い物")], ["sync"]);

    await screen.findByText("買い物");
    expect(searches[0]?.tags).toStrictEqual(["sync"]);
  });

  it("narrows by the chips, and a chip pressed again lets go", async () => {
    const { searches } = renderField([hit("買い物")], ["sync"]);
    await screen.findByText("買い物");

    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    fireEvent.click(screen.getByRole("button", { name: "今日" }));
    await waitFor(() => {
      expect(searches.at(-1)?.filter.kind).toBe("codex");
      expect(searches.at(-1)?.filter.from).not.toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: "今日" }));
    fireEvent.click(screen.getByRole("button", { name: "すべて" }));

    await waitFor(() => {
      expect(searches.at(-1)?.filter).toStrictEqual({ kind: null, from: null, to: null });
    });
  });

  // The chip stays a condition: the field does not fold around a choice still on
  it("keeps the list when the word goes but a chip is still on", async () => {
    const { input } = renderField([hit("買い物")]);
    typed(input, "kai");
    await screen.findByText("買い物");
    fireEvent.click(screen.getByRole("button", { name: "Note" }));

    typed(input, "");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Note" }).getAttribute("aria-pressed")).toBe(
        "true",
      );
    });
    expect(screen.queryByText("買い物")).not.toBeNull();
  });

  it("removes the last tag on Backspace in an empty field", async () => {
    const { input, searches } = renderField([hit("買い物")], ["sync", "sf6"]);
    await screen.findByText("買い物");

    fireEvent.keyDown(input, { key: "Backspace" });

    await waitFor(() => {
      expect(searches.at(-1)?.tags).toStrictEqual(["sync"]);
    });
  });

  it("says what to do when nothing is found", async () => {
    const { input } = renderField([]);

    typed(input, "ない");

    await expect(
      screen.findByText("見つかりません。条件を一つ外してみてください。"),
    ).resolves.toBeInstanceOf(HTMLElement);
  });

  it("says the list stopped at the cap", async () => {
    const many = Array.from({ length: 100 }, (_, i) => hit(`行 ${String(i)}`));
    const { input } = renderField(many);

    typed(input, "gyo");

    await expect(screen.findByText("100 件まで")).resolves.toBeInstanceOf(HTMLElement);
  });

  it("opens the record that is pressed", async () => {
    const found = hit("買い物");
    const { input, onOpen } = renderField([found]);
    typed(input, "kai");

    fireEvent.click(await screen.findByRole("button", { name: /買い物/u }));

    expect(onOpen).toHaveBeenCalledExactlyOnceWith(found);
  });

  it("opens with Enter, and the arrows move the choice", async () => {
    const second = hit("二つ目");
    const { input, onOpen } = renderField([hit("一つ目"), second]);
    typed(input, "ord");
    await waitFor(() => expect(document.querySelector(".palette-count")).not.toBeNull());

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onOpen).toHaveBeenCalledExactlyOnceWith(second);
  });

  // The Enter that confirms a conversion is the IME's, and so are the arrows choosing one (#102)
  it.each([{ isComposing: true }, { keyCode: 229 }])(
    "leaves the keys to the IME: %o",
    async (ime) => {
      const { input, onOpen, onClose } = renderField([hit("一つ目"), hit("二つ目")]);
      typed(input, "ord");
      await screen.findByText("二つ目");

      fireEvent.keyDown(input, { key: "ArrowDown", ...ime });
      fireEvent.keyDown(input, { key: "Enter", ...ime });
      fireEvent.keyDown(input, { key: "Escape", ...ime });

      expect(onOpen).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    },
  );

  it("closes on Esc", () => {
    const { input, onClose } = renderField([]);

    fireEvent.keyDown(input, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("gives the keys back to what had them", () => {
    const before = document.createElement("textarea");
    document.body.append(before);
    before.focus();
    const { input } = renderField([]);

    fireEvent.keyDown(input, { key: "Escape" });

    expect(document.activeElement).toBe(before);
    before.remove();
  });

  describe("commands", () => {
    const settings: SearchFieldCommand = {
      id: "go-settings",
      label: "設定を開く",
      icon: "gear",
      shortcut: "⌘,",
      run: vi.fn<() => void>(),
    };

    afterEach(() => vi.mocked(settings.run).mockClear());

    it("offers a command whose name matches the word", async () => {
      const { input, onClose } = renderField([], [], [settings]);
      typed(input, "設定");

      fireEvent.click(await screen.findByRole("button", { name: /設定を開く/u }));

      expect(settings.run).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    // Enter is for the record found. A word that happens to name a command must not run it
    it("keeps Enter on the first record when both match", async () => {
      const found = hit("週次の件");
      const { input, onOpen } = renderField([found], [], [settings]);
      typed(input, "設定");
      await waitFor(() => expect(document.querySelector(".palette-count")).not.toBeNull());

      fireEvent.keyDown(input, { key: "Enter" });

      expect(onOpen).toHaveBeenCalledExactlyOnceWith(found);
      expect(settings.run).not.toHaveBeenCalled();
    });

    it("runs nothing on an Enter that outran the search", async () => {
      const { input, onOpen } = renderField([hit("週次の件")], [], [settings]);
      typed(input, "設定");

      fireEvent.keyDown(input, { key: "Enter" });

      expect(settings.run).not.toHaveBeenCalled();
      expect(onOpen).not.toHaveBeenCalled();
      await screen.findByText("週次の件");
    });

    it("does not offer commands once a chip narrows the search", async () => {
      renderField([hit("週次の件")], ["sync"], [settings]);

      await screen.findByText("週次の件");

      expect(screen.queryByText("設定を開く")).toBeNull();
    });
  });
});
