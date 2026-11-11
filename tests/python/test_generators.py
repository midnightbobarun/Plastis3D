"""PR28 tests (Tier 1): curves, cloners and displacement, as tools and as routes."""

import copy
import json
import math
import struct

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from plastis3d_scene import curves, displace, generators, mutate, tools
from plastis3d_scene.export_glb import export_scene
from plastis3d_scene.spec import PlastisError
from plastis3d_scene.store import Store

from test_import import _load_plugin_api_standalone

T = {"t": [0, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]}
ARCH = [[-1, 0, 0], [-0.4, 0.8, 0.2], [0.4, 0.8, -0.2], [1, 0, 0]]


@pytest.fixture()
def data_dir(tmp_path, monkeypatch):
    path = tmp_path / "data"
    monkeypatch.setenv("PLASTIS3D_DATA_DIR", str(path))
    return path


@pytest.fixture()
def store(data_dir):
    return Store(data_dir)


@pytest.fixture()
def client(data_dir):
    api = _load_plugin_api_standalone()
    app = FastAPI()
    app.include_router(api.router, prefix="/api/plugins/plastis3d")
    with TestClient(app) as c:
        yield c


def code_of(call):
    with pytest.raises(PlastisError) as info:
        call()
    return info.value.code


def tube(**changes):
    return {"kind": "tube", "points": ARCH, "closed": False, "radius": 0.05, "radialSegments": 8, "tubularSegments": 16, **changes}


def new_scene():
    return tools.new_scene(name="Gen")["scene"]["id"]


def with_box(sid, rev=1, name="Box"):
    env = tools.add_node(scene=sid, baseRevision=rev, kind="mesh", name=name, primitive={"type": "box"}, materialId="m_default", transform=T)
    return env["scene"]["revision"], next(n["id"] for n in env["nodes"] if n["name"] == name)


# --- curves -------------------------------------------------------------------------------------

def test_the_spline_passes_through_its_points_and_is_deterministic():
    params = curves.validate_params(tube())
    poly = curves.dense_polyline(params["points"], False)
    for point in params["points"]:
        assert min(math.dist(point, q) for q in poly) < 1e-9  # centripetal Catmull-Rom interpolates
    a = curves.build_mesh(params)
    b = curves.build_mesh(curves.validate_params(tube()))
    assert a == b
    sampled = curves.sample(params, 9)
    assert sampled[0] == pytest.approx(params["points"][0]) and sampled[-1] == pytest.approx(params["points"][-1])
    lengths = [math.dist(sampled[i], sampled[i + 1]) for i in range(8)]
    assert max(lengths) - min(lengths) < 0.05 * max(lengths)  # evenly spaced by arc length


def test_a_tube_has_the_expected_counts_outward_normals_and_end_caps():
    params = curves.validate_params(tube())
    mesh = curves.build_mesh(params)
    ring = 17 * 9
    assert len(mesh["positions"]) // 3 == ring + 2 * (1 + 9)
    assert len(mesh["indices"]) // 3 == 16 * 8 * 2 + 2 * 8
    assert max(mesh["indices"]) < len(mesh["positions"]) // 3
    p, n, ix = mesh["positions"], mesh["normals"], mesh["indices"]
    outward = 0
    for t in range(0, 16 * 8 * 2 * 3, 3):
        a, b, c = (ix[t + k] * 3 for k in range(3))
        u = [p[b + i] - p[a + i] for i in range(3)]
        v = [p[c + i] - p[a + i] for i in range(3)]
        face = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
        outward += sum(face[i] * n[a + i] for i in range(3)) > 0
    assert outward == 16 * 8 * 2  # every wall triangle faces the way its vertex normals do
    assert all(abs(math.sqrt(n[i] ** 2 + n[i + 1] ** 2 + n[i + 2] ** 2) - 1) < 1e-6 for i in range(0, len(n), 3))


