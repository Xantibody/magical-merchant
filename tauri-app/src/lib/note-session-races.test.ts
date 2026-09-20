import { describe, it, expect, vi, afterEach } from "vitest";
import { createNoteSession } from "./note-session";
import type { NoteContent } from "./note-view";

function deferred<T>() {
  return Promise.withResolvers<T>();
}
function fixture(brokenStore = false) {
  const a = { id: "a", filename: "a.md", title: "A" };
  const b = { id: "b", filename: "b.md", title: "B" };
  let selected = a;
  let body = "original";
  let epoch = 0;
  const backups = new Map<string, string>();
  const toasts: string[] = [];
  const write = vi
    .fn<(file: string, body: string, revision: string) => Promise<string>>()
    .mockResolvedValue("r-saved");
  const read = vi.fn<(file: string) => Promise<NoteContent>>().mockResolvedValue({
    body: "disk",
    view: "editor",
    revision: "r-disk",
  });
  const session = createNoteSession({
    selected: () => selected,
    loaded: () => true,
    body: () => body,
    bodyEpoch: () => epoch,
    bodyHasFocus: () => false,
    store: {
      getItem: (key) => backups.get(key) ?? null,
      setItem: (key, value) => {
        if (brokenStore) {
          throw new Error("quota");
        }
        backups.set(key, value);
      },
    },
    read,
    write,
    showBody: (_id, _title, value) => {
      body = value;
      epoch++;
    },
    refreshList: () => {},
    setStatus: () => {},
    onSaved: () => {},
    showToast: (text) => toasts.push(text),
  });
  session.setRevision(a.filename, "r-a");
  session.setRevision(b.filename, "r-b");
  return {
    a,
    b,
    session,
    write,
    read,
    backups,
    toasts,
    body: () => body,
    edit(value: string) {
      session.ensure();
      body = value;
      session.schedule();
    },
    select(item: typeof a) {
      session.drop();
      selected = item;
      body = "original";
      epoch++;
    },
  };
}

describe("pending saves and asynchronous reads", () => {
  afterEach(() => vi.useRealTimers());

  it("preserves an unsaved draft after an IO failure before navigation", async () => {
    vi.useFakeTimers();
    const h = fixture();
    h.write.mockRejectedValue({ kind: "io", message: "No space left on device" });
    h.edit("irreplaceable typed text");
    await vi.advanceTimersByTimeAsync(1000);
    await h.session.settleEdit();
    h.select(h.b);
    expect([...h.backups.values()]).toContain("irreplaceable typed text");
  });

  it("does not cancel B's autosave when A's save is stale", async () => {
    vi.useFakeTimers();
    const h = fixture();
    const first = deferred<string>();
    h.write.mockReturnValueOnce(first.promise);
    h.edit("A edit");
    await vi.advanceTimersByTimeAsync(1000);
    await h.session.settleEdit();
    h.select(h.b);
    h.edit("B edit");
    first.reject({ kind: "stale", message: "A changed externally" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.write).toHaveBeenCalledWith("b.md", "B edit", "r-b");
  });

  it("keeps the only copy of a stale draft when its backup fails", async () => {
    vi.useFakeTimers();
    const h = fixture(true);
    h.write.mockRejectedValue({ kind: "stale", message: "changed externally" });
    h.edit("only copy of my edit");
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.body()).toBe("only copy of my edit");
  });

  it("does not replace a newer read with an older read of the same note", async () => {
    const h = fixture();
    const old = deferred<NoteContent>();
    h.read.mockReturnValueOnce(old.promise);
    const older = h.session.reload(h.a, true);
    await h.session.reload(h.a, true);
    old.resolve({ body: "obsolete read", view: "editor", revision: "r-old" });
    await older;
    expect(h.body()).toBe("disk");
    expect(h.session.revisionOf(h.a.filename)).toBe("r-disk");
  });

  it("keeps B's save when it is already queued behind A's stale save", async () => {
    vi.useFakeTimers();
    const h = fixture();
    const first = deferred<string>();
    h.write.mockReturnValueOnce(first.promise);
    h.edit("A edit");
    await vi.advanceTimersByTimeAsync(1000);
    await h.session.settleEdit();
    h.select(h.b);
    h.edit("B edit");
    await vi.advanceTimersByTimeAsync(1000);
    first.reject({ kind: "stale", message: "A changed externally" });
    await h.session.settleWrites();
    expect(h.write).toHaveBeenCalledWith("b.md", "B edit", "r-b");
  });

  it("does not reload over edits while their save is in flight", async () => {
    vi.useFakeTimers();
    const h = fixture();
    const writing = deferred<string>();
    h.write.mockReturnValueOnce(writing.promise);
    h.edit("unsaved text");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(h.session.reload(h.a)).resolves.toBe(false);
    expect(h.body()).toBe("unsaved text");
    writing.resolve("r-saved");
    await h.session.settleWrites();
  });

  it("keeps a failed draft on screen during an automatic reload", async () => {
    vi.useFakeTimers();
    const h = fixture(true);
    h.write.mockRejectedValue({ kind: "io", message: "No space left on device" });
    h.edit("only copy");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(h.session.reload(h.a)).resolves.toBe(false);
    expect(h.body()).toBe("only copy");
    expect(h.toasts).toHaveLength(1);
  });

  it("keeps a failed draft protected after settling its editing session", async () => {
    vi.useFakeTimers();
    const h = fixture(true);
    h.write.mockRejectedValue({ kind: "stale", message: "changed externally" });
    h.edit("only copy");
    await h.session.settleEdit();
    await expect(h.session.reload(h.a)).resolves.toBe(false);
    expect(h.body()).toBe("only copy");
  });

  it("does not force a read over keystrokes entered after it started", async () => {
    vi.useFakeTimers();
    const h = fixture();
    const reading = deferred<NoteContent>();
    h.read.mockReturnValueOnce(reading.promise);
    const reloading = h.session.reload(h.a, true);
    h.edit("new keystrokes");
    reading.resolve({ body: "disk", view: "editor", revision: "r-new" });
    await expect(reloading).resolves.toBe(false);
    expect(h.body()).toBe("new keystrokes");
    expect(h.session.revisionOf(h.a.filename)).toBe("r-a");
    await vi.advanceTimersByTimeAsync(1000);
  });
});
