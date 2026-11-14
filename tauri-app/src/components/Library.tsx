import { For } from "solid-js";
import type { JSX } from "solid-js";
import { useLocation } from "@solidjs/router";
import Icon from "./Icon";
import { createRingPress } from "./Ring";
import { StatusLine } from "./StatusDot";
import { t } from "../lib/i18n";
import type { RingChoice } from "../lib/ring";
import { MODE_ICONS, MODE_LABELS, ROUTES } from "../lib/routes";
import type { RoutePath } from "../lib/routes";
import { shortcutLabel } from "../lib/shortcuts";
import type { ShortcutName } from "../lib/shortcuts";
import type { SyncStatus } from "../lib/sync";

interface LibraryProps {
  sync: SyncStatus;
  /** The status line hands itself over as the popover's trigger. */
  onOpenStatus: (trigger: HTMLElement) => void;
  onGo: (path: RoutePath) => void;
  /** The search field, from the shelf's own row at its foot, next to ⌘K. */
  onSearch: () => void;
  /** The ring's petals, bloomed by the + beside the search (`lib/ring.ts`). */
  choices: RingChoice[];
}

interface Place {
  path: RoutePath;
  label: string;
  /** The key that goes there too, badged on the row while ⌘ is held. */
  key: ShortcutName;
}

/** The four places the library leads to, in the order of ⌘1/2/3 and ⌘F. */
const PLACES: readonly Place[] = [
  { path: ROUTES.SCRAWL, label: MODE_LABELS[ROUTES.SCRAWL], key: "scrawl" },
  { path: ROUTES.NOTES, label: MODE_LABELS[ROUTES.NOTES], key: "notes" },
  { path: ROUTES.CODEX, label: MODE_LABELS[ROUTES.CODEX], key: "codex" },
  { path: ROUTES.BROWSE, label: "", key: "browse" },
];

/** A surface keeps its proper noun; Browse is a page named in the string table. */
function placeLabel(place: Place): string {
  return place.label || t().browse.title;
}

/**
 * The shelf does one thing: it changes the place. The four places hang from the foot with the
 * search and the fan's + under them, and the app's state is a dot at the top. Tags are Browse's
 * job and Templates and Settings are found in the empty search field, so a wide window stands it
 * as a rail of icons. A phone has no shelf: its places are on the pill at the foot, and one way
 * to each place is enough. Every row leads somewhere visible, so moving between surfaces needs
 * neither hover nor a key (R1).
 *
 * It carries no counts: a 64px rail has no room to show one, and reading every record to fill
 * a number nobody sees cost a `browse_all` on every change. Today's count is on the phone's
 * pill, where it is seen.
 */
export default function Library(props: LibraryProps): JSX.Element {
  const location = useLocation();
  /** The + at the foot: the same ring as a held pill (65, 68), for a pointer or a thumb. */
  const ring = createRingPress({ choices: () => props.choices, holdMs: 0 });

  const isHere = (path: RoutePath): boolean => location.pathname === path;
  return (
    <nav class="library" aria-label={t().library.title}>
      {/* The state in words at the top, in the reading half: it is read far more than it is
          pressed */}
      <div class="library-top">
        <StatusLine sync={props.sync} onOpen={props.onOpenStatus} />
      </div>

      {/* The foot: the places, then the search and the ring's + at the bottom edge, where the
          thumb (or a pointer coming from the page's own foot) already is */}
      <div class="library-foot">
        <section aria-label={t().library.places}>
          <For each={PLACES}>
            {(place) => (
              <button
                type="button"
                class="library-row"
                classList={{ "library-row--here": isHere(place.path) }}
                aria-current={isHere(place.path) ? "page" : undefined}
                data-hint-key={shortcutLabel(place.key)}
                onClick={() => props.onGo(place.path)}
              >
                <Icon name={MODE_ICONS[place.path]} size={17} />
                <span class="library-row-label">{placeLabel(place)}</span>
              </button>
            )}
          </For>
        </section>
        <div class="library-search-row">
          <button
            type="button"
            class="library-row"
            data-hint-key={shortcutLabel("search")}
            onClick={() => props.onSearch()}
          >
            <Icon name="magnifying-glass" size={17} />
            <span class="library-row-label">{t().palm.search}</span>
          </button>
          <button
            type="button"
            class="library-ring ring-trigger"
            title={`${t().reach.ring} · ${t().reach.ringHint}`}
            aria-label={t().reach.ring}
            aria-haspopup="menu"
            aria-expanded={ring.open()}
            {...ring.handlers}
            onClick={(e) => {
              if (!ring.shouldClick()) {
                e.preventDefault();
              }
            }}
          >
            <Icon name="plus" size={18} />
          </button>
        </div>
      </div>
      {ring.view()}
    </nav>
  );
}
