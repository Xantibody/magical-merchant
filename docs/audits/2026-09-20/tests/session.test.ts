import { it, expect, vi, afterEach } from "vitest";
import { createNoteSession } from "./note-session";
import type { NoteContent } from "./note-view";

afterEach(() => vi.useRealTimers());
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(brokenStore = false) {
  const a = { id: "a", filename: "a.md", title: "A" };
  const b = { id: "b", filename: "b.md", title: "B" };
  let selected = a;
  let body = "original";
  let epoch = 0;
  const backups = new Map<string, string>();
  const toasts: string[] = [];
  const write = vi.fn(async (_file: string, _body: string, _rev: string) => "r-saved");
  const read = vi.fn(
    async (_file: string): Promise<NoteContent> => ({
      body: "disk",
      view: "editor",
      revision: "r-disk",
    }),
  );
  const session = createNoteSession({
    selected: () => selected,
    loaded: () => true,
    body: () => body,
    bodyEpoch: () => epoch,
    bodyHasFocus: () => false,
    store: {
      getItem: (key) => backups.get(key) ?? null,
      setItem: (key, value) => {
        if (brokenStore) throw new Error("quota");
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

it("audit: an IO failure must preserve an unsaved draft before navigation", async () => {
  vi.useFakeTimers();
  const h = fixture();
  h.write.mockRejectedValue({ kind: "io", message: "No space left on device" });
  h.edit("irreplaceable typed text");
  await vi.advanceTimersByTimeAsync(1000);
  await h.session.settleEdit();
  h.select(h.b);
  expect([...h.backups.values()]).toContain("irreplaceable typed text");
});

it("audit: a stale save for A must not cancel B's autosave", async () => {
  vi.useFakeTimers();
  const h = fixture();
  const first = deferred<string>();
  h.write.mockImplementationOnce(() => first.promise);
  h.edit("A edit");
  await vi.advanceTimersByTimeAsync(1000);
  await h.session.settleEdit();
  h.select(h.b);
  h.edit("B edit");
  first.reject({ kind: "stale", message: "A changed externally" });
  await vi.advanceTimersByTimeAsync(2000);
  expect(h.write.mock.calls.some(([file, body]) => file === "b.md" && body === "B edit")).toBe(
    true,
  );
});

it("audit: a failed backup must not discard the only copy of a stale draft", async () => {
  vi.useFakeTimers();
  const h = fixture(true);
  h.write.mockRejectedValue({ kind: "stale", message: "changed externally" });
  h.edit("only copy of my edit");
  await vi.advanceTimersByTimeAsync(1000);
  expect(h.body()).toBe("only copy of my edit");
});

it("audit: an older read of the same note must not replace a newer read", async () => {
  const h = fixture();
  const old = deferred<NoteContent>();
  h.read.mockImplementationOnce(() => old.promise);
  const older = h.session.reload(h.a, true);
  await h.session.reload(h.a, true);
  old.resolve({ body: "obsolete read", view: "editor", revision: "r-old" });
  await older;
  expect(h.body()).toBe("disk");
});
