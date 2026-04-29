import { Router, Route } from "@solidjs/router";
import AppLayout from "./layouts/AppLayout";
import Timeline from "./views/Timeline";
import Notes from "./views/Notes";
import Tasks from "./views/Tasks";
import Settings from "./views/Settings";

export default function App() {
  return (
    <Router root={AppLayout}>
      <Route path="/" component={Timeline} />
      <Route path="/notes" component={Notes} />
      <Route path="/tasks" component={Tasks} />
      <Route path="/settings" component={Settings} />
    </Router>
  );
}
