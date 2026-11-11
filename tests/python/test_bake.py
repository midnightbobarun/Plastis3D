"""PR24 tests (Tier 1): schema 2, the bake route, the asset sweep and drafts."""

import base64
import copy
import json
import os
import struct
import time
from array import array

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from plastis3d_scene import bake, drafts, mutate, sweep, tools
from plastis3d_scene.export_glb import export_scene
from plastis3d_scene.spec import PlastisError, SCHEMA_VERSION
from plastis3d_scene.store import Store
from plastis3d_scene.upgrade import upgrade_scene
from plastis3d_scene.validate import validate_scene

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


@pytest.fixture()
def client(data_dir):
    api = _load_plugin_api_standalone()
    app = FastAPI()
    app.include_router(api.router, prefix="/api/plugins/plastis3d")
    with TestClient(app) as c:
        yield c


def b64(typecode, values):
    return base64.b64encode(array(typecode, values).tobytes()).decode()


def quad(extra=None):
    mesh = {
        "positions": b64("f", [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
        "normals": b64("f", [0, 0, 1] * 4),
        "uvs": b64("f", [0, 0, 1, 0, 1, 1, 0, 1]),
        "indices": b64("I", [0, 1, 2, 0, 2, 3]),
    }
    mesh.update(extra or {})
    return mesh


def scene_with_box():
    sid = tools.new_scene(name="Bake")["scene"]["id"]
    env = tools.add_node(scene=sid, baseRevision=1, kind="mesh", name="Box", primitive={"type": "box"}, materialId="m_default", transform=T)
    node = next(n for n in env["nodes"] if n["name"] == "Box")
    return sid, env["scene"]["revision"], node["id"]


def code_of(call):
    with pytest.raises(PlastisError) as info:
        call()
    return info.value.code


# --- schema 2 ------------------------------------------------------------------------------------

def test_current_schema_and_a_schema_one_file_is_upgraded_on_read(store):
    assert SCHEMA_VERSION == 3
    sid = tools.new_scene(name="Old")["scene"]["id"]
    path = store.scene_path(sid)
    raw = json.loads(path.read_text())
    raw["schema"] = 1
    path.write_text(json.dumps(raw))
    assert store.get_scene(sid)["schema"] == 3
    env = tools.add_node(scene=sid, baseRevision=1, kind="group", name="G", transform=T)
    assert env["scene"]["schema"] == 3
    assert json.loads(path.read_text())["schema"] == 3  # the next write persists it


def test_the_one_to_two_step_changes_nothing_but_the_number():
    scene = {"schema": 1, "id": "a", "nodes": [], "keep": {"x": 1}}
    assert upgrade_scene(copy.deepcopy(scene)) == {**scene, "schema": 3}
    assert upgrade_scene({"schema": 2, "k": 1}) == {"schema": 3, "k": 1}
    assert upgrade_scene({"schema": 3}) == {"schema": 3}  # already current
    assert upgrade_scene("nope") == "nope"


def test_a_future_schema_file_is_refused_with_schema_newer(store):
    sid = tools.new_scene(name="Future")["scene"]["id"]
    path = store.scene_path(sid)
    raw = json.loads(path.read_text())
    raw["schema"] = 4
    path.write_text(json.dumps(raw))
    assert code_of(lambda: store.get_scene(sid)) == "SCHEMA_NEWER"


def test_generator_field_rules(store):
    sid, rev, node_id = scene_with_box()
    scene = store.get_scene(sid)
    node = next(n for n in scene["nodes"] if n["id"] == node_id)
    node["generator"] = {"type": "text", "version": 1, "params": {}}
    assert code_of(lambda: validate_scene(scene)) == "SPEC_INVALID"  # only a baked part may carry one
    baked = store.get_scene(sid)
    env = bake.bake_mesh(sid, store, bake_body(rev, node_id))
    scene = store.get_scene(sid)
    node = next(n for n in scene["nodes"] if n["id"] == node_id)
    asset_id = node["modelAssetId"]
    good = {"type": "curve", "version": 1, "params": {"kind": "tube", "points": [[0, 0, 0], [1, 0, 0]], "closed": False, "radius": 0.05, "radialSegments": 8, "tubularSegments": 8}, "baseAssetId": asset_id}
    node["generator"] = good
    validate_scene(scene)
    for bad in (
        {**good, "type": "sculpt"},
        {**good, "version": 0},
        {**good, "params": []},
        {**good, "params": {"x": "y" * 70000}},
        {**good, "type": "rig"},  # a rig makes a model, never a part
        {**good, "baseAssetId": aid(5)},
        {**good, "extra": 1},
        "text",
    ):
        node["generator"] = bad
        assert code_of(lambda: validate_scene(scene)) == "SPEC_INVALID", bad


# --- bake ----------------------------------------------------------------------------------------

def bake_body(rev, node_id, mesh=None, **extra):
    return {"baseRevision": rev, "nodeId": node_id, "mesh": mesh or quad(), **extra}


def test_baking_a_primitive_makes_a_part_in_one_revision_and_undo_restores_it(store):
    sid, rev, node_id = scene_with_box()
    env = bake.bake_mesh(sid, store, bake_body(rev, node_id))
    assert env["scene"]["revision"] == rev + 1
    node = next(n for n in env["nodes"] if n["id"] == node_id)
    assert node["kind"] == "part" and node["meshIndex"] == 0 and node["primitiveIndex"] == 0 and "primitive" not in node
    assert node["materialId"] == "m_default"
    asset = next(a for a in env["assets"] if a["id"] == node["modelAssetId"])
    assert asset["stats"]["verts"] == 4 and asset["stats"]["tris"] == 2 and asset["stats"]["parts"][0]["uv"] is True
    assert (store.assets_dir / ("%s.glb" % asset["id"])).is_file()
    undone = mutate.apply(sid, rev + 1, {"op": "undo"}, store=store)
    back = next(n for n in undone["nodes"] if n["id"] == node_id)
    assert back["kind"] == "mesh" and back["primitive"] == {"type": "box"}
    redone = mutate.apply(sid, rev + 2, {"op": "redo"}, store=store)
    assert next(n for n in redone["nodes"] if n["id"] == node_id)["kind"] == "part"


def test_a_baked_part_exports_with_the_edited_vertex_count(store):
    sid, rev, node_id = scene_with_box()
    bake.bake_mesh(sid, store, bake_body(rev, node_id))
    out = export_scene(store.get_scene(sid), store)
    data = open(out["path"], "rb").read()
    jl = struct.unpack("<I", data[12:16])[0]
    gltf = json.loads(data[20:20 + jl])
    counts = [a["count"] for a in gltf["accessors"] if a["type"] == "VEC3" and "min" in a]
    assert counts == [4]
    assert out["stats"]["tris"] == 2


def test_rebaking_a_part_carries_its_material_and_replaces_the_asset(store):
    sid, rev, node_id = scene_with_box()
    first = bake.bake_mesh(sid, store, bake_body(rev, node_id))
    mesh2 = quad({"positions": b64("f", [0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0])})
    second = bake.bake_mesh(sid, store, bake_body(first["scene"]["revision"], node_id, mesh2, name="Again"))
    node = next(n for n in second["nodes"] if n["id"] == node_id)
    assert node["modelAssetId"] != next(n for n in first["nodes"] if n["id"] == node_id)["modelAssetId"]
    assert len(second["assets"]) == 2  # the old one is still reachable by undo


@pytest.mark.parametrize(
    "mesh, code",
    [
        (quad({"positions": b64("f", [float("nan"), 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0])}), "BAKE_INVALID"),
        (quad({"positions": b64("f", [float("inf"), 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0])}), "BAKE_INVALID"),
        (quad({"indices": b64("I", [0, 1, 9])}), "BAKE_INVALID"),
        (quad({"indices": b64("I", [0, 1])}), "BAKE_INVALID"),
        (quad({"normals": b64("f", [0, 0, 1] * 3)}), "BAKE_INVALID"),
        (quad({"uvs": b64("f", [0, 0, 1])}), "BAKE_INVALID"),
        (quad({"positions": "!!!"}), "BAKE_INVALID"),
        (quad({"positions": base64.b64encode(b"123").decode()}), "BAKE_INVALID"),
        (quad({"skin": {"joints": "", "weights": "", "bones": []}}), "BAKE_INVALID"),
        (quad({"extra": "x"}), "BAKE_INVALID"),
        ("not an object", "BAKE_INVALID"),
    ],
)
def test_invalid_meshes_are_refused_and_write_nothing(store, mesh, code):
    sid, rev, node_id = scene_with_box()
    before_scene = store.scene_path(sid).read_bytes()
    assert code_of(lambda: bake.bake_mesh(sid, store, bake_body(rev, node_id, mesh))) == code
    assert store.scene_path(sid).read_bytes() == before_scene
    assert list(store.assets_dir.iterdir()) == []


def test_too_many_vertices(store, monkeypatch):
    sid, rev, node_id = scene_with_box()
    monkeypatch.setattr(bake, "MAX_VERTICES", 3)
    assert code_of(lambda: bake.bake_mesh(sid, store, bake_body(rev, node_id))) == "BAKE_TOO_LARGE"
    assert list(store.assets_dir.iterdir()) == []


def test_refused_nodes_and_stale_revisions_write_nothing(store):
    sid, rev, node_id = scene_with_box()
    assert code_of(lambda: bake.bake_mesh(sid, store, bake_body(rev + 5, node_id))) == "REVISION_CONFLICT"
    assert code_of(lambda: bake.bake_mesh(sid, store, bake_body(rev, "n_missing"))) == "NODE_NOT_FOUND"
    assert code_of(lambda: bake.bake_mesh(sid, store, bake_body(rev, "light_key"))) == "BAKE_INVALID"
    animated = tools.update_node(scene=sid, baseRevision=rev, id=node_id, clips=[{"name": "c", "channels": [{"target": "translation", "times": [0, 1], "values": [[0, 0, 0], [0, 1, 0]]}]}])
    assert code_of(lambda: bake.bake_mesh(sid, store, bake_body(animated["scene"]["revision"], node_id))) == "BAKE_INVALID"
    assert list(store.assets_dir.iterdir()) == []


def test_a_locked_model_is_refused_with_the_design_sentence(store, tmp_path):
    from plastis3d_scene.import_model import import_path

    sid = tools.new_scene(name="Locked")["scene"]["id"]
    path = tmp_path / "t.stl"
    tri = struct.pack("<3f", 0, 0, 1) + struct.pack("<9f", 0, 0, 0, 1, 0, 0, 0, 1, 0) + b"\0\0"
    path.write_bytes(b"x" * 80 + struct.pack("<I", 1) + tri)
    env = import_path(sid, store, str(path), base_revision=1, explode=False)
    model = next(n for n in env["nodes"] if n["kind"] == "model")
    with pytest.raises(PlastisError) as info:
        bake.bake_mesh(sid, store, bake_body(env["scene"]["revision"], model["id"]))
    assert info.value.code == "NODE_LOCKED"
    assert "This model is locked. Re-import it as editable parts to edit its mesh." in str(info.value)


def test_the_asset_cap_counts_only_what_can_be_reached(store, monkeypatch):
    sid, rev, node_id = scene_with_box()
    monkeypatch.setattr("plastis3d_scene.spec.MAX_ASSETS", 1, raising=True)
    first = bake.bake_mesh(sid, store, bake_body(rev, node_id))
    mesh2 = quad({"positions": b64("f", [0, 0, 0, 3, 0, 0, 3, 3, 0, 0, 3, 0])})
    # The first asset is still reachable by undo, so a second would be over the cap of 1.
    assert code_of(lambda: bake.bake_mesh(sid, store, bake_body(first["scene"]["revision"], node_id, mesh2))) == "LIMIT_ASSETS"
    assert len(list(store.assets_dir.glob("*.glb"))) == 1  # nothing was written for the refusal


# --- the sweep -----------------------------------------------------------------------------------

def aid(n):
    return ("%064x" % n)


def test_rows_are_swept_when_no_node_or_history_entry_reaches_them():
    scene = {
        "nodes": [{"id": "n1", "modelAssetId": aid(1)}],
        "materials": [{"id": "m", "baseColorMap": aid(2)}],
        "history": {"undo": [{"undo": {"nodes": {"n1": {"modelAssetId": aid(3)}}}}], "redo": [{"redo": {"assets": {aid(4): None}}}]},
        "assets": [{"id": aid(i)} for i in range(1, 7)],
    }
    removed = sweep.sweep_rows(scene)
    assert sorted(removed) == [aid(5), aid(6)]
    assert [a["id"] for a in scene["assets"]] == [aid(i) for i in range(1, 5)]


def test_generator_base_assets_and_extra_history_are_roots():
    scene = {"nodes": [{"id": "n", "generator": {"baseAssetId": aid(7)}}], "materials": [], "history": {}, "assets": [{"id": aid(7)}, {"id": aid(8)}, {"id": aid(9)}]}
    assert sweep.sweep_rows(scene, extra_history=[{"undo": {"assets": {aid(8): {"id": aid(8)}}}}]) == [aid(9)]


def test_files_go_only_when_no_scene_references_them_and_not_while_young(store):
    sid, rev, node_id = scene_with_box()
    kept = bake.bake_mesh(sid, store, bake_body(rev, node_id))
    in_use = next(a for a in kept["assets"])["id"]
    orphan = store.assets_dir / (aid(1) + ".glb")
    orphan.write_bytes(b"x")
    young = store.assets_dir / (aid(2) + ".glb")
    young.write_bytes(b"x")
    old = time.time() - 3600
    os.utime(orphan, (old, old))
    deleted = sweep.sweep_files(store)
    assert deleted == [orphan.name]
    assert (store.assets_dir / (in_use + ".glb")).is_file() and young.is_file()
    # A file another scene still has a row for is never deleted.
    other = tools.new_scene(name="Other")["scene"]["id"]
    raw = json.loads(store.scene_path(other).read_text())
    raw["assets"] = [{"id": aid(2)}]
    store.scene_path(other).write_text(json.dumps(raw))
    os.utime(young, (old, old))
    assert sweep.sweep_files(store) == []


def test_unreachable_history_assets_are_swept_after_the_entry_falls_off(store):
    sid, rev, node_id = scene_with_box()
    first = bake.bake_mesh(sid, store, bake_body(rev, node_id))
    mesh2 = quad({"positions": b64("f", [0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0])})
    second = bake.bake_mesh(sid, store, bake_body(first["scene"]["revision"], node_id, mesh2))
    old_id = next(n for n in first["nodes"] if n["id"] == node_id)["modelAssetId"]
    assert any(a["id"] == old_id for a in second["assets"])  # undo can still reach it
    rev_now = second["scene"]["revision"]
    for i in range(55):  # push the bake entries off the 50-entry history
        rev_now = tools.update_node(scene=sid, baseRevision=rev_now, id=node_id, name="n%d" % i)["scene"]["revision"]
    scene = store.get_scene(sid)
    assert all(a["id"] != old_id for a in scene["assets"])
    old = time.time() - 3600
    for path in store.assets_dir.iterdir():
        os.utime(path, (old, old))
    sweep.sweep_files(store)
    assert not (store.assets_dir / (old_id + ".glb")).exists()
    current = next(n for n in scene["nodes"] if n["id"] == node_id)["modelAssetId"]
    assert (store.assets_dir / (current + ".glb")).is_file()


# --- drafts --------------------------------------------------------------------------------------

def test_draft_round_trip_and_commit_deletes_it(store):
    sid, rev, node_id = scene_with_box()
    result = drafts.put_draft(store, sid, node_id, {"baseRevision": rev, "mesh": quad(), "from": {"primitive": {"type": "box"}}})
    assert result["ok"] and result["dropped"] == 0
    got = drafts.get_draft(store, sid, node_id)["draft"]
    assert got["baseRevision"] == rev and got["currentRevision"] == rev and got["mesh"]["indices"]
    bake.bake_mesh(sid, store, bake_body(rev, node_id))
    assert code_of(lambda: drafts.get_draft(store, sid, node_id)) == "DRAFT_NOT_FOUND"


def test_draft_rules(store, monkeypatch):
    sid, rev, node_id = scene_with_box()
    assert code_of(lambda: drafts.put_draft(store, sid, "n_missing", {"baseRevision": rev, "mesh": {}})) == "NODE_NOT_FOUND"
    assert code_of(lambda: drafts.put_draft(store, sid, node_id, {"mesh": {}})) == "SPEC_INVALID"
    assert code_of(lambda: drafts.put_draft(store, sid, node_id, "x")) == "SPEC_INVALID"
    assert code_of(lambda: drafts.put_draft(store, "no-such", node_id, {})) == "SCENE_NOT_FOUND"
    monkeypatch.setattr(drafts, "MAX_DRAFT_BYTES", 100)
    assert code_of(lambda: drafts.put_draft(store, sid, node_id, {"baseRevision": rev, "mesh": quad()})) == "DRAFT_TOO_LARGE"
    assert not (store.data_dir / "drafts" / sid / (node_id + ".json")).exists()


def test_the_oldest_draft_is_dropped_over_the_scene_cap(store, monkeypatch):
    sid, rev, node_id = scene_with_box()
    env = tools.add_node(scene=sid, baseRevision=rev, kind="mesh", name="Two", primitive={"type": "sphere"}, materialId="m_default", transform=T)
    second = next(n for n in env["nodes"] if n["name"] == "Two")["id"]
    monkeypatch.setattr(drafts, "MAX_SCENE_DRAFT_BYTES", 1500)
    one = drafts.put_draft(store, sid, node_id, {"baseRevision": rev, "mesh": {"positions": "A" * 700}})
    two = drafts.put_draft(store, sid, second, {"baseRevision": rev, "mesh": {"positions": "A" * 900}})
    assert one["dropped"] == 0 and two["dropped"] == 1
    assert code_of(lambda: drafts.get_draft(store, sid, node_id)) == "DRAFT_NOT_FOUND"
    assert drafts.get_draft(store, sid, second)["ok"]


def test_deleting_the_scene_deletes_its_drafts(store):
    sid, rev, node_id = scene_with_box()
    drafts.put_draft(store, sid, node_id, {"baseRevision": rev, "mesh": quad()})
    store.delete_scene(sid, store.get_scene(sid)["revision"])
    assert not (store.data_dir / "drafts" / sid).exists()


def test_a_draft_keeps_its_asset_alive(store):
    sid, rev, node_id = scene_with_box()
    drafts.put_draft(store, sid, node_id, {"baseRevision": rev, "mesh": {"p": "x"}, "from": {"modelAssetId": aid(11)}})
    stray = store.assets_dir / (aid(11) + ".glb")
    stray.write_bytes(b"x")
    old = time.time() - 3600
    os.utime(stray, (old, old))
    assert sweep.sweep_files(store) == []


# --- routes --------------------------------------------------------------------------------------

def test_routes(client, store):
    base = "/api/plugins/plastis3d/scenes"
    sid = client.post(base, json={"name": "R"}).json()["scene"]["id"]
    rev = client.patch("%s/%s" % (base, sid), json={"baseRevision": 1, "ops": [{"op": "add_node", "node": {"name": "Box", "kind": "mesh", "transform": T, "primitive": {"type": "box"}, "materialId": "m_default"}}]}).json()
    node_id = next(n["id"] for n in rev["nodes"] if n["name"] == "Box")
    revision = rev["scene"]["revision"]
    assert client.put("%s/%s/drafts/%s" % (base, sid, node_id), json={"baseRevision": revision, "mesh": quad()}).status_code == 200
    got = client.get("%s/%s/drafts/%s" % (base, sid, node_id))
    assert got.status_code == 200 and got.json()["draft"]["baseRevision"] == revision
    baked = client.post("%s/%s/bakes" % (base, sid), json=bake_body(revision, node_id))
    assert baked.status_code == 200 and baked.json()["scene"]["revision"] == revision + 1
    assert client.get("%s/%s/drafts/%s" % (base, sid, node_id)).status_code == 404
    assert client.post("%s/%s/bakes" % (base, sid), json=bake_body(revision, node_id)).status_code == 409
    assert client.post("%s/%s/bakes" % (base, sid), json=bake_body(revision + 1, node_id, quad({"indices": b64("I", [0, 1, 99])}))).json()["code"] == "BAKE_INVALID"
    assert client.post("%s/%s/bakes" % (base, sid), content=b"[]").status_code == 400
    assert client.delete("%s/%s/drafts/%s" % (base, sid, node_id)).json() == {"ok": True, "deleted": False}


def test_route_body_over_the_cap(client, monkeypatch):
    api = _load_plugin_api_standalone()
    base = "/api/plugins/plastis3d/scenes"
    sid = client.post(base, json={"name": "Big"}).json()["scene"]["id"]
    huge = b'{"baseRevision":1,"nodeId":"n","mesh":{"positions":"' + b"A" * (17 * 1024 * 1024) + b'"}}'
    response = client.post("%s/%s/bakes" % (base, sid), content=huge)
    assert response.status_code == 413 and response.json()["code"] == "BAKE_TOO_LARGE"


# --- PR23: the text generator and "create" --------------------------------------------------------

TEXT = {"text": "Hi\nthere", "size": 0.2, "depth": 0.05, "bevel": {"enabled": False, "thickness": 0.01, "size": 0.01}, "curveSegments": 4, "align": "left", "lineHeight": 1.2, "font": "bundled-sans-v1"}


def text_generator(**changes):
    params = {**TEXT, **changes}
    return {"type": "text", "version": 1, "params": params}


def test_create_adds_a_new_part_with_its_generator_in_one_revision_and_undo_removes_it(store):
    sid = tools.new_scene(name="Words")["scene"]["id"]
    env = bake.bake_mesh(sid, store, {"baseRevision": 1, "create": {"name": "Text", "transform": {"t": [1, 0, 2], "r": [0, 0, 0], "s": [1, 1, 1]}}, "mesh": quad(), "generator": text_generator()})
    assert env["scene"]["revision"] == 2
    node = next(n for n in env["nodes"] if n["name"] == "Text")
    assert node["kind"] == "part" and node["transform"]["t"] == [1, 0, 2] and node["generator"]["params"]["text"] == "Hi\nthere"
    assert node["modelAssetId"] == env["assets"][0]["id"]
    out = export_scene(store.get_scene(sid), store)
    assert out["stats"]["tris"] == 2
    undone = mutate.apply(sid, 2, {"op": "undo"}, store=store)
    assert not any(n["name"] == "Text" for n in undone["nodes"]) and undone["assets"] == []
    redone = mutate.apply(sid, 3, {"op": "redo"}, store=store)
    assert any(n["name"] == "Text" for n in redone["nodes"])


def test_create_rules(store):
    sid = tools.new_scene(name="Words")["scene"]["id"]
    sid2, rev, node_id = scene_with_box()
    assert code_of(lambda: bake.bake_mesh(sid, store, {"baseRevision": 1, "create": {}, "nodeId": "n_x", "mesh": quad()})) == "SPEC_INVALID"
    assert code_of(lambda: bake.bake_mesh(sid, store, {"baseRevision": 1, "create": {"bogus": 1}, "mesh": quad()})) == "SPEC_INVALID"
    assert code_of(lambda: bake.bake_mesh(sid, store, {"baseRevision": 1, "create": {"parent": "n_nope"}, "mesh": quad()})) == "NODE_NOT_FOUND"
    assert list(store.assets_dir.iterdir()) == []


@pytest.mark.parametrize(
    "changes",
    [
        {"text": ""}, {"text": "x" * 201}, {"text": "bell\x07"}, {"size": 0}, {"size": 11}, {"size": float("nan")}, {"depth": 0.5},
        {"depth": -1}, {"curveSegments": 0}, {"curveSegments": 13}, {"curveSegments": 2.5}, {"align": "justify"}, {"lineHeight": 0.5},
        {"lineHeight": 4}, {"font": "comic"}, {"bevel": []}, {"bevel": {"enabled": 1, "thickness": 0, "size": 0}}, {"bevel": {"enabled": True, "thickness": 5, "size": 0}},
        {"bevel": {"enabled": True, "thickness": 0, "size": 0, "x": 1}},
    ],
)
def test_bad_text_params_are_refused_and_write_nothing(store, changes):
    sid = tools.new_scene(name="Words")["scene"]["id"]
    assert code_of(lambda: bake.bake_mesh(sid, store, {"baseRevision": 1, "create": {"name": "Text"}, "mesh": quad(), "generator": text_generator(**changes)})) == "SPEC_INVALID"
    assert list(store.assets_dir.iterdir()) == []


def test_missing_and_extra_text_params_are_refused(store):
    sid = tools.new_scene(name="Words")["scene"]["id"]
    for params in ({k: v for k, v in TEXT.items() if k != "font"}, {**TEXT, "extra": 1}):
        generator = {"type": "text", "version": 1, "params": params}
        assert code_of(lambda: bake.bake_mesh(sid, store, {"baseRevision": 1, "create": {}, "mesh": quad(), "generator": generator})) == "SPEC_INVALID"


def test_editing_a_text_part_with_a_new_generator_replaces_it_and_clearing_ends_it(store):
    sid = tools.new_scene(name="Words")["scene"]["id"]
    env = bake.bake_mesh(sid, store, {"baseRevision": 1, "create": {"name": "Text"}, "mesh": quad(), "generator": text_generator()})
    node = next(n for n in env["nodes"] if n["name"] == "Text")
    mesh2 = quad({"positions": b64("f", [0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0])})
    again = bake.bake_mesh(sid, store, bake_body(2, node["id"], mesh2, generator=text_generator(text="Bye")))
    assert next(n for n in again["nodes"] if n["id"] == node["id"])["generator"]["params"]["text"] == "Bye"
    plain = bake.bake_mesh(sid, store, bake_body(3, node["id"], quad()))  # a mesh edit ends the settings
    assert "generator" not in next(n for n in plain["nodes"] if n["id"] == node["id"])


# --- PR25: the modifiers generator ------------------------------------------------------------------

def modifiers_generator(base, stack=None):
    stack = [{"type": "array", "enabled": True, "params": {"count": 2, "offset": [1, 0, 0]}}] if stack is None else stack
    return {"type": "modifiers", "version": 1, "params": {"baseAssetId": base, "stack": stack}}


def test_a_modifier_stack_keeps_its_base_asset_alive_and_the_result_replaces_the_node_asset(store):
    sid, rev, node_id = scene_with_box()
    base = bake.bake_mesh(sid, store, bake_body(rev, node_id))
    base_id = next(n for n in base["nodes"] if n["id"] == node_id)["modelAssetId"]
    mesh2 = quad({"positions": b64("f", [0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0])})
    out = bake.bake_mesh(sid, store, bake_body(base["scene"]["revision"], node_id, mesh2, generator=modifiers_generator(base_id)))
    node = next(n for n in out["nodes"] if n["id"] == node_id)
    assert node["generator"]["params"]["baseAssetId"] == base_id and node["modelAssetId"] != base_id
    assert {a["id"] for a in out["assets"]} == {base_id, node["modelAssetId"]}
    # Push the bake entries off the history: the base is still a root through the generator.
    rev_now = out["scene"]["revision"]
    for i in range(55):
        rev_now = tools.update_node(scene=sid, baseRevision=rev_now, id=node_id, name="n%d" % i)["scene"]["revision"]
    scene = store.get_scene(sid)
    assert {a["id"] for a in scene["assets"]} == {base_id, node["modelAssetId"]}
    old = time.time() - 3600
    for path in store.assets_dir.iterdir():
        os.utime(path, (old, old))
    sweep.sweep_files(store)
    assert (store.assets_dir / ("%s.glb" % base_id)).is_file()


def test_modifier_stack_rules(store):
    sid, rev, node_id = scene_with_box()
    base = bake.bake_mesh(sid, store, bake_body(rev, node_id))
    base_id = next(n for n in base["nodes"] if n["id"] == node_id)["modelAssetId"]
    revision = base["scene"]["revision"]
    ok = {"type": "smooth", "enabled": True, "params": {"iterations": 2, "factor": 0.5}}
    bad_stacks = [
        [ok] * 9,
        [{"type": "bogus", "enabled": True, "params": {}}],
        [{"type": "mirror", "enabled": True, "params": {"axis": "w", "threshold": 0.1}}],
        [{"type": "array", "enabled": True, "params": {"count": 65, "offset": [1, 0, 0]}}],
        [{"type": "array", "enabled": True, "params": {"count": 2, "offset": [1, 0]}}],
        [{"type": "subdivide", "enabled": True, "params": {"levels": 3}}],
        [{"type": "smooth", "enabled": True, "params": {"iterations": 2, "factor": 0.5, "x": 1}}],
        [{"type": "decimate", "enabled": True, "params": {"ratio": 0.99}}],
        [{"type": "edgeSplit", "enabled": 1, "params": {"angle": 30}}],
        ["nope"],
    ]
    for stack in bad_stacks:
        assert code_of(lambda: bake.bake_mesh(sid, store, bake_body(revision, node_id, quad(), generator=modifiers_generator(base_id, stack)))) == "SPEC_INVALID", stack
    assert code_of(lambda: bake.bake_mesh(sid, store, bake_body(revision, node_id, quad(), generator=modifiers_generator("f" * 64)))) == "SPEC_INVALID"
    assert code_of(lambda: bake.bake_mesh(sid, store, bake_body(revision, node_id, quad(), generator={"type": "modifiers", "version": 1, "params": {"stack": []}}))) == "SPEC_INVALID"
    # Only the base asset's file exists: nothing was written for any refusal.
    assert len(list(store.assets_dir.glob("*.glb"))) == 1


# --- PR29: vertex colours ---------------------------------------------------------------------------

def test_baked_colours_become_color_0_and_survive_export(store):
    sid, rev, node_id = scene_with_box()
    colors = b64("f", [1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1, 0, 1])
    env = bake.bake_mesh(sid, store, bake_body(rev, node_id, quad({"colors": colors})))
    asset = env["assets"][0]
    data = (store.assets_dir / ("%s.glb" % asset["id"])).read_bytes()
    gltf = json.loads(data[20:20 + struct.unpack("<I", data[12:16])[0]])
    attributes = gltf["meshes"][0]["primitives"][0]["attributes"]
    assert "COLOR_0" in attributes
    accessor = gltf["accessors"][attributes["COLOR_0"]]
    assert accessor["componentType"] == 5121 and accessor["normalized"] is True and accessor["type"] == "VEC4" and accessor["count"] == 4
    out = export_scene(store.get_scene(sid), store)
    exported = open(out["path"], "rb").read()
    egltf = json.loads(exported[20:20 + struct.unpack("<I", exported[12:16])[0]])
    assert any("COLOR_0" in p["attributes"] for m in egltf["meshes"] for p in m["primitives"])


@pytest.mark.parametrize("colors", [b64("f", [1, 0, 0]), b64("f", [float("nan")] * 16), "!!!"])
def test_bad_colour_arrays_are_refused_and_write_nothing(store, colors):
    sid, rev, node_id = scene_with_box()
    assert code_of(lambda: bake.bake_mesh(sid, store, bake_body(rev, node_id, quad({"colors": colors})))) == "BAKE_INVALID"
    assert list(store.assets_dir.iterdir()) == []


def test_colour_values_are_clamped_into_a_byte(store):
    sid, rev, node_id = scene_with_box()
    colors = b64("f", [2, -1, 0.5, 1] * 4)
    env = bake.bake_mesh(sid, store, bake_body(rev, node_id, quad({"colors": colors})))
    data = (store.assets_dir / ("%s.glb" % env["assets"][0]["id"])).read_bytes()
    gltf = json.loads(data[20:20 + struct.unpack("<I", data[12:16])[0]])
    view = gltf["bufferViews"][gltf["accessors"][gltf["meshes"][0]["primitives"][0]["attributes"]["COLOR_0"]]["bufferView"]]
    binary = data[20 + struct.unpack("<I", data[12:16])[0] + 8:]
    first = list(binary[view["byteOffset"]:view["byteOffset"] + 4])
    assert first == [255, 0, 128, 255]


@pytest.mark.parametrize("indices", [(2, 3), (0, 0)])
def test_modifier_base_selection_metadata_roundtrips(store, indices):
    sid, rev, node_id = scene_with_box()
    base = bake.bake_mesh(sid, store, bake_body(rev, node_id))
    base_id = next(n for n in base["nodes"] if n["id"] == node_id)["modelAssetId"]
    generator = modifiers_generator(base_id)
    generator["params"].update(baseMeshIndex=indices[0], basePrimitiveIndex=indices[1])
    env = bake.bake_mesh(sid, store, bake_body(base["scene"]["revision"], node_id, generator=generator))
    assert next(n for n in env["nodes"] if n["id"] == node_id)["generator"] == generator
    rev = env["scene"]["revision"]
    for invalid in ({"baseMeshIndex": -1, "basePrimitiveIndex": 0}, {"baseMeshIndex": True, "basePrimitiveIndex": 0}, {"baseMeshIndex": 0}, {"baseMeshIndex": 0, "basePrimitiveIndex": 0.5}):
        bad = modifiers_generator(base_id)
        bad["params"].update(invalid)
        assert code_of(lambda: bake.bake_mesh(sid, store, bake_body(rev, node_id, generator=bad))) == "SPEC_INVALID"


def test_bake_refuses_embedded_maps_instead_of_silently_losing_them(store):
    from pathlib import Path
    from plastis3d_scene import glb, import_model
    from test_import import _glb_from
    sid = tools.new_scene(name="Mapped")["scene"]["id"]
    scan = glb.scan(Path("tests/fixtures/two-primitive.glb").read_bytes(), source_format="glb", deadline=time.monotonic() + 10)
    doc = copy.deepcopy(scan.gltf)
    doc["images"] = [{"uri": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="}]
    doc["textures"] = [{"source": 0}]
    doc["materials"] = [{}]
    for mesh in doc["meshes"]:
        for primitive in mesh["primitives"]:
            primitive["material"] = 0
    for material in doc["materials"]:
        material.setdefault("pbrMetallicRoughness", {})["baseColorTexture"] = {"index": 0}
    env = import_model.import_bytes(sid, store, _glb_from(doc, scan.buffers[0]), original_name="Mapped.glb", source_format="glb", base_revision=1)
    node = next(n for n in env["nodes"] if n["kind"] == "part")
    before = store.get_scene(sid)
    files = sorted(p.name for p in store.assets_dir.iterdir())
    with pytest.raises(PlastisError, match="embedded texture maps") as info:
        bake.bake_mesh(sid, store, bake_body(before["revision"], node["id"]))
    assert info.value.code == "BAKE_INVALID"
    assert store.get_scene(sid) == before
    assert sorted(p.name for p in store.assets_dir.iterdir()) == files


def test_legacy_modifier_feedback_recovers_selection_without_exposing_history_or_writing(store):
    from plastis3d_scene.import_model import import_bytes
    from pathlib import Path
    sid = tools.new_scene(name="Legacy base")["scene"]["id"]
    env = import_bytes(sid, store, Path("tests/fixtures/two-primitive.glb").read_bytes(), original_name="Source.glb", source_format="glb", base_revision=1)
    original = next(n for n in env["nodes"] if n.get("kind") == "part" and n["primitiveIndex"] == 1)
    base_id = original["modelAssetId"]
    env = bake.bake_mesh(sid, store, bake_body(env["scene"]["revision"], original["id"], generator=modifiers_generator(base_id)))
    stored = store.get_scene(sid)
    assert "baseMeshIndex" not in next(n for n in stored["nodes"] if n["id"] == original["id"])["generator"]["params"]
    feedback = store.envelope(stored)
    params = next(n for n in feedback["nodes"] if n["id"] == original["id"])["generator"]["params"]
    assert (params["baseMeshIndex"], params["basePrimitiveIndex"]) == (0, 1)
    assert "history" not in feedback and "history" not in feedback["scene"]
    assert store.get_scene(sid) == stored  # observational facts do not create revisions
    # The next Apply saves the recovered pair, so it survives history rollover.
    generator = copy.deepcopy(next(n for n in feedback["nodes"] if n["id"] == original["id"])["generator"])
    again = bake.bake_mesh(sid, store, bake_body(feedback["scene"]["revision"], original["id"], generator=generator))
    assert next(n for n in store.get_scene(sid)["nodes"] if n["id"] == original["id"])["generator"] == generator
    # Two different source pairs for the same node/asset are not guessed.
    conflict = copy.deepcopy(stored)
    conflict["history"]["redo"].append({"label": "Other source", "at": "2026-11-10T00:00:00Z", "undo": {"nodes": {original["id"]: {**original, "primitiveIndex": 0}}}})
    ambiguous = next(n for n in store.envelope(conflict)["nodes"] if n["id"] == original["id"])
    assert "baseMeshIndex" not in ambiguous["generator"]["params"]

    # History rows are not full live-node validation: malformed old indices cannot
    # make feedback crash or supply a guessed selection from the other entries.
    conflict["history"]["redo"][-1]["undo"]["nodes"][original["id"]]["primitiveIndex"] = []
    unresolved = next(n for n in store.envelope(conflict)["nodes"] if n["id"] == original["id"])
    assert "baseMeshIndex" not in unresolved["generator"]["params"]
