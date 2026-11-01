import { describe, it, expect, vi } from "vitest";
import { commandRows, shellCommands } from "./shell-commands";
import { ROUTES } from "./routes";
import { shortcutLabel } from "./shortcuts";

function table() {
  const went: string[] = [];
  const deps = {
    newNote: vi.fn<() => void>(),
    go: (path: string) => () => went.push(path),
    syncNow: vi.fn<() => void>(),
  };
  return { commands: shellCommands(deps), deps, went };
}

describe("shellCommands", () => {
  // The seven global commands, and only those: what `?` lists and what the docs promise
  it("lists the seven global commands in the palette's order", () => {
    const { commands } = table();

    expect(commands.map((c) => c.id)).toStrictEqual([
      "new-note",
      "go-scrawl",
      "go-notes",
      "go-codex",
      "go-browse",
      "sync-now",
      "go-settings",
    ]);
  });

  it("marks the rows that go somewhere as places", () => {
    const { commands } = table();

    expect(commands.filter((c) => c.place).map((c) => c.id)).toStrictEqual([
      "go-scrawl",
      "go-notes",
      "go-codex",
      "go-browse",
      "go-settings",
    ]);
  });

  it("runs the dependency each row stands for", () => {
    const { commands, deps, went } = table();

    for (const command of commands) {
      command.run();
    }

    expect(deps.newNote).toHaveBeenCalledTimes(1);
    expect(deps.syncNow).toHaveBeenCalledTimes(1);
    expect(went).toStrictEqual([
      ROUTES.SCRAWL,
      ROUTES.NOTES,
      ROUTES.CODEX,
      ROUTES.BROWSE,
      ROUTES.SETTINGS,
    ]);
  });
});

describe("commandRows", () => {
  it("spells the key out for the palette and the search field", () => {
    const { commands } = table();

    const rows = commandRows(commands);

    expect(rows.map((r) => r.id)).toStrictEqual(commands.map((c) => c.id));
    expect(rows[0].shortcut).toBe(shortcutLabel("newNote"));
  });
});
