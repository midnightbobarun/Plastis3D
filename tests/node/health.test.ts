// tests/node/health.test.ts — the compatibility report's shape and wording (PR16).
import { describe, expect, it } from "vitest";
import { analyzeScene, checkScene, cleanupScene } from "../../src/api";
import { countRows, hasAnalysis, hasOutput, nodeCosts, healthHeadline, healthSummary, isHealthReport, scoreLine, severityLabel } from "../../src/state/health";
import type { HealthAnalysis, HealthReport } from "../../src/state/health";

function report(over: Partial<HealthReport> = {}): HealthReport {
  return {
    ok: true,
    scene: "s",
    revision: 3,
    target: { kind: "scene" },
    summary: { errors: 0, warnings: 0, infos: 0 },
    issues: [],
    unchecked: [],
    stats: { tris: 12, materials: 1, nodes: 3, assetsChecked: 0 },
    ...over,
  };
}

describe("isHealthReport", () => {
  it("accepts the gateway's shape and refuses anything else", () => {
    expect(isHealthReport(report())).toBe(true);
    expect(isHealthReport(null)).toBe(false);
    expect(isHealthReport({})).toBe(false);
    expect(isHealthReport({ ...report(), issues: [{ code: "X", severity: "fatal", message: "m" }] })).toBe(false);
    expect(isHealthReport({ ...report(), summary: { errors: "1" } })).toBe(false);
    expect(isHealthReport({ ...report(), ok: "yes" })).toBe(false);
  });
  it("validates scoped findings and one level of related source evidence", () => {
    const source = { code: "MISSING_NORMALS", severity: "warning", message: "Source normals absent", provenance: "source", assetId: "a", where: "source.glb", nodeIds: ["n"] };
    const output = { ...source, provenance: "output", sourceFindings: [source] };
    expect(isHealthReport(report({ issues: [output] as never }))).toBe(true);
    for (const bad of [{ where: 4 }, { assetId: false }, { provenance: "certified" }, { nodeIds: [1] }, { sourceFindings: [{ ...source, sourceFindings: [source] }] }]) {
      expect(isHealthReport(report({ issues: [{ ...output, ...bad }] as never }))).toBe(false);
    }
  });

  it("shows exact output measurements only when every count is a nonnegative safe integer", () => {
    const output = { bytes: 4096, jsonBytes: 1024, binaryBytes: 3044, nodes: 3, meshes: 1, primitives: 1, materials: 1, skins: 0, clips: 0, accessors: 3 };
    expect(hasOutput(report())).toBe(false);
    expect(hasOutput(report({ output }))).toBe(true);
    for (const value of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined]) {
      expect(hasOutput(report({ output: { ...output, bytes: value } as never }))).toBe(false);
    }
  });

});

describe("wording", () => {
  it("names each severity in plain words", () => {
    expect(severityLabel("error")).toBe("Problem");
    expect(severityLabel("warning")).toBe("Heads up");
    expect(severityLabel("info")).toBe("Note");
  });

  it("says all clear, or counts what was found", () => {
    expect(healthHeadline(report())).toBe("No problems found");
    expect(healthHeadline(report({ unchecked: [{ what: "a", reason: "b" }] }))).toBe(
      "No problems found in what was checked",
    );
    expect(healthHeadline(report({ summary: { errors: 1, warnings: 2, infos: 1 } }))).toBe(
      "1 problem · 2 heads-ups · 1 note",
    );
    expect(healthHeadline(report({ summary: { errors: 0, warnings: 1, infos: 0 } }))).toBe("1 heads-up");
  });

  it("summarises the collapsed section", () => {
    expect(healthSummary(null)).toBeUndefined();
    expect(healthSummary(report())).toBe("All clear");
    expect(healthSummary(report({ summary: { errors: 2, warnings: 0, infos: 0 } }))).toBe("2 problems");
    expect(healthSummary(report({ summary: { errors: 0, warnings: 1, infos: 1 } }))).toBe("2 findings");
  });
});

describe("checkScene", () => {
  it("asks for the report, with the asset when narrowed, and checks the payload", async () => {
    const seen: string[] = [];
    const rest = (async (path: string) => {
      seen.push(path);
      return report();
    }) as never;
    expect(await checkScene(rest, "my scene")).toEqual(report());
    await checkScene(rest, "s", "a b");
    expect(seen).toEqual(["/scenes/my%20scene/check", "/scenes/s/check?assetId=a%20b"]);
    await expect(checkScene((async () => ({ ok: true })) as never, "s")).rejects.toThrow(/unexpected payload/);
  });
});

