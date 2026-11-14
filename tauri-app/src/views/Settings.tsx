import { createEffect, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { A, useSearchParams } from "@solidjs/router";
import Icon from "../components/Icon";
import type { IconName } from "../components/Icon";
import { typedInvoke } from "../lib/commands";
import type { GlyphSummary } from "../lib/commands";
import {
  glyphFormatOf,
  glyphs,
  isGlyphName,
  loadGlyphs,
  planGlyphImport,
  suggestGlyphName,
} from "../lib/glyphs";
import { t } from "../lib/i18n";
import { isImeComposing } from "../lib/ime";
import { ROUTES, SETTINGS_PAGE_PARAM, SETTINGS_PAGES } from "../lib/routes";
import type { SettingsPage } from "../lib/routes";
import { createWide } from "../lib/media";
import { useShell } from "../lib/shell";
import GeneralPage from "./settings/GeneralPage";
import OutsideRows from "./settings/OutsideRows";
import { Row } from "./settings/Rows";
import SyncPage, { createSyncSettings } from "./settings/SyncPage";
import { getVersion } from "@tauri-apps/api/app";
import "../styles/settings.css";
import type { JSX } from "solid-js";

const UNDO_MS = 5000;

const PAGE_ICONS: Record<SettingsPage, IconName> = {
  general: "circle-half",
  records: "file-text",
  sync: "cloud-check",
};

/** An image chosen but not yet registered. Saved once a name is decided. */
interface PendingGlyph {
  file: File;
  format: "png" | "svg";
}

/** An image file as base64. IPC carries only strings. */
async function readAsBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  // Passing it all to fromCodePoint at once hits the argument limit. Even a file at the 256 KiB cap is chunked
  for (let at = 0; at < bytes.length; at += 0x80_00) {
    binary += String.fromCodePoint(...bytes.subarray(at, at + 0x80_00));
  }
  return btoa(binary);
}

