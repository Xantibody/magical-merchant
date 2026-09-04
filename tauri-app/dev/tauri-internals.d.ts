/**
 * Tauri がウェブビューに置く内部 API。公開の型は無いので、モックが名乗る
 * ぶんだけを書く。
 */
interface TauriInternals {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  /** イベントの受け口を預かって id を返す。本物ではその id を Rust 側が呼ぶ */
  transformCallback: (
    callback: (event: { event: string; id: number; payload: unknown }) => void,
  ) => number;
  unregisterCallback: (id: number) => void;
  convertFileSrc: (path: string) => string;
  metadata: { currentWindow: { label: string }; currentWebview: { label: string } };
}

/** イベントプラグインがウェブビュー側に置く分。unlisten だけがここを通る。 */
interface TauriEventPluginInternals {
  unregisterListener: (event: string, eventId: number) => void;
}

// globalThis に名前を生やす宣言は `var` しか書けない
// oxlint-disable-next-line no-var, vars-on-top
declare var __TAURI_INTERNALS__: TauriInternals | undefined;
// oxlint-disable-next-line no-var, vars-on-top
declare var __TAURI_EVENT_PLUGIN_INTERNALS__: TauriEventPluginInternals | undefined;
