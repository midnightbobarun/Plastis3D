// src/ui/controls.tsx — controls the SDK has no equivalent for (UI/UX
// redesign §7.1, PR32): ScrubField, AxisRow, Slider, MaterialBall,
// SwatchGrid, Section, Tile, Popover, MenuItem, Segmented.
//
// Every control commits ONCE per gesture (one history entry per drag,
// the same rule as a gizmo drag). Drafts are local; Escape reverts.

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { CSSProperties, ReactNode } from "react";
import { ApiError } from "../api";
import { Icon } from "./icons";
import type { IconName } from "./icons";
import { PALETTE, paletteName } from "./materials";

/** Round to 4 decimals so steps never leave float dust on screen. */
export function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function formatNumber(n: number, digits = 4): string {
  const f = 10 ** digits;
  return String(Math.round(n * f) / f);
}

/** The server message with its leading stable code stripped, one line. */
export function serverMessageOneLine(err: Error): string {
  const first = err.message.split("\n")[0];
  const stripped = first.replace(/^[A-Z][A-Z0-9_]*[ :]\s*/, "");
  return stripped !== "" ? stripped : first;
}

export type CommitErrorHandler = (err: unknown) => void;

// --- ScrubField ------------------------------------------------------------------

export interface ScrubFieldProps {
  /** Visible handle text ("X", "W"); the drag handle. */
  handle?: string;
  /** The accessible name of the input ("TX", "Roughness"). */
  ariaLabel: string;
  value: number;
  step?: number;
  integer?: boolean;
  min?: number;
  max?: number;
  unit?: string;
  axis?: "x" | "y" | "z";
  title?: string;
  onCommit: (value: number) => Promise<unknown>;
  /** Non-SPEC_INVALID failures (the caller toasts). */
  onError?: CommitErrorHandler;
}

function clampTo(v: number, min?: number, max?: number): number {
  let out = v;
  if (min !== undefined && out < min) out = min;
  if (max !== undefined && out > max) out = max;
  return out;
}

/**
 * A numeric field whose label is a drag handle: drag left/right to change
 * the value (Shift ×10, Alt ×0.1), arrows step, typing commits on Enter
 * or blur, Escape reverts. A drag commits once, on release.
 */
