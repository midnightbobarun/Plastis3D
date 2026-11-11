import { describe, expect, it } from "vitest";
import { sortRecent } from "../../src/state/sceneOrder";

describe("sortRecent", () => {
  it("puts the newest edit first and does not change the input", () => {
    const input = [
      { id: "a", name: "A", updatedAt: "2026-11-01T10:00:00Z" },
      { id: "b", name: "B", updatedAt: "2026-11-09T10:00:00Z" },
      { id: "c", name: "C", updatedAt: "2026-11-05T10:00:00Z" },
    ];
    expect(sortRecent(input).map((s) => s.id)).toEqual(["b", "c", "a"]);
    expect(input.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });
  it("breaks ties and missing dates by name then id, so the order is stable", () => {
    const same = "2026-11-05T10:00:00Z";
    const out = sortRecent([
      { id: "z", name: "Same", updatedAt: same },
      { id: "m", name: "Same", updatedAt: same },
      { id: "q", name: "Alpha", updatedAt: same },
      { id: "n", name: "Old" },
    ]);
    expect(out.map((s) => s.id)).toEqual(["q", "m", "z", "n"]);
  });
});
