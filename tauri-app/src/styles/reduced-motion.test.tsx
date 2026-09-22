import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import NoteMenu from "../components/NoteMenu";
import Popover from "../components/Popover";

function element(root: ParentNode, selector: string): HTMLElement {
  const found = root.querySelector<HTMLElement>(selector);
  if (!found) {
    throw new Error(`expected ${selector} to be mounted`);
  }
  return found;
}

async function motion(value: "reduce" | "no-preference"): Promise<void> {
  await cdp().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value }],
  });
  expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(value === "reduce");
}

describe("reduced motion in the browser", () => {
  beforeAll(async () => {
    await import("../index.css");
    await import("./workspace.css");
    await page.viewport(1280, 800);
  });

  afterEach(async () => {
    cleanup();
    document.body.innerHTML = "";
    await motion("no-preference");
  });

  it("stops animations and transitions, including the switch thumb", async () => {
    await motion("no-preference");
    const { container } = render(() => (
      <>
        <div class="palette">Search</div>
        <div class="list-pane list-pane--open">Notes</div>
        <span class="switch" />
      </>
    ));
    const palette = element(container, ".palette");
    const list = element(container, ".list-pane");
    const toggle = element(container, ".switch");
    const moving = [
      () => getComputedStyle(palette).animationDuration,
      () => getComputedStyle(list).transitionDuration,
      () => getComputedStyle(toggle, "::after").transitionDuration,
    ];
    for (const duration of moving) {
      expect(
        duration()
          .split(",")
          .some((part) => Number.parseFloat(part) > 0),
      ).toBe(true);
    }

    await motion("reduce");

    for (const duration of moving) {
      expect(
        duration()
          .split(",")
          .every((part) => Number.parseFloat(part) === 0),
      ).toBe(true);
    }
  });

  it("runs a note menu action, closes, and can reopen and close with Escape", async () => {
    await motion("reduce");
    const [open, setOpen] = createSignal(false);
    const onInfo = vi.fn<() => void>();
    render(() => (
      <NoteMenu
        open={open()}
        onOpenChange={setOpen}
        kind="note"
        mapOpen={false}
        readOnly={false}
        hasExamples={false}
        examplesShown={false}
        revertable={false}
        onToggleMap={vi.fn<() => void>()}
        onToggleReadOnly={vi.fn<() => void>()}
        onToggleExamples={vi.fn<() => void>()}
        onRevert={vi.fn<() => void>()}
        onInfo={onInfo}
        onPromote={vi.fn<() => void>()}
        onCommit={vi.fn<() => void>()}
        onHistory={vi.fn<() => void>()}
        onDelete={vi.fn<() => void>()}
      />
    ));
    const trigger = screen.getByRole("button", { name: "この Note の操作" });
    await userEvent.click(trigger);
    const menu = await screen.findByRole("menu");
    expect(getComputedStyle(menu).animationDuration).toBe("0s");
    await userEvent.click(screen.getByRole("menuitem", { name: /Note 情報/u }));
    expect(onInfo).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("menu", { hidden: true })).toBeNull());

    await userEvent.click(trigger);
    await screen.findByRole("menu");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu", { hidden: true })).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it("unmounts a popover on an outside press and opens it again", async () => {
    await motion("reduce");
    const [open, setOpen] = createSignal(false);
    render(() => (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open
        </button>
        <button type="button">Outside</button>
        <Popover open={open()} onClose={() => setOpen(false)} label="Sync">
          <div class="popover">Sync status</div>
        </Popover>
      </>
    ));
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    await screen.findByRole("dialog", { name: "Sync" });
    await userEvent.click(screen.getByRole("button", { name: "Outside" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { hidden: true })).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    await screen.findByRole("dialog", { name: "Sync" });
  });
});
