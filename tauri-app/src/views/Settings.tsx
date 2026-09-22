import { createResource, createSignal, For, onMount, onCleanup, Show } from "solid-js";
import { A } from "@solidjs/router";
// Kobalte is imported only from a per-route lazy chunk. This is Settings, so it
// stays out of the startup bundle (`.claude/skills/ui-design/SKILL.md`)
import { Switch } from "@kobalte/core/switch";
import { ToggleGroup } from "@kobalte/core/toggle-group";
import Icon from "../components/Icon";
import type { IconName } from "../components/Icon";
import { typedInvoke } from "../lib/commands";
import type { GlyphSummary } from "../lib/commands";
import { EVENTS } from "../lib/events";
import { enterFullscreen, readStartFullscreen, writeStartFullscreen } from "../lib/fullscreen";
import {
  glyphFormatOf,
  glyphs,
  isGlyphName,
  loadGlyphs,
  planGlyphImport,
  suggestGlyphName,
} from "../lib/glyphs";
import { applyLocale, readStoredLocale, t } from "../lib/i18n";
import type { LocalePreference } from "../lib/i18n";
import { isMacDesktop } from "../lib/platform";
import { isImeComposing } from "../lib/ime";
import { ROUTES } from "../lib/routes";
import { useShell } from "../lib/shell";
import { chooseTheme, theme, THEMES } from "../lib/theme";
import { syncErrorKind } from "../lib/sync-status";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import "../styles/settings.css";
import type { JSX } from "solid-js";

const UNDO_MS = 5000;

/** The three pages of Settings. The order is the nav order. */
type PageId = "general" | "records" | "sync";

const PAGE_IDS: readonly PageId[] = ["general", "records", "sync"] as const;

const PAGE_ICONS: Record<PageId, IconName> = {
  general: "circle-half",
  records: "file-text",
  sync: "cloud-check",
};

/** The Workers URL field. An ID is needed to tie the row's label to it with `for`. */
const WORKERS_URL_FIELD = "settings-workers-url";

/** An image chosen but not yet registered. Saved once a name is decided. */
interface PendingGlyph {
  file: File;
  format: "png" | "svg";
}

/**
 * A choice of three or fewer. Not enough to justify a menu that opens to pick from.
 *
 * AIDEV-NOTE: do not add `data-key` inside a ToggleGroup. Kobalte looks up the
 * roving focus target by `[data-key]`, so it collides with the Cmd badge marker
 */
function Seg<T extends string>(props: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onPick: (value: T) => void;
}): JSX.Element {
  return (
    <ToggleGroup
      class="settings-seg"
      aria-label={props.label}
      value={props.value}
      // Pressing the selected item again makes Kobalte return null. Settings has
      // no "nothing selected" state, so that report is dropped
      onChange={(value) => {
        if (value !== null) {
          props.onPick(value as T);
        }
      }}
    >
      <For each={props.options}>
        {([value, label]) => (
          <ToggleGroup.Item class="settings-seg-item" value={value}>
            {label}
          </ToggleGroup.Item>
        )}
      </For>
    </ToggleGroup>
  );
}

/**
 * One Settings row. Label and description on the left, the control on the right.
 * Only a row given `labelFor` gets a real `<label>` as its label: `for` has no
 * effect on a ToggleGroup or a group of switches, so only rows with a field get one.
 */
function Row(props: {
  label: string;
  desc?: string;
  labelFor?: string;
  /** A tall control (glyph management, Workers URL) is aligned to the top edge. */
  tall?: boolean;
  children: JSX.Element;
}): JSX.Element {
  return (
    <div class="settings-row" classList={{ "settings-row--tall": props.tall }}>
      <div class="settings-row-head">
        <Show when={props.labelFor} fallback={<div class="settings-row-label">{props.label}</div>}>
          {(field) => (
            <label class="settings-row-label" for={field()}>
              {props.label}
            </label>
          )}
        </Show>
        <Show when={props.desc}>{(desc) => <p class="settings-row-desc">{desc()}</p>}</Show>
      </div>
      <div class="settings-row-control">{props.children}</div>
    </div>
  );
}

