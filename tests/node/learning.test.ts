import { initLearning, markLearning, setHelp, getLearning, offerTip, seenTip } from "../../src/state/learning";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { expect, test } from "vitest";
import { sceneDiff } from "../../src/state/sceneDiff";
import { buildSample, SAMPLE_NAMES } from "../../src/samples";
import { buildSceneGraph, disposeBuiltScene } from "../../src/scene/build";
import { fixtureSceneSpec } from "../harness/fixture-scene";
const PYTHON = [".venv/bin/python", ".venv/Scripts/python.exe"].find(existsSync) ?? (process.platform === "win32" ? "python" : "python3");
test("node diff separates adds, changes and removals", () => {
 const scene = fixtureSceneSpec();
 const after = structuredClone(scene.nodes.slice(1)); after[0].name = "Changed";
 const diff = sceneDiff(scene.nodes, after);
 expect(diff.removed).toEqual([scene.nodes[0].id]); expect(diff.changed).toEqual([after[0].id]); expect(diff.count).toBe(2);
});
for (const sample of SAMPLE_NAMES) test(`${sample} is a small drawable primitive scene`, () => {
 const data = buildSample(sample);
 const result = execFileSync(PYTHON, ["-c", "import json,sys; from plastis3d_scene.spec import new_scene_dict; from plastis3d_scene.validate import validate_scene; sc=new_scene_dict('sample','Sample'); sc.update(json.load(sys.stdin)); validate_scene(sc); print('valid')"], { input: JSON.stringify(data), encoding: "utf-8" });
 expect(result.trim()).toBe("valid");
 expect(data.nodes.length).toBeLessThanOrEqual(40);
 expect(new Set(data.nodes.map(n=>n.id)).size).toBe(data.nodes.length);
 const scene = { ...fixtureSceneSpec(), ...data };
 const built = buildSceneGraph(scene, new Map(data.materials.map(m=>[m.id,m])));
 expect(built.nodes.size).toBe(data.nodes.length);
 disposeBuiltScene(built);
});

test("learning progress and tips persist without duplication", () => {
 const values = new Map<string, unknown>();
 const storage = { get: <T,>(key: string, fallback: T) => (values.get(key) ?? fallback) as T, set: (key: string, value: unknown) => { values.set(key, value); } };
 initLearning(storage); markLearning("look"); markLearning("look"); offerTip("move"); seenTip("move"); setHelp({ hidden: true }); initLearning(storage);
 expect(getLearning()).toMatchObject({ steps:["look"], tips:["move"], hidden:true, pending:[] });
 initLearning({ get: () => { throw Error("unavailable"); }, set: () => { throw Error("unavailable"); } });
 markLearning("save"); expect(getLearning().steps).toEqual(["save"]);
});
