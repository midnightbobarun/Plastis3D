// src/state/health.ts — the compatibility report's shape and wording (PR16).
//
// Pure: no SDK, no DOM. The report comes from the gateway
// (GET /scenes/{id}/check, plastis3d_scene/compat.py); every check runs in
// Python and this file only words the result. The sentences of each finding
// are the gateway's; this adds the section's own headline.

export type Severity = "error" | "warning" | "info";

export interface HealthIssue {
  code: string;
  severity: Severity;
  message: string;
  where?: string;
  provenance?: "scene" | "source" | "output";
  nodeIds?: string[];
  assetId?: string;
  sourceFindings?: HealthIssue[];
}

export type BudgetName = "mobile" | "desktop";

export interface HealthBudget {
  name: BudgetName;
  label: string;
  triangles: number;
  drawCalls: number;
  materials: number;
  textureMiB: number;
}

export interface HealthScore {
  /** 0-100, or null when withheld (a hard problem, or an unknown count). */
  value: number | null;
  reason: string | null;
  label: string;
  heuristic: true;
  weightsVersion: number;
  basedOnPartialChecks: boolean;
  components: Array<{ name: string; weight: number; measured: number; budget: number; ratio: number; points: number }>;
}

export interface HealthNodeCost {
  nodeId: string; name: string; kind: string; visible: boolean;
  triangles: number | null; vertices: number | null; drawCalls: number | null;
  referencedAssetBytes: number | null; assetId?: string | null;
}

export interface HealthCounts {
  perNode?: HealthNodeCost[];
  drawCallsScope?: string;
  triangles: number | null;
  vertices?: number | null;
  drawCalls: number | null;
  materials: number | null;
  textures: number;
  textureBytes: number;
  assetBytes: number;
  [key: string]: unknown;
}

/** The analyzer's addition to the report (PR17). */
export interface HealthAnalysis {
  version: number;
  budget: HealthBudget;
  counts: HealthCounts;
  score: HealthScore;
}

export interface HealthReport {
  ok: boolean;
  scene: string;
  revision: number;
  target: { kind: "scene" | "asset"; assetId?: string };
  summary: { errors: number; warnings: number; infos: number };
  issues: HealthIssue[];
  unchecked: Array<{ what: string; reason: string }>;
  stats: { tris: number | null; materials: number; nodes: number; assetsChecked: number };
  /** Present when the report came from the analyzer. */
  analysis?: HealthAnalysis;
  output?: { bytes: number; jsonBytes: number; binaryBytes: number; nodes: number; meshes: number; primitives: number; materials: number; skins: number; clips: number; accessors: number };
}

const SEVERITIES: readonly string[] = ["error", "warning", "info"];

function validIssue(value: unknown, allowSources = true): value is HealthIssue {
  if (!value || typeof value !== "object") return false;
  const row = value as HealthIssue;
  return typeof row.code === "string" && typeof row.message === "string" && SEVERITIES.includes(row.severity)
    && (row.where === undefined || typeof row.where === "string")
    && (row.assetId === undefined || typeof row.assetId === "string")
    && (row.provenance === undefined || ["scene", "source", "output"].includes(row.provenance))
    && (row.nodeIds === undefined || (Array.isArray(row.nodeIds) && row.nodeIds.every((id) => typeof id === "string")))
    && (row.sourceFindings === undefined || (allowSources && Array.isArray(row.sourceFindings) && row.sourceFindings.every((source) => validIssue(source, false))));
}

/** Exact file measurements are displayed only when the optional block is valid. */
export function hasOutput(report: HealthReport): report is HealthReport & { output: NonNullable<HealthReport["output"]> } {
  const output = report.output;
  return !!output && ["bytes", "jsonBytes", "binaryBytes", "nodes", "meshes", "primitives", "materials", "skins", "clips", "accessors"].every((key) => {
    const value = (output as unknown as Record<string, unknown>)[key];
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  });
}

