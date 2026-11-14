import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@solidjs/testing-library";
import { MemoryRouter, Route } from "@solidjs/router";
import Library from "./Library";
import { ShellProvider } from "../lib/shell";

function renderShelf(): void {
  render(() => (
    <ShellProvider>
      <MemoryRouter>
        <Route
          path="/"
          component={() => (
            <Library
              sync="idle"
              onOpenStatus={() => {}}
              onGo={() => {}}
              onSearch={() => {}}
              choices={[]}
            />
          )}
        />
      </MemoryRouter>
    </ShellProvider>
  ));
}

describe("Library", () => {
  afterEach(() => {
    cleanup();
  });

  // The shelf changes the place and nothing else: tags are Browse's, Templates and Settings
  // are in the empty search field, so none of them stands among the places
  it("lists the places and no tags, Templates or Settings", () => {
    renderShelf();
    const places = screen.getByRole("region", { name: "場所" });

    expect(places.querySelectorAll("button")).toHaveLength(4);
    expect(screen.queryByRole("button", { name: "タグ" })).toBeNull();
    expect(screen.queryByRole("button", { name: "テンプレート" })).toBeNull();
    expect(screen.queryByRole("button", { name: "設定" })).toBeNull();
  });
});