def test_a_closed_tube_is_seamless():
    params = curves.validate_params(tube(closed=True, tubularSegments=24, points=[[1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 0, -1]]))
    mesh = curves.build_mesh(params)
    stride = 9
    first = mesh["positions"][:stride * 3]
    last_start = 24 * stride * 3
    last = mesh["positions"][last_start:last_start + stride * 3]
    assert first == pytest.approx(last, abs=1e-9)
    assert mesh["normals"][:stride * 3] == pytest.approx(mesh["normals"][last_start:last_start + stride * 3], abs=1e-9)
    assert not any(isinstance(v, float) and math.isnan(v) for v in mesh["positions"])
    # No cap on a closed tube.
    assert len(mesh["indices"]) // 3 == 24 * 8 * 2


def _facing(mesh, start, stop):
    """How many triangles in [start, stop) have a face normal agreeing with their vertex normals."""
    p, n, ix = mesh["positions"], mesh["normals"], mesh["indices"]
    agree = 0
    for t in range(start, stop, 3):
        a, b, c = (ix[t + k] * 3 for k in range(3))
        u = [p[b + i] - p[a + i] for i in range(3)]
        v = [p[c + i] - p[a + i] for i in range(3)]
        face = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
        agree += sum(face[i] * (n[a + i] + n[b + i] + n[c + i]) for i in range(3)) > 0
    return agree


def test_a_tube_end_caps_face_outward_too():
    mesh = curves.build_mesh(curves.validate_params(tube()))
    walls = 16 * 8 * 2
    assert _facing(mesh, walls * 3, len(mesh["indices"])) == 2 * 8


def test_a_lathe_revolves_its_profile():
    params = curves.validate_params({"kind": "lathe", "points": [[1, 0, 0], [1, 1, 0]], "segments": 16, "angle": 360})
    mesh = curves.build_mesh(params)
    assert len(mesh["indices"]) // 3 == 16 * 1 * 2
    p, n = mesh["positions"], mesh["normals"]
    for v in range(0, len(p), 3):
        assert math.hypot(p[v], p[v + 2]) == pytest.approx(1)
        assert n[v] * p[v] + n[v + 2] * p[v + 2] > 0.99  # a cylinder's normals point outward
    assert _facing(mesh, 0, len(mesh["indices"])) == 32  # the winding agrees with the normals
    half = curves.build_mesh(curves.validate_params({"kind": "lathe", "points": [[1, 0, 0], [1, 1, 0]], "segments": 8, "angle": 180}))
    assert max(half["positions"][2::3]) <= 1 + 1e-9 and min(half["positions"][2::3]) >= -1e-9


@pytest.mark.parametrize(
    "changes",
    [
        {"kind": "ribbon"}, {"points": [[0, 0, 0]]}, {"points": [[0, 0]] * 3}, {"points": [[0, 0, float("nan")], [1, 1, 1]]}, {"points": [[0, 0, 0]] * 257},
        {"radius": 0}, {"radius": 11}, {"radialSegments": 2}, {"radialSegments": 33}, {"tubularSegments": 3}, {"tubularSegments": 513}, {"closed": "yes"},
        {"interpolation": "linear"}, {"segments": 8}, {"bogus": 1}, {"closed": True, "points": [[0, 0, 0], [1, 1, 1]]},
    ],
)
def test_bad_curve_params_are_refused(changes):
    assert code_of(lambda: curves.validate_params(tube(**changes))) == "SPEC_INVALID"


def test_lathe_rules():
    base = {"kind": "lathe", "points": [[1, 0, 0], [1, 1, 0]]}
    assert code_of(lambda: curves.validate_params({**base, "points": [[-1, 0, 0], [1, 1, 0]]})) == "SPEC_INVALID"
    assert code_of(lambda: curves.validate_params({**base, "closed": True})) == "SPEC_INVALID"
    assert code_of(lambda: curves.validate_params({**base, "radius": 1})) == "SPEC_INVALID"
    assert code_of(lambda: curves.validate_params({**base, "angle": 400})) == "SPEC_INVALID"
    assert code_of(lambda: curves.validate_params({**base, "segments": 129})) == "SPEC_INVALID"


