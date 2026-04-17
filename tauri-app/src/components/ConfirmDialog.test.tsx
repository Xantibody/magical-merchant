import { render, cleanup } from "@solidjs/testing-library";
import { page, userEvent } from "vitest/browser";
import { describe, it, expect, vi, afterEach } from "vitest";
import ConfirmDialog from "./ConfirmDialog";

describe("ConfirmDialog", () => {
  afterEach(() => cleanup());

  it("opens the dialog when open is true", async () => {
    const { baseElement } = render(() => (
      <ConfirmDialog
        open={true}
        title="削除確認"
        message="本当に削除しますか？"
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    ));

    const dialog = baseElement.querySelector("dialog") as HTMLDialogElement;
    expect(dialog.open).toBe(true);
  });

  it("does not show modal when open is false", async () => {
    const { baseElement } = render(() => (
      <ConfirmDialog
        open={false}
        title="削除確認"
        message="本当に削除しますか？"
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    ));

    const dialog = baseElement.querySelector("dialog") as HTMLDialogElement;
    expect(dialog.open).toBe(false);
  });

  it("calls onConfirm when delete button is clicked", async () => {
    const onConfirm = vi.fn();
    const { baseElement } = render(() => (
      <ConfirmDialog
        open={true}
        title="テスト"
        message="test"
        onConfirm={onConfirm}
        onCancel={() => {}}
      />
    ));
    const screen = page.elementLocator(baseElement);

    await userEvent.click(screen.getByRole("button", { name: "削除" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("calls onCancel when cancel button is clicked", async () => {
    const onCancel = vi.fn();
    const { baseElement } = render(() => (
      <ConfirmDialog
        open={true}
        title="テスト"
        message="test"
        onConfirm={() => {}}
        onCancel={onCancel}
      />
    ));
    const screen = page.elementLocator(baseElement);

    await userEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
