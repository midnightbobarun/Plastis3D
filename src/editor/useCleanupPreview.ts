// State lives at Inspector level to survive selection branch changes.
import { useEffect, useRef, useState } from "react";
import { gatewayActivationEpoch } from "@hermes/plugin-sdk";
import { cleanupScene } from "../api";
import type { CleanupInfo, RestFn } from "../api";
import { COPY } from "../copy";
import { invalidateSceneData } from "../state/sceneQuery";
import type { SceneSpec } from "../types";
interface TidyPreview { key: string; revision: number; operations: string[]; cleanup: CleanupInfo }
export function useCleanupPreview(rest: RestFn, scene: SceneSpec, sourceKey = "local") {
  const epoch = gatewayActivationEpoch();
  const surface = JSON.stringify([sourceKey, scene.id, epoch]);
  const key = JSON.stringify([surface, scene.revision]);
  const current = useRef({ surface, key }); current.current = { surface, key };
  const token = useRef(0);
  const job = useRef<{ token: number; surface: string; key: string; posting: boolean } | null>(null);
  const [state, setState] = useState<{ surface: string; preview: TidyPreview | null; busy: boolean; posting: boolean; message: string | null }>({ surface, preview: null, busy: false, posting: false, message: null });
  useEffect(() => {
    const active = job.current;
    let retired = false;
    if (active && (active.surface !== surface || (!active.posting && active.key !== key))) {
      ++token.current; job.current = null; retired = true;
    }
    setState(old => {
      if (old.surface !== surface) return { surface, preview: null, busy: false, posting: false, message: null };
      if (retired) return { surface, preview: null, busy: false, posting: false, message: COPY.tidyExpired };
      if (old.preview && old.preview.key !== key) return { ...old, preview: null, busy: !!job.current, message: old.posting ? null : COPY.tidyExpired };
      return old;
    });
  }, [key]);
  useEffect(() => () => { ++token.current; job.current = null; }, []);
  async function preview(operations: string[]) {
    if (job.current?.posting || current.current.key !== key || gatewayActivationEpoch() !== epoch) return;
    const request = { token: ++token.current, surface, key, posting: false };
    job.current = request;
    setState({ surface, preview: null, busy: true, posting: false, message: null });
    const active = () => token.current === request.token && current.current.key === key && gatewayActivationEpoch() === epoch;
    try {
      const result = await cleanupScene(rest, scene.id, { baseRevision: scene.revision, operations, dryRun: true });
      if (!active()) return;
      if (result.scene.id !== scene.id || result.scene.revision !== scene.revision || !result.cleanup.dryRun) throw new Error("stale cleanup preview");
      setState({ surface, preview: { key, revision: scene.revision, operations: [...operations], cleanup: result.cleanup }, busy: false, posting: false, message: null });
    } catch {
      if (active()) setState({ surface, preview: null, busy: false, posting: false, message: COPY.tidyFailed });
    } finally {
      if (job.current?.token === request.token) job.current = null;
    }
  }
  async function apply() {
    const captured = state.preview;
    if (!captured || captured.key !== current.current.key || job.current || gatewayActivationEpoch() !== epoch) return;
    const request = { token: ++token.current, surface, key, posting: true };
    job.current = request;
    setState(old => ({ ...old, busy: true, posting: true, message: null }));
    const active = () => token.current === request.token && current.current.surface === surface && gatewayActivationEpoch() === epoch;
    try {
      const result = await cleanupScene(rest, scene.id, { baseRevision: captured.revision, operations: captured.operations });
      if (sourceKey !== "local") invalidateSceneData(sourceKey, scene.id);
      const drawable = (result.cleanup.changes.assetsWelded ?? []).filter(row => row.becameDrawable === true).map(row => row.name);
      const message = drawable.length ? `${COPY.tidyDone} ${drawable.join(", ")} now meets the mesh and byte draw limits; loading can still fail.` : COPY.tidyDone;
      if (active()) setState({ surface, preview: null, busy: false, posting: false, message });
    } catch {
      if (active()) setState({ surface, preview: null, busy: false, posting: false, message: COPY.tidyFailed });
    } finally {
      if (job.current?.token === request.token) job.current = null;
    }
  }
  function cancel() {
    if (job.current?.posting) return;
    ++token.current; job.current = null;
    setState({ surface, preview: null, busy: false, posting: false, message: null });
  }
  return {
    scope: surface,
    preview: state.surface === surface && state.preview?.key === key ? state.preview : null,
    busy: state.surface === surface && state.busy,
    posting: state.surface === surface && state.posting,
    message: state.surface === surface ? state.message : null,
    run: preview, apply, cancel,
  };
}

export type CleanupPreviewState = ReturnType<typeof useCleanupPreview>;
