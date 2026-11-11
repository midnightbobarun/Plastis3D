"""PR19 tests (Tier 1): weld and degenerate removal (C-11, C-19, C-03, C-12).

The rules under test: only attribute-equivalent vertices merge (UV seams and hard
normal edges survive), degenerate triangles go, built-in shapes and files with
skins, animations or morph targets are skipped and listed, the result is a NEW
asset (the old bytes stay), the scene change is one undoable revision, a preview
writes nothing, and weld never runs unless it is asked for.
"""

import hashlib
import struct
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from plastis3d_scene import cleanup, glb, tools, weld
from plastis3d_scene.spec import PlastisError
from plastis3d_scene.store import Store

from test_deformable_splice import GEN as DEFORM
from test_import import _load_plugin_api_standalone

T = {"t": [0, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]}


@pytest.fixture()
def data_dir(tmp_path, monkeypatch):
    path = tmp_path / "data"
    monkeypatch.setenv("PLASTIS3D_DATA_DIR", str(path))
    return path


@pytest.fixture()
def store(data_dir):
    return Store(data_dir)


# --- Builders -------------------------------------------------------------------------------


def _doc(points, *, uvs=None, normals=None, colors=None, indices=None, mode=None, targets=False):
    """A one-primitive glTF with the given per-vertex attributes (lists of tuples)."""
    blob = bytearray()
    views, accessors = [], []

    def add(rows, letter, kind, component, target=34962, **extra):
        data = b"".join(struct.pack("<%d%s" % (len(r), letter), *r) for r in rows)
        views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(data), "target": target})
        blob.extend(data)
        accessors.append({"bufferView": len(views) - 1, "componentType": component, "count": len(rows), "type": kind, **extra})
        return len(accessors) - 1

    attrs = {
        "POSITION": add(points, "f", "VEC3", 5126, min=[min(p[a] for p in points) for a in range(3)], max=[max(p[a] for p in points) for a in range(3)])
    }
    if normals is not None:
        attrs["NORMAL"] = add(normals, "f", "VEC3", 5126)
    if uvs is not None:
        attrs["TEXCOORD_0"] = add(uvs, "f", "VEC2", 5126)
    if colors is not None:
        attrs["COLOR_0"] = add(colors, "f", "VEC4", 5126)
    primitive = {"attributes": attrs}
    if indices is not None:
        primitive["indices"] = add([(i,) for i in indices], "H", "SCALAR", 5123, target=34963)
    if mode is not None:
        primitive["mode"] = mode
    if targets:
        primitive["targets"] = [{"POSITION": attrs["POSITION"]}]
    gltf = {
        "asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0, "name": "m"}],
        "meshes": [{"primitives": [primitive]}], "accessors": accessors, "bufferViews": views,
        "buffers": [{"byteLength": len(blob)}],
    }
    return gltf, [bytes(blob)]


def _weld(doc):
    gltf, buffers = doc
    return weld.weld_document(gltf, buffers, time.monotonic() + 30)


def _glb_bytes(doc):
    gltf, buffers = doc
    return glb.build_glb(gltf, buffers)


def _scan(data):
    return glb.scan(data, source_format="glb", deadline=time.monotonic() + 30)


def _stl(triangles):
    out = bytearray(b"x" * 80) + struct.pack("<I", len(triangles))
    for tri in triangles:
        out += struct.pack("<3f", 0, 0, 1)
        for v in tri:
            out += struct.pack("<3f", *v)
        out += b"\x00\x00"
    return bytes(out)


def _cube_triangles():
    corners = [(x, y, z) for x in (0, 1) for y in (0, 1) for z in (0, 1)]
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    tris = []
    for a, b, c, d in faces:
        tris.append((corners[a], corners[b], corners[c]))
        tris.append((corners[a], corners[c], corners[d]))
    return tris


def _scene():
    return tools.new_scene(name="Weld")["scene"]["id"]


def _file(tmp_path, name, data):
    path = tmp_path / name
    path.write_bytes(data if isinstance(data, bytes) else data.encode())
    return str(path)


def _import_stl(scene_id, tmp_path, triangles, *, rev=1, name="part.stl", explode=False):
    return tools.import_model(scene=scene_id, baseRevision=rev, path=_file(tmp_path, name, _stl(triangles)), explode=explode)


