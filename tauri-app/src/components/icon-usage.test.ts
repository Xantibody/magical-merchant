import { describe, it, expect } from "vitest";

/**
 * Every icon in the table is drawn somewhere.
 *
 * Each entry of `ICONS` is a dynamic import, so an entry nobody renders still ships as a
 * chunk of its own, and knip does not look at object keys. Every place that picks an icon
 * writes its name as a string literal (directly or in a `Record<_, IconName>` table), so
 * reading the sources as text and looking for the quoted name is enough.
 */

const table = import.meta.glob("./Icon.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const sources = import.meta.glob(["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}", "!./Icon.tsx"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function iconNames(): string[] {
  const text = Object.values(table)[0] ?? "";
  return Array.from(
    text.matchAll(/^ {2}"?(?<name>[a-z-]+)"?: \(\) =>/gmu),
    (match) => match.groups?.name ?? "",
  );
}

describe("Icon table", () => {
  it("reads the names out of the table", () => {
    expect(iconNames()).toContain("push-pin-fill");
  });

  it("has no entry that no source names", () => {
    const code = Object.values(sources).join("\n");
    const unused = iconNames().filter((name) => !code.includes(`"${name}"`));
    expect(unused).toStrictEqual([]);
  });
});
