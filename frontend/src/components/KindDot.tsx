import type { JSX } from "solid-js";
import type { HitKind } from "../lib/commands";

/**
 * The one mark of a record's kind in a row (ADR 0013): hollow for a Scrawl line, filled for a
 * Note or a Codex. A title beside the filled dot goes bold in each surface's CSS.
 */
export default function KindDot(props: { kind: HitKind }): JSX.Element {
  return (
    <span
      class="kind-dot"
      classList={{ "kind-dot--filled": props.kind !== "scrawl" }}
      aria-hidden="true"
    />
  );
}
