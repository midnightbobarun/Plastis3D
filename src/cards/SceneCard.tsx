import { useEffect, useId, useMemo, useRef, useState } from "react";
import { host, Skeleton, ErrorState } from "@hermes/plugin-sdk";
import type { PluginContext, TranscriptDirectiveProps } from "@hermes/plugin-sdk";
import { ApiError, envelopeToScene } from "../api";
import type { RestFn } from "../api";
import { useScene, useSceneList } from "../state/sceneQuery";
import { createSelectionStore } from "../state/selection";
import { createGizmoModeStore } from "../gizmos/gizmoMode";
import { onLeaseFreed } from "../scene/leases";
import { Viewport } from "../viewport/Viewport";
import { COPY, cardBadIdMessage } from "../copy";
import { cardSceneId } from "./cardAttrs";
import { reportCard } from "./nearestCard";
import { sceneHue } from "../editor/ScenesPane";
export function SceneCard(props: TranscriptDirectiveProps & { ctx: PluginContext; sourceKey: string }) {
  const valid = cardSceneId(props.attrs);
  return valid ? <Card {...props} /> : null;
}
function Card({ attrs, streaming, ctx, sourceKey }: TranscriptDirectiveProps & { ctx: PluginContext; sourceKey: string }) {
  const id = useId();
  const [narrow, setNarrow] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [nearest, setNearest] = useState(false);
  const [leased, setLeased] = useState(true);
  // A yield destroys the renderer synchronously. React can batch the
  // summary transition with a rapid lease-freed notification; a new key
  // still remounts that destroyed renderer when leased returns to true.
  const [rendererGeneration, setRendererGeneration] = useState(0);
  const [awake, setAwake] = useState(document.visibilityState === "visible");
  const selection = useMemo(createSelectionStore, []);
  const gizmoMode = useMemo(createGizmoModeStore, []);
  useEffect(() => { if (!root.current) return; const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < 360)); observer.observe(root.current); return () => observer.disconnect(); }, []);
  useEffect(() => { const fn = () => setAwake(document.visibilityState === "visible"); document.addEventListener("visibilitychange", fn); return () => document.removeEventListener("visibilitychange", fn); }, []);
  useEffect(() => {
    if (streaming || !awake || !root.current) return;
    const element = root.current;
    const observer = new IntersectionObserver(([entry]) => {
      setVisible(entry.isIntersecting);
      reportCard(id, { element, height: entry.isIntersecting ? entry.intersectionRect.height : 0, notify: setNearest });
    }, { threshold: [0, .25, .5, .75, 1] });
    observer.observe(element);
    return () => { observer.disconnect(); reportCard(id, null); setVisible(false); };
  }, [id, streaming, awake]);
  useEffect(() => { setLeased(true); return onLeaseFreed(() => { if (nearest) { setLeased(true);  } }); }, [nearest]);
  const query = useScene(sourceKey, !streaming && visible && awake ? attrs.scene : null, { eligible: !streaming && visible && awake });
  const name = attrs.scene;
  const scene = query.data ? envelopeToScene(query.data, name) : null;
  const stageHeight = narrow ? 180 : 240;
  const tris = query.data?.stats.tris;
  const objects = query.data ? query.data.nodes.filter((n) => n.kind !== "light" && n.kind !== "camera").length : null;
  const meta = query.data
    ? `rev ${query.data.scene.revision} · ${objects === 1 ? "1 object" : `${objects} objects`} · ${tris} tris · Read-only`
    : "Read-only";
  return <div ref={root} data-plastis-card={attrs.scene} className="p3d-root p3d-card">
    {streaming ? <Skeleton style={{ height: stageHeight }} /> : <>
      {query.status === "error" ? (
        <div className="p3d-message" style={{ minHeight: 120, alignItems: "center" }}>
          <ErrorState title={query.error instanceof ApiError && query.error.code === "SCENE_NOT_FOUND" ? cardBadIdMessage(attrs.scene) : COPY.storeTitle} description={query.error instanceof ApiError && query.error.code === "SCENE_NOT_FOUND" ? undefined : COPY[query.storeSentence]} />
        </div>
      ) : scene && nearest && visible && awake && leased ? (
        <div style={{ height: stageHeight, position: "relative", display: "flex" }}>
          <Viewport key={rendererGeneration} scene={scene} sourceKey={sourceKey} rest={ctx.rest as unknown as RestFn} visible chrome="card" selection={selection} gizmoMode={gizmoMode} onYield={() => { setLeased(false); setRendererGeneration(value => value + 1); }} />
        </div>
      ) : (
        <div className="p3d-stage" style={{ height: scene ? 120 : stageHeight, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span className="p3d-muted" style={{ fontSize: 12 }} title={scene ? "Another 3D view is using the renderer. Scroll to this card or open it in the editor." : undefined}>
            {scene ? "Preview paused" : "Loading scene…"}
          </span>
        </div>
      )}
      <div className="p3d-card-foot p3d-glass" style={{ position: scene && nearest && visible && awake && leased && query.status !== "error" ? "absolute" : "static", margin: scene && nearest && visible && awake && leased ? 0 : 8 }}>
        <span className="p3d-scene-tile" aria-hidden="true" style={{ flex: "0 0 30px", height: 30, borderRadius: 8, fontSize: 13, ["--p3d-hue" as string]: sceneHue(attrs.scene) } as React.CSSProperties}>
          {(name.trim()[0] ?? "?").toUpperCase()}
        </span>
        <span className="p3d-grow">
          <div className="p3d-card-name">{visible && awake ? <SceneName sourceKey={sourceKey} sceneId={attrs.scene} /> : name}</div>
          <div className="p3d-card-meta p3d-num">{meta}</div>
        </span>
        <button type="button" className="p3d-btn p3d-btn--primary p3d-btn--sm" onClick={() => host.navigate(`/plastis3d?scene=${attrs.scene}`)}>Open in editor</button>
      </div>
    </>}
  </div>;
}

function SceneName({ sourceKey, sceneId }: { sourceKey: string; sceneId: string }) {
 const list = useSceneList(sourceKey, { eligible: true });
 return <>{list.data?.find(row => row.id === sceneId)?.name ?? sceneId}</>;
}
