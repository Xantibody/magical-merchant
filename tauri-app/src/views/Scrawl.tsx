import {
  createSignal,
  createResource,
  createMemo,
  createEffect,
  on,
  For,
  Show,
  onCleanup,
} from "solid-js";
import type { JSX } from "solid-js";
import Icon from "../components/Icon";
import { Portal } from "solid-js/web";
import CaptureBar from "../components/CaptureBar";
import { createWide } from "../lib/media";
import CalendarPopover from "../components/CalendarPopover";
import Popover from "../components/Popover";
import TagFilter from "../components/TagFilter";
import ScrawlEntry from "../components/ScrawlEntry";
import ScrawlScrubber from "../components/ScrawlScrubber";
import HoldButton from "../components/HoldButton";
import PromoteDialog from "../components/PromoteDialog";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { typedInvoke } from "../lib/commands";
import { getClientContext } from "../lib/client-context";
import { useShell } from "../lib/shell";
import { formatDayHeading, toIsoDate } from "../lib/day-labels";
import { t } from "../lib/i18n";
import {
  keepUnchangedItems,
  notesByOrigin,
  originKeyOf,
  planBulkDelete,
  replaceDayItems,
  toNoteItems,
  toScrawlItems,
} from "../lib/items";
import type { NoteItem, ScrawlItem } from "../lib/items";
import { places } from "../lib/places";
import { MODE_LABELS, ROUTES } from "../lib/routes";
import { noteRoute, writeRoute } from "../lib/note-route";
import { scrawlDays } from "../lib/scrawl-days";
import { awayFromNewest } from "../lib/scrawl-scroll";
import { placeBesideTrigger } from "../lib/popover-place";
import type { ScrawlRow } from "../lib/scrawl-days";
import { countTags, parseTags } from "../lib/tags";
import {
  digestWeekKey,
  isDigestDismissed,
  summarizeWeek,
  yearAgoToday,
} from "../lib/weekly-digest";
import type { DeviceContext } from "../lib/parse-scrawl";

/** Days loaded into the list from the start. Days reached through the calendar are added as needed. */
const RECENT_DAYS = 14;

/** The week (Monday's date) whose weekly digest was dismissed. Display state local to the device. */
const DIGEST_DISMISS_KEY = "weekly-digest-dismissed";

/** How long a record just left keeps its dot green. The only save signal on the page. */
const FRESH_MS = 1500;

/** How long the line just sent can be taken back (36), like a sent mail's undo. */
const TAKE_BACK_MS = 5000;

/**
 * The calendar's height with six weeks and its foot line, the most it draws: what it needs
 * above a trigger to open there (`lib/popover-place.ts`). It is asked before the calendar mounts.
 */
const CALENDAR_HEIGHT_PX = 320;

interface ScrawlData {
  items: ScrawlItem[];
  /** Every date with a record (newest first). The digest's "a year ago today" check uses it. */
  dates: string[];
}

/**
 * Returns the recent days and the full date list as one value. Split into separate
 * resources, they would render in separate flushes, and the digest would cut into
 * the day list already shown and cause a layout shift.
 *
 * One call, not the date list and then a call per day: this is the first screen, and each
 * of those ran on the main thread one after another.
 */
async function loadScrawl(extraDates: string[]): Promise<ScrawlData> {
  const { dates, days } = await typedInvoke("read_scrawl_days", {
    recent: RECENT_DAYS,
    extra: extraDates,
  });
  return { items: days.flatMap((day) => toScrawlItems(day.date, day.entries)), dates };
}

/** A Note or a Codex among Scrawl's rows: a filled dot and its title, nothing more. */
function NoteRow(props: { note: NoteItem; onOpen: (note: NoteItem) => void }): JSX.Element {
  return (
    <article class="entry entry--note">
      <span class="entry-time">{props.note.time}</span>
      <span class="entry-rail" aria-hidden="true">
        <span class="entry-rail-line" />
        <span class="entry-rail-dot" />
      </span>
      <div class="entry-body">
        <button type="button" class="entry-note" onClick={() => props.onOpen(props.note)}>
          {props.note.title}
        </button>
      </div>
    </article>
  );
}

