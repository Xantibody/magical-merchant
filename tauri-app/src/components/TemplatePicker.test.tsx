import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@solidjs/testing-library";
import TemplatePicker from "./TemplatePicker";
import type { Template } from "../lib/commands";

const TEMPLATES: Template[] = [
  {
    filename: "daily.md",
    name: "daily",
    tags: ["{{date:YYYY-MM}}", "daily"],
    preview: "Daily {{date}}",
  },
  { filename: "meeting.md", name: "meeting", tags: [], preview: "打ち合わせ" },
];

function renderPicker(templates: Template[] = TEMPLATES) {
  const onPickEmpty = vi.fn<() => void>();
  const onPick = vi.fn<(template: Template) => void>();
  const onManage = vi.fn<() => void>();
  const { container } = render(() => (
    <TemplatePicker
      templates={templates}
      onPickEmpty={onPickEmpty}
      onPick={onPick}
      onManage={onManage}
    />
  ));
  return { container, onPickEmpty, onPick, onManage };
}

describe("TemplatePicker", () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  it("lists every template by name", () => {
    renderPicker();

    expect(screen.getByText("daily")).toBeDefined();
    expect(screen.getByText("meeting")).toBeDefined();
  });

  // ここは押せば今すぐノートになる場所。知りたいのは「今日作ると何が付くか」で、
  // `{{date:YYYY-MM}}` のままでは何のタグか分からない
  it("resolves the leading tag so it reads as today's value", () => {
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const { container } = renderPicker();

    const badge = container.querySelector(".tag-badge");

    expect(badge?.textContent).toBe(`#${month}`);
  });

  it("hands back the template that was chosen", () => {
    const { onPick } = renderPicker();

    fireEvent.click(screen.getByText("daily"));

    expect(onPick).toHaveBeenCalledExactlyOnceWith(TEMPLATES[0]);
  });

  // タップで空のノートを作る道は、テンプレが増えても塞がない
  it("keeps the empty note as its own row", () => {
    const { onPickEmpty } = renderPicker();

    fireEvent.click(screen.getByText("空のノート"));

    expect(onPickEmpty).toHaveBeenCalledTimes(1);
  });

  it("offers the way to the management screen", () => {
    const { onManage } = renderPicker();

    fireEvent.click(screen.getByText("テンプレートを管理…"));

    expect(onManage).toHaveBeenCalledTimes(1);
  });

  // 1 件も無いうちから見出しだけ出ていると、壊れているように見える
  it("drops the section label when there is no template", () => {
    renderPicker([]);

    expect(screen.queryByText("テンプレートから")).toBeNull();
    expect(screen.getByText("空のノート")).toBeDefined();
  });
});