export function ScrubField({
  handle,
  ariaLabel,
  value,
  step = 0.1,
  integer = false,
  min,
  max,
  unit,
  axis,
  title,
  onCommit,
  onError,
}: ScrubFieldProps) {
  const [draft, setDraft] = useState(formatNumber(value));
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const dragRef = useRef<{ x: number; start: number; last: number } | null>(null);
  const errorId = useId();

  useEffect(() => {
    if (!focused && !dragging) {
      setDraft(formatNumber(value));
      setError(null);
    }
  }, [value, focused, dragging]);

  const normalise = useCallback(
    (n: number) => clampTo(integer ? Math.round(n) : round4(n), min, max),
    [integer, min, max],
  );

  async function commit(next: number): Promise<void> {
    if (!Number.isFinite(next) || (integer && !Number.isInteger(next))) {
      setDraft(formatNumber(value));
      setError(null);
      return;
    }
    const v = normalise(next);
    if (v === value) {
      setDraft(formatNumber(value));
      return;
    }
    try {
      await onCommit(v);
      setDraft(formatNumber(v));
      setError(null);
    } catch (err) {
      setDraft(formatNumber(value));
      if (err instanceof ApiError && err.code === "SPEC_INVALID") {
        setError(serverMessageOneLine(err));
      } else {
        onError?.(err);
        setError(null);
      }
    }
  }

  function parseDraft(raw: string): number {
    return integer ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
  }

  // Drag on the handle.
  function onPointerDown(e: React.PointerEvent<HTMLSpanElement>): void {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, start: value, last: value };
    setDragging(true);
  }
  function onPointerMove(e: React.PointerEvent<HTMLSpanElement>): void {
    const drag = dragRef.current;
    if (!drag) return;
    const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
    const px = e.clientX - drag.x;
    const next = normalise(drag.start + Math.round(px / 4) * step * mult);
    drag.last = next;
    setDraft(formatNumber(next));
  }
  function onPointerUp(e: React.PointerEvent<HTMLSpanElement>): void {
    const drag = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Already released.
    }
    if (drag && drag.last !== drag.start) void commit(drag.last);
  }

  return (
    <div className="p3d-field-col" style={{ minWidth: 0 }}>
      <div className="p3d-scrub" title={title}>
        {handle !== undefined && (
          <span
            className="p3d-scrub-handle"
            aria-hidden="true"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {axis && <span className={`p3d-scrub-bar p3d-scrub-bar--${axis}`} />}
            {handle}
          </span>
        )}
        <input
          value={draft}
          aria-label={ariaLabel}
          aria-invalid={error !== null || undefined}
          aria-describedby={error !== null ? errorId : undefined}
          inputMode="decimal"
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => {
            setFocused(true);
            e.currentTarget.select();
          }}
          onBlur={() => {
            setFocused(false);
            if (cancelledRef.current) {
              cancelledRef.current = false;
              return;
            }
            void commit(parseDraft(draft));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              (e.target as HTMLInputElement).blur();
            } else if (e.key === "Escape") {
              cancelledRef.current = true;
              setDraft(formatNumber(value));
              setError(null);
              (e.target as HTMLInputElement).blur();
            } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              const base = parseDraft(draft);
              const from = Number.isFinite(base) ? base : value;
              const delta =
                (e.key === "ArrowUp" ? 1 : -1) *
                step *
                (e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
              const next = normalise(from + delta);
              setDraft(formatNumber(next));
              void commit(next);
            }
          }}
        />
        {unit && <span className="p3d-scrub-unit">{unit}</span>}
      </div>
      {error !== null && (
        <div id={errorId} className="p3d-help" style={{ color: "var(--p3d-bad)", marginTop: 3 }}>
          {error}
        </div>
      )}
    </div>
  );
}

// --- AxisRow -----------------------------------------------------------------------

export interface AxisRowProps {
  label: string;
  /** "T", "R", "S": the aria-label prefix (TX, RY, SZ…). */
  prefix: string;
  values: [number, number, number];
  step: number;
  unit?: string;
  defaults: [number, number, number];
  onCommit: (index: 0 | 1 | 2, value: number) => Promise<unknown>;
  onReset: () => Promise<unknown>;
  onError?: CommitErrorHandler;
  /** Uniform-scale lock: when on, one field writes all three. */
  locked?: boolean;
  onToggleLock?: () => void;
  /** Uniform mode: field `index` was set to `value`; scale all three. */
  onCommitAll?: (index: 0 | 1 | 2, value: number) => Promise<unknown>;
}

export function AxisRow({
  label,
  prefix,
  values,
  step,
  unit,
  defaults,
  onCommit,
  onReset,
  onError,
  locked,
  onToggleLock,
  onCommitAll,
}: AxisRowProps) {
  const isDefault = values.every((v, i) => Math.abs(v - defaults[i]) < 1e-9);
  return (
    <div className="p3d-axis-row">
      <span className="p3d-label" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        {label}
        {onToggleLock && (
          <button
            type="button"
            className="p3d-iconbtn p3d-iconbtn--sm"
            aria-label={locked ? "Uniform scale on" : "Uniform scale off"}
            aria-pressed={locked ?? false}
            title={locked ? "Scaling all three together — click to unlock" : "Scale each direction separately — click to lock"}
            onClick={onToggleLock}
            style={{ width: 20, height: 20 }}
          >
            <Icon name="lock" size={12} />
          </button>
        )}
      </span>
      {([0, 1, 2] as const).map((i) => (
        <ScrubField
          key={i}
          handle={"XYZ"[i]}
          axis={(["x", "y", "z"] as const)[i]}
          ariaLabel={`${prefix}${"XYZ"[i]}`}
          value={values[i]}
          step={step}
          unit={unit}
          title={`${label} ${"XYZ"[i]} — drag the letter to change it`}
          onCommit={(v) =>
            locked && onCommitAll ? onCommitAll(i, v) : onCommit(i, v)
          }
          onError={onError}
        />
      ))}
      <button
        type="button"
        className="p3d-iconbtn p3d-iconbtn--sm p3d-reset"
        aria-label={`Reset ${label.toLowerCase()}`}
        title={`Reset ${label.toLowerCase()}`}
        disabled={isDefault}
        onClick={() => void onReset().catch((err) => onError?.(err))}
      >
        <Icon name="reset" size={13} />
      </button>
    </div>
  );
}