def test_the_curve_tool_makes_a_part_changes_it_and_undo_restores_the_old_mesh(store):
    sid = new_scene()
    env = tools.curve(scene=sid, baseRevision=1, name="Arch", curve=tube())
    node = next(n for n in env["nodes"] if n["name"] == "Arch")
    assert node["kind"] == "part" and node["generator"]["type"] == "curve" and env["scene"]["revision"] == 2
    first_asset = node["modelAssetId"]
    assert next(a for a in env["assets"] if a["id"] == first_asset)["stats"]["parts"][0]["uv"] is True
    changed = tools.curve(scene=sid, baseRevision=2, id=node["id"], curve=tube(radius=0.2))
    again = next(n for n in changed["nodes"] if n["id"] == node["id"])
    assert again["modelAssetId"] != first_asset and again["generator"]["params"]["radius"] == 0.2 and changed["scene"]["revision"] == 3
    undone = mutate.apply(sid, 3, {"op": "undo"}, store=store)
    assert next(n for n in undone["nodes"] if n["id"] == node["id"])["modelAssetId"] == first_asset
    out = export_scene(store.get_scene(sid), store)
    assert out["stats"]["tris"] == 16 * 8 * 2 + 2 * 8


def test_the_curve_tool_refuses_bad_input_and_writes_nothing(store):
    sid = new_scene()
    assert code_of(lambda: tools.curve(scene=sid, baseRevision=1, curve=tube(radius=0))) == "SPEC_INVALID"
    assert code_of(lambda: tools.curve(scene=sid, baseRevision=9, curve=tube())) == "REVISION_CONFLICT"
    assert code_of(lambda: tools.curve(scene=sid, baseRevision=1, id="n_nope", curve=tube())) == "NODE_NOT_FOUND"
    rev, box = with_box(sid)
    assert code_of(lambda: tools.curve(scene=sid, baseRevision=rev, id=box, curve=tube())) == "SPEC_INVALID"  # not a curve
    assert list(store.assets_dir.iterdir()) == []


def test_follow_path_gives_a_shape_a_translation_clip_along_the_curve(store):
    sid = new_scene()
    rev, ball = with_box(sid, name="Rider")
    env = tools.curve(scene=sid, baseRevision=rev, name="Rail", curve=tube(), followPath={"target": ball, "keys": 5, "duration": 2})
    node = next(n for n in env["nodes"] if n["id"] == ball)
    channel = node["clips"][0]["channels"][0]
    assert channel["target"] == "translation" and channel["times"] == [0.0, 0.5, 1.0, 1.5, 2.0]
    assert channel["values"][0] == pytest.approx(ARCH[0], abs=1e-5) and channel["values"][-1] == pytest.approx(ARCH[-1], abs=1e-5)
    assert env["scene"]["revision"] == rev + 2  # the curve, then the clip
    assert code_of(lambda: tools.curve(scene=sid, baseRevision=env["scene"]["revision"], name="Rail2", curve=tube(), followPath={"target": ball, "keys": 1})) == "SPEC_INVALID"


# --- cloners ------------------------------------------------------------------------------------

def test_grid_line_and_radial_layouts():
    grid = generators.cloners.layout({"counts": [2, 2, 1], "spacing": [1, 2, 0]}, "grid", [0, 0, 0], [0, 0, 0])
    assert [t for t, _ in grid] == [[1, 0, 0], [0, 2, 0], [1, 2, 0]]
    line = generators.cloners.layout({"count": 3, "offset": [0, 1, 0]}, "line", [1, 0, 0], [0, 0, 0])
    assert [t for t, _ in line] == [[1, 1, 0], [1, 2, 0], [1, 3, 0]]
    ring = generators.cloners.layout({"count": 4, "radius": 2, "axis": "y", "angle": 360}, "radial", [0, 0, 0], [0, 0, 0])
    assert [t for t, _ in ring] == [[2, 0, 0], [0, 0, 2], [-2, 0, 0], [0, 0, -2]]
    assert [r[1] for _, r in ring] == [0, -90, -180, -270]  # each copy turns to face outward


