import { lazy } from "solid-js";
import { Router, Route } from "@solidjs/router";
import AppLayout from "./layouts/AppLayout";
import Scrawl from "./views/Scrawl";
import { ROUTES } from "./lib/routes";
import type { JSX } from "solid-js";

// Views not shown at startup are lazy-loaded to keep the initial bundle small.
// Workspace drags in Milkdown + ProseMirror + Shiki; taking it out alone
// greatly reduces the JS parsed at startup.
const Workspace = lazy(() => import("./views/Workspace"));
// Codex is another face of the same Workspace. Only the directory it reads differs;
// once open, writing works the same, so there are not two screens
const Codex = (): JSX.Element => <Workspace kind="codex" />;
const Settings = lazy(() => import("./views/Settings"));
// The Browse screen. An entry on the rail, but not something visible at startup
const Browse = lazy(() => import("./views/Browse"));
// Template management is a screen under Settings. Even fewer people open it,
// so it is not prefetched either
const Templates = lazy(() => import("./views/Templates"));

// In exchange for the lazy loading, read them in the background once startup settles.
// Without this, the first opening of the Note tab has a loading wait in the way
function prefetchLazyViews(): void {
  const idle: (task: () => void) => unknown =
    typeof requestIdleCallback === "function"
      ? requestIdleCallback
      : (task) => setTimeout(task, 2000);
  idle(() => {
    void import("./views/Workspace");
    void import("./views/Settings");
    void import("./views/Browse");
  });
}

export default function App(): JSX.Element {
  prefetchLazyViews();
  return (
    <Router root={AppLayout}>
      <Route path={ROUTES.SCRAWL} component={Scrawl} />
      <Route path={ROUTES.NOTES} component={Workspace} />
      <Route path={ROUTES.CODEX} component={Codex} />
      <Route path={ROUTES.BROWSE} component={Browse} />
      <Route path={ROUTES.SETTINGS} component={Settings} />
      <Route path={ROUTES.TEMPLATES} component={Templates} />
    </Router>
  );
}