// --- Slider ------------------------------------------------------------------------

export interface SliderProps {
  ariaLabel: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  /** Plain end-cap words: "Shiny" … "Rough". */
  ends?: [string, string];
  /** Show the technical value field beside the slider (default on). */
  field?: boolean;
  onCommit: (value: number) => Promise<unknown>;
  onError?: CommitErrorHandler;
}

/**
 * A styled range with plain end-caps and a ScrubField showing the
 * technical value. One commit on release (pointer up, key up, blur).
 */
export function Slider({
  ariaLabel,
  value,
  min = 0,
  max = 1,
  step = 0.01,
  ends,
  field = true,
  onCommit,
  onError,
}: SliderProps) {
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? value;
  const pct = ((shown - min) / (max - min)) * 100;

  function finish(): void {
    if (draft === null) return;
    const next = round4(draft);
    setDraft(null);
    if (Math.abs(next - value) < 1e-9) return;
    void onCommit(next).catch((err) => onError?.(err));
  }

  return (
    <div className="p3d-slider-row">
      <div style={{ minWidth: 0 }}>
        <input
          type="range"
          className="p3d-range"
          min={min}
          max={max}
          step={step}
          value={shown}
          aria-label={`${ariaLabel} slider`}
          aria-valuetext={ends ? `${formatNumber(shown, 2)} (${ends[0]} to ${ends[1]})` : undefined}
          style={{ ["--p3d-fill" as string]: `${pct}%` } as CSSProperties}
          onChange={(e) => setDraft(Number(e.target.value))}
          onPointerUp={finish}
          onKeyUp={finish}
          onBlur={finish}
        />
        {ends && (
          <div className="p3d-slider-ends" aria-hidden="true">
            <span>{ends[0]}</span>
            <span>{ends[1]}</span>
          </div>
        )}
      </div>
      {field && (
        <ScrubField
          ariaLabel={ariaLabel}
          value={shown}
          step={step * 5}
          min={min}
          max={max}
          onCommit={onCommit}
          onError={onError}
        />
      )}
    </div>
  );
}

// --- MaterialBall --------------------------------------------------------------------

export interface BallLook {
  color: string;
  roughness: number;
  metalness: number;
  opacity: number;
  emissive?: string;
}