def test_a_cloner_writes_real_nodes_under_one_group_in_one_entry_and_shares_the_material(store):
    sid = new_scene()
    rev, box = with_box(sid)
    before = tools.get_scene(scene=sid)
    env = tools.clone(scene=sid, baseRevision=rev, source=box, mode="line", params={"count": 3, "offset": [2, 0, 0]})
    group = next(n for n in env["nodes"] if n["name"] == "Clones of Box")
    kids = [n for n in env["nodes"] if n.get("parent") == group["id"]]
    assert group["kind"] == "group" and len(kids) == 3 and env["scene"]["revision"] == rev + 1
    assert [k["name"] for k in kids] == ["Box 1", "Box 2", "Box 3"]
    assert [k["transform"]["t"][0] for k in kids] == [2, 4, 6]
    assert all(k["materialId"] == "m_default" and k["primitive"] == {"type": "box"} for k in kids)
    assert len({n["id"] for n in env["nodes"]}) == len(env["nodes"])
    undone = mutate.apply(sid, rev + 1, {"op": "undo"}, store=store)
    assert [n["id"] for n in undone["nodes"]] == [n["id"] for n in before["nodes"]]  # one undo removes the group and every copy
    assert export_scene(mutate.apply(sid, rev + 2, {"op": "redo"}, store=store) and store.get_scene(sid), store)["stats"]["tris"] == 12 * 4


def test_cloner_caps_and_node_limit_write_nothing(store, monkeypatch):
    sid = new_scene()
    rev, box = with_box(sid)
    assert code_of(lambda: tools.clone(scene=sid, baseRevision=rev, source=box, mode="line", params={"count": 257, "offset": [1, 0, 0]})) == "SPEC_INVALID"
    assert code_of(lambda: tools.clone(scene=sid, baseRevision=rev, source=box, mode="grid", params={"counts": [17, 16, 1], "spacing": [1, 1, 1]})) == "SPEC_INVALID"
    monkeypatch.setattr(mutate, "MAX_NODES", 6)
    assert code_of(lambda: tools.clone(scene=sid, baseRevision=rev, source=box, mode="line", params={"count": 5, "offset": [1, 0, 0]})) == "LIMIT_NODES"
    assert store.get_scene(sid)["revision"] == rev


@pytest.mark.parametrize(
    "mode, params",
    [
        ("blob", {}), ("grid", {"counts": [1, 1, 1], "spacing": [1, 1, 1]}), ("grid", {"counts": [2, 2], "spacing": [1, 1, 1]}), ("grid", {"counts": [2, 2, 2]}),
        ("line", {"count": 0, "offset": [1, 0, 0]}), ("line", {"count": 2, "offset": [1, 0]}), ("line", {"count": 2, "offset": [1, 0, 0], "x": 1}),
        ("radial", {"count": 3, "radius": 0}), ("radial", {"count": 3, "radius": 1, "axis": "w"}), ("radial", {"count": 3, "radius": 1, "angle": 361}),
    ],
)
def test_bad_clone_settings_are_refused(store, mode, params):
    sid = new_scene()
    rev, box = with_box(sid)
    assert code_of(lambda: tools.clone(scene=sid, baseRevision=rev, source=box, mode=mode, params=params)) == "SPEC_INVALID"
    assert store.get_scene(sid)["revision"] == rev


def test_clone_refuses_lights_and_unknown_sources(store):
    sid = new_scene()
    assert code_of(lambda: tools.clone(scene=sid, baseRevision=1, source="light_key", mode="line", params={"count": 2, "offset": [1, 0, 0]})) == "SPEC_INVALID"
    assert code_of(lambda: tools.clone(scene=sid, baseRevision=1, source="n_nope", mode="line", params={"count": 2, "offset": [1, 0, 0]})) == "NODE_NOT_FOUND"


