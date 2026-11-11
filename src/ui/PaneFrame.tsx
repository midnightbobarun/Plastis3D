import type { ReactNode } from "react";

/** Keep the host's pane-close gesture discoverable in every pane state. */
export function PaneFrame({ children }: { children: ReactNode }) {
  return (
    <div className="p3d-root p3d-pane-frame">
      <div className="p3d-pane-content">{children}</div>
      <p className="p3d-pane-close-hint">To close this pane, right-click it and choose Close.</p>
    </div>
  );
}
