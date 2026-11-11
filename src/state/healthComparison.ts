// Two scalar measurements per mounted Health surface; no persistence.
import type { HealthReport } from "./health";

export interface HealthMeasurement {
  source: string;
  scene: string;
  revision: number;
  budget: string;
  weights: number;
  score: number | null;
  triangles: number | null;
  drawCalls: number | null;
  materials: number | null;
  textureBytes: number | null;
  outputBytes: number | null;
}
export interface HealthComparison { before: HealthMeasurement; after: HealthMeasurement }

function measurement(source: string, report: HealthReport): HealthMeasurement | null {
  const analysis = report.analysis;
  if (!analysis || report.target?.kind !== "scene" || typeof report.scene !== "string" || !Number.isSafeInteger(analysis.score.weightsVersion) || !Number.isSafeInteger(report.revision) || report.revision < 0) return null;
  const number = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  return {
    source, scene: report.scene, revision: report.revision, budget: analysis.budget.name,
    weights: analysis.score.weightsVersion, score: number(analysis.score.value),
    triangles: number(analysis.counts.triangles), drawCalls: number(analysis.counts.drawCalls),
    materials: number(analysis.counts.materials), textureBytes: number(analysis.counts.textureBytes),
    outputBytes: number(report.output?.bytes),
  };
}
function sameScope(a: HealthMeasurement, b: HealthMeasurement): boolean {
  return a.source === b.source && a.scene === b.scene && a.budget === b.budget && a.weights === b.weights;
}

/** Two scalar snapshots per mounted surface; never persists reports or scene data. */
export function createHealthComparison() {
  let current: HealthMeasurement | null = null;
  let previous: HealthMeasurement | null = null;
  return {
    clear() { current = previous = null; },
    accept(source: string, report: HealthReport): HealthComparison | null {
      const next = measurement(source, report);
      if (!next) return null;
      if (!current || !sameScope(current, next)) {
        current = next; previous = null; return null;
      }
      if (next.revision < current.revision) return null;
      if (next.revision > current.revision) previous = current;
      current = next;
      return previous ? { before: previous, after: current } : null;
    },
  };
}

export function comparisonRows(pair: HealthComparison): Array<[string, string]> {
  const rows: Array<[string, keyof HealthMeasurement, string]> = [
    ["Heuristic score", "score", ""], ["Triangles", "triangles", ""],
    ["Draw calls (estimate)", "drawCalls", ""], ["Materials", "materials", ""],
    ["Texture memory", "textureBytes", " B"], ["Prospective GLB", "outputBytes", " B"],
  ];
  return rows.map(([label, key, suffix]) => {
    const before = pair.before[key], after = pair.after[key];
    if (typeof before !== "number" || typeof after !== "number") return [label, "unknown"];
    const change = after - before;
    return [label, `${before.toLocaleString("en-US")}${suffix} → ${after.toLocaleString("en-US")}${suffix} (${change > 0 ? "+" : ""}${change.toLocaleString("en-US")}${suffix})`];
  });
}
