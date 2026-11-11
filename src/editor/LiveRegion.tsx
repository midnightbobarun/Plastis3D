// src/editor/LiveRegion.tsx — the polite live region (Phase 0, 0-B).
//
// One visually-hidden `div aria-live="polite"` per surface (the pane
// and the editor route each render one), mounted once per surface,
// never on the stats line. Both regions read the single shared
// announcer store (src/state/announcer.ts), so a broadcast-driven
// revision change is announced once across surfaces even when both
// are mounted (round-3 Issue 9 erratum).
//
// The announce() call sites land with G-06 (Phase 4); until then the
// region renders empty and inert.

import type { CSSProperties } from "react";
import { useAnnouncer } from "../state/announcer";

/** Visually hidden but exposed to assistive technology. */
const visuallyHiddenStyle: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
};

export function LiveRegion(): React.JSX.Element {
  const snapshot = useAnnouncer();
  return (
    <div
      aria-live="polite"
      role="status"
      aria-atomic="true"
      style={visuallyHiddenStyle}
    >
      {snapshot.message}
    </div>
  );
}