/** The field is below the days on both widths, at the foot under the thumb. */
function EmptyScrawl(): JSX.Element {
  return (
    <div class="scrawl-empty">
      <span class="scrawl-empty-rail" aria-hidden="true" />
      <div>
        <p class="scrawl-empty-title">{t().scrawl.emptyToday}</p>
        <p class="scrawl-empty-hint">{t().scrawl.emptyHintBelow}</p>
      </div>
    </div>
  );
}

export default function Scrawl(): JSX.Element {
  const shell = useShell();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const today = new Date();

  const [extraDates, setExtraDates] = createSignal<string[]>([]);
  /** The day chosen in the calendar that is about to be shown. Cleared once it is on screen. */
  const [jumpTo, setJumpTo] = createSignal<string | null>(null);
  /** Select mode. Only while in it can an entry body be selected by clicking. */
  const [selecting, setSelecting] = createSignal(false);
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  /** A delete in progress. The lock that keeps a double press from deleting the same row twice. */
  const [deleting, setDeleting] = createSignal(false);
  /** The record just left. Its dot stays green for a moment. */
  const [freshId, setFreshId] = createSignal<string | null>(null);
  /** The record opened by a tap: its full meta and its actions show. One at a time. */
  const [openId, setOpenId] = createSignal<string | null>(null);
  /** The record waiting on "Make a Note"'s confirmation. */
  const [promoting, setPromoting] = createSignal<ScrawlItem | null>(null);
  /** The line just sent, while it can still be taken back (36). */
  const [takeBackId, setTakeBackId] = createSignal<string | null>(null);
  /** A line taken back goes back into the field, to be fixed and sent again. */
  const [refill, setRefill] = createSignal<{ text: string } | null>(null);
  const wide = createWide();
  let scrollRef: HTMLDivElement | undefined;
  /** Scrolled far enough from the newest records that the way back is offered (S6). */
  const [away, setAway] = createSignal(false);
  /** Whether a line is being typed: the tags beside the field then add to it (71). */
  const [typing, setTyping] = createSignal(false);
  /** The tag pressed to join the line being typed. A new object each press, so a repeat lands. */
  const [addTag, setAddTag] = createSignal<{ tag: string } | null>(null);
  /** Folds the selection states at once. Leaving works the same from anywhere. */
  const exitSelecting = (): void => {
    setSelecting(false);
    setSelected(new Set<string>());
  };
  /**
   * Folds the selection before the list is reread. A selection points at a row by
   * `date#index`, so if a reread adds a row earlier in the same day, that index
   * points at the neighbouring record. Reselecting is a few more taps; a wrong
   * deletion cannot be undone.
   */
  const dropSelectionForReload = (): void => {
    if (!selecting()) {
      return;
    }
    exitSelecting();
    shell.showToast(t().scrawl.selectionCleared);
  };

  const [scrawl, { refetch, mutate }] = createResource(extraDates, loadScrawl);
  // Used for the promoted-note chips. Scrawl's render does not wait for it: the
  // chips alone appear later, once the note list arrives
  const [notes, { refetch: refetchNotes }] = createResource(async () =>
    toNoteItems(await typedInvoke("list_notes")),
  );

  // The first read is done by createResource. Without defer, the same full read
  // would run once more right after mount, doubling the IPC at startup
  createEffect(
    on(
      shell.dataVersion,
      () => {
        // Fold the selection before the rows are replaced
        dropSelectionForReload();
        void refetch();
        void refetchNotes();
      },
      { defer: true },
    ),
  );

  // refetch is not the only trigger for a reread. extraDates is the resource's source,
  // so the calendar or "a year ago today" adding a day is enough to refetch the whole list.
  // The fold sits on the source, not inside the function that adds days, so a new
  // caller cannot leave a gap
  createEffect(on(extraDates, dropSelectionForReload, { defer: true }));

  // Both a one-day reread and a full refetch parse every line anew; the lines that read the
  // same keep their objects here, so their rows are not rebuilt
  const entries = createMemo<ScrawlItem[]>(
    (previous) => keepUnchangedItems(previous, scrawl()?.items ?? []),
    [],
  );
  // A place name is not part of the record, so the list does not wait for it. Rows
  // are laid out with coordinates first and swap to names as each one is resolved.
  createEffect(() => {
    void places.load(entries().map((item) => item.context));
  });
  const knownTags = createMemo(() => countTags(entries().map((item) => item.text)));

  const days = createMemo(() => scrawlDays(entries(), notes() ?? [], toIsoDate(today)));

  /** The calendar opens beside whichever control asked for it: the band's button, the scrubber. */
  const calendarPlace = createMemo(() => {
    if (shell.popover() !== "calendar") {
      return {};
    }
    return placeBesideTrigger(
      shell.popoverTrigger()?.getBoundingClientRect(),
      { width: globalThis.innerWidth, height: globalThis.innerHeight },
      CALENDAR_HEIGHT_PX,
    );
  });

  // Today's section is drawn apart from the past days: it is always there, with its heading,
  // the way into select mode and the empty state, even before it has a row. It follows the
  // newest day, so a capture past midnight still lands in it
  const currentDay = createMemo(() => {
    const newest = days()[0]?.date ?? "";
    const opened = toIsoDate(today);
    return newest > opened ? newest : opened;
  });
  const rowsByDate = createMemo(() => new Map(days().map((day) => [day.date, day.rows])));
  const rowsOf = (date: string): ScrawlRow[] => rowsByDate().get(date) ?? [];
  const currentRows = createMemo(() => rowsOf(currentDay()));
  // The past days are listed by date, not by day object: scrawlDays makes new day objects on
  // every call, and `<For>` matching those by reference rebuilt every section for one capture
  const pastDates = createMemo(() =>
    days()
      .map((day) => day.date)
      .filter((date) => date !== currentDay()),
  );
  const currentHeading = createMemo(() => formatDayHeading(currentDay(), today));

  // Entry datetime -> notes. A chip sits right under its origin entry
  const originNotes = createMemo(() => notesByOrigin(notes() ?? []));
  const notesFor = (item: ScrawlItem): NoteItem[] => originNotes().get(originKeyOf(item)) ?? [];

  // ---- Weekly digest (once a week, in the band at the foot until dismissed; a phone says
  // the count beside the page's name) ----
  const [digestDismissed, setDigestDismissed] = createSignal(
    localStorage.getItem(DIGEST_DISMISS_KEY),
  );
  const weekSummary = createMemo(() => summarizeWeek(entries(), today));
  const yearAgo = createMemo(() => yearAgoToday(today, scrawl()?.dates ?? []));
  const digestVisible = createMemo(() => {
    if (isDigestDismissed(digestDismissed(), today)) {
      return false;
    }
    // items and dates are one value of the same resource, so the card and the day
    // list always render in the same flush (nothing cuts in later and pushes down)
    // A week with nothing to tell gets no empty card
    return weekSummary().count > 0 || yearAgo() !== null;
  });

  const dismissDigest = (): void => {
    const key = digestWeekKey(today);
    localStorage.setItem(DIGEST_DISMISS_KEY, key);
    setDigestDismissed(key);
  };

  const jumpToDay = (iso: string): void => {
    setExtraDates((dates) => (dates.includes(iso) ? dates : [...dates, iso]));
    setJumpTo(iso);
  };

  // Landing from search or the palette (?day=). Goes down the same path as a
  // calendar pick: add the data if older than the last 14 days, then scroll to that day's heading
  createEffect(() => {
    const { day } = searchParams;
    if (typeof day !== "string" || !day) {
      return;
    }
    jumpToDay(day);
    setSearchParams({ day: undefined }, { replace: true });
  });

  /**
   * Adding a date refetches the data, so the rows are rebuilt; scrolling right away
   * is undone by the redraw, which returns to the top. Move only after loading ends.
   */
  createEffect(() => {
    const iso = jumpTo();
    if (!iso || scrawl.loading) {
      return;
    }
    document.querySelector(`[data-day="${iso}"]`)?.scrollIntoView({ block: "start" });
    setJumpTo(null);
  });

  const recordedDates = createMemo(() => [...new Set((scrawl()?.items ?? []).map((i) => i.date))]);

  const contextsFor = (iso: string): (DeviceContext | null)[] =>
    (scrawl()?.items ?? []).filter((i) => i.date === iso).map((i) => i.context);

  /** Rereads only the day written to. Rereading every day pays one IPC per day for a single save. */
  const reloadDay = async (date: string): Promise<ScrawlItem[]> => {
    const items = toScrawlItems(date, await typedInvoke("read_scrawl_by_date", { date }));
    mutate((prev) => ({
      items: replaceDayItems(prev?.items ?? [], date, items),
      dates: prev?.dates ?? [],
    }));
    return items;
  };

  const capture = async (text: string): Promise<void> => {
    await typedInvoke("save_quick_capture", { text, client: await getClientContext() });
    shell.recordsChanged();
    const items = await reloadDay(toIsoDate(new Date()));
    // A capture appends to the day's file, so the one just left has the highest index
    const [left] = items.toSorted((a, b) => b.index - a.index);
    if (left) {
      setFreshId(left.id);
      setTimeout(() => setFreshId((id) => (id === left.id ? null : id)), FRESH_MS);
      setTakeBackId(left.id);
      setTimeout(() => setTakeBackId((id) => (id === left.id ? null : id)), TAKE_BACK_MS);
      // Where the eye is: the field stays put, so the list brings the new row to it. On a phone
      // the newest is at the top while the field is at the foot, a scroll away
      requestAnimationFrame(() => {
        document.querySelector(`[data-entry="${left.id}"]`)?.scrollIntoView({ block: "nearest" });
      });
    }
  };

  /**
   * Takes the line just sent back out of the day (36) and puts it into the field again. Core
   * checks the line is still the one read (`raw`), so a file that moved meanwhile refuses.
   */
  const takeBack = async (item: ScrawlItem): Promise<void> => {
    setTakeBackId(null);
    try {
      await typedInvoke("delete_scrawl_entry", {
        date: item.date,
        index: item.index,
        raw: item.raw,
      });
    } catch {
      shell.showToast(t().palm.takeBackFailed);
      return;
    }
    await reloadDay(item.date);
    shell.recordsChanged();
    setRefill({ text: item.text });
    shell.showToast(t().palm.takenBack);
  };

  /** Creates a note from `body` and opens it to write. */
  const openNewNote = async (body: string, origin?: string): Promise<void> => {
    const path = await typedInvoke("create_draft", {
      body,
      tags: parseTags(body),
      origin,
      client: await getClientContext(),
    });
    const filename = path.split("/").at(-1);
    if (!filename) {
      return;
    }
    shell.refreshData();
    navigate(writeRoute("note", filename));
  };

  /**
   * ⌘Enter on the input line: the line becomes the new Note's title. A refusal is left to
   * throw: the line keeps what was typed and says so itself (`CaptureBar`'s `onError`).
   */
  const writeNote = (text: string): Promise<void> => openNewNote(`# ${text}\n\n`);

  /** The ways in with no typed line to keep, so a refusal only needs saying. */
  const openNewNoteOrToast = async (body: string, origin?: string): Promise<void> => {
    try {
      await openNewNote(body, origin);
    } catch {
      shell.showToast(t().notes.createFailed);
    }
  };

  /**
   * Promotes an entry into a note. Nothing is written to the entry's file: only the
   * note's frontmatter `origin` links the two, and the chip is derived from it every time.
   */
  const promote = (item: ScrawlItem): Promise<void> =>
    openNewNoteOrToast(item.text, `${item.date}T${item.time}`);

  const openNote = (note: NoteItem): void => {
    navigate(noteRoute(note.kind, note.filename));
  };

  /**
   * Unlinks a note from its origin entry. Only the record of the link goes; the
   * note itself is untouched. Restoring is just writing the same value back, so
   * like deletion it is handled by Undo, not by a confirmation.
   */
  const unlinkNote = async (note: NoteItem): Promise<void> => {
    const { origin } = note;
    if (!origin) {
      return;
    }
    try {
      await typedInvoke("set_note_origin", { filename: note.filename, origin: null });
    } catch {
      shell.showToast(t().scrawl.unlinkFailed);
      return;
    }
    await refetchNotes();
    shell.showToast(t().scrawl.unlinked, () => {
      void (async () => {
        try {
          await typedInvoke("set_note_origin", { filename: note.filename, origin });
        } catch {
          shell.showToast(t().scrawl.relinkFailed);
          return;
        }
        await refetchNotes();
      })();
    });
  };

  // ---- Bulk delete (select -> hold -> run) ----
  const toggleSelected = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  /**
   * Deletes `targets` one line at a time, rereads every day touched and says how it went. The
   * select bar and a single entry's action row both come here, so the Stale guard and the
   * reread are one path.
   */
  const deleteEntries = async (targets: ScrawlItem[]): Promise<void> => {
    // A double press must not delete the same index twice
    if (deleting()) {
      return;
    }
    setDeleting(true);
    try {
      const plan = planBulkDelete(targets);
      let deleted = 0;
      try {
        // An index in the same day changes meaning once an earlier delete shifts the rows up, so delete in order, not in parallel
        for (const target of plan) {
          // oxlint-disable-next-line no-await-in-loop
          await typedInvoke("delete_scrawl_entry", {
            date: target.date,
            index: target.index,
            raw: target.raw,
          });
          deleted += 1;
        }
      } catch {
        // Stop at the first refusal. It says the file moved after the screen read it, so the
        // later targets of that day were planned against rows that are gone. Those of other days
        // stop too: the toast and the dropped selection ask for one fresh pick over all of them
      }
      // Reread every day it touched, refused or not: a line already gone has to leave the screen,
      // and the selection's indices no longer point where they did. A day that cannot be reread
      // keeps its old rows, and core's `raw` check refuses to delete any of them again
      await Promise.allSettled(
        [...new Set(plan.map((target) => target.date))].map((date) => reloadDay(date)),
      );
      exitSelecting();
      shell.recordsChanged();
      shell.showToast(
        deleted === plan.length
          ? t().scrawl.deleted(deleted)
          : t().scrawl.deleteFailed(plan.length - deleted),
      );
    } finally {
      setDeleting(false);
    }
  };

  /** Copies a record's text as written, tags included; the clipboard is the way out of a read-only record. */
  const copy = async (item: ScrawlItem): Promise<void> => {
    try {
      await navigator.clipboard.writeText(item.text);
      shell.showToast(t().scrawl.copied);
    } catch {
      shell.showToast(t().scrawl.copyFailed);
    }
  };

  const deleteOne = async (item: ScrawlItem): Promise<void> => {
    await deleteEntries([item]);
    setOpenId(null);
  };

  const runDelete = (): Promise<void> => {
    const ids = selected();
    return deleteEntries(entries().filter((item) => ids.has(item.id)));
  };

  /**
   * The one field new records are written in, at the foot on both widths: a wide window's
   * Scrawl sheet ends on it, and a phone carries it in the place pill under the thumb (R2). The
   * list above it reads newest first, so what is sent appears at the top. Both read the same draft, so a window resized across the line keeps
   * what was typed.
   */
  const composer = (): JSX.Element => (
    <CaptureBar
      knownTags={knownTags()}
      refill={refill()}
      searchWhenEmpty
      addTag={addTag()}
      onFocusChange={setTyping}
      onSend={capture}
      onPromote={writeNote}
      onError={() => shell.showToast(t().capture.saveFailed)}
      onSearch={() => shell.openSearch()}
      onNewNote={() => {
        void openNewNoteOrToast("");
      }}
      onJumpToDate={(trigger) => shell.togglePopover("calendar", trigger)}
    />
  );

  /** Back to the newest, at the top of the list. Without the glide where motion is turned down. */
  const toNewest = (): void => {
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    scrollRef?.scrollTo({ top: 0, behavior: still ? "auto" : "smooth" });
  };

  /** The round button back to the newest. Near the field: above the phone's dock, or low on the right. */
  const newestButton = (): JSX.Element => (
    <Show when={away() && !selecting()}>
      <button
        type="button"
        class="scrawl-newest"
        title={t().scrawl.newest}
        aria-label={t().scrawl.newest}
        onClick={toNewest}
      >
        <Icon name="arrow-up" size={18} />
      </button>
    </Show>
  );

  /**
   * The week and the tags, at the foot over the field: pressed, a tag searches; while a line is
   * typed, it joins the line (71). The calendar stays at the row's end, out of its scroll.
   */
  const band = (): JSX.Element => (
    <div class="scrawl-head">
      <div class="scrawl-band">
        <Show when={digestVisible() && !typing()}>
          <section class="digest-line" aria-label={t().scrawl.digestTitle}>
            {/* A phone says the week beside the page's name; a wide window has no name there */}
            <Show when={wide() && weekSummary().count > 0}>
              <span>{t().scrawl.digestSummary(weekSummary().days, weekSummary().count)}</span>
            </Show>
            <Show when={yearAgo()}>
              {(iso) => (
                <button
                  type="button"
                  class="digest-year-ago"
                  aria-label={t().scrawl.lastYearOpen}
                  onClick={() => jumpToDay(iso())}
                >
                  {t().scrawl.lastYear}
                  <span aria-hidden="true">→</span>
                </button>
              )}
            </Show>
            <button
              type="button"
              class="icon-button digest-close"
              title={t().scrawl.digestClose}
              aria-label={t().scrawl.digestClose}
              onClick={dismissDigest}
            >
              <Icon name="x" size={12} />
            </button>
          </section>
        </Show>
        <TagFilter
          tags={knownTags()}
          adding={typing()}
          onPick={(tag) => {
            if (typing()) {
              setAddTag({ tag });
            } else {
              shell.openSearch({ tags: [tag] });
            }
          }}
        />
      </div>
      <button
        type="button"
        class="icon-button"
        title={t().header.jumpToDate}
        aria-label={t().header.jumpToDate}
        aria-expanded={shell.popover() === "calendar"}
        onClick={(e) => shell.togglePopover("calendar", e.currentTarget)}
      >
        <Icon name="calendar-blank" size={16} />
      </button>
    </div>
  );

  const renderRow = (row: ScrawlRow): JSX.Element =>
    row.kind === "scrawl" ? (
      <ScrawlEntry
        item={row.item}
        notes={notesFor(row.item)}
        fresh={freshId() === row.item.id}
        selecting={selecting()}
        selected={selected().has(row.item.id)}
        open={openId() === row.item.id}
        onOpenChange={(open) => setOpenId(open ? row.item.id : null)}
        onToggle={() => toggleSelected(row.item.id)}
        onPromote={() => setPromoting(row.item)}
        onCopy={() => {
          void copy(row.item);
        }}
        onDelete={() => deleteOne(row.item)}
        onTakeBack={
          takeBackId() === row.item.id
            ? () => {
                void takeBack(row.item);
              }
            : undefined
        }
        onOpenNote={openNote}
        onUnlinkNote={(note) => {
          void unlinkNote(note);
        }}
      />
    ) : (
      <NoteRow note={row.note} onOpen={openNote} />
    );

  // An opened record folds on Esc, and when select mode takes over the rows
  createEffect(on(selecting, () => setOpenId(null), { defer: true }));

  // The select bar stands where the place pill floats, so the pill steps away meanwhile
  createEffect(() => shell.setPlacesAway(selecting()));
  onCleanup(() => shell.setPlacesAway(false));
  createEffect(() => {
    if (openId() === null) {
      return;
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        setOpenId(null);
      }
    };
    globalThis.addEventListener("keydown", onKey);
    onCleanup(() => globalThis.removeEventListener("keydown", onKey));
  });

  // Esc leaves select mode
  createEffect(() => {
    if (!selecting()) {
      return;
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") {
        return;
      }
      e.preventDefault();
      exitSelecting();
    };
    globalThis.addEventListener("keydown", onKey);
    onCleanup(() => globalThis.removeEventListener("keydown", onKey));
  });

  return (
    <div class="scrawl" classList={{ "scrawl--selecting": selecting() }}>
      {/* Newest first, as a feed reads: today at the top under the page's name, older days
          below. The field stays at the foot under the thumb, so a line just sent appears at
          the top and the list goes up to meet it (capture) */}
      <div
        class="scrawl-scroll"
        ref={scrollRef}
        onScroll={(e) =>
          setAway(awayFromNewest(e.currentTarget.scrollTop, e.currentTarget.clientHeight))
        }
      >
        <div class="scrawl-column">
          {/* A phone's page opens on its own large name, as every page there does: no bar
              above. It scrolls away with the rows */}
          <Show when={!wide()}>
            <h1 class="list-big-title scrawl-big-title">
              {MODE_LABELS[ROUTES.SCRAWL]}
              <Show when={digestVisible() && weekSummary().count > 0}>
                <span class="list-big-count">
                  {t().scrawl.digestSummary(weekSummary().days, weekSummary().count)}
                </span>
              </Show>
            </h1>
          </Show>

          <section class="day-group day-group--current" data-day={currentDay()}>
            <header class="day-heading">
              <h2 class="day-heading-label">{currentHeading().label}</h2>
              <span class="day-heading-date">{currentHeading().date}</span>
              <Show when={currentRows().length > 0}>
                <span class="day-heading-count">
                  {t().scrawl.entryCount(currentRows().length)}
                  {/* The entry into selection is one word beside the count of the
                      day being written. No floating bar of its own is added. Once
                      inside, the bottom bar takes over, so it is hidden meanwhile */}
                  <Show when={!selecting()}>
                    <span aria-hidden="true">·</span>
                    <button
                      type="button"
                      class="day-heading-select"
                      onClick={() => setSelecting(true)}
                    >
                      {t().scrawl.select}
                    </button>
                  </Show>
                </span>
              </Show>
            </header>

            <Show when={days().length === 0}>
              <EmptyScrawl />
            </Show>
            <For each={currentRows()}>{renderRow}</For>
          </section>

          <For each={pastDates()}>
            {(date) => {
              const heading = createMemo(() => formatDayHeading(date, today));
              const rows = (): ScrawlRow[] => rowsOf(date);
              return (
                <section class="day-group" data-day={date}>
                  <header class="day-heading">
                    <h2 class="day-heading-label">{heading().label}</h2>
                    <span class="day-heading-date">{heading().date}</span>
                    <span class="day-heading-count">{t().scrawl.entryCount(rows().length)}</span>
                  </header>

                  <For each={rows()}>{renderRow}</For>
                </section>
              );
            }}
          </For>
        </div>
      </div>

      {/* The sheet ends on the band and the field on both widths. A wide window writes in the
          field here; a phone's field is in the place pill below, so only the band stands here,
          and it steps away with the pill while reading down (63). While selecting, the bottom
          bar stands in for the field; the band stays (a jump to a day is still a way through
          them) */}
      <Show when={wide() || !shell.slim()}>
        <div class="scrawl-composer">
          {band()}
          <Show when={wide() && !selecting()}>{composer()}</Show>
        </div>
      </Show>

      {/* A phone writes in the shell's place pill, stretched here to the right gutter: one
          thing floating at the foot, not the pill and a bar. The pill is AppLayout's so it can
          stretch from a list as one element; the field stays this screen's, carried there by a
          Portal. While the field has the focus the places step aside (layout.css). The way back
          to the newest rides on the pill, so a field grown to five lines lifts it too */}
      <Show when={!wide() && !selecting() && shell.placesSlot()} keyed>
        {(slot) => (
          <Portal
            mount={slot}
            ref={(holder: HTMLDivElement) => {
              holder.className = "scrawl-dock";
            }}
          >
            {newestButton()}
            {composer()}
          </Portal>
        )}
      </Show>

      {/* A wide window keeps it low on the right. A phone reading down has folded the pill it
          rides on, so it stands over the pencil instead: away from the newest, the way back is
          always in sight (S6) */}
      <Show when={wide() || (shell.slim() && !selecting())}>
        <div class="scrawl-newest-stand">{newestButton()}</div>
      </Show>

      <ScrawlScrubber
        dates={scrawl()?.dates ?? []}
        scroller={() => scrollRef}
        onJump={jumpToDay}
        onCalendar={(trigger) => shell.togglePopover("calendar", trigger)}
      />

      {/* Reading down, the bar folds to its line of words and the field to one pencil (63):
          pressed, the bar comes back with the field in hand */}
      <Show when={!wide() && shell.slim() && !selecting()}>
        <button
          type="button"
          class="compose-fab compose-fab--write"
          title={t().capture.label}
          aria-label={t().capture.label}
          onClick={() => {
            shell.setSlim(false);
            requestAnimationFrame(() =>
              document.querySelector<HTMLTextAreaElement>(".scrawl-dock .capture-input")?.focus(),
            );
          }}
        >
          <Icon name="pencil" size={22} />
        </button>
      </Show>

      <Show when={selecting()}>
        <div class="capture-dock">
          <div class="select-bar" role="toolbar" aria-label={t().scrawl.bulkDelete}>
            {/* Counting means nothing while nothing is selected. The entry bar is gone, so
                what to do next is said here instead */}
            <span class="select-bar-label">
              {selected().size === 0
                ? t().scrawl.selectHint
                : t().scrawl.selectedCount(selected().size)}
            </span>
            {/* Held, not confirmed (96): a delete of several that cannot be taken back is
                a press that lasts, in the same spot, not a second bar asking */}
            <HoldButton
              label={t().scrawl.deleteCount(selected().size)}
              hint={t().palm.holdDelete}
              icon="trash"
              danger
              disabled={selected().size === 0 || deleting()}
              onConfirm={() => {
                void runDelete();
              }}
            />
            <button type="button" class="select-bar-plain" onClick={exitSelecting}>
              {t().common.cancel}
            </button>
          </div>
        </div>
      </Show>

      <PromoteDialog
        open={promoting() !== null}
        icon="note-pencil"
        title={t().scrawl.promote}
        body={
          <>
            {t().scrawl.promoteConfirm}
            <strong>{t().scrawl.promoteConfirmStrong}</strong>
            {t().scrawl.promoteConfirmEnd}
          </>
        }
        yes={t().scrawl.promote}
        no={t().scrawl.promoteNo}
        onClose={() => setPromoting(null)}
        onConfirm={() => {
          const item = promoting();
          setPromoting(null);
          if (item) {
            void promote(item);
          }
        }}
      />

      <Popover
        open={shell.popover() === "calendar"}
        onClose={() => shell.closePopovers()}
        trigger={shell.popoverTrigger}
        label={t().header.jumpToDate}
        class="popover-anchor popover-anchor--calendar"
        style={calendarPlace()}
      >
        <CalendarPopover
          recordedDates={recordedDates()}
          contextsFor={contextsFor}
          onPick={(iso) => {
            jumpToDay(iso);
            shell.closePopovers();
          }}
        />
      </Popover>
    </div>
  );
}
