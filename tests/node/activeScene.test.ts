// tests/node/activeScene.test.ts — E-12 split selections (Tier 2,
// D-REPLAN-02).
//
// Covers src/state/activeScene.ts: the editor and pane selections are
// independent; the resolver falls through editor -> pane -> first ->
// null, ignoring stale ids; the mount-write value is pane else first.
// Each test uses a fresh sourceKey (the store is module-level).
// The harness test drives the split in the real UI
// (editor-pane-split.spec.ts).
import { describe, expect, it } from "vitest";

import {
  clearEditorSceneId,
  getActiveSceneId,
  getEditorSceneId,
  getPaneSceneId,
  setAvailableScenes,
  setEditorSceneId,
  setEditorSceneIdFromQuery,
  setPaneSceneId,
} from "../../src/state/activeScene";

describe("split selections", () => {
  it("a pane write does not change the editor read (and vice versa)", () => {
    setAvailableScenes("s-pane", ["a", "b"]);
    setPaneSceneId("s-pane", "b");
    expect(getPaneSceneId("s-pane")).toBe("b");
    // No editor selection: the resolver falls through to the pane.
    expect(getActiveSceneId("s-pane")).toBe("b");
    setEditorSceneId("s-pane", "a");
    expect(getActiveSceneId("s-pane")).toBe("a");
    expect(getPaneSceneId("s-pane")).toBe("b");
  });

  it("an editor write does not change the pane read", () => {
    setAvailableScenes("s-editor", ["a", "b"]);
    setEditorSceneId("s-editor", "b");
    expect(getActiveSceneId("s-editor")).toBe("b");
    expect(getPaneSceneId("s-editor")).toBe("a");
    setPaneSceneId("s-editor", "a");
    expect(getPaneSceneId("s-editor")).toBe("a");
    expect(getActiveSceneId("s-editor")).toBe("b");
  });

  it("resolver falls through: null editor -> pane, null pane -> first", () => {
    setAvailableScenes("s-fall", ["a", "b"]);
    expect(getActiveSceneId("s-fall")).toBe("a");
    expect(getPaneSceneId("s-fall")).toBe("a");
    setPaneSceneId("s-fall", "b");
    expect(getActiveSceneId("s-fall")).toBe("b");
    setEditorSceneId("s-fall", "a");
    expect(getActiveSceneId("s-fall")).toBe("a");
    clearEditorSceneId("s-fall");
    expect(getActiveSceneId("s-fall")).toBe("b");
    expect(getEditorSceneId("s-fall")).toBeNull();
  });

  it("stale ids are ignored by the resolver and the pane fallback", () => {
    setAvailableScenes("s-stale", ["a", "b"]);
    setEditorSceneId("s-stale", "gone");
    setPaneSceneId("s-stale", "also-gone");
    expect(getActiveSceneId("s-stale")).toBe("a");
    expect(getPaneSceneId("s-stale")).toBe("a");
    setPaneSceneId("s-stale", "b");
    expect(getActiveSceneId("s-stale")).toBe("b");
  });

  it("no scenes -> null on every read", () => {
    setAvailableScenes("s-empty", []);
    expect(getActiveSceneId("s-empty")).toBeNull();
    expect(getPaneSceneId("s-empty")).toBeNull();
  });

  it("mount-write value is pane else first, null when no scenes", () => {
    setAvailableScenes("s-mount", ["a", "b"]);
    expect(getPaneSceneId("s-mount")).toBe("a");
    setPaneSceneId("s-mount", "b");
    expect(getPaneSceneId("s-mount")).toBe("b");
    setAvailableScenes("s-mount-none", []);
    expect(getPaneSceneId("s-mount-none")).toBeNull();
  });

  it("setEditorSceneIdFromQuery sets only when in list", () => {
    setAvailableScenes("s-query", ["a", "b"]);
    expect(setEditorSceneIdFromQuery("s-query", "b", ["a", "b"])).toBe(true);
    expect(getEditorSceneId("s-query")).toBe("b");
    expect(setEditorSceneIdFromQuery("s-query", "ghost", ["a", "b"])).toBe(
      false,
    );
    expect(getEditorSceneId("s-query")).toBe("b");
  });

  it("clearEditorSceneId is a no-op when nothing was set", () => {
    setAvailableScenes("s-clear", ["a"]);
    clearEditorSceneId("s-clear");
    expect(getActiveSceneId("s-clear")).toBe("a");
  });
});

describe("pane default stays put when the list is re-ordered", () => {
  it("locks the first scene at load and keeps it when another scene becomes newest", async () => {
    const { getPaneSceneId, setAvailableScenes } = await import("../../src/state/activeScene");
    const key = "lock-test:default";
    setAvailableScenes(key, ["old", "other"]);
    expect(getPaneSceneId(key)).toBe("old");
    setAvailableScenes(key, ["newer", "old", "other"]);
    expect(getPaneSceneId(key)).toBe("old");
  });
  it("re-locks to the new first scene when the locked one is deleted", async () => {
    const { getPaneSceneId, setAvailableScenes } = await import("../../src/state/activeScene");
    const key = "lock-test:delete";
    setAvailableScenes(key, ["a", "b"]);
    setAvailableScenes(key, ["b"]);
    expect(getPaneSceneId(key)).toBe("b");
    setAvailableScenes(key, ["c", "b"]);
    expect(getPaneSceneId(key)).toBe("b");
  });
});
