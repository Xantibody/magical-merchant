import { describe, it, expect, afterEach } from "vitest";
import { createSignal } from "solid-js";
import { render, screen, fireEvent, cleanup } from "@solidjs/testing-library";
import Popover from "./Popover";

/**
 * Opening and closing are settled next to the place that opens. Before, one `pointerdown`
 * in AppLayout closed everything, and forgetting to add a class to the exclusion table
 * caused "it folds right after opening, on its own button".
 */
function mount() {
  const [open, setOpen] = createSignal(true);
  let trigger: HTMLButtonElement | undefined;
  render(() => (
    <>
      <button type="button" ref={trigger} onClick={() => setOpen((v) => !v)}>
        開く
      </button>
      <span>外側</span>
      <Popover
        open={open()}
        onClose={() => setOpen(false)}
        trigger={() => trigger}
        label="ためし"
        class="popover-anchor"
      >
        <div class="popover">中身</div>
      </Popover>
    </>
  ));
  return { open, trigger: (): HTMLButtonElement => screen.getByRole("button", { name: "開く" }) };
}

describe("Popover", () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  it("shows its children while it is open", () => {
    mount();

    expect(screen.getByText("中身")).toBeDefined();
  });

  it("closes itself when the pointer goes down outside", () => {
    mount();

    fireEvent.pointerDown(screen.getByText("外側"));

    expect(screen.queryByText("中身")).toBeNull();
  });

  // Closing on its own button lets the click right after the press reopen it, and then
  // the same button can never fold it
  it("leaves the button that opened it to do the closing", () => {
    const { trigger } = mount();

    fireEvent.pointerDown(trigger());

    expect(screen.getByText("中身")).toBeDefined();

    fireEvent.click(trigger());

    expect(screen.queryByText("中身")).toBeNull();
  });

  it("names the panel for a screen reader", () => {
    mount();

    expect(screen.getByRole("dialog", { name: "ためし" })).toBeDefined();
  });
});