/** An on / off row. The Kobalte Switch is the row itself. */
function SwitchRow(props: {
  label: string;
  desc: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}): JSX.Element {
  return (
    <Switch
      class="settings-row"
      checked={props.checked}
      onChange={(checked) => props.onChange(checked)}
    >
      <div class="settings-row-head">
        <Switch.Label class="settings-row-label">{props.label}</Switch.Label>
        <Switch.Description class="settings-row-desc">{props.desc}</Switch.Description>
      </div>
      <Switch.Input />
      <div class="settings-row-control">
        <Switch.Control class="settings-switch">
          <Switch.Thumb class="settings-switch-thumb" />
        </Switch.Control>
      </div>
    </Switch>
  );
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
  /** The page shown. Mobile shows only the list until one is opened (`settings--page`). */
  const [page, setPage] = createSignal<PageId>("general");
  const [pageOpen, setPageOpen] = createSignal(false);
  const [workersUrl, setWorkersUrl] = createSignal("");
  const [authenticated, setAuthenticated] = createSignal(false);
  const [editable, setEditable] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const [localePreference, setLocalePreference] =
    createSignal<LocalePreference>(readStoredLocale());
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

  const chooseLocale = (preference: LocalePreference): void => {
    setLocalePreference(preference);
    applyLocale(preference);
  };

  const [startFullscreen, setStartFullscreen] = createSignal(readStartFullscreen());

  const chooseStartFullscreen = (on: boolean): void => {
    setStartFullscreen(on);
    writeStartFullscreen(on);
    // Turning it on goes fullscreen right now instead of waiting for next launch.
    // Turning it off touches nothing: a Settings action has no reason to leave
    // the fullscreen in use right now
    if (on) {
      void enterFullscreen();
    }
  };

  const unlisteners: UnlistenFn[] = [];

  onMount(async () => {
    try {
      const config = await typedInvoke("get_sync_config");
      setWorkersUrl(config.workers_url);
    } catch (error) {
      // Opened with nothing configured, it starts blank. Only a corrupt config is
      // reported: if it looked like a blank one, a save meant as a re-entry would overwrite it
      if (syncErrorKind(error) === "configCorrupt") {
        setMessage(t().sync.configCorrupt);
      }
    }

    try {
      setEditable(await typedInvoke("is_sync_config_editable"));
    } catch {
      setEditable(false);
    }

    try {
      setAuthenticated(await typedInvoke("auth_status"));
    } catch {
      setAuthenticated(false);
    }

    // On Android the sign-in completes through a deep link, so the state is updated from events
    unlisteners.push(
      await listen(EVENTS.AUTH_SUCCESS, () => {
        setAuthenticated(true);
        flash(t().settings.signedInMessage);
      }),
      await listen<string>(EVENTS.AUTH_ERROR, (e) => {
        setAuthenticated(false);
        setMessage(t().settings.signInFailed(String(e.payload)));
      }),
    );
  });

  onCleanup(() => {
    for (const unlisten of unlisteners) {
      unlisten();
    }
  });

  const save = async (): Promise<void> => {
    setSaving(true);
    setMessage("");
    try {
      // auto_sync belongs to the sync popover, so its current value is kept and written back
      const current = await typedInvoke("get_sync_config");
      await typedInvoke("save_sync_config", {
        config: { ...current, workers_url: workersUrl() },
      });
      flash(t().common.saved);
    } catch (error) {
      setMessage(t().settings.saveFailed(String(error)));
    } finally {
      setSaving(false);
    }
  };

  const login = async (): Promise<void> => {
    setMessage(t().settings.continueSignIn);
    try {
      // Desktop finishes the sign-in in an in-app window; the token is saved by the time the command returns.
      // Android only opens the browser; completion is reported by the auth-success deep link
      await typedInvoke("auth_login");
      const status = await typedInvoke("auth_status");
      setAuthenticated(status);
      if (status) {
        flash(t().settings.signedInMessage);
      }
    } catch (error) {
      setMessage(t().settings.signInFailed(String(error)));
    }
  };

  const logout = async (): Promise<void> => {
    try {
      await typedInvoke("auth_logout");
      setAuthenticated(false);
      flash(t().settings.signedOutMessage);
    } catch (error) {
      setMessage(t().settings.signOutFailed(String(error)));
    }
  };

  const general = (): JSX.Element => (
    <>
      <Row label={t().settings.language} desc={t().settings.languageDesc}>
        {/* Unlike the theme, this cannot be a cycling button. Each press would pass through a language you cannot read */}
        <Seg
          label={t().settings.language}
          value={localePreference()}
          options={
            [
              ["system", t().settings.languageSystem],
              ["ja", t().settings.languageJa],
              ["en", t().settings.languageEn],
            ] as [LocalePreference, string][]
          }
          onPick={chooseLocale}
        />
      </Row>

      {/* Moved here from the cycling button in the header. Something touched a
          few times a year was sitting where it was seen every time */}
      <Row label={t().settings.theme} desc={t().settings.themeDesc}>
        <Seg
          label={t().settings.theme}
          value={theme()}
          options={THEMES.map((choice) => [choice, t().theme[choice]] as const)}
          onPick={chooseTheme}
        />
      </Row>

      {/* Only macOS has a window that can go fullscreen. On Android the switch would do nothing */}
      <Show when={isMacDesktop()}>
        <SwitchRow
          label={t().settings.startFullscreen}
          desc={t().settings.startFullscreenHint}
          checked={startFullscreen()}
          onChange={chooseStartFullscreen}
        />
      </Show>
    </>
  );

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
    </>
  );

  const sync = (): JSX.Element => (
    <>
      <Row
        label={t().settings.workersUrl}
        desc={t().settings.workersUrlDesc}
        labelFor={editable() ? WORKERS_URL_FIELD : undefined}
        tall
      >
        <Show
          when={editable()}
          fallback={
            // Read-only where the config file fixes it
            <p class="settings-readonly">{workersUrl() || t().settings.notSet}</p>
          }
        >
          <input
            id={WORKERS_URL_FIELD}
            type="url"
            class="settings-input settings-input--mono"
            value={workersUrl()}
            onInput={(e) => setWorkersUrl(e.currentTarget.value)}
            placeholder="https://....workers.dev"
          />
          <div class="settings-actions">
            <button
              type="button"
              class="button-primary"
              onClick={() => {
                void save();
              }}
              disabled={saving()}
            >
              {saving() ? t().common.saving : t().common.save}
            </button>
          </div>
        </Show>
      </Row>

      <Row label={t().settings.account} desc={t().settings.accountDesc} tall>
        <p class="settings-status">
          <span class="settings-dot" classList={{ "settings-dot--on": authenticated() }} />
          {authenticated() ? t().settings.signedIn : t().settings.notSignedIn}
        </p>

        <div class="settings-actions">
          <Show
            when={authenticated()}
            fallback={
              <button
                type="button"
                class="button-primary"
                onClick={() => {
                  void login();
                }}
                disabled={!workersUrl().trim()}
              >
                {t().settings.signInGoogle}
              </button>
            }
          >
            <button
              type="button"
              class="button-secondary"
              onClick={() => {
                void logout();
              }}
            >
              {t().settings.signOut}
            </button>
          </Show>
        </div>

        <Show when={!authenticated() && !workersUrl().trim()}>
          <p class="settings-hint">{t().settings.signInHint}</p>
        </Show>
      </Row>
    </>
  );

  const rowsOf = (id: PageId): JSX.Element => {
    switch (id) {
      case "general": {
        return general();
      }
      case "records": {
        return records();
      }
      case "sync": {
        return sync();
      }
    }
  };

  return (
    <div class="settings" classList={{ "settings--page": pageOpen() }}>
      <nav class="settings-nav" aria-label={t().settings.title}>
        <h1 class="settings-title">{t().settings.title}</h1>
        <For each={PAGE_IDS}>
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
      <div class="settings-page">
        <Show when={page()} keyed>
          {(id) => (
            <div class="settings-page-inner">
              <div class="settings-page-head">
                {/* The way back to the list. Only meaningful on mobile, where pages come one at a time */}
                <button
                  type="button"
                  class="icon-button settings-back"
                  aria-label={t().settings.backToPages}
                  onClick={() => setPageOpen(false)}
                >
                  <Icon name="arrow-left" size={18} />
                </button>
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