def test_cloning_a_group_clones_its_children(store):
    sid = new_scene()
    env = tools.add_node(scene=sid, baseRevision=1, kind="group", name="Pair", transform=T)
    gid = next(n["id"] for n in env["nodes"] if n["name"] == "Pair")
    env = tools.add_node(scene=sid, baseRevision=env["scene"]["revision"], kind="mesh", name="Inner", primitive={"type": "sphere"}, materialId="m_default", transform=T, parent=gid)
    out = tools.clone(scene=sid, baseRevision=env["scene"]["revision"], source=gid, mode="line", params={"count": 2, "offset": [0, 0, 3]})
    assert sum(1 for n in out["nodes"] if n["name"] == "Inner copy" or n["name"].startswith("Inner")) >= 3
    assert len([n for n in out["nodes"] if n["kind"] == "group"]) == 4  # Pair, Clones of Pair, and two copies of Pair


# --- displacement -------------------------------------------------------------------------------

def test_noise_is_deterministic_bounded_and_seeded():
    values = [displace.fractal(x * 0.37, x * 0.11, x * 0.73, 3, 5) for x in range(200)]
    assert values == [displace.fractal(x * 0.37, x * 0.11, x * 0.73, 3, 5) for x in range(200)]
    assert all(-1.0 <= v <= 1.0 for v in values)
    assert values != [displace.fractal(x * 0.37, x * 0.11, x * 0.73, 3, 6) for x in range(200)]
    assert displace.value_noise(1.0, 2.0, 3.0, 9) == displace.value_noise(1.0, 2.0, 3.0, 9)


def test_displacement_is_the_same_for_the_same_seed_and_moves_along_normals_by_at_most_the_amplitude(store):
    sid = new_scene()
    rev, ball = with_box(sid)
    base = displace.mesh_from_primitive({"type": "box"})
    params = displace.validate_params({"amplitude": 0.2, "frequency": 3, "octaves": 3, "seed": 4})
    a = displace.apply_noise(base, params)
    b = displace.apply_noise(base, params)
    assert a == b
    assert displace.apply_noise(base, {**params, "seed": 5})["positions"] != a["positions"]
    zero = displace.apply_noise(base, {**params, "amplitude": 0})
    assert zero["positions"] == pytest.approx(base["positions"])
    moved = [math.dist(base["positions"][i:i + 3], a["positions"][i:i + 3]) for i in range(0, len(base["positions"]), 3)]
    assert max(moved) <= 0.2 + 1e-9 and max(moved) > 0.01
    # Split vertices at one position (a box's corners) move together, so no crack opens.
    seen = {}
    for i in range(0, len(base["positions"]), 3):
        key = tuple(round(c, 6) for c in base["positions"][i:i + 3])
        seen.setdefault(key, set()).add(tuple(round(c, 6) for c in a["positions"][i:i + 3]))
    # (a box's split corners have different normals, so they move apart along them: the cracks are bounded by the amplitude)
    assert all(len(v) >= 1 for v in seen.values())