/** True when `value` has the shape the Health section reads. */
export function isHealthReport(value: unknown): value is HealthReport {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  const summary = r.summary as Record<string, unknown> | undefined;
  return (
    typeof r.ok === "boolean" &&
    Array.isArray(r.issues) &&
    r.issues.every((issue) => validIssue(issue)) &&
    Array.isArray(r.unchecked) &&
    !!summary &&
    typeof summary.errors === "number" &&
    typeof summary.warnings === "number" &&
    typeof summary.infos === "number"
  );
}

/** True when `value` carries an analyzer block the section can show. */
export function hasAnalysis(report: HealthReport | null): report is HealthReport & { analysis: HealthAnalysis } {
  const a = report?.analysis;
  return (
    !!a &&
    typeof a.budget?.name === "string" &&
    typeof a.score === "object" &&
    a.score !== null &&
    (a.score.value === null || typeof a.score.value === "number") &&
    typeof a.counts === "object" &&
    a.counts !== null
  );
}

function number(n: number | null | undefined): string {
  return typeof n === "number" ? n.toLocaleString("en-US") : "unknown";
}

/** The measured numbers as label/value rows, in the order the analyzer reports them. */
export function countRows(analysis: HealthAnalysis): Array<[string, string]> {
  const c = analysis.counts;
  const b = analysis.budget;
  const mib = (c.textureBytes / (1024 * 1024)).toFixed(1);
  return [
    ["Triangles", `${number(c.triangles)} of ${b.triangles.toLocaleString("en-US")}`],
    ["Draw calls (estimate)", `${number(c.drawCalls)} of ${b.drawCalls.toLocaleString("en-US")}`],
    ["Materials", `${number(c.materials)} of ${b.materials.toLocaleString("en-US")}`],
    ["Texture memory", `${mib} MB of ${b.textureMiB} MB`],
  ];
}

/** The score line: the number with its label, or why there is none. */
export function scoreLine(analysis: HealthAnalysis): string {
  const { score, budget } = analysis;
  return score.value === null
    ? "No score yet"
    : `${score.value} out of 100 for a ${budget.label.toLowerCase()} · heuristic`;
}

/** The word for a severity, in the section's plain language. */
export function severityLabel(severity: Severity): string {
  return severity === "error" ? "Problem" : severity === "warning" ? "Heads up" : "Note";
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** One line for the section header and the top of the list. */
export function healthHeadline(report: HealthReport): string {
  const { errors, warnings, infos } = report.summary;
  if (errors + warnings + infos === 0) {
    return report.unchecked.length > 0
      ? "No problems found in what was checked"
      : "No problems found";
  }
  const parts: string[] = [];
  if (errors > 0) parts.push(count(errors, "problem", "problems"));
  if (warnings > 0) parts.push(count(warnings, "heads-up", "heads-ups"));
  if (infos > 0) parts.push(count(infos, "note", "notes"));
  return parts.join(" · ");
}

/** The short summary shown on the collapsed section. */
export function healthSummary(report: HealthReport | null): string | undefined {
  if (!report) return undefined;
  const { errors, warnings, infos } = report.summary;
  if (errors + warnings + infos === 0) return report.unchecked.length ? "Partial checks" : "All clear";
  return errors > 0 ? count(errors, "problem", "problems") : count(warnings + infos, "finding", "findings");
}

/** Optional attribution is bounded by the scene node cap and validated before rendering. */
export function nodeCosts(report: HealthReport): HealthNodeCost[] {
  const rows = report.analysis?.counts.perNode;
  const count = (v: unknown) => v === null || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0);
  return Array.isArray(rows) && rows.length <= 2000 ? rows.filter(row => row && typeof row.nodeId === "string" && typeof row.name === "string" && typeof row.kind === "string" && typeof row.visible === "boolean" && count(row.triangles) && count(row.vertices) && count(row.drawCalls) && count(row.referencedAssetBytes)) : [];
}
