import { createResource, createSignal, For, onMount, onCleanup, Show } from "solid-js";
import { A } from "@solidjs/router";
import Icon from "../components/Icon";
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
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import "../styles/settings.css";
import type { JSX } from "solid-js";

const UNDO_MS = 5000;

/** 選んだが、まだ登録していない画像。名前を決めてから保存する。 */
interface PendingGlyph {
  file: File;
  format: "png" | "svg";
}

/** 画像ファイルを base64 に。IPC は文字列しか運ばない。 */
async function readAsBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  // 一度に fromCodePoint へ渡すと引数の上限に当たる。上限の 256 KiB でも刻む
  for (let at = 0; at < bytes.length; at += 0x80_00) {
    binary += String.fromCodePoint(...bytes.subarray(at, at + 0x80_00));
  }
  return btoa(binary);
}

export default function Settings(): JSX.Element {
  const shell = useShell();
  const [workersUrl, setWorkersUrl] = createSignal("");
  const [authenticated, setAuthenticated] = createSignal(false);
  const [editable, setEditable] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const [localePreference, setLocalePreference] =
    createSignal<LocalePreference>(readStoredLocale());
  const [templates] = createResource(() => typedInvoke("list_templates"));
  const [glyphList, { refetch: refetchGlyphs }] = createResource(() => typedInvoke("list_glyphs"));
  /** 削除の猶予中で、一覧から隠している名前。 */
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
   * フォルダや複数選択。名前は訊かずファイル名から決めて、まとめて登録する。
   * 同じ名前は core が置き換えるので上書きになる — ヒントにそう書いてある。
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
          // 一枚ずつ書く。同じフォルダへ一斉に書かせて競わせる理由がない
          // oxlint-disable-next-line no-await-in-loop
          await typedInvoke("save_glyph", { name, format, dataBase64: await readAsBase64(file) });
          savedCount += 1;
        } catch {
          // 一枚の失敗で残りを止めない。壊れた SVG が混ざっていても他は登録する
          failed += 1;
        }
      }
      // 登録表は最後に一度だけ読み直す。一枚ごとに読むと一覧が枚数分跳ねる
      await refetchGlyphs();
      await loadGlyphs();
    } finally {
      setSavingGlyph(false);
    }
    flash(t().settings.glyphsImported(savedCount, plan.skipped.length + failed));
  };

  // 一枚なら名前を確かめる形のまま。二枚以上でまとめ登録になる
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
      // 描画側の登録表も読み直す。ここで書いた画像を、戻った先の本文が
      // すぐ引けるように
      await loadGlyphs();
      flash(t().settings.glyphSaved(name));
    } catch (error) {
      setMessage(t().settings.glyphSaveFailed(String(error)));
    } finally {
      setSavingGlyph(false);
    }
  };

  // 削除 + Undo。テンプレと同じ 5 秒の tombstone
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
    // 入れた側は次回を待たせずその場で全画面にする。切った側は触らない —
    // いま全画面で使っているのを設定の操作で解く理由はない
    if (on) {
      void enterFullscreen();
    }
  };

  const unlisteners: UnlistenFn[] = [];

  onMount(async () => {
    try {
      const config = await typedInvoke("get_sync_config");
      setWorkersUrl(config.workers_url);
    } catch {
      // 未設定のまま開いた場合。空欄で始める
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

    // Android はディープリンク経由で認証が完了するので、イベントで状態を反映する
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
      // auto_sync は同期ポップオーバー側が持つ設定なので、現在値を保って書き戻す
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
      // デスクトップはアプリ内の窓でログインを終え、コマンド完了時点でトークン保存済み。
      // Android はブラウザを開くだけで、完了はディープリンクの auth-success で通知される
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

  return (
    <div class="settings-scroll">
      <div class="settings">
        <h1 class="settings-title">{t().settings.title}</h1>

        <section class="settings-section">
          <h2 class="settings-section-label">LANGUAGE</h2>
          {/* テーマと違い巡回では選べない。押すたびに読めない言語を通る */}
          <div class="settings-choices" role="radiogroup" aria-label={t().settings.language}>
            <For
              each={
                [
                  ["system", t().settings.languageSystem],
                  ["ja", t().settings.languageJa],
                  ["en", t().settings.languageEn],
                ] as [LocalePreference, string][]
              }
            >
              {([preference, label]) => (
                <button
                  type="button"
                  role="radio"
                  class="settings-choice"
                  classList={{ "settings-choice--on": localePreference() === preference }}
                  aria-checked={localePreference() === preference}
                  onClick={() => chooseLocale(preference)}
                >
                  {label}
                </button>
              )}
            </For>
          </div>
        </section>

        {/* 全画面の窓があるのは macOS だけ。Android に出しても何も起きない */}
        <Show when={isMacDesktop()}>
          <section class="settings-section">
            <h2 class="settings-section-label">WINDOW</h2>
            <label class="settings-toggle">
              <span>{t().settings.startFullscreen}</span>
              <input
                type="checkbox"
                checked={startFullscreen()}
                onChange={(e) => chooseStartFullscreen(e.currentTarget.checked)}
              />
              <span class="switch" aria-hidden="true" />
            </label>
            <p class="settings-hint">{t().settings.startFullscreenHint}</p>
          </section>
        </Show>

        <section class="settings-section">
          <h2 class="settings-section-label">TEMPLATES</h2>
          <A href={ROUTES.TEMPLATES} class="settings-link">
            <Icon name="file-text" size={16} />
            <span class="settings-link-label">{t().templates.manage}</span>
            <span class="settings-link-count">
              {t().templates.count((templates() ?? []).length)}
            </span>
            <Icon name="caret-right" size={14} />
          </A>
          <p class="settings-hint">{t().templates.manageHint}</p>
        </section>

        <section class="settings-section">
          <h2 class="settings-section-label">GLYPHS</h2>
          <Show
            when={visibleGlyphs().length > 0}
            fallback={<p class="settings-hint">{t().settings.glyphsEmpty}</p>}
          >
            <ul class="glyph-list" aria-label={t().settings.glyphs}>
              <For each={visibleGlyphs()}>
                {(glyph) => (
                  <li class="glyph-row">
                    {/* 縮小表示。画像が届いていない(登録表に無い)ときは枠だけ */}
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
                {/* ダイアログのプラグインは入れない。ファイル選択はブラウザで足りる */}
                <input
                  ref={fileInput}
                  type="file"
                  class="glyph-file"
                  accept=".png,.svg,image/png,image/svg+xml"
                  multiple
                  aria-label={t().settings.addGlyph}
                  onChange={(e) => {
                    pickGlyphFiles(e.currentTarget.files);
                    // 同じファイルを選び直しても change が飛ぶように
                    e.currentTarget.value = "";
                  }}
                />
                {/* webkitdirectory は標準外だが、どのエンジンもフォルダ選択に
                    これを見る。Solid の JSX 型に無いので ref で付ける。
                    Android の WebView は出せないことがあるので、上の複数選択の
                    input も残している。accept はフォルダ選択では効かない —
                    中身の選別は planGlyphImport がやる */}
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
          <p class="settings-hint">{t().settings.glyphsHint}</p>
          <p class="settings-hint">{t().settings.glyphsFolderHint}</p>
        </section>

        <section class="settings-section">
          <h2 class="settings-section-label">SERVER</h2>
          <Show
            when={editable()}
            fallback={
              <p class="settings-readonly">
                Workers URL
                <span>{workersUrl() || t().settings.notSet}</span>
              </p>
            }
          >
            <label class="settings-field">
              <span class="settings-field-label">Workers URL</span>
              <input
                type="url"
                class="settings-input"
                value={workersUrl()}
                onInput={(e) => setWorkersUrl(e.currentTarget.value)}
                placeholder="https://....workers.dev"
              />
            </label>
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
        </section>

        <section class="settings-section">
          <h2 class="settings-section-label">ACCOUNT</h2>

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
        </section>

        <Show when={message()}>
          <p class="settings-message">{message()}</p>
        </Show>
      </div>
    </div>
  );
}
