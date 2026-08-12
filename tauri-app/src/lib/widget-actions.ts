/** ホーム画面ウィジェットのタップ。 */
export interface WidgetAction {
  name: string;
  file: string | null;
}

/**
 * `magical-merchant://widget/<name>?file=<filename>` を読む。
 * ウィジェット以外の deep link（認証のコールバック）は `null`。
 */
export function parseWidgetAction(raw: string): WidgetAction | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.hostname !== "widget") {
    return null;
  }

  const name = url.pathname.replace(/^\/+/, "");
  if (!name) {
    return null;
  }

  return { name, file: url.searchParams.get("file") };
}

/** 起動 URL には認証のコールバックも混じる。最初のウィジェットリンクを取る。 */
export function firstWidgetAction(urls: readonly string[]): WidgetAction | null {
  for (const url of urls) {
    const action = parseWidgetAction(url);
    if (action) {
      return action;
    }
  }
  return null;
}
