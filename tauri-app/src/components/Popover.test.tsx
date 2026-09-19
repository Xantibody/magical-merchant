import { describe, it, expect, afterEach } from "vitest";
import { createSignal } from "solid-js";
import { render, screen, fireEvent, cleanup } from "@solidjs/testing-library";
import Popover from "./Popover";

/**
 * 開閉の始末は開く場所の隣に置く。以前は AppLayout の 1 つの `pointerdown` が
 * 全部を閉じていて、除外する class の表を足し忘れると「開いた直後に自分の
 * ボタンのぶんで畳まれる」が起きた。
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

  // 自分のボタンのぶんで閉じてしまうと、押した直後の click が開け直して
  // しまい、同じボタンでは畳めなくなる
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
