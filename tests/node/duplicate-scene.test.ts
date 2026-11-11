import { describe, expect, it } from "vitest";
import { duplicateSceneName } from "../../src/editor/duplicateScene";
import { duplicateScene } from "../../src/api";
describe("duplicate scene", () => {
  it("bounds the new name", () => {
    expect(duplicateSceneName("Demo")).toBe("Copy of Demo");
    expect(duplicateSceneName("x".repeat(100)).length).toBeLessThanOrEqual(80);
  });
  it("asks the server to copy the source", async () => {
    let request: unknown;
    const rest = async <T>(_path: string, opts?: unknown): Promise<T> => {
      request = opts;
      return { ok: true, scene: {}, nodes: [], materials: [], assets: [] } as T;
    };
    await duplicateScene(rest, "source", "Copy");
    expect(request).toEqual({ method: "POST", body: { name: "Copy", copyFrom: "source" } });
  });
});
