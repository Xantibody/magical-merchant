/**
 * The general page of Settings: the language, the theme, and the window at startup.
 */

import { createSignal, Show } from "solid-js";
import type { JSX } from "solid-js";
import { enterFullscreen, readStartFullscreen, writeStartFullscreen } from "../../lib/fullscreen";
import { applyLocale, readStoredLocale, t } from "../../lib/i18n";
import type { LocalePreference } from "../../lib/i18n";
import { isMacDesktop } from "../../lib/platform";
import { chooseTheme, theme, THEMES } from "../../lib/theme";
import { Row, Seg, SwitchRow } from "./Rows";

export default function GeneralPage(): JSX.Element {
  // Read again each time the page is built. Every choice is stored as it is made, so this
  // reads back the last one; unlike the sync state, nothing here has to outlive the page
  const [localePreference, setLocalePreference] =
    createSignal<LocalePreference>(readStoredLocale());

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

  return (
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
}
