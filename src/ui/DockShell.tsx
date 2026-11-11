// src/ui/DockShell.tsx — the tool dock's frame: a vertical toolbar that folds into one button in a narrow stage.
//
// At normal sizes the toggle is hidden and the tools show as before. When the stage is narrower than 340 px or
// shorter than 440 px while under 700 px wide (measured here) only the toggle shows, carrying the active tool's icon; pressing it opens the
// tools over the stage. Choosing a tool, pressing Escape or moving focus away closes it again.
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "./icons";
import type { IconName } from "./icons";

let closeActiveDock: (() => void) | null = null;

/** Close the open (narrow-stage) dock, if any; true when one was open. The editor's Escape key calls this first. */
export function closeOpenDock(): boolean {
  if (!closeActiveDock) return false;
  closeActiveDock();
  return true;
}

export function DockShell({
  label,
  className,
  activeIcon,
  children,
}: {
  label: string;
  className: string;
  activeIcon: IconName;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [folded, setFolded] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // Fold the dock when its stage is narrow (under 340 px), or both fairly narrow (under 700 px) and short (under 440 px):
  // the full column would not fit. A wide stage that is merely short has room beside it.
  useEffect(() => {
    const stage = rootRef.current?.parentElement;
    if (!stage || typeof ResizeObserver === "undefined") return undefined;
    const measure = () => setFolded(stage.clientWidth < 340 || (stage.clientWidth < 700 && stage.clientHeight < 440));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);
  // While open: a press anywhere else folds the dock, and the editor's Escape key can fold it too (focus
  // usually sits on the editor root, not in the dock, so the dock cannot rely on its own key events).
  useEffect(() => {
    if (!open) return undefined;
    const fold = () => setOpen(false);
    const onDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) fold();
    };
    document.addEventListener("pointerdown", onDown, true);
    closeActiveDock = fold;
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      if (closeActiveDock === fold) closeActiveDock = null;
    };
  }, [open]);
  return (
    <div
      ref={rootRef}
      role="toolbar"
      aria-label={label}
      aria-orientation="vertical"
      className={className}
      data-open={open}
      data-folded={folded}
      onClick={(event) => {
        // A tool button was chosen: fold the dock again (the Snap summary keeps it open).
        if (open && (event.target as HTMLElement).closest(".p3d-dock-tools button")) setOpen(false);
      }}
    >
      <button
        type="button"
        className="p3d-iconbtn p3d-dock-toggle"
        aria-label="Tools"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name={activeIcon} size={19} />
      </button>
      <div className="p3d-dock-tools">{children}</div>
    </div>
  );
}
