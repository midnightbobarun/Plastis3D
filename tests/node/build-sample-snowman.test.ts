// tests/node/build-sample-snowman.test.ts — the one-click snowman
// flow (Tier 2, Phase 0 0-D).
//
// Covers src/editor/sceneActions.ts buildSampleSnowman with a stub
// RestFn: POST /scenes { name: "Snowman" }, then PATCH build with the
// canned spec + the new scene's revision, then the new scene is
// selected. The click-flow harness test lands with the Phase 2 wiring
// (E-02), when the shared empty state is mounted.
//
// sceneActions imports @hermes/plugin-sdk (host.notify for toasts),
// which has no Node module in this repo — the SDK is stubbed with
// vi.mock, the same way the harness stubs it in the browser.
import { describe, expect, it, vi } from "vitest";

vi.mock("@hermes/plugin-sdk", () => ({
  host: { notify: () => "mock-notify" },
}));

import { buildSampleSnowman } from "../../src/editor/sceneActions";
import {
  getActiveSceneId,
  setAvailableScenes,
} from "../../src/state/activeScene";
import type { RestFn } from "../../src/api";
import type { SceneEnvelope } from "../../src/types";
import { ApiError } from "../../src/api";

function envelope(
  id: string,
  revision: number,
  nodes: SceneEnvelope["nodes"],
): SceneEnvelope {
  return {
    ok: true,
    scene: { id, revision, units: "m", upAxis: "Y" },
    nodes,
    materials: [
      {
        id: "m_default",
        color: "#c8ccd0",
        emissive: "#000000",
        metalness: 0,
        roughness: 0.6,
        opacity: 1,
        doubleSide: false,
      },
    ],
    assets: [],
    stats: { tris: 0, verts: 0, materials: 1, nodes: nodes.length },
    feedback: {
      canUndo: false,
      canRedo: false,
      defaultsAdded: [],
      historyTruncated: false,
    },
  };
}

describe("buildSampleSnowman", () => {
  it("creates Snowman, builds the canned spec, and selects the new scene", async () => {
    const calls: Array<{ path: string; opts: unknown }> = [];
    const rest = (async (path: string, opts?: unknown) => {
      calls.push({ path, opts });
      if (path === "/scenes") {
        return envelope("snowman", 1, []);
      }
      if (path === "/scenes/snowman") {
        const body = (opts as { body: unknown }).body as {
          baseRevision: number;
          ops: Array<Record<string, unknown>>;
        };
        expect(body.baseRevision).toBe(1);
        expect(body.ops).toHaveLength(1);
        expect(body.ops[0].op).toBe("build");
        const nodes = body.ops[0].nodes as Array<{ id: string }>;
        expect(nodes.map((n) => n.id)).toEqual([
          "snow_base",
          "snow_middle",
          "snow_head",
          "snow_scarf",
          "snow_hat",
        ]);
        return envelope("snowman", 2, nodes as SceneEnvelope["nodes"]);
      }
      throw new Error(`unexpected rest call ${path}`);
    }) as unknown as RestFn;

    const result = await buildSampleSnowman(rest, "src-test-snowman");
    expect(result).not.toBeNull();
    expect(result?.scene.id).toBe("snowman");
    expect(result?.scene.revision).toBe(2);
    expect(calls.map((c) => c.path)).toEqual(["/scenes", "/scenes/snowman"]);
    expect((calls[0].opts as { body: unknown }).body).toEqual({
      name: "Snowman",
    });
    // The formal rule resolves the explicit selection only once the
    // new scene is in the list: seed the list the way the list
    // refetch (triggered by invalidateSceneData) would, then the
    // selection resolves to the new scene.
    setAvailableScenes("src-test-snowman", ["snowman"]);
    expect(getActiveSceneId("src-test-snowman")).toBe("snowman");
  });

  it("on build failure after a successful create, still selects the new scene and returns null", async () => {
    const rest = (async (path: string) => {
      if (path === "/scenes") return envelope("snowman", 1, []);
      throw new ApiError("SPEC_INVALID", "build refused");
    }) as unknown as RestFn;

    const result = await buildSampleSnowman(rest, "src-test-snowman-fail");
    expect(result).toBeNull();
    setAvailableScenes("src-test-snowman-fail", ["snowman"]);
    expect(getActiveSceneId("src-test-snowman-fail")).toBe("snowman");
  });

  it("on create failure, returns null and selects nothing", async () => {
    const rest = (async () => {
      throw new ApiError("SCENE_EXISTS", "a scene with that name already exists");
    }) as unknown as RestFn;

    const result = await buildSampleSnowman(rest, "src-test-snowman-create-fail");
    expect(result).toBeNull();
    expect(getActiveSceneId("src-test-snowman-create-fail")).toBeNull();
  });
});
