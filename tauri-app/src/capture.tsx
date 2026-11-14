import { render } from "solid-js/web";
import CaptureWindow from "./views/CaptureWindow";
import "./capture.css";

// The floating window's own entry (capture.html): the pill and nothing of the app around it, so
// the window the OS key shows is a small page that is already up when the key comes
const root = document.querySelector("#root");
if (!root) {
  throw new Error("missing #root element");
}

render(() => <CaptureWindow />, root);
