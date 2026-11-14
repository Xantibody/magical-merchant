import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";
import TagFilter from "./TagFilter";
import { setLocale } from "../lib/i18n";
import "../styles/tags.css";

/** The row's name. It has no label line of its own any more (S4); a reader gets the name. */
function rowName(): string | null {
  const { container } = render(() => (
    <TagFilter tags={[{ tag: "sf6", count: 3 }]} onPick={() => {}} />
  ));
  return container.querySelector<HTMLElement>("[role='group']")?.getAttribute("aria-label") ?? null;
}

describe("TagFilter", () => {
  afterEach(() => {
    cleanup();
    setLocale("ja");
  });

  // The row was labelled "TAGS" in both languages, an English word on a Japanese screen
  it("names the row in the reader's language", () => {
    expect(rowName()).toBe("タグ");

    cleanup();
    setLocale("en");
    expect(rowName()).toBe("Tags");
  });
});
