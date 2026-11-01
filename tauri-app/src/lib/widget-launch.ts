/**
 * What a tap on a home-screen widget does once the app is up. Reading the URL is
 * `widget-actions.ts`; this is the dispatch, and the subscription that feeds it. A widget
 * usually wakes the app from cold, and `onOpenUrl` only delivers what arrives after
 * subscribing, so the launch URL is picked up with `getCurrent` as well.
 */

import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { getDeviceSignals } from "./client-context";
import { typedInvoke } from "./commands";
import { locale, t } from "./i18n";
import { noteRoute, writeRoute } from "./note-route";
import { ROUTES } from "./routes";
import { firstWidgetAction } from "./widget-actions";
import type { WidgetAction } from "./widget-actions";

export interface WidgetLaunchDeps {
  navigate: (path: string) => void;
  /** Starts an empty note and opens its writing screen; the same as the palette's. */
  newNote: () => void;
  closePalette: () => void;
  refreshData: () => void;
  showToast: (text: string) => void;
}

/** The dispatcher. Unknown actions, and known ones missing their argument, do nothing. */
export function createWidgetLaunch(deps: WidgetLaunchDeps): (action: WidgetAction) => void {
  /**
   * A widget's template button. If today's note from the same template already exists,
   * core returns it instead of creating one, so this only has to open it.
   */
  const openFromTemplate = (name: string): void => {
    deps.closePalette();
    void (async () => {
      try {
        const created = await typedInvoke("create_from_template", {
          filename: `${name}.md`,
          locale: locale(),
          client: await getDeviceSignals(),
        });
        deps.refreshData();
        deps.navigate(writeRoute("note", created.path.split("/").at(-1)));
      } catch {
        // A widget may still point at a template that was deleted. Rather than
        // nothing happening on tap, open the list and show the reason
        deps.navigate(ROUTES.NOTES);
        deps.showToast(t().templates.createFailed);
      }
    })();
  };

  return (action) => {
    if (action.name === "new-note") {
      deps.newNote();
      return;
    }
    if (action.name === "template" && action.template) {
      openFromTemplate(action.template);
      return;
    }
    // Where a widget with no buttons at all, and its header, lead
    if (action.name === "templates") {
      deps.navigate(ROUTES.TEMPLATES);
      return;
    }
    // ?file= is left to the router. Carrying the wanted note in the URL is more
    // natural than lifting the Workspace selection state out to be touched from outside
    if (action.name === "note" && action.file) {
      deps.navigate(noteRoute("note", action.file));
    }
  };
}

/** Runs `run` for the launch URL and for every widget link that arrives later. Resolves to the way to stop. */
export async function watchWidgetLaunch(run: (action: WidgetAction) => void): Promise<() => void> {
  const unlisten = await onOpenUrl((urls) => {
    const action = firstWidgetAction(urls);
    if (action) {
      run(action);
    }
  });
  const launched = firstWidgetAction((await getCurrent()) ?? []);
  if (launched) {
    run(launched);
  }
  return unlisten;
}