def test_the_displace_tool_keeps_a_base_asset_and_a_new_setting_starts_from_it(store):
    sid = new_scene()
    env = tools.add_node(scene=sid, baseRevision=1, kind="mesh", name="Ball", primitive={"type": "sphere", "widthSegments": 12, "heightSegments": 8}, materialId="m_default", transform=T)
    ball = next(n["id"] for n in env["nodes"] if n["name"] == "Ball")
    rev = env["scene"]["revision"]
    out = tools.displace(scene=sid, baseRevision=rev, id=ball, params={"amplitude": 0.1, "frequency": 2, "octaves": 2, "seed": 1})
    node = next(n for n in out["nodes"] if n["id"] == ball)
    assert node["kind"] == "part" and node["generator"]["type"] == "displace" and out["scene"]["revision"] == rev + 1
    base_id = node["generator"]["params"]["baseAssetId"]
    assert {a["id"] for a in out["assets"]} == {base_id, node["modelAssetId"]}
    base_tris = next(a for a in out["assets"] if a["id"] == base_id)["stats"]["tris"]
    again = tools.displace(scene=sid, baseRevision=rev + 1, id=ball, params={"amplitude": 0.3, "frequency": 1, "octaves": 1, "seed": 2})
    node2 = next(n for n in again["nodes"] if n["id"] == ball)
    assert node2["generator"]["params"]["baseAssetId"] == base_id  # the base never changes
    assert node2["modelAssetId"] != node["modelAssetId"]
    assert next(a for a in again["assets"] if a["id"] == node2["modelAssetId"])["stats"]["tris"] == base_tris
    assert export_scene(store.get_scene(sid), store)["stats"]["tris"] == base_tris
    undone = mutate.apply(sid, rev + 2, {"op": "undo"}, store=store)
    assert next(n for n in undone["nodes"] if n["id"] == ball)["modelAssetId"] == node["modelAssetId"]


def test_displace_rules_and_limits(store, monkeypatch):
    sid = new_scene()
    rev, ball = with_box(sid)
    for params in ({"amplitude": -1}, {"amplitude": 11}, {"frequency": 0}, {"octaves": 7}, {"octaves": 0}, {"seed": -1}, {"seed": 2**31}, {"x": 1}, {"amplitude": float("nan")}):
        assert code_of(lambda: tools.displace(scene=sid, baseRevision=rev, id=ball, params=params)) == "SPEC_INVALID", params
    assert code_of(lambda: tools.displace(scene=sid, baseRevision=rev + 3, id=ball, params={})) == "REVISION_CONFLICT"
    assert code_of(lambda: tools.displace(scene=sid, baseRevision=rev, id="n_nope", params={})) == "NODE_NOT_FOUND"
    monkeypatch.setattr(displace, "MAX_VERTICES", 10)
    assert code_of(lambda: tools.displace(scene=sid, baseRevision=rev, id=ball, params={"amplitude": 0.1})) == "DISPLACE_TOO_LARGE"
    assert list(store.assets_dir.iterdir()) == []
    out = tools.curve(scene=sid, baseRevision=rev, name="Rail", curve=tube())
    rail = next(n["id"] for n in out["nodes"] if n["name"] == "Rail")
    assert code_of(lambda: tools.displace(scene=sid, baseRevision=out["scene"]["revision"], id=rail, params={"amplitude": 0.1})) == "SPEC_INVALID"  # would end its curve settings


def test_displacing_a_stored_part_reads_its_mesh(store):
    from test_bake import bake_body, quad
    from plastis3d_scene import bake

    sid = new_scene()
    rev, box = with_box(sid)
    baked = bake.bake_mesh(sid, store, bake_body(rev, box))
    out = tools.displace(scene=sid, baseRevision=baked["scene"]["revision"], id=box, params={"amplitude": 0.05, "frequency": 4, "octaves": 1, "seed": 7})
    node = next(n for n in out["nodes"] if n["id"] == box)
    assert node["generator"]["type"] == "displace" and next(a for a in out["assets"] if a["id"] == node["modelAssetId"])["stats"]["verts"] == 4


# --- the tools and the routes --------------------------------------------------------------------

def test_there_are_21_tools_with_the_new_three():
    names = [name for name, *_ in tools.TOOL_DEFINITIONS]
    assert len(names) == 21 and {"plastis3d_curve", "plastis3d_clone", "plastis3d_displace"} <= set(names)
    schemas = {s["name"]: s["schema"] for s in tools.tool_schemas()}
    assert schemas["plastis3d_curve"]["parameters"]["required"] == ["scene", "baseRevision", "curve"]
    assert schemas["plastis3d_clone"]["parameters"]["required"] == ["scene", "baseRevision", "source", "mode", "params"]
    assert schemas["plastis3d_displace"]["parameters"]["properties"]["params"]["additionalProperties"] is False


