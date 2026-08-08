import { lazy } from "solid-js";
import { Router, Route } from "@solidjs/router";
import AppLayout from "./layouts/AppLayout";
import Timeline from "./views/Timeline";
import { ROUTES } from "./lib/routes";
import type { JSX } from "solid-js";

// 起動時に表示しない view は遅延読み込みして初期バンドルを軽くする。
// Workspace は Milkdown + ProseMirror + Shiki を引き連れており、
// これを外すだけで起動時に parse する JS が大きく減る。
const Workspace = lazy(() => import("./views/Workspace"));
const Settings = lazy(() => import("./views/Settings"));

// 遅延にした代わりに、起動が落ち着いてから裏で読んでおく。
// これが無いと Notes タブを初めて開いた瞬間に読み込み待ちが挟まる
function prefetchLazyViews(): void {
  const idle: (task: () => void) => unknown =
    typeof requestIdleCallback === "function"
      ? requestIdleCallback
      : (task) => setTimeout(task, 2000);
  idle(() => {
    void import("./views/Workspace");
    void import("./views/Settings");
  });
}

export default function App(): JSX.Element {
  prefetchLazyViews();
  return (
    <Router root={AppLayout}>
      <Route path={ROUTES.TIMELINE} component={Timeline} />
      <Route path={ROUTES.NOTES} component={Workspace} />
      <Route path={ROUTES.SETTINGS} component={Settings} />
    </Router>
  );
}
