import { lazy } from "solid-js";
import { Router, Route } from "@solidjs/router";
import AppLayout from "./layouts/AppLayout";
import Workspace from "./views/Workspace";
import { ROUTES } from "./lib/routes";
import type { JSX } from "solid-js";

// 起動時に表示しない view は遅延読み込みして初期バンドルを軽くする
const Settings = lazy(() => import("./views/Settings"));

export default function App(): JSX.Element {
  return (
    <Router root={AppLayout}>
      <Route path={ROUTES.TIMELINE} component={() => <Workspace tab="timeline" />} />
      <Route path={ROUTES.NOTES} component={() => <Workspace tab="notes" />} />
      <Route path={ROUTES.SETTINGS} component={Settings} />
    </Router>
  );
}
