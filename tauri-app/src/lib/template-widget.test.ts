import { afterEach, describe, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { canPinTemplateWidget, pinTemplateWidget } from "./template-widget";

describe("template widget", () => {
  afterEach(() => {
    clearMocks();
  });

  it("offers the button when the launcher can pin", async () => {
    mockIPC((cmd) => cmd === "template_widget_pinnable");
    await expect(canPinTemplateWidget()).resolves.toBe(true);
  });

  // The entry is an extra; a failing check must hide it rather than break the menu
  it("hides the button when the check fails", async () => {
    mockIPC(() => {
      throw new Error("no widgets here");
    });
    await expect(canPinTemplateWidget()).resolves.toBe(false);
  });

  it("names the template by its filename", async () => {
    const calls: unknown[] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      return true;
    });
    await expect(pinTemplateWidget("daily.md")).resolves.toBe(true);
    expect(calls).toStrictEqual([["pin_template_widget", { filename: "daily.md" }]]);
  });
});
