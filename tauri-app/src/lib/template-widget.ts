import { typedInvoke } from "./commands";

/**
 * The Android home-screen button for one template (the template editor's
 * "add a button to the home screen").
 *
 * Whether to offer it at all. A failed call reads as "no": the entry is an
 * extra, and a menu that throws over it would lose the ones that work.
 */
export async function canPinTemplateWidget(): Promise<boolean> {
  try {
    return await typedInvoke("template_widget_pinnable");
  } catch {
    return false;
  }
}

/**
 * Asks the launcher to place the button. `true` means the system's own
 * confirmation is now on screen — the toast should wait for nothing more,
 * because declining there is never reported back.
 */
export function pinTemplateWidget(filename: string): Promise<boolean> {
  return typedInvoke("pin_template_widget", { filename });
}