export default function Settings(): JSX.Element {
  const shell = useShell();
  // A link can name the page (`settingsPage()`), as the sync popover does. Read once at
  // open: the nav rows change the page without touching the URL, so the query is a
  // starting point, not the state
  const [searchParams] = useSearchParams();
  const requestedPage = SETTINGS_PAGES.find((id) => id === searchParams[SETTINGS_PAGE_PARAM]);
  /** The page shown. Mobile shows only the list until one is opened (`settings--page`). */
  const [page, setPage] = createSignal<SettingsPage>(requestedPage ?? "general");
  const [pageOpen, setPageOpen] = createSignal(requestedPage !== undefined);
  const [message, setMessage] = createSignal("");
  const wide = createWide();
  let rootRef: HTMLDivElement | undefined;
  let pageRef: HTMLDivElement | undefined;
  let navRef: HTMLElement | undefined;

  // On a phone a page is a level over the list of pages: the round way out at the foot and a
  // stroke to the right go back to the list, with the list showing through under the page as it
  // slides (61)
  createEffect(() => {
    if (wide() || !pageOpen()) {
      shell.setHeaderBack(null);
      shell.setBackStage(null);
      return;
    }
    shell.setHeaderBack(() => setPageOpen(false));
    shell.setBackStage(() => {
      if (!pageRef) {
        return null;
      }
      rootRef?.classList.add("settings--peek");
      return {
        page: pageRef,
        under: navRef,
        done: (commit) => {
          rootRef?.classList.remove("settings--peek");
          if (commit) {
            setPageOpen(false);
          }
        },
      };
    });
  });
  onCleanup(() => {
    shell.setHeaderBack(null);
    shell.setBackStage(null);
  });
  const [templates] = createResource(() => typedInvoke("list_templates"));
  /**
   * Returns the version from tauri.conf.json as is. It matches the release tag, so
   * it tells which build is on the device. If it cannot be read, it is left empty
   * and the foot of the nav is hidden with it: Settings failing to open is worse
   * than the version not showing
   */
  const [version] = createResource(async () => {
    try {
      return await getVersion();
    } catch {
      return "";
    }
  });
  const [glyphList, { refetch: refetchGlyphs }] = createResource(() => typedInvoke("list_glyphs"));
  /** Names hidden from the list while their deletion is still undoable. */
  const [hiddenGlyphs, setHiddenGlyphs] = createSignal<string[]>([]);
  const [pendingGlyph, setPendingGlyph] = createSignal<PendingGlyph | null>(null);
  const [glyphName, setGlyphName] = createSignal("");
  const [savingGlyph, setSavingGlyph] = createSignal(false);
  let fileInput: HTMLInputElement | undefined;
  let folderInput: HTMLInputElement | undefined;

  const flash = (text: string): void => {
    setMessage(text);
    setTimeout(() => setMessage(""), 2000);
  };

  const sync = createSyncSettings({ setMessage, flash });

  const visibleGlyphs = (): GlyphSummary[] =>
    (glyphList() ?? []).filter((glyph) => !hiddenGlyphs().includes(glyph.name));

  const pickGlyphFile = (file: File | undefined): void => {
    if (!file) {
      return;
    }
    const format = glyphFormatOf(file.name);
    if (!format) {
      setMessage(t().settings.glyphUnsupported);
      return;
    }
    setMessage("");
    setPendingGlyph({ file, format });
    setGlyphName(suggestGlyphName(file.name));
  };

  const cancelGlyph = (): void => {
    setPendingGlyph(null);
    setGlyphName("");
  };

  /**
   * A folder or a multi-selection. Names are taken from the file names without
   * asking, and all are registered at once. core replaces a same name, so it is
   * an overwrite; the hint says so.
   */
  const importGlyphs = async (files: File[]): Promise<void> => {
    const plan = planGlyphImport(files);
    setSavingGlyph(true);
    setMessage("");
    let savedCount = 0;
    let failed = 0;
    try {
      for (const { name, format, file } of plan.ready) {
        try {
          // Written one at a time. There is no reason to make them race into the same folder
          // oxlint-disable-next-line no-await-in-loop
          await typedInvoke("save_glyph", { name, format, dataBase64: await readAsBase64(file) });
          savedCount += 1;
        } catch {
          // One failure does not stop the rest. A broken SVG in the mix still lets the others register
          failed += 1;
        }
      }
      // The registry is reread once, at the end. Reading per file makes the list jump once per file
      await refetchGlyphs();
      await loadGlyphs();
    } finally {
      setSavingGlyph(false);
    }
    flash(t().settings.glyphsImported(savedCount, plan.skipped.length + failed));
  };

  // One file keeps the form that confirms the name. Two or more become a bulk import
  const pickGlyphFiles = (list: FileList | null): void => {
    const files = [...(list ?? [])];
    if (files.length === 1) {
      pickGlyphFile(files[0]);
    } else if (files.length > 1) {
      void importGlyphs(files);
    }
  };

  const saveGlyph = async (): Promise<void> => {
    const pending = pendingGlyph();
    const name = glyphName().trim();
    if (!pending || !isGlyphName(name)) {
      return;
    }
    setSavingGlyph(true);
    setMessage("");
    try {
      await typedInvoke("save_glyph", {
        name,
        format: pending.format,
        dataBase64: await readAsBase64(pending.file),
      });
      cancelGlyph();
      await refetchGlyphs();
      // Reread the renderer's registry too, so the body returned to can look up
      // the image written here right away
      await loadGlyphs();
      flash(t().settings.glyphSaved(name));
    } catch (error) {
      setMessage(t().settings.glyphSaveFailed(String(error)));
    } finally {
      setSavingGlyph(false);
    }
  };

  // Delete + Undo. The same 5-second tombstone as templates
  const removeGlyph = (glyph: GlyphSummary): void => {
    setHiddenGlyphs((names) => [...names, glyph.name]);

    const commit = setTimeout(() => {
      void (async () => {
        await typedInvoke("delete_glyph", { name: glyph.name });
        await refetchGlyphs();
        await loadGlyphs();
        setHiddenGlyphs((names) => names.filter((name) => name !== glyph.name));
      })();
    }, UNDO_MS);

    shell.showToast(t().settings.glyphDeleted, () => {
      clearTimeout(commit);
      setHiddenGlyphs((names) => names.filter((name) => name !== glyph.name));
    });
  };

  const records = (): JSX.Element => (
    <>
      {/* Template management is its own screen (`ROUTES.TEMPLATES`). This is the
          entry to it, and the whole row is pressable */}
      <A
        href={ROUTES.TEMPLATES}
        class="settings-row settings-row--link"
        aria-label={t().templates.manage}
      >
        <div class="settings-row-head">
          <div class="settings-row-label">{t().templates.title}</div>
          <p class="settings-row-desc">{t().templates.manageHint}</p>
        </div>
        <div class="settings-row-value">
          <span>{t().templates.count((templates() ?? []).length)}</span>
          <Icon name="caret-right" size={14} />
        </div>
      </A>

      <Row label={t().settings.glyphs} desc={t().settings.glyphsHint} tall>
        <Show
          when={visibleGlyphs().length > 0}
          fallback={<p class="settings-hint">{t().settings.glyphsEmpty}</p>}
        >
          <ul class="glyph-list" aria-label={t().settings.glyphs}>
            <For each={visibleGlyphs()}>
              {(glyph) => (
                <li class="glyph-row">
                  {/* A thumbnail. Only the frame when the image has not arrived (not in the registry) */}
                  <span class="glyph-thumb">
                    <Show when={glyphs().get(glyph.name)}>
                      {(url) => <img class="glyph" src={url()} alt="" draggable={false} />}
                    </Show>
                  </span>
                  <code class="glyph-code">:{glyph.name}:</code>
                  <span class="glyph-meta">
                    {glyph.format} · {Math.max(1, Math.round(glyph.bytes / 1024))} KB
                  </span>
                  <button
                    type="button"
                    class="icon-button glyph-remove"
                    title={t().settings.deleteGlyph(glyph.name)}
                    aria-label={t().settings.deleteGlyph(glyph.name)}
                    onClick={() => removeGlyph(glyph)}
                  >
                    <Icon name="trash" size={16} />
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>

        <Show
          when={pendingGlyph()}
          fallback={
            <div class="settings-actions">
              <button
                type="button"
                class="button-secondary"
                disabled={savingGlyph()}
                onClick={() => fileInput?.click()}
              >
                <Icon name="plus" size={14} />
                {t().settings.addGlyph}
              </button>
              <button
                type="button"
                class="button-secondary"
                disabled={savingGlyph()}
                onClick={() => folderInput?.click()}
              >
                <Icon name="folder" size={14} />
                {t().settings.addGlyphsFolder}
              </button>
              {/* No dialog plugin is added. The browser's file picker is enough */}
              <input
                ref={fileInput}
                type="file"
                class="glyph-file"
                accept=".png,.svg,image/png,image/svg+xml"
                multiple
                aria-label={t().settings.addGlyph}
                onChange={(e) => {
                  pickGlyphFiles(e.currentTarget.files);
                  // So that choosing the same file again still fires change
                  e.currentTarget.value = "";
                }}
              />
              {/* webkitdirectory is non-standard, but every engine reads it for a
                  folder pick. It is not in Solid's JSX types, so it is set through
                  a ref. Android's WebView sometimes cannot show it, so the
                  multi-select input above is kept as well. accept has no effect on
                  a folder pick; planGlyphImport does the filtering of the contents */}
              <input
                ref={(el) => {
                  folderInput = el;
                  el.setAttribute("webkitdirectory", "");
                }}
                type="file"
                class="glyph-file"
                multiple
                aria-label={t().settings.addGlyphsFolder}
                onChange={(e) => {
                  pickGlyphFiles(e.currentTarget.files);
                  e.currentTarget.value = "";
                }}
              />
            </div>
          }
        >
          {(pending) => (
            <div class="glyph-form">
              <span class="glyph-thumb">
                <img
                  class="glyph"
                  src={URL.createObjectURL(pending().file)}
                  alt=""
                  draggable={false}
                />
              </span>
              <div class="settings-field glyph-form-name">
                <label class="settings-field">
                  <span class="settings-field-label">{t().settings.glyphName}</span>
                  <input
                    type="text"
                    class="settings-input"
                    value={glyphName()}
                    onInput={(e) => setGlyphName(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !isImeComposing(e)) {
                        void saveGlyph();
                      }
                    }}
                    autocapitalize="off"
                    autocorrect="off"
                    spellcheck={false}
                  />
                </label>
                <span class="settings-hint">{t().settings.glyphNameHint}</span>
              </div>
              <div class="settings-actions">
                <button
                  type="button"
                  class="button-primary"
                  onClick={() => {
                    void saveGlyph();
                  }}
                  disabled={savingGlyph() || !isGlyphName(glyphName().trim())}
                >
                  {savingGlyph() ? t().common.saving : t().common.save}
                </button>
                <button type="button" class="button-secondary" onClick={cancelGlyph}>
                  {t().common.cancel}
                </button>
              </div>
            </div>
          )}
        </Show>
        <p class="settings-hint">{t().settings.glyphsFolderHint}</p>
      </Row>

      {/* Where records come from outside the app (38, 67, 78): told and tried here */}
      <OutsideRows onSaid={(text) => shell.showToast(text)} />
    </>
  );

  const rowsOf = (id: SettingsPage): JSX.Element => {
    switch (id) {
      case "general": {
        return <GeneralPage />;
      }
      case "records": {
        return records();
      }
      case "sync": {
        return <SyncPage sync={sync} />;
      }
    }
  };

  return (
    <div class="settings" classList={{ "settings--page": pageOpen() }} ref={rootRef}>
      <nav class="settings-nav" aria-label={t().settings.title} ref={navRef}>
        <h1 class="settings-title">{t().settings.title}</h1>
        <For each={SETTINGS_PAGES}>
          {(id) => (
            <button
              type="button"
              class="settings-nav-row"
              classList={{ "settings-nav-row--on": page() === id }}
              aria-current={page() === id ? "page" : undefined}
              onClick={() => {
                setPage(id);
                setPageOpen(true);
              }}
            >
              <Icon name={PAGE_ICONS[id]} size={15} />
              <span class="settings-nav-text">
                <span>{t().settings.pages[id].title}</span>
                <Show when={t().settings.pages[id].hint}>
                  {(hint) => <span class="settings-nav-hint">{hint()}</span>}
                </Show>
              </span>
              {/* The "go to page" mark, shown only on mobile where pages come one at a time */}
              <span class="settings-nav-caret">
                <Icon name="caret-right" size={14} />
              </span>
            </button>
          )}
        </For>
        <Show when={version()}>
          {(built) => <p class="settings-version">{t().settings.versionLine(built())}</p>}
        </Show>
      </nav>

      {/* A page is rebuilt on every switch. That is where the 8px rise-in motion runs */}
      <div class="settings-page" ref={pageRef}>
        <Show when={page()} keyed>
          {(id) => (
            <div class="settings-page-inner">
              <div class="settings-page-head">
                <h2 class="settings-page-title">{t().settings.pages[id].title}</h2>
              </div>
              <p class="settings-page-lead">{t().settings.pages[id].lead}</p>

              {rowsOf(id)}

              <Show when={message()}>
                <p class="settings-message">{message()}</p>
              </Show>
            </div>
          )}
        </Show>
      </div>
    </div>
  );
}