def _weld_tool(scene_id, rev, **extra):
    return tools.cleanup(scene=scene_id, baseRevision=rev, operations=["weld"], **extra)


# --- The pure weld -----------------------------------------------------------------------------


def test_identical_records_merge_and_the_result_is_indexed():
    pts = [(0, 0, 0), (1, 0, 0), (0, 1, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)]  # a quad as two triangles, no indices
    result = _weld((_doc(pts)))
    assert result["status"] == "welded" and result["vertices_removed"] == 2 and result["triangles_removed"] == 0
    gltf = result["gltf"]
    primitive = gltf["meshes"][0]["primitives"][0]
    assert gltf["accessors"][primitive["attributes"]["POSITION"]]["count"] == 4
    assert gltf["accessors"][primitive["indices"]]["count"] == 6


def test_a_uv_seam_is_preserved():
    pts = [(0, 0, 0), (1, 0, 0), (0, 1, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)]
    normals = [(0, 0, 1)] * 6
    same = [(0, 0), (1, 0), (0, 1), (1, 0), (1, 1), (0, 1)]
    seam = [(0, 0), (1, 0), (0, 1), (0.5, 0.5), (1, 1), (0.25, 0.75)]  # the shared edge has two UVs
    assert _weld(_doc(pts, uvs=same, normals=normals))["vertices_removed"] == 2
    kept = _weld(_doc(pts, uvs=seam, normals=normals))
    assert kept["status"] == "unchanged"  # every vertex differs in some attribute: nothing to merge


def test_a_hard_normal_edge_and_a_colour_boundary_are_preserved():
    pts = [(0, 0, 0), (1, 0, 0), (0, 1, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)]
    flat = [(0, 0, 1)] * 6
    hard = [(0, 0, 1), (0, 0, 1), (0, 0, 1), (0, 1, 0), (0, 0, 1), (0, 1, 0)]
    assert _weld(_doc(pts, normals=hard))["status"] == "unchanged"
    red, blue = (1, 0, 0, 1), (0, 0, 1, 1)
    colours = [red, red, red, blue, blue, blue]
    assert _weld(_doc(pts, normals=flat, colors=colours))["status"] == "unchanged"


def test_the_tolerance_is_a_millionth_and_errs_toward_not_merging():
    base = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    near = [(0.0000004, 0, 0), (1, 0, 0), (0, 1, 0)]   # 4e-7 apart: the same vertex
    far = [(0.000003, 0, 0), (1, 0, 0), (0, 1, 0)]     # 3e-6 apart: not
    assert _weld(_doc(base + near))["vertices_removed"] == 3
    assert _weld(_doc(base + far))["vertices_removed"] == 2


def test_degenerate_triangles_are_dropped_and_unused_vertices_go_with_them():
    pts = [(0, 0, 0), (1, 0, 0), (0, 1, 0), (5, 5, 5), (5, 5, 5), (6, 6, 6), (0, 0, 0), (1, 0, 0), (2, 0, 0)]
    result = _weld(_doc(pts))
    assert result["triangles_removed"] == 2  # a repeated corner, and three collinear points
    primitive = result["gltf"]["meshes"][0]["primitives"][0]
    assert result["gltf"]["accessors"][primitive["indices"]]["count"] == 3
    assert result["gltf"]["accessors"][primitive["attributes"]["POSITION"]]["count"] == 3  # only the real triangle's corners


def test_a_primitive_that_would_lose_every_triangle_is_left_alone():
    result = _weld(_doc([(0, 0, 0), (0, 0, 0), (0, 0, 0)]))
    assert result["status"] == "unchanged" and "every triangle would be removed" in result["reason"]


def test_position_bounds_are_recomputed():
    pts = [(0, 0, 0), (1, 0, 0), (0, 1, 0), (9, 9, 9), (9, 9, 9), (9, 9, 9)]  # the second triangle is degenerate
    gltf = _weld(_doc(pts))["gltf"]
    position = gltf["accessors"][gltf["meshes"][0]["primitives"][0]["attributes"]["POSITION"]]
    assert position["min"] == [0, 0, 0] and position["max"] == [1, 1, 0]