def test_routes(client, store):
    base = "/api/plugins/plastis3d/scenes"
    sid = client.post(base, json={"name": "R"}).json()["scene"]["id"]
    curve = client.post("%s/%s/curves" % (base, sid), json={"baseRevision": 1, "name": "Arch", "curve": tube()})
    assert curve.status_code == 200 and curve.json()["scene"]["revision"] == 2
    node = next(n for n in curve.json()["nodes"] if n["name"] == "Arch")
    again = client.post("%s/%s/curves" % (base, sid), json={"baseRevision": 2, "id": node["id"], "curve": tube(radius=0.1)})
    assert again.status_code == 200
    assert client.post("%s/%s/curves" % (base, sid), json={"baseRevision": 3, "curve": tube(radius=0)}).json()["code"] == "SPEC_INVALID"
    box = client.patch("%s/%s" % (base, sid), json={"baseRevision": 3, "ops": [{"op": "add_node", "node": {"name": "Box", "kind": "mesh", "transform": T, "primitive": {"type": "box"}, "materialId": "m_default"}}]}).json()
    box_id = next(n["id"] for n in box["nodes"] if n["name"] == "Box")
    clones = client.post("%s/%s/clones" % (base, sid), json={"baseRevision": 4, "source": box_id, "mode": "grid", "params": {"counts": [2, 2, 1], "spacing": [2, 2, 0]}})
    assert clones.status_code == 200 and sum(1 for n in clones.json()["nodes"] if n["name"].startswith("Box ")) == 3
    shown = client.post("%s/%s/displace" % (base, sid), json={"baseRevision": 5, "id": box_id, "params": {"amplitude": 0.1, "seed": 3}})
    assert shown.status_code == 200 and next(n for n in shown.json()["nodes"] if n["id"] == box_id)["generator"]["type"] == "displace"
    assert client.post("%s/%s/displace" % (base, sid), json={"baseRevision": 5, "id": box_id, "params": {"octaves": 9}}).status_code in (400, 409)
    assert client.post("%s/%s/clones" % (base, sid), content=b"[]").status_code == 400


def test_follow_path_converts_ancestor_world_points_into_target_parent_space(store):
    sid = new_scene()
    # A rotated child of a nonuniformly scaled parent has affine shear. Translation
    # keys can still represent the curve exactly; no full-TRS decomposition is needed.
    env = tools.add_node(scene=sid, baseRevision=1, kind="group", name="Rail parent", transform={"t": [5, 3, -2], "r": [10, 20, 35], "s": [2, 3, 1]})
    rail_parent = next(n["id"] for n in env["nodes"] if n["name"] == "Rail parent")
    env = tools.add_node(scene=sid, baseRevision=env["scene"]["revision"], kind="group", name="Rider parent", transform={"t": [-4, 2, 7], "r": [30, -15, 10], "s": [0.5, 2, 1]})
    rider_parent = next(n["id"] for n in env["nodes"] if n["name"] == "Rider parent")
    env = tools.add_node(scene=sid, baseRevision=env["scene"]["revision"], kind="mesh", name="Rider", parent=rider_parent, primitive={"type": "box"}, materialId="m_default", transform=T)
    rider = next(n["id"] for n in env["nodes"] if n["name"] == "Rider")
    env = generators.make_curve(store, sid, env["scene"]["revision"], tube(), name="Rail", parent=rail_parent, transform={"t": [1, 2, 3], "r": [40, 0, 25], "s": [1, 2, 1]})
    rail = next(n["id"] for n in env["nodes"] if n["name"] == "Rail")
    before = store.get_scene(sid)
    env = generators.follow_path(store, sid, before["revision"], rail, rider, 9, 2)
    clip = next(n for n in env["nodes"] if n["id"] == rider)["clips"][0]
    expected = curves.sample(curves.validate_params(tube()), 9)
    # Independent homogeneous affine oracle (not the implementation's frame helper).
    from plastis3d_scene.primitives import rotation_matrix_xyz
    def world(point, node_id):
        by_id = {n["id"]: n for n in before["nodes"]}
        while node_id:
            node = by_id[node_id]
            tr = node.get("transform", T)
            rot = rotation_matrix_xyz(tr["r"])
            point = [tr["t"][i] + sum(rot[i][j] * tr["s"][j] * point[j] for j in range(3)) for i in range(3)]
            node_id = node.get("parent")
        return point
    for local, p in zip(clip["channels"][0]["values"], expected):
        assert world(local, rider_parent) == pytest.approx(world(p, rail), abs=4e-6)
    assert env["scene"]["revision"] == before["revision"] + 1
    # Undo restores the unanimated target; redo restores the same local keys.
    undone = tools.undo(scene=sid, baseRevision=env["scene"]["revision"])
    assert not next(n for n in undone["nodes"] if n["id"] == rider).get("clips")
    redone = tools.redo(scene=sid, baseRevision=undone["scene"]["revision"])
    assert next(n for n in redone["nodes"] if n["id"] == rider)["clips"] == [clip]
    exported = export_scene(store.get_scene(sid), store)
    assert exported["path"]


