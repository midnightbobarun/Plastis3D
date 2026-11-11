import { expect, it } from "vitest";
import { createHealthComparison, comparisonRows } from "../../src/state/healthComparison";
import type { HealthReport } from "../../src/state/health";
const report = (revision: number, over = {}): HealthReport => ({
  scene: "s", revision, target: { kind: "scene" },
  analysis: { budget: { name: "mobile" }, counts: { triangles: revision * 12, drawCalls: revision, materials: 1, textureBytes: 0 }, score: { value: 100, weightsVersion: 1 } },
  ...over,
} as HealthReport);
it("retains only adjacent checked revisions and replaces same-revision measurements", () => {
  const session = createHealthComparison();
  expect(session.accept("profileA", report(1))).toBeNull();
  expect(session.accept("profileA", report(1))).toBeNull();
  const pair = session.accept("profileA", report(3))!;
  expect([pair.before.revision, pair.after.revision]).toEqual([1, 3]);
  expect(comparisonRows(pair)).toContainEqual(["Triangles", "12 → 36 (+24)"]);
  expect(session.accept("profileA", report(3))?.before.revision).toBe(1);
  expect(session.accept("profileA", report(2))).toBeNull();
  expect(session.accept("profileA", report(4))?.before.revision).toBe(3);
});
it("resets on backend, scene, budget, weight version or explicit lifecycle reset", () => {
  for (const change of [
    (r: HealthReport) => ({ ...r, scene: "other" }),
    (r: HealthReport) => ({ ...r, analysis: { ...r.analysis!, budget: { ...r.analysis!.budget, name: "desktop" as const } } }),
    (r: HealthReport) => ({ ...r, analysis: { ...r.analysis!, score: { ...r.analysis!.score, weightsVersion: 2 } } }),
  ]) {
    const session = createHealthComparison();
    session.accept("p", report(1));
    expect(session.accept("p", change(report(2)))).toBeNull();
  }
  const session = createHealthComparison();
  session.accept("a", report(1));
  expect(session.accept("b", report(2))).toBeNull();
  session.clear();
  expect(session.accept("b", report(3))).toBeNull();
});
it("does not compare a withheld score or absent output as a zero", () => {
  const session = createHealthComparison();
  session.accept("p", report(1));
  const after = report(2); after.analysis!.score.value = null;
  const rows = comparisonRows(session.accept("p", after)!);
  expect(rows).toContainEqual(["Heuristic score", "unknown"]);
  expect(rows).toContainEqual(["Prospective GLB", "unknown"]);
});
