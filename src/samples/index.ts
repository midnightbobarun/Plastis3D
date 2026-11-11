import type { NodeSpec, MaterialSpec } from "../types";
import { buildSnowman } from "../editor/buildSnowman";
export const SAMPLE_NAMES = ["Snowman", "Desk lamp", "Little rocket", "Cozy cabin"] as const;
export type SampleName = typeof SAMPLE_NAMES[number];
export function buildSample(name: SampleName): { nodes: NodeSpec[]; materials: MaterialSpec[] } {
 if (name === "Snowman") return buildSnowman();
 const materials: MaterialSpec[] = [{ id: "m_default", color: "#e0a16a", metalness: 0, roughness: .6, emissive: "#000000", opacity: 1, doubleSide: false }];
 const nodes: NodeSpec[] = [];
 const shape = (id: string, type: "box" | "cylinder" | "cone" | "capsule" | "plane", t: [number,number,number], s: [number,number,number]) => nodes.push({ id, name: id.replaceAll('_',' '), kind: "mesh", parent: null, visible: true, transform: { t, s, r: [0,0,0] }, materialId: "m_default", primitive: type === "box" ? { type, width: 1, height: 1, depth: 1 } : type === "plane" ? { type, width: 1, height: 1 } : type === "capsule" ? { type, radius: .5, length: 1, capSegments: 4, radialSegments: 12 } : type === "cone" ? { type, radius: .5, height: 1, radialSegments: 16 } : { type, radiusTop: .5, radiusBottom: .5, height: 1, radialSegments: 16 } } as NodeSpec);
 if (name === "Desk lamp") { shape("base","cylinder",[0,.05,0],[1,.1,1]); shape("stem","cylinder",[0,.7,0],[.1,1.3,.1]); shape("shade","cone",[0,1.5,0],[1,.5,1]); }
 if (name === "Little rocket") { shape("body","capsule",[0,1.5,0],[.8,1,.8]); shape("nose","cone",[0,2.5,0],[.8,.8,.8]); for (const x of [-1,1]) shape(`fin_${x < 0 ? 'left' : 'right'}`,"box",[x*.5,.5,0],[.5,.7,.15]); }
 if (name === "Cozy cabin") { shape("walls","box",[0,.75,0],[2,1.5,2]); shape("roof","cone",[0,1.9,0],[3,1,3]); shape("window","box",[0,.9,1.01],[.5,.5,.05]); shape("floor","plane",[0,0,0],[4,4,4]); nodes.find(n=>n.id === "floor")!.transform.r = [-90,0,0]; materials.push({ ...materials[0], id: "m_glow", color: "#ffcd72", emissive: "#ffad42" }); nodes.find(n=>n.id === 'window')!.materialId = 'm_glow'; }
 if (name === "Little rocket") {
  materials[0].color = "#e5e9f0";
  materials.push({ ...materials[0], id: "m_accent", color: "#e87c6b" });
  for (const node of nodes) { node.parent = "rocket_group"; if (node.id !== "body") node.materialId = "m_accent"; }
  nodes.unshift({ id: "rocket_group", name: "Rocket", kind: "group", parent: null, visible: true, transform: { t:[0,0,0], r:[0,0,0], s:[1,1,1] } });
 }
 nodes.push({ id: "sample_light", name: "Warm light", kind: "light", parent: null, visible: true, transform: { t: [0,1.3, name === "Desk lamp" ? 0 : 2], r: [0,0,0], s: [1,1,1] }, light: { type: "point", color: "#ffdaab", intensity: 4, distance: 10, decay: 2 } } as NodeSpec);
 return { nodes, materials };
}
