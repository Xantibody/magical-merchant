import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readVimEnabled, writeVimEnabled } from "./vim-setting";

describe("vim setting", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("is off until someone turns it on", () => {
    expect(readVimEnabled()).toBe(false);
  });

  it("remembers being turned on", () => {
    writeVimEnabled(true);
    expect(readVimEnabled()).toBe(true);
  });

  it("remembers being turned off again", () => {
    writeVimEnabled(true);
    writeVimEnabled(false);
    expect(readVimEnabled()).toBe(false);
  });
});