/** CSS-only material preview: no WebGL, so it takes no renderer lease. */
export function ballStyle(look: BallLook): CSSProperties {
  const r = Math.max(0, Math.min(1, look.roughness));
  const m = Math.max(0, Math.min(1, look.metalness));
  const glow = look.emissive && look.emissive.toLowerCase() !== "#000000";
  const hlSize = 8 + r * 34; // sharp small highlight when glossy
  const hlAlpha = (1 - r) * 0.85 + 0.12;
  const highlight = `radial-gradient(circle at 34% 28%, rgba(255,255,255,${hlAlpha.toFixed(2)}) 0%, rgba(255,255,255,0) ${hlSize.toFixed(0)}%)`;
  const body = m > 0.5
    ? `radial-gradient(circle at 40% 35%, color-mix(in oklab, ${look.color} 70%, #fff) 0%, ${look.color} 38%, color-mix(in oklab, ${look.color} 35%, #000) 78%, color-mix(in oklab, ${look.color} 80%, #fff) 100%)`
    : `radial-gradient(circle at 40% 35%, color-mix(in oklab, ${look.color} 88%, #fff) 0%, ${look.color} 45%, color-mix(in oklab, ${look.color} 72%, #000) 100%)`;
  const layers = [highlight, body];
  if (look.opacity < 0.99) {
    layers.push("repeating-conic-gradient(#bbb 0 25%, #fff 0 50%) 0 0 / 8px 8px");
  }
  return {
    background: layers.join(", "),
    opacity: look.opacity < 0.99 ? 0.55 + look.opacity * 0.45 : 1,
    boxShadow: glow
      ? `0 0 10px 1px color-mix(in oklab, ${look.emissive} 70%, transparent), inset 0 -2px 4px rgba(0,0,0,.12)`
      : undefined,
  };
}

export function MaterialBall({ look, large = false }: { look: BallLook; large?: boolean }) {
  return <span className={`p3d-ball${large ? " p3d-ball--lg" : ""}`} style={ballStyle(look)} aria-hidden="true" />;
}

// --- SwatchGrid ----------------------------------------------------------------------

export interface SwatchGridProps {
  value: string;
  ariaLabel: string;
  onPick: (hex: string) => void;
  recent?: string[];
}

export function SwatchGrid({ value, ariaLabel, onPick, recent = [] }: SwatchGridProps) {
  const [custom, setCustom] = useState(false);
  const [hexDraft, setHexDraft] = useState(value);
  const lower = value.toLowerCase();
  useEffect(() => setHexDraft(value), [value]);
  const extras = recent.filter((h) => !PALETTE.some((c) => c.hex === h.toLowerCase())).slice(0, 6);
  return (
    <div>
      <div className="p3d-swatches" role="group" aria-label={ariaLabel}>
        {PALETTE.map((c) => (
          <button
            key={c.hex}
            type="button"
            className="p3d-swatch"
            style={{ ["--p3d-sw" as string]: c.hex } as CSSProperties}
            aria-label={c.name}
            title={c.name}
            aria-pressed={lower === c.hex}
            onClick={() => onPick(c.hex)}
          />
        ))}
        {extras.map((hex) => (
          <button
            key={hex}
            type="button"
            className="p3d-swatch"
            style={{ ["--p3d-sw" as string]: hex } as CSSProperties}
            aria-label={`Recent ${hex}`}
            title={hex}
            aria-pressed={lower === hex.toLowerCase()}
            onClick={() => onPick(hex)}
          />
        ))}
        <button
          type="button"
          className="p3d-swatch p3d-swatch--custom"
          aria-label="Custom colour"
          title="Custom colour…"
          aria-expanded={custom}
          onClick={() => setCustom((c) => !c)}
        />
      </div>
      {custom && (
        <div className="p3d-color-row" style={{ marginTop: 8 }}>
          <input
            type="color"
            className="p3d-color-input"
            value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#ffffff"}
            aria-label={`${ariaLabel} picker`}
            onChange={(e) => setHexDraft(e.target.value)}
            onBlur={(e) => {
              if (e.target.value.toLowerCase() !== lower) onPick(e.target.value.toLowerCase());
            }}
          />
          <input
            className="p3d-text-input p3d-mono"
            value={hexDraft}
            maxLength={7}
            aria-label={`${ariaLabel} hex`}
            spellCheck={false}
            onChange={(e) => setHexDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") {
                setHexDraft(value);
                (e.target as HTMLInputElement).blur();
              }
            }}
            onBlur={() => {
              const next = hexDraft.trim().toLowerCase();
              if (/^#[0-9a-f]{6}$/.test(next) && next !== lower) onPick(next);
              else setHexDraft(value);
            }}
          />
          <span className="p3d-help">{paletteName(value) ?? "Custom"}</span>
        </div>
      )}
    </div>
  );
}

