/** ホーム画面ウィジェットのタップ。 */
export interface WidgetAction {
  name: string;
  file: string | null;
  /** テンプレ起動(`template`)のときだけ、どのテンプレかが入る。 */
  template: string | null;
}

/**
 * `magical-merchant://widget/<name>?file=<filename>` を読む。
 * テンプレ起動だけは `?name=<テンプレ名>` を伴う。
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

  const name = url.pathname.replace(/^\/+/u, "");
  if (!name) {
    return null;
  }

  return {
    name,
    file: url.searchParams.get("file"),
    template: url.searchParams.get("name"),
  };
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
