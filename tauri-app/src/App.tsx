import { Router, Route } from "@solidjs/router";
import AppLayout from "./layouts/AppLayout";
import Timeline from "./views/Timeline";
import Notes from "./views/Notes";
import Tasks from "./views/Tasks";
import Settings from "./views/Settings";
import { ROUTES } from "./lib/routes";

export default function App() {
  return (
    <Router root={AppLayout}>
      <Route path={ROUTES.TIMELINE} component={Timeline} />
      <Route path={ROUTES.NOTES} component={Notes} />
      <Route path={ROUTES.TASKS} component={Tasks} />
      <Route path={ROUTES.SETTINGS} component={Settings} />
    </Router>
  );
}