@pytest.mark.parametrize("kwargs, word", [({"mode": 1}, "triangle list"), ({"targets": True}, "morph")])
def test_unsupported_primitives_are_left_alone_and_named(kwargs, word):
    pts = [(0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 0), (1, 0, 0), (0, 1, 0)]
    result = _weld(_doc(pts, **kwargs))
    assert result["status"] in ("unchanged", "skipped") and word in result["reason"]


def test_an_expired_deadline_writes_nothing():
    gltf, buffers = _doc([(0, 0, 0), (1, 0, 0), (0, 1, 0)] * 4000)
    with pytest.raises(PlastisError) as excinfo:
        weld.weld_document(gltf, buffers, time.monotonic() - 1)
    assert excinfo.value.code == "IMPORT_TIMEOUT"


def test_the_input_is_never_modified():
    gltf, buffers = _doc([(0, 0, 0), (1, 0, 0), (0, 1, 0)] * 2)
    import copy
    frozen = copy.deepcopy((gltf, buffers))
    _weld((gltf, buffers))
    assert (gltf, buffers) == frozen


def test_index_width_follows_c12():
    triangles = 23_000  # 69,000 distinct vertices, plus one degenerate triangle to force a change
    pts = []
    for i in range(triangles):
        pts += [(i, 0, 0), (i, 1, 0), (i, 0, 1)]
    pts += [(0, 0, 0), (0, 0, 0), (0, 0, 0)]
    result = _weld(_doc(pts))
    gltf = result["gltf"]
    index_accessor = gltf["accessors"][gltf["meshes"][0]["primitives"][0]["indices"]]
    assert index_accessor["componentType"] == 5125  # a vertex index of 65535 or more needs uint32
    small = _weld(_doc([(0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 0), (1, 0, 0), (0, 1, 0)]))["gltf"]
    assert small["accessors"][small["meshes"][0]["primitives"][0]["indices"]]["componentType"] == 5123


# --- A stored asset, through the scene -----------------------------------------------------------


def test_a_welded_asset_is_new_bytes_the_scene_repoints_and_the_old_file_stays(store, tmp_path):
    scene_id = _scene()
    env = _import_stl(scene_id, tmp_path, _cube_triangles())
    old = env["assets"][0]
    assert old["stats"]["verts"] == 36 and old["stats"]["tris"] == 12
    old_file = store.assets_dir / ("%s.glb" % old["sha256"])
    old_bytes = old_file.read_bytes()
    result = _weld_tool(scene_id, env["scene"]["revision"])
    welded = result["cleanup"]["changes"]["assetsWelded"]
    assert len(welded) == 1 and welded[0]["verticesRemoved"] == 28 and welded[0]["trianglesRemoved"] == 0
    assert welded[0]["bytesAfter"] < welded[0]["bytesBefore"]
    assert result["cleanup"]["summary"] == ["Weld part.stl: remove 28 duplicate vertices."]
    new = result["assets"][0]
    assert new["id"] != old["id"] and len(result["assets"]) == 1  # the old row went
    assert new["stats"]["verts"] == 8 and new["stats"]["tris"] == 12
    assert new["sourceFormat"] == "stl" and new["originalName"] == "part.stl" and new["format"] == "glb"
    assert next(n for n in result["nodes"] if n["kind"] == "model")["modelAssetId"] == new["id"]
    assert old_file.read_bytes() == old_bytes  # C-03: the source bytes are left
    stored = (store.assets_dir / ("%s.glb" % new["sha256"])).read_bytes()
    assert hashlib.sha256(stored).hexdigest() == new["sha256"] and new["bytes"] == len(stored)
    assert _scan(stored).stats["tris"] == 12
    assert result["scene"]["revision"] == env["scene"]["revision"] + 1


def test_the_welded_scene_still_exports_with_the_same_triangles(store, tmp_path):
    scene_id = _scene()
    env = _import_stl(scene_id, tmp_path, _cube_triangles(), explode=True)
    before = tools.export_glb(scene=scene_id)["stats"]["tris"]
    _weld_tool(scene_id, env["scene"]["revision"])
    assert tools.export_glb(scene=scene_id)["stats"]["tris"] == before == 12


