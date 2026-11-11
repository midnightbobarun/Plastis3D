import { AskChips } from "../ui/Learning";
import { SAMPLE_NAMES, type SampleName } from "../samples";
// src/editor/NoSceneEmptyState.tsx — the shared no-scene welcome
// (Phase 0, 0-D; restyled in PR32 as the welcome shell of UI/UX
// redesign §8.1).
//
// An original illustration, a heading, one friendly sentence and three
// large choices — Build a sample snowman, New scene, Import — wired to
// the same handlers on every surface. `compact` is the narrow form for
// the Scenes pane and the viewport pane. PR33 replaces the one-click
// snowman with the four-sample chooser and adds the ask-Hermes chips.

import { useState } from "react";
import type { RestFn } from "../api";
import { COPY, LEARNING_COPY } from "../copy";
import { buildSampleSnowman } from "./sceneActions";
import { Icon } from "../ui/icons";

export interface NoSceneEmptyStateProps {
  rest: RestFn;
  sourceKey: string;
  /** Open the New-scene dialog (surface-specific). Takes the click event — the caller needs it for the 0-C focus return. */
  onNew: (e: React.MouseEvent<HTMLButtonElement>) => void;
  /** Open the Import dialog (surface-specific). Takes the click event — the caller needs it for the 0-C focus return. */
  onImport: (e: React.MouseEvent<HTMLButtonElement>) => void;
  /** Override the snowman build (tests); default buildSampleSnowman. */
  onBuildSnowman?: () => Promise<unknown>;
  /** The narrow form (panes). */
  compact?: boolean;
}

/** Original welcome art: three soft shapes on a floor, in theme hues. */
export function WelcomeArt({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 168 112" aria-hidden="true">
      <defs>
        <radialGradient id="p3d-wa-ball" cx="35%" cy="30%" r="75%">
          <stop offset="0" stopColor="#fff" stopOpacity=".9" />
          <stop offset=".35" stopColor="var(--p3d-z)" stopOpacity=".95" />
          <stop offset="1" stopColor="var(--p3d-z)" />
        </radialGradient>
        <linearGradient id="p3d-wa-floor" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--p3d-text)" stopOpacity=".07" />
          <stop offset="1" stopColor="var(--p3d-text)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <ellipse cx="84" cy="92" rx="76" ry="16" fill="url(#p3d-wa-floor)" />
      <ellipse cx="52" cy="90" rx="22" ry="5" fill="var(--p3d-text)" opacity=".10" />
      <ellipse cx="104" cy="92" rx="18" ry="4.5" fill="var(--p3d-text)" opacity=".10" />
      <ellipse cx="134" cy="88" rx="13" ry="3.5" fill="var(--p3d-text)" opacity=".10" />
      {/* box */}
      <path d="M52 44 74 55v27L52 93 30 82V55Z" fill="var(--p3d-x)" opacity=".92" />
      <path d="M52 44 74 55 52 66 30 55Z" fill="#fff" opacity=".28" />
      <path d="M52 66v27L74 82V55Z" fill="#000" opacity=".12" />
      {/* ball */}
      <circle cx="104" cy="72" r="19" fill="url(#p3d-wa-ball)" />
      {/* cone */}
      <path d="M134 40 147 84c-4 3-22 3-26 0Z" fill="var(--p3d-warn)" />
      <path d="M134 40 147 84c-2 1.5-7 2.4-13 2.4Z" fill="#000" opacity=".12" />
      {/* sparkle */}
      <path d="M84 14c.8 4.8 2.4 6.4 7.2 7.2-4.8.8-6.4 2.4-7.2 7.2-.8-4.8-2.4-6.4-7.2-7.2 4.8-.8 6.4-2.4 7.2-7.2Z" fill="var(--p3d-accent)" />
    </svg>
  );
}

export function NoSceneEmptyState({
  rest,
  sourceKey,
  onNew,
  onImport,
  onBuildSnowman,
  compact = false,
}: NoSceneEmptyStateProps): React.JSX.Element {
  const [chooser, setChooser] = useState(false);
  const [building, setBuilding] = useState(false);

  async function build(sample: SampleName = "Snowman"): Promise<void> {
    if (building) return;
    setBuilding(true);
    try {
      if (onBuildSnowman) await onBuildSnowman();
      else await buildSampleSnowman(rest, sourceKey, sample);
    } finally {
      setBuilding(false);
    }
  }

  return (
    <div className={`p3d-root p3d-welcome${compact ? " p3d-welcome--compact" : ""}`}>
      <WelcomeArt className="p3d-welcome-art" />
      <h1>{COPY.noSceneTitle}</h1>
      <p>{COPY.noSceneBody}</p>
      {chooser && <div className="p3d-sample-grid" role="group" aria-label="Samples">{SAMPLE_NAMES.map(sample => <button className="p3d-btn p3d-btn--outline" key={sample} disabled={building} onClick={() => void build(sample)}>{sample}</button>)}</div>}
      <div className="p3d-welcome-tiles">
        <button
          type="button"
          className="p3d-tile p3d-tile--wide"
          aria-label="Try a sample"
          disabled={building}
          onClick={() => setChooser(!chooser)}
        >
          <Icon name="sparkle" size={compact ? 22 : 28} />
          <span>
            <div className="p3d-tile-title">{building ? "Building…" : "Try a sample"}</div>
            {!compact && <div className="p3d-tile-desc">A friendly snowman to look around and change.</div>}
          </span>
        </button>
        <button type="button" className="p3d-tile p3d-tile--wide" aria-label="New scene" onClick={onNew}>
          <Icon name="cube3" size={compact ? 22 : 28} />
          <span>
            <div className="p3d-tile-title">Start from scratch</div>
            {!compact && <div className="p3d-tile-desc">An empty stage. Add boxes, balls, lights and more.</div>}
          </span>
        </button>
        <button type="button" className="p3d-tile p3d-tile--wide" aria-label="Import" onClick={onImport}>
          <Icon name="import" size={compact ? 22 : 28} />
          <span>
            <div className="p3d-tile-title">Bring a model</div>
            {!compact && <div className="p3d-tile-desc">{COPY.importTileDesc}</div>}
          </span>
        </button>
      </div>
      <AskChips /><p>{LEARNING_COPY.reassurance}</p>
    </div>
  );
}
