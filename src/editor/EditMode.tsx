// src/editor/EditMode.tsx — the Edit mesh toolbar, the Restore offer and the generator
// confirmation (PR24). It only shows while a session is open; the session itself lives in the
// Viewport (src/viewport/editSession.ts). Every control sends a command through the store.
import { COPY } from "../copy";
import { useEditMode } from "../state/editMode";
import type { EditModeStore } from "../state/editMode";
import type { PickMode } from "../scene/meshEdit";

const TOOLS: Array<{ tool: "mesh" | "sculpt" | "paint"; label: string; key: string }> = [
  { tool: "mesh", label: COPY.toolMesh, key: "M" },
  { tool: "sculpt", label: COPY.toolSculpt, key: "B" },
  { tool: "paint", label: COPY.toolPaint, key: "P" },
];
const PICKS: Array<{ mode: PickMode; label: string; key: string }> = [
  { mode: "vertex", label: COPY.editVertex, key: "1" },
  { mode: "edge", label: COPY.editEdge, key: "2" },
  { mode: "face", label: COPY.editFace, key: "3" },
];

export function EditToolbar({ store }: { store: EditModeStore }) {
  const edit = useEditMode(store);
  if (!edit.active) return null;
  const btn = "p3d-btn p3d-btn--sm";
  const saved = edit.restoreOffer ? new Date(edit.restoreOffer.savedAt * 1000).toLocaleTimeString() : "";
  return (
    <>
      <div role="toolbar" aria-label={COPY.editToolbar} className="p3d-glass p3d-edit-bar">
        <div className="p3d-edit-row">
          <strong data-testid="edit-name" className="p3d-edit-name">{edit.nodeName}</strong>
          <span className="p3d-seg" role="group" aria-label="Tool">
            {TOOLS.map((t) => (
              <button key={t.tool} type="button" aria-pressed={edit.tool === t.tool} aria-label={`${t.label} (${t.key})`} disabled={edit.busy} onClick={() => store.dispatch({ type: "tool", tool: t.tool })}>{t.label} <kbd>{t.key}</kbd></button>
            ))}
          </span>
          <span className="p3d-grow" />
          <span role="status" aria-live="polite" data-testid="edit-status" className="p3d-edit-status">{edit.busy ? COPY.editSaving : `${edit.selected} selected${edit.dirty ? " · changed" : ""}`}</span>
          <button type="button" className={btn} disabled={edit.busy} onClick={() => store.dispatch({ type: "cancel" })}>{COPY.editCancel}</button>
          <button type="button" className={`${btn} p3d-btn--primary`} disabled={edit.busy} onClick={() => store.dispatch({ type: "toggle" })}>{COPY.editDone} <kbd>M</kbd></button>
        </div>
        <div className="p3d-edit-row p3d-edit-options">
          {edit.tool === "mesh" && <>
            <span className="p3d-seg" role="group" aria-label="Select">
              {PICKS.map((p) => (
                <button key={p.mode} type="button" aria-pressed={edit.pick === p.mode} aria-label={`${p.label} (${p.key})`} disabled={edit.busy} onClick={() => store.dispatch({ type: "pick", mode: p.mode })}>{p.label} <kbd>{p.key}</kbd></button>
              ))}
            </span>
            <span className="p3d-edit-sep" />
            <button type="button" className={btn} disabled={edit.busy || edit.selected === 0} onClick={() => store.dispatch({ type: "extrude" })}>{COPY.editExtrude}</button>
            <button type="button" className={btn} disabled={edit.busy || edit.selected === 0} onClick={() => store.dispatch({ type: "delete" })}>{COPY.editDeleteFaces}</button>
            <button type="button" className={btn} disabled={edit.busy || edit.selected === 0} onClick={() => store.dispatch({ type: "flip" })}>{COPY.editFlip}</button>
            <button type="button" className={btn} disabled={edit.busy || edit.selected === 0 || edit.pick !== "edge"} onClick={() => store.dispatch({ type: "seam" })}>{COPY.editMarkSeam}</button>
          </>}
          {edit.tool === "sculpt" && <>
            <span className="p3d-seg" role="group" aria-label="Brush">
              {(["draw", "smooth", "flatten", "grab"] as const).map((b) => (
                <button key={b} type="button" aria-pressed={edit.brush.type === b} onClick={() => store.dispatch({ type: "brush", patch: { type: b } })}>{{ draw: COPY.brushDraw, smooth: COPY.brushSmooth, flatten: COPY.brushFlatten, grab: COPY.brushGrab }[b]}</button>
              ))}
            </span>
            <span className="p3d-edit-sep" />
          </>}
          {edit.tool === "paint" && <>
            <label className="p3d-edit-field">{COPY.brushColor} <input type="color" aria-label={COPY.brushColor} value={edit.brush.color} onChange={(e) => store.dispatch({ type: "brush", patch: { color: e.target.value } })} /></label>
            <button type="button" className={btn} disabled={edit.busy} onClick={() => store.dispatch({ type: "fill" })}>{COPY.brushFill}</button>
            <span className="p3d-edit-sep" />
          </>}
          {edit.tool !== "mesh" && <>
            <label className="p3d-edit-field">{COPY.brushRadius} <input className="p3d-input" type="number" aria-label={COPY.brushRadius} min={4} max={400} step={4} style={{ width: 60 }} value={edit.brush.radius} onChange={(e) => store.dispatch({ type: "brush", patch: { radius: Number(e.target.value) } })} /></label>
            <label className="p3d-edit-field">{COPY.brushStrength} <input className="p3d-input" type="number" aria-label={COPY.brushStrength} min={0.05} max={1} step={0.05} style={{ width: 60 }} value={edit.brush.strength} onChange={(e) => store.dispatch({ type: "brush", patch: { strength: Number(e.target.value) } })} /></label>
            {edit.tool === "paint" && <label className="p3d-edit-field">{COPY.brushHardness} <input className="p3d-input" type="number" aria-label={COPY.brushHardness} min={0} max={1} step={0.1} style={{ width: 60 }} value={edit.brush.hardness} onChange={(e) => store.dispatch({ type: "brush", patch: { hardness: Number(e.target.value) } })} /></label>}
            <label className="p3d-edit-field"><input type="checkbox" aria-label={COPY.brushSymmetry} checked={edit.brush.symmetryX} onChange={(e) => store.dispatch({ type: "brush", patch: { symmetryX: e.target.checked } })} /> {COPY.brushSymmetry}</label>
          </>}
        </div>
      </div>
      {edit.restoreOffer && (
        <div role="alertdialog" aria-label={COPY.editRestoreOffer} className="p3d-glass" style={{ position: "absolute", top: 64, left: "50%", transform: "translateX(-50%)", zIndex: 9, padding: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span>{edit.restoreOffer.changed ? COPY.editRestoreChanged : `${COPY.editRestoreOffer} ${saved}?`}</span>
          <button type="button" className={btn} onClick={() => store.dispatch({ type: "restore" })}>{COPY.editRestore}</button>
          <button type="button" className={btn} onClick={() => store.dispatch({ type: "discard" })}>{COPY.editDiscard}</button>
        </div>
      )}
      {edit.confirmGenerator && (
        <>
          <div className="p3d-scrim" />
          <div className="p3d-dialog" role="dialog" aria-modal="true" aria-label={COPY.editGeneratorEnds}>
            <p>{COPY.editGeneratorEnds}</p>
            <button type="button" className={btn} onClick={() => store.dispatch({ type: "confirm", ok: true })}>{COPY.editContinue}</button>
            <button type="button" className={btn} onClick={() => store.dispatch({ type: "confirm", ok: false })}>{COPY.editCancel}</button>
          </div>
        </>
      )}
    </>
  );
}
