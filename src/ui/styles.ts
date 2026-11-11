// src/ui/styles.ts — the one namespaced stylesheet (UI/UX redesign §4.1,
// PR32).
//
// Injected at register() into <style data-plastis3d> in document.head
// and removed in ctx.onDispose — the host's own Radio plugin does the
// same (apps/desktop/src/plugins/radio/plugin.js:691). Every selector
// starts with `.p3d-` (scripts/lint-desktop.mjs enforces it): the sheet
// never selects host markup (catalog rule 8). Colours come from host
// `--ui-*` tokens through `--p3d-*` aliases; every var() has a fallback.

export const P3D_STYLE_ATTR = "data-plastis3d";

export const P3D_CSS = String.raw`
.p3d-sample-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; margin:12px 0; }
.p3d-row--pulse { outline: 2px solid var(--p3d-accent); background: var(--p3d-accent-soft); }
.p3d-learning { position:absolute; top:130px; right:12px; max-width:240px; max-height:38%; overflow:auto; padding:6px 8px; z-index:6; font-size:12px; border-radius:12px; }
.p3d-learning > .p3d-btn { margin-right:4px; }
.p3d-agent-bar { position:absolute; bottom:120px; left:50%; transform:translateX(-50%); width:max-content; padding:8px 12px; z-index:8; }
.p3d-ask-chips { padding:8px; display:flex; flex-wrap:wrap; gap:6px; }
.p3d-stage-top { position:absolute; top:12px; left:50%; transform:translateX(-50%); width:max-content; z-index:6; display:flex; align-items:flex-start; gap:8px; max-width:calc(100% - 200px); }
.p3d-ask { position:relative; z-index:6; font-size:12px; }
.p3d-ask > summary { list-style:none; cursor:pointer; padding:5px 12px; border-radius:999px; white-space:nowrap; }
.p3d-ask > summary::-webkit-details-marker { display:none; }
.p3d-ask[open] > summary { border-bottom-left-radius:8px; border-bottom-right-radius:8px; }
.p3d-ask .p3d-ask-chips { position:absolute; top:calc(100% + 4px); left:50%; transform:translateX(-50%); flex-direction:column; align-items:stretch; width:max-content; max-width:min(320px, 80vw); padding:8px; border-radius:10px; }
.p3d-ask .p3d-ask-chips button { text-align:left; white-space:normal; }
.p3d-settle .p3d-btn { border-color:var(--p3d-stroke-strong); background:var(--p3d-surface); }
.p3d-settle { display:flex; gap:6px; align-items:center; padding:4px 8px; border-radius:12px; flex-wrap:wrap; font-size:12px; }
.p3d-edit-bar { position:absolute; top:12px; left:50%; transform:translateX(-50%); width:max-content; z-index:9; display:flex; flex-direction:column; gap:6px; padding:8px 10px; max-width:calc(100% - 170px); border-radius:12px; font-size:12px; }
.p3d-edit-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.p3d-edit-options { padding-top:6px; border-top:1px solid var(--p3d-stroke); min-height:34px; }
.p3d-edit-bar > .p3d-edit-row:first-child { flex-wrap:nowrap; }
.p3d-edit-name { font-weight:600; margin-right:2px; min-width:0; max-width:120px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.p3d-edit-status { color:var(--p3d-text-3); white-space:nowrap; min-width:0; overflow:hidden; text-overflow:ellipsis; }
.p3d-edit-sep { width:1px; align-self:stretch; background:var(--p3d-stroke); margin:2px 2px; }
.p3d-edit-field { display:inline-flex; align-items:center; gap:6px; color:var(--p3d-text-2); white-space:nowrap; }
.p3d-grow { flex:1 1 auto; }
.p3d-seg { display:inline-flex; border:1px solid var(--p3d-stroke-strong); border-radius:8px; overflow:hidden; background:var(--p3d-surface); }
.p3d-seg > button { height:26px; padding:0 10px; border:0; background:transparent; color:var(--p3d-text); font:inherit; font-size:12px; cursor:pointer; display:inline-flex; align-items:center; gap:5px; }
.p3d-seg > button + button { border-left:1px solid var(--p3d-stroke); }
.p3d-seg > button:hover:not(:disabled) { background:var(--p3d-hover); }
.p3d-seg > button[aria-pressed="true"] { background:var(--p3d-accent-soft); color:var(--p3d-accent); font-weight:600; }
.p3d-seg > button:disabled { opacity:.45; cursor:default; }
.p3d-seg kbd, .p3d-edit-bar .p3d-btn kbd { font:inherit; font-size:10px; opacity:.55; }
.p3d-root input[type="checkbox"] { accent-color: var(--p3d-accent); }
.p3d-section-body .p3d-btn:not(.p3d-btn--primary):not(.p3d-btn--danger):not([aria-expanded]):not(.p3d-btn--outline), .p3d-edit-bar .p3d-btn:not(.p3d-btn--primary) { border-color: var(--p3d-stroke-strong); background: var(--p3d-surface); }
.p3d-editor--narrow .p3d-add-label { display:none; }
.p3d-render-bar { position:absolute; bottom:12px; left:50%; transform:translateX(-50%); width:max-content; z-index:4; display:flex; align-items:center; flex-wrap:wrap; justify-content:center; gap:8px; padding:6px 8px; border-radius:12px; max-width:calc(100% - 200px); font-size:12px; }
.p3d-render-bar--active { bottom:52px; }
.p3d-render-bar--active ~ .p3d-hint { display:none; }
.p3d-render-progress { display:inline-block; width:110px; height:6px; border-radius:3px; background:var(--p3d-stroke); overflow:hidden; }
.p3d-render-progress > span { display:block; height:100%; background:var(--p3d-accent); transition:width .2s linear; }
.p3d-render-count { font-variant-numeric:tabular-nums; color:var(--p3d-text-2); white-space:nowrap; }
.p3d-render-info { width:26px; height:26px; }
.p3d-render-why { position:absolute; bottom:calc(100% + 6px); left:0; width:max-content; max-width:280px; padding:8px 10px; border-radius:10px; font-size:11px; text-align:left; color:var(--p3d-text-2); }
.p3d-render-why p { margin:0; }
.p3d-render-note { flex-basis:100%; text-align:center; font-size:11px; color:var(--p3d-text-3); }
.p3d-pane-standby { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; height:100%; padding:24px; text-align:center; color:var(--p3d-text-2, inherit); }
.p3d-sidepanel { position:relative; }
.p3d-sidepanel:focus { outline:none; }
.p3d-drop-overlay { position:absolute; inset:8px; z-index:60; display:flex; align-items:center; justify-content:center; text-align:center; padding:16px; border:2px dashed var(--p3d-accent); border-radius:12px; background:color-mix(in oklab, var(--p3d-accent) 12%, var(--p3d-surface)); color:var(--p3d-text); font-weight:600; pointer-events:none; }
.p3d-sidepanel { display:flex; flex-direction:column; height:100%; min-height:0; background:var(--p3d-surface); }
.p3d-sidepanel-outline { flex:0 1 auto; max-height:40%; min-height:0; display:flex; flex-direction:column; border-bottom:1px solid var(--p3d-stroke); }
.p3d-sidepanel-props { flex:1 1 60%; min-height:0; display:flex; flex-direction:column; }
.p3d-pane-standby p { margin:0; font-size:13px; }
.p3d-shortcut-help { position:absolute; right:34px; top:92px; z-index:8; }
.p3d-snap > summary { list-style:none; }
.p3d-snap > summary::-webkit-details-marker { display:none; }
.p3d-editor--narrow .p3d-header [aria-label="Redo"] { display:none; }
.p3d-shortcut-help > button { width:28px; height:28px; border-radius:50%; padding:0; background:var(--p3d-glass); border:1px solid var(--p3d-stroke); backdrop-filter:blur(10px); }
.p3d-shortcut-help section { padding:16px; max-width:320px; }
.p3d-coach { position:absolute; left:50%; transform:translateX(-50%); bottom:120px; width:max-content; max-width:min(360px, calc(100% - 160px)); padding:8px 12px; z-index:7; pointer-events:none; display:flex; align-items:center; gap:10px; font-size:12px; }
.p3d-coach button { pointer-events:auto; }
.p3d-rename-pop { position:absolute; top:52px; left:12px; z-index:30; display:flex; flex-wrap:wrap; align-items:center; gap:6px; padding:8px; border-radius:10px; max-width:calc(100% - 24px); }
.p3d-rename-pop .p3d-input { flex:1 1 180px; min-width:180px; max-width:100%; }
.p3d-edit-bar ~ .p3d-learning, .p3d-edit-bar ~ .p3d-shortcut-help { display:none; }
.p3d-learning ul { list-style:none; margin:8px 0 0; padding:0; line-height:1.8; }
.p3d-clip-transport { position:absolute; bottom:60px; left:50%; transform:translateX(-50%); z-index:8; display:flex; align-items:center; gap:8px; max-width:calc(100% - 24px); padding:8px; flex-wrap:wrap; }
.p3d-clip-transport input[type="range"] { min-height:24px; min-width:80px; }
.p3d-agent-bar { display:flex; align-items:center; gap:8px; max-width:calc(100% - 160px); flex-wrap:wrap; }
.p3d-snap label { display:flex; align-items:center; gap:6px; padding:4px; }
.p3d-snap input[type=number] { width:72px; }
.p3d-snap summary { padding:6px; cursor:pointer; }
.p3d-snap { position:relative; z-index:7; font-size:11px; }
.p3d-snap-options { position:absolute; left:44px; bottom:0; width:220px; padding:10px; background:var(--p3d-raised); border:1px solid var(--p3d-stroke); border-radius:8px; }

.p3d-root {
  --p3d-surface: var(--ui-bg-editor, var(--ui-background, #ffffff));
  --p3d-raised: var(--ui-bg-elevated, var(--p3d-surface));
  --p3d-glass: color-mix(in oklab, var(--p3d-raised) 78%, transparent);
  --p3d-stroke: var(--ui-stroke-tertiary, var(--ui-stroke-secondary, rgba(127,127,127,.22)));
  --p3d-stroke-strong: var(--ui-stroke-secondary, rgba(127,127,127,.35));
  --p3d-text: var(--ui-text-primary, currentColor);
  --p3d-text-2: var(--ui-text-secondary, color-mix(in oklab, currentColor 70%, transparent));
  --p3d-text-3: var(--ui-text-tertiary, color-mix(in oklab, currentColor 50%, transparent));
  --p3d-accent: var(--ui-accent, #0053fd);
  --p3d-accent-soft: color-mix(in oklab, var(--p3d-accent) 14%, transparent);
  --p3d-accent-ring: color-mix(in oklab, var(--p3d-accent) 55%, transparent);
  --p3d-hover: color-mix(in oklab, var(--p3d-text) 6%, transparent);
  --p3d-press: color-mix(in oklab, var(--p3d-text) 11%, transparent);
  --p3d-ok: var(--ui-green, #2e9c5a);
  --p3d-warn: var(--ui-yellow, #c99a1a);
  --p3d-bad: var(--ui-red, #d1352b);
  --p3d-x: var(--ui-red, #e5484d);
  --p3d-y: var(--ui-green, #46a758);
  --p3d-z: var(--ui-blue, #3e7bfa);
  --p3d-stage-top: color-mix(in oklab, var(--p3d-surface) 82%, var(--p3d-text) 18%);
  --p3d-stage-bottom: color-mix(in oklab, var(--p3d-surface) 94%, var(--p3d-text) 6%);
  --p3d-r-s: var(--radius-sm, 6px);
  --p3d-r-m: var(--radius-md, 10px);
  --p3d-r-l: var(--radius-lg, 14px);
  --p3d-shadow: var(--shadow-md, 0 4px 16px rgba(0,0,0,.10), 0 1px 3px rgba(0,0,0,.08));
  --p3d-shadow-lg: var(--shadow-lg, 0 12px 40px rgba(0,0,0,.18), 0 2px 6px rgba(0,0,0,.10));
  --p3d-fast: 120ms;
  --p3d-med: 200ms;
  --p3d-slow: 360ms;
  --p3d-ease: cubic-bezier(.2,.7,.2,1);
  font-family: var(--font-sans, inherit);
  font-size: 13px;
  color: var(--p3d-text);
  -webkit-font-smoothing: antialiased;
}
@media (prefers-reduced-motion: reduce) {
  .p3d-root { --p3d-fast: 0ms; --p3d-med: 0ms; --p3d-slow: 0ms; }
}
.p3d-root *, .p3d-root *::before, .p3d-root *::after { box-sizing: border-box; }
.p3d-num { font-variant-numeric: tabular-nums; }
.p3d-mono { font-family: var(--font-mono, ui-monospace, monospace); }
.p3d-muted { color: var(--p3d-text-2); }
.p3d-faint { color: var(--p3d-text-3); }
.p3d-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

/* ---------- buttons ---------- */
.p3d-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 30px; padding: 0 12px; border-radius: var(--p3d-r-s);
  border: 1px solid transparent; background: transparent; color: var(--p3d-text);
  font: inherit; font-size: 13px; font-weight: 500; line-height: 1; white-space: nowrap;
  cursor: pointer; user-select: none;
  transition: background var(--p3d-fast) var(--p3d-ease), color var(--p3d-fast) var(--p3d-ease),
    border-color var(--p3d-fast) var(--p3d-ease), box-shadow var(--p3d-fast) var(--p3d-ease),
    transform var(--p3d-fast) var(--p3d-ease);
}
.p3d-btn:hover:not(:disabled) { background: var(--p3d-hover); }
.p3d-btn:active:not(:disabled) { background: var(--p3d-press); transform: translateY(.5px); }
.p3d-btn:focus-visible, .p3d-iconbtn:focus-visible, .p3d-tile:focus-visible, .p3d-swatch:focus-visible,
.p3d-ballbtn:focus-visible, .p3d-row:focus-visible, .p3d-scene-row:focus-visible, .p3d-tab:focus-visible {
  outline: 2px solid var(--p3d-accent-ring); outline-offset: 1px;
}
.p3d-btn:disabled { opacity: .45; cursor: default; }
.p3d-btn--primary {
  background: var(--p3d-accent); color: #fff; border-color: transparent;
  box-shadow: 0 1px 2px color-mix(in oklab, var(--p3d-accent) 40%, transparent);
}
.p3d-btn--primary:hover:not(:disabled) { background: color-mix(in oklab, var(--p3d-accent) 88%, #000); }
.p3d-btn--outline { border-color: var(--p3d-stroke-strong); background: var(--p3d-surface); }
.p3d-btn--outline:hover:not(:disabled) { background: var(--p3d-hover); border-color: var(--p3d-text-3); }
.p3d-btn--sm { height: 26px; padding: 0 9px; font-size: 12px; }
.p3d-btn--danger { color: var(--p3d-bad); }
.p3d-btn--danger:hover:not(:disabled) { background: color-mix(in oklab, var(--p3d-bad) 12%, transparent); }
.p3d-iconbtn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; padding: 0; border-radius: var(--p3d-r-s);
  border: 0; background: transparent; color: var(--p3d-text-2); cursor: pointer;
  transition: background var(--p3d-fast) var(--p3d-ease), color var(--p3d-fast) var(--p3d-ease);
}
.p3d-iconbtn:hover:not(:disabled) { background: var(--p3d-hover); color: var(--p3d-text); }
.p3d-iconbtn:disabled { opacity: .35; cursor: default; }
.p3d-iconbtn[aria-pressed="true"] { background: var(--p3d-accent-soft); color: var(--p3d-accent); }
.p3d-iconbtn--sm { width: 24px; height: 24px; }
.p3d-sep-v { width: 1px; align-self: stretch; margin: 6px 4px; background: var(--p3d-stroke); }
.p3d-sep-h { height: 1px; margin: 4px 6px; background: var(--p3d-stroke); }
.p3d-kbd {
  display: inline-flex; align-items: center; min-width: 18px; height: 18px; padding: 0 5px;
  border-radius: 4px; border: 1px solid var(--p3d-stroke-strong); color: var(--p3d-text-2);
  font-size: 11px; font-family: var(--font-mono, ui-monospace, monospace); line-height: 1;
}

/* ---------- editor layout ---------- */
.p3d-editor { container: p3deditor / inline-size; position: relative; display: flex; flex-direction: column; width: 100%; height: 100%;
  background: var(--p3d-surface); outline: none; overflow: hidden; }
.p3d-header { flex: 0 0 48px; display: flex; align-items: center; gap: 6px; padding: 0 10px 0 8px;
  border-bottom: 1px solid var(--p3d-stroke); min-width: 0; }
.p3d-header-spacer { flex: 1 1 auto; min-width: 8px; }
.p3d-header > * { flex-shrink: 0; }
.p3d-header > .p3d-header-title { flex: 0 1 auto; min-width: 96px; max-width: 280px; }
.p3d-header-title .p3d-btn { max-width: 100%; }
.p3d-save-state { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--p3d-text-3);
  padding: 0 6px; white-space: nowrap; }
.p3d-save-state svg { color: var(--p3d-ok); }
.p3d-cols { flex: 1 1 auto; display: flex; min-height: 0; min-width: 0; }
.p3d-col-left { flex: 0 1 240px; min-width: 200px; max-width: 280px; display: flex; flex-direction: column;
  min-height: 0; border-right: 1px solid var(--p3d-stroke); background: var(--p3d-surface); }
.p3d-col-center { flex: 1 1 auto; min-width: 360px; display: flex; flex-direction: column; min-height: 0; position: relative; }
.p3d-col-right { flex: 0 1 300px; min-width: 240px; max-width: 340px; display: flex; flex-direction: column;
  min-height: 0; border-left: 1px solid var(--p3d-stroke); background: var(--p3d-surface); }
.p3d-editor--narrow .p3d-cols { flex-direction: column; }
.p3d-editor--narrow .p3d-col-center { min-width: 0; flex: 1 1 55%; min-height: 12rem; }
.p3d-sheet { flex: 0 0 45%; min-height: 10rem; display: flex; flex-direction: column; border-top: 1px solid var(--p3d-stroke);
  background: var(--p3d-surface); box-shadow: 0 -6px 20px rgba(0,0,0,.06); }
.p3d-sheet-tabs { flex: 0 0 auto; display: flex; gap: 2px; padding: 6px 8px 0; border-bottom: 1px solid var(--p3d-stroke); }
.p3d-tab { height: 30px; padding: 0 12px; border: 0; background: transparent; color: var(--p3d-text-2); font: inherit;
  font-weight: 500; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.p3d-tab[aria-selected="true"] { color: var(--p3d-text); border-bottom-color: var(--p3d-accent); }
.p3d-sheet-body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.p3d-panel-title { display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 12px; flex: 0 0 auto;
  font-size: 12px; font-weight: 600; color: var(--p3d-text-2); }
.p3d-panel-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; }
.p3d-message { padding: 24px; display: flex; justify-content: center; }

/* ---------- stage ---------- */
.p3d-stage { position: relative; container: p3dstage / inline-size; flex: 1 1 auto; min-height: 0; overflow: hidden;
  background:
    radial-gradient(120% 90% at 50% 38%, transparent 55%, color-mix(in oklab, var(--p3d-text) 7%, transparent) 100%),
    linear-gradient(180deg, var(--p3d-stage-top) 0%, var(--p3d-stage-bottom) 78%); }
.p3d-stage--plain { background: var(--p3d-surface); }
.p3d-stage-mount { position: absolute; inset: 0; }
.p3d-stage-mount canvas { display: block; outline: none; }
.p3d-glass { background: var(--p3d-glass); border: 1px solid var(--p3d-stroke);
  -webkit-backdrop-filter: blur(12px) saturate(1.2); backdrop-filter: blur(12px) saturate(1.2);
  box-shadow: var(--p3d-shadow); border-radius: var(--p3d-r-m); }
.p3d-stage--low .p3d-glass { -webkit-backdrop-filter: none; backdrop-filter: none; background: var(--p3d-raised); }
.p3d-dock { position: absolute; top: 12px; left: 12px; z-index: 5; display: flex; flex-direction: column; gap: 2px; padding: 4px; }
.p3d-dock-tools { display: flex; flex-direction: column; gap: 2px; }
.p3d-dock-toggle { display: none; }
.p3d-dock[data-folded="true"] .p3d-dock-toggle { display: inline-flex; }
.p3d-dock[data-folded="true"]:not([data-open="true"]) .p3d-dock-tools { display: none; }
.p3d-dock[data-folded="true"][data-open="true"] .p3d-dock-toggle { background: var(--p3d-accent-soft); }
.p3d-dock .p3d-iconbtn { width: 36px; height: 36px; }
.p3d-dock--compact .p3d-iconbtn { width: 32px; height: 32px; }
.p3d-dock .p3d-sep-h { margin: 3px 4px; }
.p3d-stage-bl { position: absolute; left: 12px; bottom: 10px; z-index: 3; display: flex; align-items: center; gap: 8px;
  font-size: 11px; color: var(--p3d-text-2); pointer-events: none; }
.p3d-stage-bl > * { pointer-events: auto; }
.p3d-dock ~ .p3d-stage-bl { left: 66px; }
.p3d-dock--compact ~ .p3d-pane-foot { left: 56px; }
.p3d-stage-br { position: absolute; right: 12px; bottom: 10px; z-index: 6; display: flex; align-items: center; gap: 6px; }
.p3d-stat-chip { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border-radius: 999px;
  font-size: 11px; color: var(--p3d-text-2); border: 0; font: inherit; font-size: 11px; cursor: default; }
.p3d-hint { position: absolute; left: 50%; bottom: 60px; transform: translateX(-50%); z-index: 3; width: max-content;
  max-width: min(600px, calc(100% - 24px)); display: flex; align-items: center; gap: 10px; padding: 7px 8px 7px 14px;
  font-size: 12px; line-height: 1.45; color: var(--p3d-text-2); border-radius: 16px;
  transition: opacity var(--p3d-slow) var(--p3d-ease), transform var(--p3d-slow) var(--p3d-ease); }
.p3d-hint--gone { opacity: 0; transform: translate(-50%, 6px); pointer-events: none; }
.p3d-hint b { color: var(--p3d-text); font-weight: 500; }
.p3d-stage-note { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); z-index: 3; padding: 5px 12px;
  font-size: 11px; color: var(--p3d-text-2); border-radius: 999px; }
.p3d-overlay-center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 8px; pointer-events: none; z-index: 2; }
.p3d-overlay-card { padding: 10px 14px; font-size: 12px; max-width: 80%; }
.p3d-overlay-card b { display: block; font-weight: 600; margin-top: 2px; }

/* ---------- popovers & menus ---------- */
.p3d-pop-anchor { position: relative; display: inline-flex; }
.p3d-pop { position: absolute; z-index: 40; min-width: 200px; padding: 6px; background: var(--p3d-raised);
  border: 1px solid var(--p3d-stroke-strong); border-radius: var(--p3d-r-m); box-shadow: var(--p3d-shadow-lg);
  animation: p3d-pop-in var(--p3d-med) var(--p3d-ease); color: var(--p3d-text); }
@keyframes p3d-pop-in { from { opacity: 0; transform: translateY(-4px) scale(.98); } to { opacity: 1; transform: none; } }
.p3d-pop--up { animation-name: p3d-pop-up; }
@keyframes p3d-pop-up { from { opacity: 0; transform: translateY(4px) scale(.98); } to { opacity: 1; transform: none; } }
.p3d-menu-item { display: flex; align-items: center; gap: 10px; width: 100%; height: 30px; padding: 0 8px;
  border: 0; border-radius: var(--p3d-r-s); background: transparent; color: var(--p3d-text); font: inherit; font-size: 13px;
  text-align: left; cursor: pointer; }
.p3d-menu-item:hover, .p3d-menu-item:focus-visible { background: var(--p3d-hover); outline: none; }
.p3d-menu-item[aria-checked="true"] .p3d-check { opacity: 1; }
.p3d-menu-item .p3d-grow { flex: 1 1 auto; }
.p3d-check { opacity: 0; color: var(--p3d-accent); }
.p3d-menu-label { padding: 8px 8px 4px; font-size: 11px; font-weight: 600; color: var(--p3d-text-3); }
.p3d-seg { display: inline-flex; padding: 2px; gap: 2px; border-radius: var(--p3d-r-s); background: var(--p3d-hover); }
.p3d-seg button { height: 24px; padding: 0 9px; border: 0; border-radius: 5px; background: transparent; color: var(--p3d-text-2);
  font: inherit; font-size: 12px; cursor: pointer; }
.p3d-seg button[aria-pressed="true"] { background: var(--p3d-raised); color: var(--p3d-text); box-shadow: 0 1px 2px rgba(0,0,0,.12); }
.p3d-menu-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 4px 8px; min-height: 32px; }

/* ---------- add popover & tiles ---------- */
.p3d-add { width: 372px; padding: 10px; }
.p3d-add-search { width: 100%; height: 32px; padding: 0 10px 0 32px; border-radius: var(--p3d-r-s); border: 1px solid var(--p3d-stroke-strong);
  background: var(--p3d-surface); color: var(--p3d-text); font: inherit; outline: none; }
.p3d-add-search:focus { border-color: var(--p3d-accent); box-shadow: 0 0 0 3px var(--p3d-accent-soft); }
.p3d-add-search-wrap { position: relative; margin-bottom: 4px; }
.p3d-add-search-wrap svg { position: absolute; left: 9px; top: 8px; color: var(--p3d-text-3); }
.p3d-tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; }
.p3d-tile { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; min-height: 68px;
  padding: 8px 4px 6px; border-radius: var(--p3d-r-m); border: 1px solid transparent; background: transparent;
  color: var(--p3d-text); font: inherit; font-size: 12px; cursor: pointer;
  transition: background var(--p3d-fast) var(--p3d-ease), border-color var(--p3d-fast) var(--p3d-ease), transform var(--p3d-fast) var(--p3d-ease); }
.p3d-tile svg { color: var(--p3d-text-2); transition: color var(--p3d-fast) var(--p3d-ease), transform var(--p3d-med) var(--p3d-ease); }
.p3d-tile:hover, .p3d-tile[data-active="true"] { background: var(--p3d-accent-soft); border-color: color-mix(in oklab, var(--p3d-accent) 30%, transparent); }
.p3d-tile:hover svg, .p3d-tile[data-active="true"] svg { color: var(--p3d-accent); transform: translateY(-1px); }
.p3d-tile:active { transform: scale(.97); }
.p3d-tile--wide { flex-direction: row; justify-content: flex-start; gap: 14px; min-height: 64px; padding: 12px 16px;
  border-color: var(--p3d-stroke); background: var(--p3d-surface); text-align: left; }
.p3d-tile-title { font-weight: 600; font-size: 13px; }
.p3d-tile-desc { font-size: 12px; color: var(--p3d-text-2); margin-top: 2px; }

/* ---------- outliner ---------- */
.p3d-tree { padding: 2px 6px 8px; outline: none; }
.p3d-row { position: relative; display: flex; align-items: center; gap: 6px; height: 28px; padding-right: 4px;
  border-radius: var(--p3d-r-s); cursor: default; color: var(--p3d-text); user-select: none;
  transition: background var(--p3d-fast) var(--p3d-ease); }
.p3d-row:hover { background: var(--p3d-hover); }
.p3d-row[aria-selected="true"] { background: var(--p3d-accent-soft); }
.p3d-row[aria-selected="true"]::before { content: ""; position: absolute; left: 0; top: 5px; bottom: 5px; width: 2px;
  border-radius: 2px; background: var(--p3d-accent); }
.p3d-row--hidden .p3d-row-name, .p3d-row--hidden .p3d-row-icon { opacity: .45; }
.p3d-row-caret { flex: 0 0 16px; display: inline-flex; align-items: center; justify-content: center; color: var(--p3d-text-3);
  border: 0; background: transparent; padding: 0; cursor: pointer; height: 16px; }
.p3d-row-icon { flex: 0 0 auto; display: inline-flex; color: var(--p3d-text-2); }
.p3d-row[aria-selected="true"] .p3d-row-icon { color: var(--p3d-accent); }
.p3d-row-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.p3d-row-meta { flex: 0 0 auto; font-size: 11px; color: var(--p3d-text-3); }
.p3d-row-tools { flex: 0 0 auto; display: inline-flex; opacity: 0; transition: opacity var(--p3d-fast) var(--p3d-ease); }
.p3d-row:hover .p3d-row-tools, .p3d-row:focus-within .p3d-row-tools, .p3d-row-tools--on { opacity: 1; }
.p3d-row:hover .p3d-row-meta, .p3d-row:focus-within .p3d-row-meta { display: none; }
.p3d-row--drop-into { box-shadow: inset 0 0 0 2px var(--p3d-accent-ring); }
.p3d-outliner-foot { flex: 0 0 auto; padding: 8px; border-top: 1px solid var(--p3d-stroke); }

/* ---------- inspector ---------- */
.p3d-insp-head { display: flex; align-items: center; gap: 10px; padding: 12px 14px 10px; flex: 0 0 auto; min-width: 0; }
.p3d-panel-scroll > .p3d-insp-head { position: sticky; top: 0; z-index: 3; background: var(--p3d-surface); box-shadow: 0 1px 0 var(--p3d-stroke); }
.p3d-insp-icon { flex: 0 0 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center;
  border-radius: var(--p3d-r-s); background: var(--p3d-accent-soft); color: var(--p3d-accent); }
.p3d-insp-name { font-size: 15px; font-weight: 600; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.p3d-insp-kind { font-size: 12px; color: var(--p3d-text-2); }
.p3d-section { border-top: 1px solid var(--p3d-stroke); }
.p3d-section-head { display: flex; align-items: center; gap: 8px; width: 100%; height: 36px; padding: 0 14px; border: 0;
  background: transparent; color: var(--p3d-text); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; text-align: left; }
.p3d-section-head:hover { background: var(--p3d-hover); }
.p3d-section-head .p3d-caret { transition: transform var(--p3d-med) var(--p3d-ease); color: var(--p3d-text-3); }
.p3d-section-head[aria-expanded="false"] .p3d-caret { transform: rotate(-90deg); }
.p3d-section-summary { margin-left: auto; font-weight: 400; color: var(--p3d-text-3); font-size: 11px; }
.p3d-section-body { padding: 2px 14px 14px; display: flex; flex-direction: column; gap: 10px; }
.p3d-label { font-size: 12px; color: var(--p3d-text-2); }
.p3d-help { font-size: 11px; color: var(--p3d-text-3); line-height: 1.4; }
.p3d-field-row { display: grid; grid-template-columns: minmax(84px, 42%) 1fr; align-items: center; gap: 8px; }
.p3d-axis-row { container: p3daxis / inline-size; display: grid; grid-template-columns: 1fr 1fr 1fr 22px; align-items: center; gap: 4px 4px; }
.p3d-axis-row > .p3d-label { grid-column: 1 / -1; margin-bottom: -1px; }
.p3d-axis-row .p3d-reset { opacity: 0; }
.p3d-axis-row:hover .p3d-reset, .p3d-axis-row:focus-within .p3d-reset { opacity: 1; }
.p3d-scrub { position: relative; display: flex; align-items: center; height: 28px; min-width: 0; border-radius: var(--p3d-r-s);
  background: var(--p3d-hover); border: 1px solid transparent; transition: border-color var(--p3d-fast) var(--p3d-ease), background var(--p3d-fast) var(--p3d-ease); }
.p3d-scrub:hover { border-color: var(--p3d-stroke-strong); }
.p3d-scrub:focus-within { border-color: var(--p3d-accent); background: var(--p3d-surface); box-shadow: 0 0 0 3px var(--p3d-accent-soft); }
.p3d-scrub-handle { flex: 0 0 auto; align-self: stretch; display: inline-flex; align-items: center; gap: 4px; padding: 0 2px 0 7px;
  cursor: ew-resize; color: var(--p3d-text-3); font-size: 11px; font-weight: 600; user-select: none; touch-action: none; }
.p3d-scrub-bar { width: 3px; height: 12px; border-radius: 2px; background: var(--p3d-text-3); }
.p3d-scrub-bar--x { background: var(--p3d-x); } .p3d-scrub-bar--y { background: var(--p3d-y); } .p3d-scrub-bar--z { background: var(--p3d-z); }
.p3d-scrub input { flex: 1 1 auto; min-width: 0; width: 100%; height: 100%; padding: 0 4px; border: 0; background: transparent;
  color: var(--p3d-text); font: inherit; font-size: 12px; font-variant-numeric: tabular-nums; outline: none; }
.p3d-scrub-unit { flex: 0 0 auto; padding-right: 7px; font-size: 11px; color: var(--p3d-text-3); }
.p3d-slider-row { display: grid; grid-template-columns: 1fr 64px; align-items: center; gap: 10px; }
.p3d-slider-ends { display: flex; justify-content: space-between; font-size: 11px; color: var(--p3d-text-3); margin-top: 1px; }
.p3d-range { -webkit-appearance: none; appearance: none; width: 100%; height: 18px; background: transparent; margin: 0; cursor: pointer; }
.p3d-range:focus { outline: none; }
.p3d-range::-webkit-slider-runnable-track { height: 4px; border-radius: 4px;
  background: linear-gradient(90deg, var(--p3d-accent) 0 var(--p3d-fill, 50%), var(--p3d-stroke-strong) var(--p3d-fill, 50%) 100%); }
.p3d-range::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; margin-top: -5px; border-radius: 50%;
  background: #fff; border: 1px solid rgba(0,0,0,.18); box-shadow: 0 1px 3px rgba(0,0,0,.25); transition: transform var(--p3d-fast) var(--p3d-ease); }
.p3d-range:hover::-webkit-slider-thumb { transform: scale(1.12); }
.p3d-range:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 4px var(--p3d-accent-ring); }
.p3d-range::-moz-range-track { height: 4px; border-radius: 4px; background: var(--p3d-stroke-strong); }
.p3d-range::-moz-range-progress { height: 4px; border-radius: 4px; background: var(--p3d-accent); }
.p3d-range::-moz-range-thumb { width: 14px; height: 14px; border-radius: 50%; background: #fff; border: 1px solid rgba(0,0,0,.18); }
.p3d-health { display: flex; flex-direction: column; gap: 8px; }
.p3d-health-head { font-size: 12px; font-weight: 600; color: var(--p3d-text); }
.p3d-health-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.p3d-health-row { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 8px; align-items: start; font-size: 12px; line-height: 1.4; }
.p3d-health-row svg { margin-top: 1px; }
.p3d-health-row[data-severity="error"] svg { color: var(--p3d-bad); }
.p3d-health-row[data-severity="warning"] svg { color: var(--p3d-warn, #b86e00); }
.p3d-health-row[data-severity="info"] svg { color: var(--p3d-text-2); }
.p3d-health-score { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-radius: var(--p3d-r-s);
  background: var(--p3d-raised); border: 1px solid var(--p3d-stroke); }
.p3d-health-score strong { font-size: 13px; }
.p3d-tidy { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border-radius: var(--p3d-r-s);
  border: 1px solid var(--p3d-stroke); }
.p3d-tidy ul { margin: 0; padding-left: 16px; font-size: 12px; }
.p3d-health-seg { display: inline-flex; gap: 4px; }
.p3d-health-where { color: var(--p3d-text-2); font-size: 11px; }
.p3d-maps { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.p3d-map-tile { display: grid; grid-template-columns: 36px minmax(0, 1fr) auto; align-items: center; gap: 8px; }
.p3d-map-thumb { width: 36px; height: 36px; border-radius: var(--p3d-r-s); overflow: hidden; display: grid; place-items: center;
  background: var(--p3d-raised); border: 1px solid var(--p3d-stroke); color: var(--p3d-text-2); }
.p3d-map-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.p3d-map-meta { min-width: 0; }
.p3d-map-title { font-size: 12px; font-weight: 600; color: var(--p3d-text); }
.p3d-map-sub { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.p3d-map-actions { display: flex; gap: 4px; }
.p3d-balls { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; }
.p3d-ballbtn { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 6px 0 4px; border-radius: var(--p3d-r-s);
  border: 1px solid transparent; background: transparent; color: var(--p3d-text-2); font: inherit; font-size: 11px; cursor: pointer;
  transition: background var(--p3d-fast) var(--p3d-ease); }
.p3d-ballbtn:hover { background: var(--p3d-hover); color: var(--p3d-text); }
.p3d-ballbtn[aria-pressed="true"] { border-color: var(--p3d-accent-ring); background: var(--p3d-accent-soft); color: var(--p3d-text); }
.p3d-ball { width: 28px; height: 28px; border-radius: 50%; position: relative; flex: 0 0 auto;
  box-shadow: inset 0 -2px 4px rgba(0,0,0,.18), 0 1px 2px rgba(0,0,0,.18); }
.p3d-ball--lg { width: 40px; height: 40px; }
.p3d-swatches { display: grid; grid-template-columns: repeat(9, 1fr); gap: 5px; }
.p3d-swatch { aspect-ratio: 1; width: 100%; padding: 0; border-radius: 50%; border: 1px solid rgba(0,0,0,.12); cursor: pointer;
  background: var(--p3d-sw); transition: transform var(--p3d-fast) var(--p3d-ease), box-shadow var(--p3d-fast) var(--p3d-ease); }
.p3d-swatch:hover { transform: scale(1.12); }
.p3d-swatch[aria-pressed="true"] { box-shadow: 0 0 0 2px var(--p3d-surface), 0 0 0 4px var(--p3d-accent); }
.p3d-swatch--custom { display: inline-flex; align-items: center; justify-content: center; color: var(--p3d-text-2);
  background: conic-gradient(#e0483e, #f2b33d, #6baf4b, #2e9c97, #2d5da8, #7b4b94, #e0483e); }
.p3d-color-row { display: flex; align-items: center; gap: 8px; }
.p3d-color-input { width: 32px; height: 28px; padding: 0; border: 1px solid var(--p3d-stroke-strong); border-radius: var(--p3d-r-s);
  background: transparent; cursor: pointer; }
.p3d-text-input { height: 28px; padding: 0 8px; min-width: 0; width: 100%; border-radius: var(--p3d-r-s); border: 1px solid transparent;
  background: var(--p3d-hover); color: var(--p3d-text); font: inherit; font-size: 12px; outline: none; }
.p3d-text-input:hover { border-color: var(--p3d-stroke-strong); }
.p3d-text-input:focus { border-color: var(--p3d-accent); background: var(--p3d-surface); box-shadow: 0 0 0 3px var(--p3d-accent-soft); }
.p3d-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.p3d-stat-grid { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 12px; }
.p3d-stat-grid dt { color: var(--p3d-text-2); }
.p3d-stat-grid dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
.p3d-badge { display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 7px; border-radius: 999px; font-size: 11px;
  background: var(--p3d-hover); color: var(--p3d-text-2); }
.p3d-scene-card { padding: 4px 14px 16px; display: flex; flex-direction: column; gap: 12px; }
.p3d-quick { display: flex; flex-direction: column; gap: 4px; }

/* ---------- scenes pane ---------- */
.p3d-scenes { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.p3d-pane-frame { display:flex; flex-direction:column; width:100%; height:100%; min-height:0; }
.p3d-pane-content { flex:1 1 auto; min-height:0; overflow:hidden; }
.p3d-pane-close-hint { flex:0 0 auto; margin:0; padding:6px 12px; border-top:1px solid var(--p3d-stroke); color:var(--p3d-text-2); font-size:11px; line-height:1.4; }
.p3d-scenes-head { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; height: 40px; padding: 0 6px 0 12px; }
.p3d-scenes-title { flex: 1 1 auto; font-size: 13px; font-weight: 600; }
.p3d-scene-list { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 2px 6px 8px; list-style: none; margin: 0; }
.p3d-scene-row { position: relative; display: flex; align-items: center; gap: 10px; width: 100%; min-height: 52px; padding: 6px 8px;
  border: 0; border-radius: var(--p3d-r-m); background: transparent; color: var(--p3d-text); font: inherit; text-align: left; cursor: pointer;
  transition: background var(--p3d-fast) var(--p3d-ease); }
.p3d-scene-row:hover { background: var(--p3d-hover); }
.p3d-scene-row[aria-current="true"] { background: var(--p3d-accent-soft); }
.p3d-scene-row[aria-current="true"]::before { content: ""; position: absolute; left: 0; top: 10px; bottom: 10px; width: 3px;
  border-radius: 3px; background: var(--p3d-accent); }
.p3d-scene-tile { flex: 0 0 40px; height: 40px; border-radius: 9px; display: inline-flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: 16px; color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,.25);
  background: radial-gradient(120% 120% at 25% 20%, color-mix(in oklab, var(--p3d-hue) 55%, #fff) 0%, var(--p3d-hue) 55%,
    color-mix(in oklab, var(--p3d-hue) 70%, #000) 100%);
  box-shadow: inset 0 0 0 1px rgba(255,255,255,.15), 0 1px 2px rgba(0,0,0,.15); }
.p3d-scene-text { min-width: 0; flex: 1 1 auto; }
.p3d-scene-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.p3d-scene-meta { font-size: 11px; color: var(--p3d-text-3); margin-top: 2px; white-space: nowrap; }

/* ---------- pane ---------- */
.p3d-pane { display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; outline: none; }
.p3d-pane-head { flex: 0 0 40px; display: flex; align-items: center; gap: 4px; padding: 0 6px 0 8px; border-bottom: 1px solid var(--p3d-stroke); min-width: 0; }
.p3d-select { height: 28px; min-width: 0; flex: 1 1 auto; max-width: 100%; padding: 0 26px 0 8px; border-radius: var(--p3d-r-s);
  border: 1px solid transparent; background: transparent; color: var(--p3d-text); font: inherit; font-weight: 600; font-size: 13px;
  -webkit-appearance: none; appearance: none; cursor: pointer;
  background-image: linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%);
  background-position: calc(100% - 13px) 12px, calc(100% - 9px) 12px; background-size: 4px 4px; background-repeat: no-repeat; }
.p3d-select:hover { background-color: var(--p3d-hover); }
.p3d-select:focus-visible { outline: 2px solid var(--p3d-accent-ring); }
.p3d-pane-foot { position: absolute; left: 8px; right: 8px; bottom: 8px; z-index: 6; display: flex; align-items: center; gap: 8px;
  height: 32px; padding: 0 4px 0 10px; font-size: 11px; color: var(--p3d-text-2); }
.p3d-pane-foot .p3d-grow { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---------- welcome / empty ---------- */
.p3d-welcome { max-width: 560px; margin: 0 auto; padding: 40px 24px; display: flex; flex-direction: column; align-items: center; gap: 18px; text-align: center; }
.p3d-welcome-art { width: 168px; height: 112px; }
.p3d-welcome h1 { margin: 0; font-size: 28px; font-weight: 650; letter-spacing: -.01em; }
.p3d-welcome p { margin: 0; color: var(--p3d-text-2); font-size: 14px; line-height: 1.5; }
.p3d-welcome-tiles { display: flex; flex-direction: column; gap: 8px; width: 100%; margin-top: 4px; }
.p3d-welcome--compact { padding: 20px 12px; gap: 12px; }
.p3d-welcome--compact .p3d-welcome-art { width: 104px; height: 70px; }
.p3d-welcome--compact h1 { font-size: 15px; }
.p3d-welcome--compact p { font-size: 12px; }

/* ---------- dialogs ---------- */
.p3d-dialog { position: absolute; z-index: 50; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 340px; max-width: 92%;
  padding: 18px; background: var(--p3d-raised); border: 1px solid var(--p3d-stroke-strong); border-radius: var(--p3d-r-l);
  box-shadow: var(--p3d-shadow-lg); animation: p3d-pop-in var(--p3d-med) var(--p3d-ease); }
.p3d-dialog-title { font-size: 15px; font-weight: 600; margin-bottom: 12px; }
.p3d-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.p3d-scrim { position: absolute; inset: 0; z-index: 45; background: color-mix(in oklab, #000 18%, transparent); }

/* ---------- card & chip ---------- */
.p3d-card { position: relative; border-radius: var(--p3d-r-l); overflow: hidden; border: 1px solid var(--p3d-stroke); background: var(--p3d-surface); }
.p3d-card-foot { position: absolute; left: 8px; right: 8px; bottom: 8px; z-index: 3; display: flex; align-items: center; gap: 8px;
  padding: 6px 6px 6px 12px; }
.p3d-card-foot .p3d-grow { flex: 1 1 auto; min-width: 0; }
.p3d-card-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.p3d-card-meta { font-size: 11px; color: var(--p3d-text-2); }
.p3d-chip { display: inline-flex; align-items: center; gap: 5px; }

.p3d-settle-tip { display:inline-flex; }
.p3d-settle--idle:has(> .p3d-settle-tip:only-child) { padding:0; border-color:transparent; background:transparent; box-shadow:none; backdrop-filter:none; }
.p3d-settle--idle > .p3d-settle-tip > button { background:var(--p3d-glass); backdrop-filter:blur(10px); }
.p3d-render-bar:not(.p3d-render-bar--active):not(:has(.p3d-render-note)) { padding:0; border-color:transparent; background:transparent; box-shadow:none; backdrop-filter:none; }
.p3d-render-bar:not(.p3d-render-bar--active) > button:only-child { border:1px solid var(--p3d-stroke-strong); background:var(--p3d-glass); backdrop-filter:blur(10px); }
.p3d-hint { max-width: calc(100% - 160px); }
/* While the Edit toolbar is up it needs the stage top; the view cube steps aside. */
.p3d-edit-bar ~ .p3d-viewgizmo, .p3d-edit-bar ~ .p3d-coach { display:none; }
/* In a narrow Properties column the unit suffix would cut the value ("0.5" showing as "0."): drop it. */
@container p3daxis (max-width: 260px) {
  .p3d-scrub-unit { display:none; }
}
/* Narrow-width adjustments live last so they override the base rules above. */
@container p3dstage (max-width: 480px) {
  .p3d-stage-bl { display:none !important; }
  .p3d-coach, .p3d-agent-bar { bottom:160px; }
  .p3d-stage-top { left:84px; transform:none; max-width:calc(100% - 184px); flex-wrap:wrap; }
  .p3d-render-bar { left:12px; transform:none; max-width:calc(100% - 24px); }
  .p3d-render-bar--active { max-width:calc(100% - 24px); }
  .p3d-edit-bar { left:84px; right:12px; width:auto; max-width:none; transform:none; }
  .p3d-edit-bar > .p3d-edit-row:first-child { flex-wrap:wrap; }
  .p3d-edit-bar kbd, .p3d-edit-sep { display:none; }
  .p3d-seg > button { padding:0 6px; font-size:11px; }
  .p3d-edit-bar { padding:8px; }
}
@container p3dstage (max-width: 339px) {
  /* No room for the first-visit hint or the coach tips beside the dock and the view cube. */
  .p3d-hint, .p3d-coach { display:none; }
}
@container p3deditor (max-width: 340px) {
  .p3d-header [aria-label="Undo"] { display:none; }
}
`;

/** Insert the stylesheet once; returns a remover for ctx.onDispose. */
export function injectStyles(doc: Document | undefined = typeof document === "undefined" ? undefined : document): () => void {
  if (!doc) return () => {};
  const existing = doc.head.querySelector(`style[${P3D_STYLE_ATTR}]`);
  if (existing) existing.remove();
  const el = doc.createElement("style");
  el.setAttribute(P3D_STYLE_ATTR, "");
  el.textContent = P3D_CSS;
  doc.head.appendChild(el);
  return () => el.remove();
}

// PR20: view-only animation transport, overlaid on the stage.
