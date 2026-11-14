import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import CapturePill from "./CapturePill";
import { typedInvoke } from "../lib/commands";
import { getClientContext } from "../lib/client-context";
import { toIsoDate } from "../lib/day-labels";
import { t } from "../lib/i18n";
import { toScrawlItems } from "../lib/items";
import { writeRoute } from "../lib/note-route";
import { useShell } from "../lib/shell";
import { ROUTES } from "../lib/routes";

interface QuickJotProps {
  /** A wide window floats it at the foot of the page, where the pointer's hand writes. */
  wide?: boolean;
  /** How far an on-screen keyboard reaches into the window. */
  lift?: number;
  onClose: () => void;
}

/**
 * Takes back the line just written, if it is still the newest of the day. Core refuses (Stale)
 * when the file moved meanwhile, and nothing else is touched.
 */
async function takeBackNewest(date: string, text: string): Promise<boolean> {
  const items = toScrawlItems(date, await typedInvoke("read_scrawl_by_date", { date }));
  const [newest] = items.toSorted((a, b) => b.index - a.index);
  if (!newest || newest.text !== text) {
    return false;
  }
  await typedInvoke("delete_scrawl_entry", {
    date: newest.date,
    index: newest.index,
    raw: newest.raw,
  });
  return true;
}

/**
 * One line into Scrawl over whatever is open (68): the ring's first petal, from a held pill or a
 * +. It is the pill in its own shape (CapturePill), the same one the OS key floats over other
 * apps, at the foot where the thumb (or the pointer's page) is. Sent, it closes and says so with
 * a way to take it back (36); the screen under it never moved. Esc or a tap outside closes it
 * and the draft stays for next time.
 */
export default function QuickJot(props: QuickJotProps): JSX.Element {
  const shell = useShell();
  const navigate = useNavigate();

  const send = async (text: string): Promise<void> => {
    await typedInvoke("save_quick_capture", { text, client: await getClientContext() });
    shell.recordsChanged();
    props.onClose();
    const date = toIsoDate(new Date());
    shell.showToast(t().palm.jotSent, () => {
      void (async () => {
        try {
          const done = await takeBackNewest(date, text);
          shell.recordsChanged();
          shell.showToast(done ? t().palm.takenBack : t().palm.takeBackFailed);
        } catch {
          shell.showToast(t().palm.takeBackFailed);
        }
      })();
    });
  };

  const promote = async (text: string): Promise<void> => {
    const path = await typedInvoke("create_draft", {
      body: text ? `# ${text}\n\n` : "",
      tags: [],
      client: await getClientContext(),
    });
    props.onClose();
    shell.refreshData();
    navigate(writeRoute("note", path.split("/").at(-1)));
  };

  return (
    <div
      class="quick-jot-layer"
      classList={{ "quick-jot-layer--wide": props.wide === true }}
      style={{ "--keyboard-lift": `${props.lift ?? 0}px` }}
    >
      <button
        type="button"
        class="quick-jot-scrim"
        tabIndex={-1}
        aria-label={t().common.close}
        onClick={() => props.onClose()}
      />
      <div class="quick-jot">
        <CapturePill
          hint={props.wide ? t().reach.captureHint("Enter") : t().palm.jot}
          onSend={send}
          onPromote={promote}
          onClose={() => props.onClose()}
          onError={() => shell.showToast(t().capture.saveFailed)}
          onSearch={() => {
            props.onClose();
            shell.openSearch();
          }}
          onNewNote={() => {
            void promote("");
          }}
          onJumpToDate={() => {
            props.onClose();
            navigate(ROUTES.SCRAWL);
          }}
        />
      </div>
    </div>
  );
}
