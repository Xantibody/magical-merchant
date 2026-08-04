import { lazy } from "solid-js";
import { Router, Route } from "@solidjs/router";
import AppLayout from "./layouts/AppLayout";
import Timeline from "./views/Timeline";
import { ROUTES } from "./lib/routes";
import type { JSX } from "solid-js";

// 起動時に表示しない view は遅延読み込みして初期バンドルを軽くする
const Notes = lazy(() => import("./views/Notes"));
const Tasks = lazy(() => import("./views/Tasks"));
const Settings = lazy(() => import("./views/Settings"));

export default function App(): JSX.Element {
  return (
    <Router root={AppLayout}>
      <Route path={ROUTES.TIMELINE} component={Timeline} />
      <Route path={ROUTES.NOTES} component={Notes} />
      <Route path={ROUTES.TASKS} component={Tasks} />
      <Route path={ROUTES.SETTINGS} component={Settings} />
    </Router>
  );
}