def test_undo_and_redo_restore_the_old_and_the_new_asset(store, tmp_path):
    scene_id = _scene()
    env = _import_stl(scene_id, tmp_path, _cube_triangles())
    old_id = env["assets"][0]["id"]
    welded = _weld_tool(scene_id, env["scene"]["revision"])
    new_id = welded["assets"][0]["id"]
    undone = tools.undo(scene=scene_id, baseRevision=welded["scene"]["revision"])
    assert [a["id"] for a in undone["assets"]] == [old_id]
    assert next(n for n in undone["nodes"] if n["kind"] == "model")["modelAssetId"] == old_id
    redone = tools.redo(scene=scene_id, baseRevision=undone["scene"]["revision"])
    assert [a["id"] for a in redone["assets"]] == [new_id]
    assert next(n for n in redone["nodes"] if n["kind"] == "model")["modelAssetId"] == new_id


def test_a_preview_reports_the_same_numbers_and_writes_nothing(store, tmp_path):
    scene_id = _scene()
    env = _import_stl(scene_id, tmp_path, _cube_triangles())
    files = sorted(p.name for p in store.assets_dir.iterdir())
    before = store.get_scene(scene_id)
    preview = _weld_tool(scene_id, env["scene"]["revision"], dryRun=True)
    assert preview["cleanup"]["applied"] is False and preview["cleanup"]["summary"] == ["Weld part.stl: remove 28 duplicate vertices."]
    assert store.get_scene(scene_id) == before and sorted(p.name for p in store.assets_dir.iterdir()) == files
    real = _weld_tool(scene_id, env["scene"]["revision"])
    strip = lambda c: {k: v for k, v in c["changes"]["assetsWelded"][0].items() if k not in ("nodes", "newAssetId")}
    assert strip(real["cleanup"]) == strip(preview["cleanup"])


def test_welding_twice_changes_nothing_the_second_time(store, tmp_path):
    scene_id = _scene()
    env = _import_stl(scene_id, tmp_path, _cube_triangles())
    first = _weld_tool(scene_id, env["scene"]["revision"])
    second = _weld_tool(scene_id, first["scene"]["revision"])
    assert second["cleanup"]["applied"] is False and second["scene"]["revision"] == first["scene"]["revision"]


def test_weld_is_never_implied(store, tmp_path):
    scene_id = _scene()
    env = _import_stl(scene_id, tmp_path, _cube_triangles())
    result = tools.cleanup(scene=scene_id, baseRevision=env["scene"]["revision"])  # the defaults
    assert result["cleanup"]["operations"] == ["dedupe_materials", "prune_materials", "prune_groups"]
    assert result["assets"][0]["id"] == env["assets"][0]["id"]
    assert cleanup.DEFAULT_OPERATIONS == ("dedupe_materials", "prune_materials", "prune_groups")


def test_every_node_that_used_the_asset_is_repointed(store, tmp_path):
    scene_id = _scene()
    env = _import_stl(scene_id, tmp_path, _cube_triangles())
    model = next(n for n in env["nodes"] if n["kind"] == "model")
    env = tools.duplicate_node(scene=scene_id, baseRevision=env["scene"]["revision"], id=model["id"])
    result = _weld_tool(scene_id, env["scene"]["revision"])
    models = [n for n in result["nodes"] if n["kind"] == "model"]
    assert len(models) == 2 and len({n["modelAssetId"] for n in models}) == 1
    assert len(result["cleanup"]["changes"]["assetsWelded"][0]["nodes"]) == 2


def test_parts_keep_their_indexes_and_their_uv_flag(store, tmp_path):
    scene_id = _scene()
    quad = "v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\nf 1/1 2/2 3/3 4/4\nf 1/1 3/3 4/4\n"  # an extra copy of a corner triangle
    env = tools.import_model(scene=scene_id, baseRevision=1, path=_file(tmp_path, "q.obj", quad))
    part = next(n for n in env["nodes"] if n["kind"] == "part")
    result = _weld_tool(scene_id, env["scene"]["revision"])
    welded = [n for n in result["nodes"] if n["kind"] == "part"][0]
    assert (welded["meshIndex"], welded["primitiveIndex"]) == (part["meshIndex"], part["primitiveIndex"])
    assert welded["modelAssetId"] == result["assets"][0]["id"]
    assert result["assets"][0]["stats"]["parts"][0]["uv"] is True


