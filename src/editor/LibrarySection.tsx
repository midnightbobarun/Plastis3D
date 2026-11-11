// src/editor/LibrarySection.tsx — "Files in this scene" and Remove unused (PR14).
//
// Lists the models and images a scene holds and whether the scene uses each. Remove unused shows what it
// would drop, then drops those rows as one undoable revision. A file leaves the disk only later, when the
// sweep finds nothing (no scene, undo entry or draft) referencing it, so this can never break an undo.
import { useCallback, useEffect, useState } from "react";
import { getLibrary, removeUnusedAssets } from "../api";
import type { LibraryView, RestFn } from "../api";
import { COPY } from "../copy";
import { invalidateSceneData } from "../state/sceneQuery";
import type { SceneSpec } from "../types";
import { Section } from "../ui/controls";
import { toastApiError } from "./sceneActions";

const mb = (bytes: number): string => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export function LibrarySection({ rest, scene, sourceKey }: { rest: RestFn; scene: SceneSpec; sourceKey?: string }) {
  const [view, setView] = useState<LibraryView | null>(null);
  const [preview, setPreview] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    void getLibrary(rest, scene.id).then(setView).catch(() => setView(null));
  }, [rest, scene.id]);
  useEffect(() => { setPreview(null); load(); }, [load, scene.revision]);

  if (!view || view.assets.length === 0) return null;

  async function showPreview(): Promise<void> {
    setBusy(true);
    try {
      const result = await removeUnusedAssets(rest, scene.id, scene.revision, true);
      setPreview(result.removed);
    } catch (err) { toastApiError(err, "edit"); } finally { setBusy(false); }
  }
  async function apply(): Promise<void> {
    setBusy(true);
    try {
      const result = await removeUnusedAssets(rest, scene.id, scene.revision, false);
      setPreview(null);
      setNote(result.applied ? COPY.libraryRemoved : COPY.libraryNothing);
      if (sourceKey !== undefined) invalidateSceneData(sourceKey, scene.id);
      load();
    } catch (err) { toastApiError(err, "edit"); } finally { setBusy(false); }
  }

  const names = new Map(view.assets.map((a) => [a.id, a.name]));
  return (
    <Section id="library" title={COPY.libraryTitle} icon="cube3" summary={view.unused ? `${view.unused} unused` : undefined}>
      <ul className="p3d-help" style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label={COPY.libraryTitle}>
        {view.assets.map((a) => (
          <li key={a.id} data-testid="library-row" style={{ display: "flex", gap: 8, justifyContent: "space-between" }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</span>
            <span>{mb(a.bytes)} · {a.used ? COPY.libraryUsed : COPY.libraryUnused}</span>
          </li>
        ))}
      </ul>
      {view.unused > 0 && !preview && (
        <button type="button" className="p3d-btn p3d-btn--sm" disabled={busy} onClick={() => void showPreview()}>
          {COPY.libraryRemoveUnused} ({view.unused})
        </button>
      )}
      {preview && (
        <div role="group" aria-label={COPY.libraryRemoveUnused} className="p3d-help">
          <p style={{ margin: "4px 0" }}>{COPY.libraryPreview} {preview.map((id) => names.get(id) ?? id.slice(0, 8)).join(", ")}.</p>
          <button type="button" className="p3d-btn p3d-btn--sm" disabled={busy} onClick={() => void apply()}>{COPY.libraryApply}</button>{" "}
          <button type="button" className="p3d-btn p3d-btn--sm" disabled={busy} onClick={() => setPreview(null)}>{COPY.editCancel}</button>
        </div>
      )}
      {note && <div className="p3d-help" role="status">{note}</div>}
    </Section>
  );
}
