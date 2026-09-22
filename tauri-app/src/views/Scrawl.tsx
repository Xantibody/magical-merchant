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
import CaptureBar from "../components/CaptureBar";
import CalendarPopover from "../components/CalendarPopover";
import Popover from "../components/Popover";
import TagFilter from "../components/TagFilter";
import ScrawlEntry, { OriginChip } from "../components/ScrawlEntry";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { typedInvoke } from "../lib/commands";
import { getClientContext } from "../lib/client-context";
import { useShell } from "../lib/shell";
import { formatDayHeading, toIsoDate } from "../lib/day-labels";
import { t } from "../lib/i18n";
import {
  groupScrawlByDay,
  notesByOrigin,
  orphanNotesByDate,
  originKeyOf,
  planBulkDelete,
  replaceDayItems,
  toNoteItems,
  toScrawlItems,
} from "../lib/items";
import type { NoteItem, ScrawlItem } from "../lib/items";
import { places } from "../lib/places";
import { noteRoute } from "../lib/note-route";
import { ROUTES } from "../lib/routes";
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

interface ScrawlData {
  items: ScrawlItem[];
  /** Every date with a record (newest first). The digest's "a year ago today" check uses it. */
  dates: string[];
}

/**
 * Returns the recent days and the full date list as one value. Split into separate
 * resources, they would render in separate flushes, and the digest would cut into
 * the day list already shown and cause a layout shift.
 */
async function loadScrawl(extraDates: string[]): Promise<ScrawlData> {
  const dates = await typedInvoke("list_scrawl_dates");
  const wanted = [...new Set([...dates.slice(0, RECENT_DAYS), ...extraDates])].toSorted((a, b) =>
    b.localeCompare(a),
  );
  const days = await Promise.all(
    wanted.map(async (date) =>
      toScrawlItems(date, await typedInvoke("read_scrawl_by_date", { date })),
    ),
  );
  return { items: days.flat(), dates };
}

