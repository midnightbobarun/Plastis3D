import { describe, expect, it } from "vitest";
import { clearThumbnailCache, filterScenes, loadThumbnail, thumbnailUrl } from "../../src/state/thumbnails";
import { ApiError } from "../../src/api";

const scenes = [{ name: "Snowman" }, { name: "Cozy cabin" }, { name: "snow globe" }, { name: "Rocket" }];

describe("scene search", () => {
  it("matches anywhere in the name, ignoring case", () => {
    expect(filterScenes(scenes, "SNOW").map((s) => s.name)).toEqual(["Snowman", "snow globe"]);
    expect(filterScenes(scenes, "ab").map((s) => s.name)).toEqual(["Cozy cabin"]);
  });
  it("an empty or blank query keeps every scene, and nothing matches nothing", () => {
    expect(filterScenes(scenes, "")).toHaveLength(4);
    expect(filterScenes(scenes, "   ")).toHaveLength(4);
    expect(filterScenes(scenes, "zzz")).toEqual([]);
  });
});

describe("thumbnails", () => {
  it("fetches once per revision, and again when the revision moves", async () => {
    clearThumbnailCache();
    let calls = 0;
    const rest = (async () => { calls++; return { ok: true, revision: 1, png: "QUJD" }; }) as never;
    expect(await loadThumbnail(rest, "src", "s", 1)).toBe(thumbnailUrl("QUJD"));
    expect(await loadThumbnail(rest, "src", "s", 1)).toBe(thumbnailUrl("QUJD"));
    expect(calls).toBe(1);
    await loadThumbnail(rest, "src", "s", 2);
    expect(calls).toBe(2);
    await loadThumbnail(rest, "other-source", "s", 1);
    expect(calls).toBe(3); // a source switch never reuses another source's picture
  });
  it("a scene with no thumbnail, or a failing gateway, gives null (the letter tile)", async () => {
    clearThumbnailCache();
    const missing = (async () => { throw new ApiError("THUMBNAIL_NOT_FOUND", "none"); }) as never;
    expect(await loadThumbnail(missing, "src", "a", 1)).toBeNull();
    const down = (async () => { throw new Error("network"); }) as never;
    expect(await loadThumbnail(down, "src", "b", 1)).toBeNull();
  });
  it("concurrent requests for one revision share one fetch", async () => {
    clearThumbnailCache();
    let calls = 0;
    const rest = (async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return { ok: true, revision: 1, png: "QQ==" }; }) as never;
    await Promise.all([loadThumbnail(rest, "s", "x", 1), loadThumbnail(rest, "s", "x", 1), loadThumbnail(rest, "s", "x", 1)]);
    expect(calls).toBe(1);
  });
});
