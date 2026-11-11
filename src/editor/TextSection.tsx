// src/editor/TextSection.tsx — the Text settings of a text part, and "Add > Text" (PR23).
//
// Field edits are checked as you type (the same rules as the server, the triangle estimate and the
// missing-character list), and Apply, Enter or leaving a field builds the mesh and bakes it ONCE
// (one revision, one history entry; one undo restores the previous text). The settings are kept on the
// node as `generator: {type: "text", version: 1, params}`, so the section can reopen them.
import { useEffect, useMemo, useState } from "react";
import { bakeMesh } from "../api";
import type { RestFn } from "../api";
import { COPY } from "../copy";
import { encodeMesh } from "../scene/bake";
import { buildTextMesh, bundledFont, DEFAULT_TEXT_PARAMS, estimateTriangles, MAX_TEXT_TRIANGLES, missingGlyphs, TextError, validateTextParams } from "../scene/text";
import type { TextParams } from "../scene/text";
import { invalidateSceneData } from "../state/sceneQuery";
import type { NodeSpec, SceneSpec } from "../types";
import { Section } from "../ui/controls";
import { notifyToast, toastApiError } from "./sceneActions";
import { toastForCode } from "../copy";

function textMessage(error: unknown): string {
  if (error instanceof TextError) return error.code === "TEXT_GLYPH_MISSING" ? `${COPY.textMissing} ${error.chars.join(" ")}` : error.code === "TEXT_TOO_COMPLEX" ? COPY.textTooComplex : error.message;
  return COPY.textFailed;
}

/** What is wrong with these settings right now, if anything (cheap; nothing is built). */
export function textProblem(params: TextParams): string | null {
  try {
    validateTextParams(params);
    const font = bundledFont();
    const missing = missingGlyphs(font, params.text);
    if (missing.length) return `${COPY.textMissing} ${missing.join(" ")}`;
    if (estimateTriangles(font, params) > MAX_TEXT_TRIANGLES) return COPY.textTooComplex;
    return null;
  } catch (err) {
    return textMessage(err);
  }
}

/** Build the text, then bake it onto `nodeId`, or onto a new node when `create` is given. */
export async function applyText(rest: RestFn, scene: SceneSpec, params: TextParams, target: { nodeId: string } | { create: { name: string; transform: { t: number[]; r: number[]; s: number[] } } }, sourceKey?: string): Promise<string | null> {
  const mesh = buildTextMesh(params);
  const generator = { type: "text", version: 1, params };
  const envelope = await bakeMesh(rest, scene.id, { baseRevision: scene.revision, ...("nodeId" in target ? { nodeId: target.nodeId } : { create: target.create }), mesh: encodeMesh(mesh), generator } as never);
  if (sourceKey !== undefined) invalidateSceneData(sourceKey, scene.id);
  if ("create" in target) return envelope.nodes.find((n) => n.name === target.create.name || (n.generator?.type === "text" && !scene.nodes.some((o) => o.id === n.id)))?.id ?? null;
  return target.nodeId;
}

/** Add > Text: a new part with the defaults, at `position` (metres). */
export async function addText(rest: RestFn, scene: SceneSpec, name: string, position: [number, number, number], sourceKey?: string): Promise<string | null> {
  try {
    return await applyText(rest, scene, DEFAULT_TEXT_PARAMS, { create: { name, transform: { t: position, r: [0, 0, 0], s: [1, 1, 1] } } }, sourceKey);
  } catch (err) {
    if (err instanceof TextError) notifyToast({ id: "textFailed", kind: "warn", message: textMessage(err) } as never);
    else notifyToast(toastForCode(err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : "SPEC_INVALID", { context: "edit", serverMessage: err instanceof Error ? err.message : undefined }));
    return null;
  }
}

export function TextSection({ node, scene, rest, sourceKey }: { node: NodeSpec; scene: SceneSpec; rest: RestFn; sourceKey?: string }) {
  const saved = node.generator?.params as unknown as TextParams;
  const [draft, setDraft] = useState<TextParams>(saved);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(node.generator?.params as unknown as TextParams), [node.id, scene.revision, node.generator]);
  const problem = useMemo(() => textProblem(draft), [draft]);
  const changed = JSON.stringify(draft) !== JSON.stringify(saved);

  async function apply(): Promise<void> {
    if (busy || !changed || problem) return;
    setBusy(true);
    try {
      await applyText(rest, scene, draft, { nodeId: node.id }, sourceKey);
    } catch (err) {
      if (err instanceof TextError) notifyToast({ id: "textFailed", kind: "warn", message: textMessage(err) } as never);
      else toastApiError(err, "edit");
    } finally {
      setBusy(false);
    }
  }
  const set = <K extends keyof TextParams>(key: K, value: TextParams[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const num = (label: string, key: "size" | "depth" | "lineHeight" | "curveSegments", step: number) => (
    <label key={key} style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
      {label}
      <input className="p3d-input" type="number" step={step} aria-label={label} value={draft[key]} style={{ width: 90 }}
        onChange={(e) => set(key, Number(e.target.value))}
        onBlur={() => void apply()} onKeyDown={(e) => { if (e.key === "Enter") void apply(); }} />
    </label>
  );
  const tris = problem ? null : estimateTriangles(bundledFont(), draft);
  return (
    <Section id="text" title={COPY.textTitle} icon="chat" summary={changed ? COPY.textUnapplied : undefined}>
      <textarea className="p3d-input" aria-label={COPY.textField} rows={3} value={draft.text} maxLength={200} style={{ width: "100%" }}
        onChange={(e) => set("text", e.target.value)} onBlur={() => void apply()}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void apply(); } }} />
      {num(COPY.textSize, "size", 0.05)}
      {num(COPY.textDepth, "depth", 0.01)}
      {num(COPY.textLineHeight, "lineHeight", 0.1)}
      {num(COPY.textCurve, "curveSegments", 1)}
      <label style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
        {COPY.textAlign}
        <select className="p3d-select" aria-label={COPY.textAlign} value={draft.align} onChange={(e) => { set("align", e.target.value as TextParams["align"]); }} onBlur={() => void apply()}>
          <option value="left">{COPY.textLeft}</option><option value="center">{COPY.textCentre}</option><option value="right">{COPY.textRight}</option>
        </select>
      </label>
      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" aria-label={COPY.textBevel} checked={draft.bevel.enabled} onChange={(e) => set("bevel", { ...draft.bevel, enabled: e.target.checked })} />
        {COPY.textBevel}
      </label>
      <div className="p3d-help" role="status" aria-live="polite">{problem ?? `${COPY.textReady} (about ${tris?.toLocaleString()} triangles)`}</div>
      <button type="button" className="p3d-btn p3d-btn--sm" disabled={busy || !changed || problem !== null} onClick={() => void apply()}>{COPY.textApply}</button>
    </Section>
  );
}
