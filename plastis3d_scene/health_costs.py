"""per-node geometry and base-pass estimates, no exclusive-memory claims."""
import time
from .primitives import count_primitive

# Internal Health work budget, never an import/export or scene cap.
MAX_COST_RECORDS = 20_000


def primitive_costs(gltf, deadline=None):
    """Internal source facts. Counts actual default-scene node references."""
    accessors = gltf.get("accessors", [])
    meshes = gltf.get("meshes", [])
    rows = {}
    steps = 0
    for mi, mesh in enumerate(meshes):
        for pi, primitive in enumerate(mesh.get("primitives", [])):
            if steps >= MAX_COST_RECORDS or (steps % 256 == 0 and deadline is not None and time.monotonic() >= deadline):
                return rows, None
            steps += 1
            position = primitive.get("attributes", {}).get("POSITION")
            indices = primitive.get("indices", position)
            vertices = accessors[position].get("count") if isinstance(position, int) and 0 <= position < len(accessors) else None
            count = accessors[indices].get("count") if isinstance(indices, int) and 0 <= indices < len(accessors) else None
            triangles = count // 3 if isinstance(count, int) and primitive.get("mode", 4) == 4 else None
            rows["%d:%d" % (mi, pi)] = {"triangles": triangles, "vertices": vertices, "drawCalls": 1}
    scenes = gltf.get("scenes", [])
    selected = gltf.get("scene", 0)
    if not isinstance(selected, int) or not 0 <= selected < len(scenes):
        return rows, None
    nodes = gltf.get("nodes", [])
    pending = list(scenes[selected].get("nodes", []))
    seen = set()
    total = {"triangles": 0, "vertices": 0, "drawCalls": 0}
    while pending:
        if steps >= MAX_COST_RECORDS or (steps % 256 == 0 and deadline is not None and time.monotonic() >= deadline):
            return rows, None
        steps += 1
        index = pending.pop()
        if not isinstance(index, int) or not 0 <= index < len(nodes) or index in seen:
            return rows, None
        seen.add(index)
        node = nodes[index]
        pending.extend(node.get("children", []))
        mesh = node.get("mesh")
        if mesh is None:
            continue
        if not isinstance(mesh, int) or not 0 <= mesh < len(meshes):
            return rows, None
        for pi in range(len(meshes[mesh].get("primitives", []))):
            row = rows["%d:%d" % (mesh, pi)]
            for key in total:
                total[key] = total[key] + row[key] if total[key] is not None and row[key] is not None else None
    return rows, total


def node_costs(scene, asset_facts):
    assets = {a["id"]: a for a in scene.get("assets", [])}
    nodes = scene.get("nodes", [])
    by_id = {n["id"]: n for n in nodes}
    visible = {}
    # Validated scenes are acyclic. Resolve each ancestry once, without recursion.
    for node in nodes:
        chain, current = [], node
        while current is not None and current["id"] not in visible:
            chain.append(current)
            current = by_id.get(current.get("parent"))
        shown = visible.get(current["id"], True) if current is not None else True
        for item in reversed(chain):
            shown = shown and item.get("visible", True) is not False
            visible[item["id"]] = shown
    result = []
    for node in nodes:
        kind = node.get("kind")
        if kind not in ("mesh", "model", "part"):
            continue
        asset = assets.get(node.get("modelAssetId"), {})
        facts = asset_facts.get(node.get("modelAssetId"), {})
        if kind == "mesh":
            counts = count_primitive(node["primitive"])
            cost = {"triangles": counts["tris"], "vertices": counts["verts"], "drawCalls": 1}
        elif kind == "part":
            cost = facts.get("primitiveCosts", {}).get("%d:%d" % (node.get("meshIndex", 0), node.get("primitiveIndex", 0)), {})
        else:
            cost = facts.get("defaultSceneCost") or {}
        result.append({"nodeId": node["id"], "name": node.get("name") or node["id"], "kind": kind,
                       "visible": visible[node["id"]], "triangles": cost.get("triangles"),
                       "vertices": cost.get("vertices"), "drawCalls": cost.get("drawCalls") if visible[node["id"]] else 0,
                       "referencedAssetBytes": 0 if kind == "mesh" else asset.get("bytes"), "assetId": asset.get("id")})
    return result