def test_an_obj_with_hard_normal_edges_is_left_alone(store, tmp_path):
    scene_id = _scene()
    lines = ["v %d %d %d" % c for c in [(x, y, z) for x in (0, 1) for y in (0, 1) for z in (0, 1)]]
    lines += ["vn 1 0 0", "vn -1 0 0", "vn 0 1 0", "vn 0 -1 0", "vn 0 0 1", "vn 0 0 -1"]
    faces = [(5, 6, 8, 7, 1), (1, 3, 4, 2, 2), (3, 7, 8, 4, 3), (1, 2, 6, 5, 4), (2, 4, 8, 6, 5), (1, 5, 7, 3, 6)]
    lines += ["f " + " ".join("%d//%d" % (v, n) for v in f[:4] for n in [f[4]]) for f in faces]
    env = tools.import_model(scene=scene_id, baseRevision=1, path=_file(tmp_path, "cube.obj", "\n".join(lines) + "\n"), explode=False)
    assert env["assets"][0]["stats"]["verts"] == 24  # four per face: the hard edges are in the data
    result = _weld_tool(scene_id, env["scene"]["revision"])
    assert result["cleanup"]["applied"] is False  # all 24 records differ in their normals


def test_only_the_asked_asset_is_welded(store, tmp_path):
    scene_id = _scene()
    env = _import_stl(scene_id, tmp_path, _cube_triangles(), name="a.stl")
    env = _import_stl(scene_id, tmp_path, _cube_triangles()[:6], rev=env["scene"]["revision"], name="b.stl")
    by_name = {a["originalName"]: a for a in env["assets"]}
    result = _weld_tool(scene_id, env["scene"]["revision"], assetId=by_name["b.stl"]["id"])
    after = {a["originalName"]: a for a in result["assets"]}
    assert after["a.stl"]["id"] == by_name["a.stl"]["id"] and after["b.stl"]["id"] != by_name["b.stl"]["id"]
    with pytest.raises(PlastisError) as excinfo:
        _weld_tool(scene_id, result["scene"]["revision"], assetId="f" * 64)
    assert excinfo.value.code == "ASSET_NOT_FOUND"


# --- Skipped, and said so -----------------------------------------------------------------------------


def test_a_model_with_skins_animations_or_morphs_is_skipped_and_listed(store, tmp_path):
    scene_id = _scene()
    env = tools.import_model(scene=scene_id, baseRevision=1, path=_file(tmp_path, "rig.glb", DEFORM.build_source_glb()), explode=False)
    result = _weld_tool(scene_id, env["scene"]["revision"])
    assert result["cleanup"]["applied"] is False and result["assets"][0]["id"] == env["assets"][0]["id"]
    skipped = result["cleanup"]["changes"]["weldSkipped"]
    assert skipped and skipped[0]["what"] == "rig.glb"
    assert "skins or animations" in skipped[0]["reason"]


def test_built_in_shapes_are_skipped_and_listed():
    scene_id = _scene()
    env = tools.add_node(scene=scene_id, baseRevision=1, kind="mesh", name="Ball", primitive={"type": "sphere"}, materialId="m_default", transform=T)
    result = _weld_tool(scene_id, env["scene"]["revision"])
    skipped = result["cleanup"]["changes"]["weldSkipped"]
    assert result["cleanup"]["applied"] is False
    assert skipped == [{"what": "1 primitive shape", "reason": "built-in shapes have deliberate seams, so they are left alone"}]


def test_a_missing_or_changed_file_is_skipped_not_a_crash(store, tmp_path):
    scene_id = _scene()
    env = _import_stl(scene_id, tmp_path, _cube_triangles())
    stored = store.assets_dir / ("%s.glb" % env["assets"][0]["sha256"])
    stored.write_bytes(stored.read_bytes() + b"\x00")
    skipped = _weld_tool(scene_id, env["scene"]["revision"])["cleanup"]["changes"]["weldSkipped"]
    assert "changed since import" in skipped[0]["reason"]
    stored.unlink()
    assert "missing" in _weld_tool(scene_id, env["scene"]["revision"])["cleanup"]["changes"]["weldSkipped"][0]["reason"]