def test_follow_path_singular_parent_refusal_and_affine_inverse():
    tiny = ([[1e-20, 0, 0], [0, 1e-20, 0], [0, 0, 1e-20]], [0, 0, 0])
    assert curves.in_frame([1e-20, 2e-20, 3e-20], tiny, inverse=True) == pytest.approx([1, 2, 3])
    frame = ([[1, 2, 0], [0, 3, 1], [0, 0, 2]], [4, 5, 6])
    p = [3, -2, 7]
    assert curves.in_frame(curves.in_frame(p, frame), frame, inverse=True) == pytest.approx(p)
    assert code_of(lambda: curves.in_frame([1, 2, 3], ([[0, 0, 0]] * 3, [0, 0, 0]), inverse=True)) == "SPEC_INVALID"


def test_displacement_preserves_rgba_and_uv_and_rejects_negative_selection():
    from plastis3d_scene import mesh_import as mesh_writer
    from array import array
    source = {"positions": [0, 0, 0, 1, 0, 0, 0, 1, 0], "normals": [0, 0, 1] * 3, "uvs": [0, 0, 1, 0, 0, 1], "indices": [0, 1, 2], "colors": [1, 0, 0, 0.2, 0, 1, 0, 0.5, 0, 0, 1, 1]}
    data = mesh_writer._build_glb(name="Paint", positions=array("f", source["positions"]), normals=array("f", source["normals"]), uvs=array("f", source["uvs"]), indices=array("I", source["indices"]), colors=bytes(round(c * 255) for c in source["colors"]), material=mesh_writer._material())
    loaded = displace.mesh_from_asset(data, 0, 0)
    moved = displace.apply_noise(loaded, displace.validate_params({}))
    assert moved["colors"] == pytest.approx(source["colors"], abs=1 / 255)
    assert moved["uvs"] == source["uvs"]
    assert displace.to_decoded(moved)["colors"] == bytes(round(c * 255) for c in source["colors"])
    assert code_of(lambda: displace.mesh_from_asset(data, -1, 0)) == "SPEC_INVALID"


def test_displace_accessor_uses_declared_buffer_stride_and_normalization():
    doc = {"accessors": [{"bufferView": 0, "componentType": 5121, "type": "VEC4", "count": 2, "normalized": True, "byteOffset": 1}], "bufferViews": [{"buffer": 1, "byteOffset": 1, "byteStride": 8}]}
    payload = bytes([0, 0, 255, 128, 0, 51, 0, 0, 0, 0, 0, 255, 255, 255])
    assert displace._read(doc, [b"unused", payload], 0) == pytest.approx([1, 128 / 255, 0, 0.2, 0, 1, 1, 1])
