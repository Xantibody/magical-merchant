import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@solidjs/testing-library";
import { cdp, page } from "vitest/browser";
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { createSignal, Show } from "solid-js";
import type { Setter } from "solid-js";
import PlaceSwitch from "./PlaceSwitch";
import { ringChoices } from "../lib/ring";
import type { RingChoice } from "../lib/ring";
import { ShellProvider, useShell } from "../lib/shell";
import type { Shell } from "../lib/shell";

interface Mounted {
  history: ReturnType<typeof createMemoryHistory>;
  shell: () => Shell | undefined;
  jots: () => number;
}

/** A petal whose work is not under test. */
function none(): void {
  // What the app wires to it (AppLayout) is tested there
}

/** The ring's petals with only the line counted. */
function petals(onJot: () => void): RingChoice[] {
  return ringChoices({ jot: onJot, note: none, codex: none, template: none });
}

function mount(at: string): Mounted {
  const history = createMemoryHistory();
  history.set({ value: at });
  let held: Shell | undefined;
  let jots = 0;
  render(() => (
    <ShellProvider>
      <MemoryRouter history={history}>
        <Route
          path="*"
          component={() => {
            held = useShell();
            return <PlaceSwitch choices={petals(() => (jots += 1))} />;
          }}
        />
      </MemoryRouter>
    </ShellProvider>
  ));
  return { history, shell: () => held, jots: () => jots };
}

function pause(ms: number): Promise<void> {
  // oxlint-disable-next-line promise/avoid-new
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The centre of an element, where a finger lands on it. */
function centre(el: Element): { clientX: number; clientY: number } {
  const box = el.getBoundingClientRect();
  return { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
}

/**
 * A finger held on a place until the ring blooms, then slid to `to` (still on the glass) and
 * lifted there, the way a phone sends it. The pointer is captured, so every move goes to the
 * button it landed on.
 */
async function holdAndSlide(
  button: HTMLElement,
  to: () => { clientX: number; clientY: number },
): Promise<void> {
  const base = { pointerType: "touch", bubbles: true, pointerId: 3, button: 0 };
  button.dispatchEvent(new PointerEvent("pointerdown", { ...base, ...centre(button) }));
  await pause(420);
  const end = to();
  button.dispatchEvent(new PointerEvent("pointermove", { ...base, ...end }));
  button.dispatchEvent(new PointerEvent("pointerup", { ...base, ...end }));
  fireEvent.click(button);
}

function element(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (!found) {
    throw new Error(`expected ${selector} to be mounted`);
  }
  return found;
}

describe("PlaceSwitch", () => {
  afterEach(() => {
    cleanup();
  });

  // R1: from Scrawl, Note is one tap away
  it("goes to another surface in one tap", async () => {
    const { history } = mount("/");

    fireEvent.click(screen.getByRole("button", { name: /^Note/u }));

    await waitFor(() => expect(history.get()).toBe("/notes"));
  });

  it("marks where you are", () => {
    mount("/codex");

    expect(screen.getByRole("button", { name: /^Codex/u }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(
      screen.getByRole("button", { name: /^Scrawl/u }).getAttribute("aria-current"),
    ).toBeNull();
  });

  // 93: a writer's machine returns to its draft. The list is a held press away
  it("goes straight back to the note last open on that surface", async () => {
    const { history, shell } = mount("/");
    shell()?.setLastNote("codex", "20260812_140000.md");

    fireEvent.click(screen.getByRole("button", { name: /^Codex/u }));

    await waitFor(() => expect(history.get()).toBe("/codex?file=20260812_140000.md"));
  });

  // 93's hold, folded into the ring: held, then slid along the pill onto a place, its list
  it("goes to a place's list when held and slid onto it", async () => {
    const { history, shell } = mount("/");
    shell()?.setLastNote("note", "20260811_100000.md");
    const scrawl = screen.getByRole("button", { name: /^Scrawl/u });
    const note = screen.getByRole("button", { name: /^Note/u });

    await holdAndSlide(scrawl, () => centre(note));

    await waitFor(() => expect(history.get()).toBe("/notes"));
  });

  // 68: held from another screen, the ring's first petal is a line over it; the screen stays
  it("opens a line for Scrawl from the ring's first petal", async () => {
    const { history, jots } = mount("/notes");
    const scrawl = screen.getByRole("button", { name: /^Scrawl/u });

    // Where the ring laid the petal (its style), whether or not a stylesheet draws it there
    await holdAndSlide(scrawl, () => {
      const petal = screen.getByRole("menuitem", { name: /Scrawl に 1 行/u });
      return {
        clientX: Number.parseFloat(petal.style.left),
        clientY: Number.parseFloat(petal.style.top),
      };
    });

    expect(jots()).toBe(1);
    expect(history.get()).toBe("/notes");
  });

  // A press let go where it was pressed leaves the ring standing; it is not also a tap
  it("leaves the ring standing for a tap when the held press is let go in place", async () => {
    const { history } = mount("/");
    const note = screen.getByRole("button", { name: /^Note/u });

    await holdAndSlide(note, () => centre(note));

    expect(screen.queryAllByRole("menu", { name: "ここから" })).toHaveLength(1);
    expect(history.get()).toBe("/");
  });

  // The list's query holds the open note; pressing the surface you are on must not drop it
  it("leaves the URL alone when the surface pressed is the one you are on", async () => {
    const { history } = mount("/notes?id=20260101_000000.md");

    fireEvent.click(screen.getByRole("button", { name: /^Note/u }));

    await waitFor(() => expect(history.get()).toBe("/notes?id=20260101_000000.md"));
  });

  // Scrawl's field is carried into the slot; a slot left behind would take it to a pill gone
  it("hands its slot over and takes it back when it goes", () => {
    const slots: (HTMLElement | undefined)[] = [];
    const [shown, setShown] = createSignal(true);
    const history = createMemoryHistory();
    render(() => (
      <ShellProvider>
        <MemoryRouter history={history}>
          <Route
            path="*"
            component={() => (
              <Show when={shown()}>
                <PlaceSwitch slot={(slot) => slots.push(slot)} choices={[]} />
              </Show>
            )}
          />
        </MemoryRouter>
      </ShellProvider>
    ));

    setShown(false);

    expect(slots).toHaveLength(2);
    expect(slots[0]?.classList.contains("place-switch-slot")).toBe(true);
    expect(slots[1]).toBeUndefined();
  });
});

/** The pill a phone sees, stretched or not as the signal says. */
function mountPill(): Setter<boolean> {
  const [stretched, setStretched] = createSignal(false);
  render(() => (
    <ShellProvider>
      <MemoryRouter>
        <Route path="*" component={() => <PlaceSwitch stretched={stretched()} choices={[]} />} />
      </MemoryRouter>
    </ShellProvider>
  ));
  return setStretched;
}

const moving = (selector: string): number =>
  element(selector)
    .getAnimations()
    .filter((animation) => animation.playState === "running").length;

async function motion(value: "reduce" | "no-preference"): Promise<void> {
  await cdp().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value }],
  });
}

