"""W06: measured references, unknowns and shared-byte attribution."""
from plastis3d_scene.health_costs import primitive_costs, node_costs
from plastis3d_scene.analyze import _count_scene


def source():
    return {"scene": 0, "scenes": [{"nodes": [0, 1]}], "nodes": [{"mesh": 0}, {"mesh": 0}], "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}], "accessors": [{"count": 6}]}


def test_repeated_source_mesh_instances_are_counted_per_default_scene_node():
    rows, total = primitive_costs(source())
    assert rows == {"0:0": {"triangles": 2, "vertices": 6, "drawCalls": 1}}
    assert total == {"triangles": 4, "vertices": 12, "drawCalls": 2}
    scene = {"nodes": [{"id": "a", "kind": "model", "modelAssetId": "shared"}, {"id": "b", "kind": "model", "modelAssetId": "shared"}], "assets": [{"id": "shared", "bytes": 1234}], "materials": []}
    facts = {"shared": {"primitiveCosts": rows, "defaultSceneCost": total}}
    costs = node_costs(scene, facts)
    assert [c["drawCalls"] for c in costs] == [2, 2]
    assert [c["referencedAssetBytes"] for c in costs] == [1234, 1234]  # Shared references, not exclusive allocations.
    counts = _count_scene(scene, facts, [])
    assert counts["drawCalls"] == 4 and counts["triangles"] == 8
    assert counts["assetBytes"] == 1234  # Stored bytes counted once.


def test_hidden_ancestor_suppresses_base_pass_but_not_geometry_and_unknowns_are_not_zero():
    rows, total = primitive_costs(source())
    scene = {"nodes": [{"id": "a", "kind": "model", "modelAssetId": "shared", "parent": "g"}, {"id": "g", "kind": "group", "visible": False}, {"id": "missing", "kind": "part", "modelAssetId": "absent", "meshIndex": 2, "primitiveIndex": 1}], "assets": [{"id": "shared", "bytes": 1234}], "materials": []}
    costs = node_costs(scene, {"shared": {"primitiveCosts": rows, "defaultSceneCost": total}})
    assert costs[0]["drawCalls"] == 0 and costs[0]["triangles"] == 4 and costs[0]["visible"] is False
    assert costs[1]["triangles"] is None and costs[1]["drawCalls"] is None and costs[1]["referencedAssetBytes"] is None
    unknowns = []
    counts = _count_scene(scene, {}, unknowns)
    assert counts["triangles"] is None and counts["drawCalls"] is None and unknowns


def test_part_cost_uses_exact_pair_and_default_scene_does_not_count_unused_meshes():
    doc = source()
    doc["meshes"].append({"primitives": [{"attributes": {"POSITION": 1}}]})
    doc["accessors"].append({"count": 300})
    rows, total = primitive_costs(doc)
    assert total["triangles"] == 4
    scene = {"nodes": [{"id": "p", "kind": "part", "modelAssetId": "s", "meshIndex": 1, "primitiveIndex": 0}], "assets": [{"id": "s", "bytes": 100}]}
    assert node_costs(scene, {"s": {"primitiveCosts": rows}})[0]["triangles"] == 100


def test_cost_inspection_budget_yields_unknown_without_imposing_scene_or_export_cap(monkeypatch):
    from plastis3d_scene import health_costs
    monkeypatch.setattr(health_costs, "MAX_COST_RECORDS", 1)
    rows, total = primitive_costs(source())
    assert "0:0" in rows and total is None
    rows, total = primitive_costs(source(), deadline=0)
    assert rows == {} and total is None