def test_weld_can_run_with_the_other_operations_in_one_revision(store, tmp_path):
    scene_id = _scene()
    env = _import_stl(scene_id, tmp_path, _cube_triangles())
    env = tools.set_material(scene=scene_id, baseRevision=env["scene"]["revision"], id="m_idle", color="#00ff00")
    result = tools.cleanup(scene=scene_id, baseRevision=env["scene"]["revision"], operations=["weld", "prune_materials"])
    assert result["cleanup"]["operations"] == ["prune_materials", "weld"]
    assert result["cleanup"]["changes"]["materialsRemoved"] == ["m_idle"] and result["cleanup"]["changes"]["assetsWelded"]
    undone = tools.undo(scene=scene_id, baseRevision=result["scene"]["revision"])  # one entry undoes both
    assert "m_idle" in [m["id"] for m in undone["materials"]] and undone["assets"][0]["stats"]["verts"] == 36


# --- Route ----------------------------------------------------------------------------------------------


@pytest.fixture()
def client(data_dir):
    api = _load_plugin_api_standalone()
    app = FastAPI()
    app.include_router(api.router, prefix="/api/plugins/plastis3d")
    with TestClient(app) as c:
        yield c


def test_route_previews_and_applies_a_weld(client, tmp_path):
    base = "/api/plugins/plastis3d/scenes"
    sid = client.post(base, json={"name": "R"}).json()["scene"]["id"]
    env = client.post("%s/%s/imports" % (base, sid), json={"backendPath": _file(tmp_path, "c.stl", _stl(_cube_triangles())), "baseRevision": 1, "explode": False}).json()
    rev = env["scene"]["revision"]
    preview = client.post("%s/%s/cleanup" % (base, sid), json={"baseRevision": rev, "operations": ["weld"], "dryRun": True}).json()
    assert preview["cleanup"]["changes"]["assetsWelded"][0]["verticesRemoved"] == 28 and preview["scene"]["revision"] == rev
    applied = client.post("%s/%s/cleanup" % (base, sid), json={"baseRevision": rev, "operations": ["weld"]}).json()
    assert applied["cleanup"]["applied"] is True and applied["assets"][0]["stats"]["verts"] == 8
    assert client.post("%s/%s/cleanup" % (base, sid), json={"baseRevision": rev + 1, "operations": ["weld"], "assetId": "f" * 64}).status_code == 404
    assert client.post("%s/%s/cleanup" % (base, sid), json={"baseRevision": rev + 1, "operations": ["weld"], "assetId": 3}).status_code == 400


def test_the_checked_in_weld_fixtures_match_the_generator():
    import importlib.util
    from pathlib import Path

    path = Path(__file__).resolve().parent.parent / "fixtures" / "make_welded_glb.py"
    spec = importlib.util.spec_from_file_location("make_welded_glb", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    source = module.build_source()
    assert module.SOURCE.read_bytes() == source
    assert module.RESULT.read_bytes() == module.build_result(source)
    result = _scan(module.RESULT.read_bytes())
    assert result.stats["verts"] == 8 and result.stats["tris"] == 4 and len(module.RESULT.read_bytes()) < len(source)


@pytest.mark.parametrize("gate", ["triangles", "bytes", "both", "still-over-byte"])
def test_weld_drawability_feedback_uses_rescanned_triangle_and_byte_gates(store, monkeypatch, gate):
    # One real triangle and many empty triangles shrink below either gate.
    points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)] + [(0, 0, 0)] * 300
    data = _glb_bytes(_doc(points))
    initial = weld.weld_asset(data, time.monotonic() + 30)
    assert initial["status"] == "welded" and len(initial["bytes"]) < len(data)
    monkeypatch.setattr(glb, "MAX_DRAWABLE_TRIS", 2 if gate in ("triangles", "both") else 1000)
    cap = (len(data) + len(initial["bytes"])) // 2 if gate in ("bytes", "both") else (len(initial["bytes"]) - 1 if gate == "still-over-byte" else 100000)
    monkeypatch.setattr(glb, "MAX_BYTE_ROUTE_BYTES", cap)
    source = store.assets_dir / (hashlib.sha256(data).hexdigest() + ".glb")
    source.write_bytes(data)
    scan = _scan(data)
    asset_id = source.stem
    scene = {"nodes": [{"kind": "model", "id": "n", "modelAssetId": asset_id}], "assets": [{"id": asset_id, "sha256": asset_id, "format": "glb", "bytes": len(data), "stats": scan.stats}]}
    report = cleanup.plan_welds(scene, store)["assets"][asset_id]["report"]
    assert report["drawableBefore"] is False
    assert report["drawableAfter"] is (gate != "still-over-byte")
    assert report["becameDrawable"] is (gate != "still-over-byte")
