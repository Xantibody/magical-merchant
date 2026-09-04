/**
 * Tauri がウェブビューに置く内部 API。公開の型は無いので、モックが名乗る
 * ぶんだけを書く。
 */
interface TauriInternals {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  transformCallback: () => number;
  unregisterCallback: () => void;
  convertFileSrc: (path: string) => string;
  metadata: { currentWindow: { label: string }; currentWebview: { label: string } };
}

// globalThis に名前を生やす宣言は `var` しか書けない
// oxlint-disable-next-line no-var, vars-on-top
declare var __TAURI_INTERNALS__: TauriInternals | undefined;