function EmptyScrawl(): JSX.Element {
  return (
    <div class="scrawl-empty">
      <span class="scrawl-empty-rail" aria-hidden="true" />
      <div>
        <p class="scrawl-empty-title">{t().scrawl.emptyToday}</p>
        <p class="scrawl-empty-hint">{t().scrawl.emptyHint}</p>
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
  /** The one step before deleting. True only while the confirm bar is shown. */
  const [confirming, setConfirming] = createSignal(false);
  /** A delete in progress. The lock that keeps a double press from deleting the same row twice. */
  const [deleting, setDeleting] = createSignal(false);
  /** Folds the three selection states at once. Leaving works the same from anywhere. */
  const exitSelecting = (): void => {
    setSelecting(false);
    setSelected(new Set<string>());
    setConfirming(false);
  };
  /**
   * Folds the selection before the list is reread. A selection points at a row by
   * `date#index`, so if a reread adds a row earlier in the same day, that index
   * points at the neighbouring record. Reselecting is one more press on the
   * confirm bar; a wrong deletion cannot be undone.
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

  const entries = createMemo(() => scrawl()?.items ?? []);
  // A place name is not part of the record, so the list does not wait for it. Rows
  // are laid out with coordinates first and swap to names as each one is resolved.
  createEffect(() => {
    void places.load(entries().map((item) => item.context));
  });
  const knownTags = createMemo(() => countTags(entries().map((item) => item.text)));

  const days = createMemo(() => groupScrawlByDay(entries()));

  // Entry datetime -> notes. A chip sits right under its origin entry
  const originNotes = createMemo(() => notesByOrigin(notes() ?? []));
  const notesFor = (item: ScrawlItem): NoteItem[] => originNotes().get(originKeyOf(item)) ?? [];

  // Only notes whose origin entry is gone still appear right under the day heading, as before
  const orphanNotes = createMemo(() => orphanNotesByDate(notes() ?? [], entries()));

  // ---- Weekly digest (once a week, shown at the top until dismissed) ----
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
  const reloadDay = async (date: string): Promise<void> => {
    const items = toScrawlItems(date, await typedInvoke("read_scrawl_by_date", { date }));
    mutate((prev) => ({
      items: replaceDayItems(prev?.items ?? [], date, items),
      dates: prev?.dates ?? [],
    }));
  };

  const capture = async (text: string): Promise<void> => {
    await typedInvoke("save_quick_capture", { text, client: await getClientContext() });
    await reloadDay(toIsoDate(new Date()));
  };

  /**
   * Promotes an entry into a note and opens it ready to write. Nothing is written
   * to the entry's file: only the note's frontmatter `origin` links the two, and
   * the chip is derived from it every time.
   */
  const promote = async (item: ScrawlItem): Promise<void> => {
    const path = await typedInvoke("create_draft", {
      body: item.text,
      tags: parseTags(item.text),
      origin: `${item.date}T${item.time}`,
      client: await getClientContext(),
    });
    const filename = path.split("/").at(-1);
    if (!filename) {
      return;
    }
    shell.refreshData();
    navigate(`${noteRoute("note", filename)}&edit=1`);
  };

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
    await typedInvoke("set_note_origin", { filename: note.filename, origin: null });
    await refetchNotes();
    shell.showToast(t().scrawl.unlinked, () => {
      void (async () => {
        await typedInvoke("set_note_origin", { filename: note.filename, origin });
        await refetchNotes();
      })();
    });
  };

  // ---- Bulk delete (select -> confirm -> run) ----
  const toggleSelected = (id: string): void => {
    // Changing the selection restarts the confirmation. A confirmation whose count changed must not run as is
    setConfirming(false);
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

  const runDelete = async (): Promise<void> => {
    // A double press must not delete the same index twice
    if (deleting()) {
      return;
    }
    setDeleting(true);
    try {
      const ids = selected();
      const plan = planBulkDelete(entries().filter((item) => ids.has(item.id)));
      // An index in the same day changes meaning once an earlier delete shifts the rows up, so delete in order, not in parallel
      for (const target of plan) {
        // oxlint-disable-next-line no-await-in-loop
        await typedInvoke("delete_scrawl_entry", {
          date: target.date,
          index: target.index,
          raw: target.raw,
        });
      }
      await Promise.all(
        [...new Set(plan.map((target) => target.date))].map((date) => reloadDay(date)),
      );
      exitSelecting();
      shell.showToast(t().scrawl.deleted(plan.length));
    } finally {
      setDeleting(false);
    }
  };

  // Esc steps back one level at a time: confirm bar -> select mode -> normal
  createEffect(() => {
    if (!selecting()) {
      return;
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") {
        return;
      }
      e.preventDefault();
      if (confirming()) {
        setConfirming(false);
      } else {
        exitSelecting();
      }
    };
    globalThis.addEventListener("keydown", onKey);
    onCleanup(() => globalThis.removeEventListener("keydown", onKey));
  });

  return (
    <div class="scrawl">
      <div class="scrawl-scroll">
        <div class="scrawl-column">
          {/* The tag row and the week summary are one continuous heading strip. They
              sit at the strip's 14px, not the column's 36px: the summary continues
              the tags, it is not a layer of its own. The digest is not inserted
              above TagFilter because when the data arrives late, a row present in
              the first paint would be pushed down and cause a layout shift */}
          <div class="scrawl-head">
            <div class="scrawl-head-row">
              {/* Pressing does not filter here. It opens the Browse screen with Scrawl
                  and that tag: the filter's answer is not kept in two places */}
              <TagFilter
                tags={knownTags()}
                onPick={(tag) =>
                  navigate(`${ROUTES.BROWSE}?kind=scrawl&tag=${encodeURIComponent(tag)}`)
                }
              />

              {/* The only way to go back across days. Not shown on a narrow screen
                  (CSS), where the header has it. So it does not vanish on a day
                  with no tags at all, this strip is drawn whether or not it has content */}
              <button
                type="button"
                class="icon-button scrawl-calendar"
                title={t().header.jumpToDate}
                aria-label={t().header.jumpToDate}
                aria-expanded={shell.popover() === "calendar"}
                onClick={(e) => shell.togglePopover("calendar", e.currentTarget)}
              >
                <Icon name="calendar-blank" size={16} />
              </button>
            </div>

            <Show when={digestVisible()}>
              <section class="digest-line" aria-label={t().scrawl.digestTitle}>
                <span class="digest-label">{t().scrawl.digestTitle}</span>
                <Show when={weekSummary().count > 0}>
                  <span>{t().scrawl.digestSummary(weekSummary().days, weekSummary().count)}</span>
                </Show>
                <Show when={yearAgo()}>
                  {(iso) => (
                    <>
                      {/* The middle dot only separates the summary from the link. A screen reader does not need it */}
                      <Show when={weekSummary().count > 0}>
                        <span class="digest-sep" aria-hidden="true">
                          ·
                        </span>
                      </Show>
                      <button
                        type="button"
                        class="digest-year-ago"
                        aria-label={t().scrawl.lastYearOpen}
                        onClick={() => jumpToDay(iso())}
                      >
                        {t().scrawl.lastYear}
                        <span aria-hidden="true">→</span>
                      </button>
                    </>
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
          </div>

          <Show when={days().length} fallback={<EmptyScrawl />}>
            <For each={days()}>
              {(day, index) => {
                const heading = createMemo(() => formatDayHeading(day.date, today));
                const orphans = createMemo(() => orphanNotes().get(day.date) ?? []);
                return (
                  <section class="day-group" data-day={day.date}>
                    <header class="day-heading">
                      <h2 class="day-heading-label">{heading().label}</h2>
                      <span class="day-heading-date">{heading().date}</span>
                      <span class="day-heading-count">
                        {t().scrawl.entryCount(day.items.length)}
                        {/* The entry into selection is one word beside the count of the
                            day being written. No floating bar of its own is added. Once
                            inside, the bottom bar takes over, so it is hidden meanwhile */}
                        <Show when={index() === 0 && !selecting()}>
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
                    </header>

                    {/* A shelter only for notes whose origin entry is gone. A normal
                        chip appears right under its entry */}
                    <Show when={orphans().length}>
                      <div class="origin-chips">
                        <For each={orphans()}>
                          {(note) => (
                            <OriginChip
                              note={note}
                              onOpen={openNote}
                              onUnlink={(target) => {
                                void unlinkNote(target);
                              }}
                            />
                          )}
                        </For>
                      </div>
                    </Show>

                    <For each={day.items}>
                      {(item) => (
                        <ScrawlEntry
                          item={item}
                          notes={notesFor(item)}
                          selecting={selecting()}
                          selected={selected().has(item.id)}
                          onToggle={() => toggleSelected(item.id)}
                          onPromote={() => {
                            void promote(item);
                          }}
                          onOpenNote={openNote}
                          onUnlinkNote={(note) => {
                            void unlinkNote(note);
                          }}
                        />
                      )}
                    </For>
                  </section>
                );
              }}
            </For>
          </Show>
        </div>
      </div>

      <div class="capture-dock">
        <Show when={selecting()} fallback={<CaptureBar onSend={capture} knownTags={knownTags()} />}>
          <div class="select-bar" role="toolbar" aria-label={t().scrawl.bulkDelete}>
            <Show
              when={confirming()}
              fallback={
                <>
                  {/* Counting means nothing while nothing is selected. The entry
                      bar is gone, so what to do next is said here instead */}
                  <span class="select-bar-label">
                    {selected().size === 0
                      ? t().scrawl.selectHint
                      : t().scrawl.selectedCount(selected().size)}
                  </span>
                  <button
                    type="button"
                    class="select-bar-danger"
                    disabled={selected().size === 0}
                    onClick={() => setConfirming(true)}
                  >
                    <Icon name="trash" size={14} />
                    {t().scrawl.deleteCount(selected().size)}
                  </button>
                  <button type="button" class="select-bar-plain" onClick={exitSelecting}>
                    {t().common.cancel}
                  </button>
                </>
              }
            >
              <span class="select-bar-label">{t().scrawl.confirmDelete(selected().size)}</span>
              <button
                type="button"
                class="select-bar-danger"
                disabled={deleting()}
                onClick={() => {
                  void runDelete();
                }}
              >
                {t().scrawl.confirmDeleteYes}
              </button>
              <button type="button" class="select-bar-plain" onClick={() => setConfirming(false)}>
                {t().common.back}
              </button>
            </Show>
          </div>
        </Show>
      </div>

      <Popover
        open={shell.popover() === "calendar"}
        onClose={() => shell.closePopovers()}
        trigger={shell.popoverTrigger}
        label={t().header.jumpToDate}
        class="popover-anchor popover-anchor--calendar"
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