describe("PlaceSwitch's stretch on a phone", () => {
  beforeAll(async () => {
    await import("../index.css");
    await page.viewport(390, 844);
  });

  afterEach(async () => {
    cleanup();
    await motion("no-preference");
  });

  afterAll(async () => {
    await page.viewport(1280, 800);
  });

  // The same element grows to the gutter, so the move between surfaces is seen as a stretch
  it("grows the ground from its old width and fades the field in", () => {
    const setStretched = mountPill();
    const compact = element(".place-switch").getBoundingClientRect().width;

    setStretched(true);

    expect(element(".place-switch").getBoundingClientRect().width).toBeGreaterThan(compact * 2);
    expect(moving(".place-switch-ground")).toBe(1);
    expect(moving(".place-switch-slot")).toBe(1);
  });

  it("shrinks back the same way when it leaves Scrawl", () => {
    const setStretched = mountPill();
    setStretched(true);
    for (const animation of document.getAnimations()) {
      animation.finish();
    }

    setStretched(false);

    expect(moving(".place-switch-ground")).toBe(1);
  });

  // Opening the app on Scrawl must not make the field wait for a show
  it("stands still where nothing changed", () => {
    mountPill();

    expect(moving(".place-switch-ground")).toBe(0);
    expect(moving(".place-switch-slot")).toBe(0);
  });

  it("jumps to the new shape where motion is turned down", async () => {
    await motion("reduce");
    const setStretched = mountPill();

    setStretched(true);

    expect(moving(".place-switch-ground")).toBe(0);
    expect(moving(".place-switch-slot")).toBe(0);
  });
});