// --- Section -------------------------------------------------------------------------

const sectionOpen = new Map<string, boolean>();

export function Section({
  id,
  title,
  summary,
  icon,
  defaultOpen = true,
  children,
}: {
  id: string;
  title: string;
  summary?: ReactNode;
  icon?: IconName;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(sectionOpen.get(id) ?? defaultOpen);
  const bodyId = useId();
  return (
    <section className="p3d-section" aria-label={title}>
      <button
        type="button"
        className="p3d-section-head"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => {
          sectionOpen.set(id, !open);
          setOpen(!open);
        }}
      >
        <Icon name="chevron" size={14} className="p3d-caret" />
        {icon && <Icon name={icon} size={15} style={{ color: "var(--p3d-text-2)" }} />}
        <h3 style={{ margin: 0, font: "inherit" }}>{title}</h3>
        {summary !== undefined && <span className="p3d-section-summary">{summary}</span>}
      </button>
      {open && (
        <div id={bodyId} className="p3d-section-body">
          {children}
        </div>
      )}
    </section>
  );
}

// --- Tile -------------------------------------------------------------------------------

export function Tile({
  icon,
  label,
  hint,
  active,
  onClick,
}: {
  icon: IconName;
  label: string;
  hint?: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="p3d-tile"
      data-active={active ? "true" : undefined}
      title={hint}
      onClick={onClick}
    >
      <Icon name={icon} size={26} />
      <span>{label}</span>
    </button>
  );
}

// --- Popover ------------------------------------------------------------------------------

export interface PopoverProps {
  open: boolean;
  onClose: (reason: "escape" | "outside") => void;
  /** The trigger (rendered inline); the panel positions against it. */
  anchor: ReactNode;
  children: ReactNode;
  align?: "start" | "end";
  side?: "bottom" | "top";
  className?: string;
  label?: string;
  role?: string;
}

/**
 * A plugin-owned popover anchored to its trigger. Closes on Escape and
 * on a pointerdown outside the anchor+panel. Stays inside the plugin's
 * own subtree (no portal into host markup).
 */
export function Popover({
  open,
  onClose,
  anchor,
  children,
  align = "start",
  side = "bottom",
  className,
  label,
  role = "dialog",
}: PopoverProps) {
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: PointerEvent) => {
      const root = rootRef.current;
      if (root && e.target instanceof Node && root.contains(e.target)) return;
      onCloseRef.current("outside");
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current("escape");
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  const pos: CSSProperties = {
    [side === "bottom" ? "top" : "bottom"]: "calc(100% + 6px)",
    [align === "start" ? "left" : "right"]: 0,
  };
  return (
    <span ref={rootRef} className="p3d-pop-anchor">
      {anchor}
      {open && (
        <div
          className={`p3d-pop${side === "top" ? " p3d-pop--up" : ""}${className ? ` ${className}` : ""}`}
          role={role}
          aria-label={label}
          style={pos}
        >
          {children}
        </div>
      )}
    </span>
  );
}

export function MenuItem({
  icon,
  label,
  kbd,
  checked,
  onClick,
  role = "menuitem",
}: {
  icon?: IconName;
  label: string;
  kbd?: string;
  checked?: boolean;
  onClick: () => void;
  role?: string;
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? role : "menuitemcheckbox"}
      aria-checked={checked}
      className="p3d-menu-item"
      onClick={onClick}
    >
      {icon && <Icon name={icon} size={16} style={{ color: "var(--p3d-text-2)" }} />}
      <span className="p3d-grow">{label}</span>
      {kbd && <span className="p3d-kbd">{kbd}</span>}
      {checked !== undefined && <Icon name="check" size={15} className="p3d-check" />}
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <span className="p3d-seg" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}
