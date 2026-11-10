import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";
import TagFilter from "./TagFilter";
import { setLocale } from "../lib/i18n";
import "../styles/tags.css";

function label(): HTMLElement {
  const { container } = render(() => (
    <TagFilter tags={[{ tag: "sf6", count: 3 }]} onPick={() => {}} />
  ));
  const found = container.querySelector<HTMLElement>(".tag-filter-label");
  if (!found) {
    throw new Error("the tag row has no label");
  }
  return found;
}

describe("TagFilter", () => {
  afterEach(() => {
    cleanup();
    setLocale("ja");
  });

  // The row was labelled "TAGS" in both languages, an English word on a Japanese screen
  it("labels the row in the reader's language", () => {
    expect(label().textContent).toBe("タグ");

    cleanup();
    setLocale("en");
    expect(label().textContent).toBe("Tags");
  });

  // The capitals were typed into the string. They are the stylesheet's to draw, so the
  // English row still reads TAGS and a screen reader says the word, not four letters
  it("leaves the capitals to the stylesheet", () => {
    expect(getComputedStyle(label()).textTransform).toBe("uppercase");
  });
});