function analysis(over: Partial<HealthAnalysis["score"]> = {}): HealthAnalysis {
  return {
    version: 1,
    budget: { name: "mobile", label: "Phone", triangles: 100000, drawCalls: 100, materials: 16, textureMiB: 64 },
    counts: { triangles: 12345, drawCalls: 7, materials: 2, textures: 1, textureBytes: 3 * 1024 * 1024, assetBytes: 10 },
    score: {
      value: 88,
      reason: null,
      label: "heuristic",
      heuristic: true,
      weightsVersion: 1,
      basedOnPartialChecks: false,
      components: [],
      ...over,
    },
  };
}

describe("the analyzer's block (PR17)", () => {
  it("is recognised only when the score and counts are present", () => {
    expect(hasAnalysis(null)).toBe(false);
    expect(hasAnalysis(report())).toBe(false);
    expect(hasAnalysis(report({ analysis: analysis() }))).toBe(true);
    expect(hasAnalysis(report({ analysis: { ...analysis(), score: null as never } }))).toBe(false);
    expect(hasAnalysis(report({ analysis: analysis({ value: null, reason: "x" }) }))).toBe(true);
  });

  it("labels the score a heuristic and names the budget, or says there is none", () => {
    expect(scoreLine(analysis())).toBe("88 out of 100 for a phone · heuristic");
    expect(scoreLine(analysis({ value: null, reason: "Fix problems first." }))).toBe("No score yet");
  });

  it("lists the measured numbers against the budget, with unknowns said plainly", () => {
    expect(countRows(analysis())).toEqual([
      ["Triangles", "12,345 of 100,000"],
      ["Draw calls (estimate)", "7 of 100"],
      ["Materials", "2 of 16"],
      ["Texture memory", "3.0 MB of 64 MB"],
    ]);
    const unknown = analysis();
    unknown.counts.drawCalls = null;
    expect(countRows(unknown)[1]).toEqual(["Draw calls (estimate)", "unknown of 100"]);
  });

  it("analyzeScene asks for the budget and refuses a payload with no analysis", async () => {
    const seen: string[] = [];
    const rest = (async (path: string) => {
      seen.push(path);
      return report({ analysis: analysis() });
    }) as never;
    await analyzeScene(rest, "s");
    await analyzeScene(rest, "s", { budget: "desktop", assetId: "a b" });
    expect(seen).toEqual(["/scenes/s/analyze", "/scenes/s/analyze?budget=desktop&assetId=a+b"]);
    await expect(analyzeScene((async () => report()) as never, "s")).rejects.toThrow(/unexpected payload/);
  });
});

describe("cleanupScene (PR18)", () => {
  const info = (over = {}) => ({
    operations: ["dedupe_materials"],
    dryRun: true,
    applied: false,
    summary: ["Remove 1 unused material."],
    changes: { materialsMerged: [], materialsRemoved: ["m_idle"], groupsRemoved: [], nodesRepointed: [] },
    ...over,
  });
  const envelope = (cleanup: unknown) => ({
    ok: true,
    scene: { id: "s", name: "S", revision: 4, nodeCount: 1 },
    nodes: [],
    materials: [],
    assets: [],
    stats: { tris: 0, verts: 0, materials: 0, nodes: 0 },
    cleanup,
  });

  it("posts the revision and the dry-run flag, and checks the cleanup block", async () => {
    const calls: Array<{ path: string; opts: unknown }> = [];
    const rest = (async (path: string, opts: unknown) => {
      calls.push({ path, opts });
      return envelope(info());
    }) as never;
    const out = await cleanupScene(rest, "my scene", { baseRevision: 3, dryRun: true });
    expect(out.cleanup.summary).toEqual(["Remove 1 unused material."]);
    expect(calls[0].path).toBe("/scenes/my%20scene/cleanup");
    expect(calls[0].opts).toEqual({ method: "POST", body: { baseRevision: 3, dryRun: true } });
    await expect(cleanupScene((async () => envelope(undefined)) as never, "s", { baseRevision: 1 })).rejects.toThrow(
      /unexpected payload/,
    );
  });
});


it("scopes partial summaries and refuses malformed or oversized object attribution", () => {
  expect(healthSummary(report({ unchecked: [{ what: "scan", reason: "budget" }] }))).toBe("Partial checks");
  const a = analysis();
  const row = { nodeId: "n", name: "Model", kind: "model", visible: true, triangles: null, vertices: null, drawCalls: null, referencedAssetBytes: null };
  a.counts.perNode = [row];
  expect(nodeCosts(report({ analysis: a }))).toEqual([row]);
  a.counts.perNode = [{ ...row, triangles: NaN }, { ...row, nodeId: 1 as never }];
  expect(nodeCosts(report({ analysis: a }))).toEqual([]);
  a.counts.perNode = Array(2001).fill(row);
  expect(nodeCosts(report({ analysis: a }))).toEqual([]);
});
