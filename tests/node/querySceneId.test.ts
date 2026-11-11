import { describe, expect, it } from "vitest";
import { querySceneId, sceneIdFromHash } from "../../src/editor/querySceneId";

// F-UI-FIX-07: the real host's host.navigate writes the query into the
// hash (`#/plastis3d?scene=<id>`); location.search stays empty.
describe("querySceneId", () => {
  it("reads the scene from the hash route (the real host's shape)", () => {
    expect(querySceneId("#/plastis3d?scene=probe-b", "")).toBe("probe-b");
  });

  it("falls back to the real search string (the old shape)", () => {
    expect(querySceneId("#/plastis3d", "?scene=demo-scene")).toBe("demo-scene");
  });

  it("prefers the hash when both carry a scene", () => {
    expect(querySceneId("#/plastis3d?scene=b", "?scene=a")).toBe("b");
  });

  it("is null when neither carries a scene", () => {
    expect(querySceneId("#/plastis3d", "")).toBeNull();
    expect(querySceneId("", "")).toBeNull();
    expect(querySceneId("#/plastis3d?other=1", "")).toBeNull();
  });

  it("keeps an unknown id verbatim so the editor can report cardBadId", () => {
    expect(querySceneId("#/plastis3d?scene=no-such-scene", "")).toBe(
      "no-such-scene",
    );
  });

  it("accepts a hash without the leading #", () => {
    expect(sceneIdFromHash("/plastis3d?scene=x")).toBe("x");
  });
});
