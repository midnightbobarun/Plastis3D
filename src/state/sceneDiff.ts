import type { NodeSpec, MaterialSpec } from "../types";
export function sceneDiff(before: NodeSpec[], after: NodeSpec[], beforeMaterials: MaterialSpec[] = [], afterMaterials: MaterialSpec[] = []) {
 const old = new Map(before.map(node => [node.id, node]));
 const next = new Map(after.map(node => [node.id, node]));
 const added = after.filter(node => !old.has(node.id)).map(node => node.id);
 const removed = before.filter(node => !next.has(node.id)).map(node => node.id);
 const materialChanges = new Set(afterMaterials.filter(material => JSON.stringify(beforeMaterials.find(old => old.id === material.id)) !== JSON.stringify(material)).map(material => material.id));
 const changed = after.filter(node => old.has(node.id) && (JSON.stringify(old.get(node.id)) !== JSON.stringify(node) || node.materialId && materialChanges.has(node.materialId))).map(node => node.id);
 return { added, changed, removed, count: added.length + changed.length + removed.length };
}
const origins = new Map<string, { revision: number; origin: "tool" | "ui" }>();
const writes = new Map<string, number>();
export function rememberOrigin(id: string, revision: number, origin: unknown) { origins.set(id, { revision, origin: origin === "tool" ? "tool" : "ui" }); }
export function revisionOrigin(id: string, revision: number) { const value = origins.get(id); return value?.revision === revision ? value.origin : "ui"; }
export function markLocalWrite(id: string, revision: number) { writes.set(id, revision); }
export function isLocalWrite(id: string, revision: number) { return writes.get(id) === revision; }
