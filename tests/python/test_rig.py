"""PR30 tests (Tier 1): rigging — validation, envelope weights, the skinned GLB, the route and the export splice."""

import base64
import copy
import json
import struct
from array import array

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from plastis3d_scene import rig, tools
from plastis3d_scene.export_glb import export_scene
from plastis3d_scene.spec import PlastisError
from plastis3d_scene.store import Store

from test_import import _load_plugin_api_standalone

T = {"t": [0, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]}
IDENTITY = [0, 0, 0, 1]
BEND = [0, 0, 0.3826834, 0.9238795]  # 45 degrees about Z


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


def b64(typecode, values):
    return base64.b64encode(array(typecode, values).tobytes()).decode()


def column(segments=4):
    """A 1 x 1 x (segments) square column of quads along +Y, a vertex ring at each height."""
    positions, indices = [], []
    for level in range(segments + 1):
        y = level / segments * 2.0
        for x, z in ((-0.25, -0.25), (0.25, -0.25), (0.25, 0.25), (-0.25, 0.25)):
            positions += [x, y, z]
    for level in range(segments):
        for k in range(4):
            a, b = level * 4 + k, level * 4 + (k + 1) % 4
            c, d = a + 4, b + 4
            indices += [a, b, c, b, d, c]
    return {"positions": b64("f", positions), "indices": b64("I", indices)}


def two_bones(**extra):
    return {
        "bones": [
            {"id": "lower", "name": "Lower", "parent": None, "head": [0, 0, 0], "tail": [0, 1, 0]},
            {"id": "upper", "name": "Upper", "parent": "lower", "head": [0, 1, 0], "tail": [0, 2, 0]},
        ],
        "weights": "envelope",
        "clips": [{"name": "Bend", "keys": [{"t": 0, "boneId": "upper", "rotation": IDENTITY}, {"t": 1, "boneId": "upper", "rotation": BEND}]}],
        **extra,
    }


def scene_with_box():
    sid = tools.new_scene(name="Rig")["scene"]["id"]
    env = tools.add_node(scene=sid, baseRevision=1, kind="mesh", name="Column", primitive={"type": "box"}, materialId="m_default", transform=T)
    return sid, env["scene"]["revision"], next(n["id"] for n in env["nodes"] if n["name"] == "Column")


def parse_glb(path):
    data = open(path, "rb").read() if not isinstance(path, bytes) else path
    jlen = struct.unpack("<I", data[12:16])[0]
    return json.loads(data[20:20 + jlen])


# --- validation -----------------------------------------------------------------------------------------------

def test_a_good_rig_validates_and_normalises_quaternions():
    clean = rig.validate_params(two_bones())
    assert len(clean["bones"]) == 2 and clean["weights"] == "envelope"
    assert clean["clips"][0]["keys"][1]["rotation"][3] == pytest.approx(0.9238795, abs=1e-6)


@pytest.mark.parametrize("change", [
    lambda p: p.update(bones=[]),
    lambda p: p["bones"].append(dict(p["bones"][0])),  # duplicate id
    lambda p: p["bones"][0].update(parent="upper"),  # a loop
    lambda p: p["bones"][0].update(parent="ghost"),
    lambda p: p["bones"][0].update(tail=[0, 0, 0]),  # no length
    lambda p: p["bones"][0].update(head=[0, 0, float("nan")]),
    lambda p: p.update(weights="heat"),
    lambda p: p["clips"][0]["keys"][1].update(t=0),  # not increasing
    lambda p: p["clips"][0]["keys"][1].update(rotation=[0, 0, 0, 2]),  # not a unit quaternion
    lambda p: p["clips"][0]["keys"][1].update(boneId="ghost"),
    lambda p: p["clips"][0]["keys"][1].update(rotation=[1, 0, 0, 0]),  # a half turn from the identity key
    lambda p: p.update(clips=[p["clips"][0]] * 17),
])
def test_bad_rigs_are_refused(change):
    params = copy.deepcopy(two_bones())
    change(params)
    assert code_of(lambda: rig.validate_params(params)) == "RIG_INVALID"


def test_more_than_64_bones_is_refused():
    bones = [{"id": "b%d" % i, "name": "b", "parent": None, "head": [i, 0, 0], "tail": [i, 1, 0]} for i in range(65)]
    assert code_of(lambda: rig.validate_params({"bones": bones})) == "RIG_INVALID"


# --- weights --------------------------------------------------------------------------------------------------

def decoded_column():
    positions = array("f", [])
    for level in range(5):
        for x, z in ((-0.25, -0.25), (0.25, -0.25), (0.25, 0.25), (-0.25, 0.25)):
            positions.extend([x, level * 0.5, z])
    return positions


def test_weights_sum_to_one_are_deterministic_and_follow_the_nearest_bone():
    bones = rig.validate_params(two_bones())["bones"]
    positions = decoded_column()
    joints, weights = rig.envelope_weights(positions, bones)
    again = rig.envelope_weights(positions, bones)
    assert (joints, weights) == again
    for v in range(len(positions) // 3):
        assert sum(weights[4 * v:4 * v + 4]) == pytest.approx(1.0, abs=1e-6)
    assert joints[0] == 0 and weights[0] > 0.5  # the bottom ring belongs to the lower bone
    assert joints[4 * 19] == 1 and weights[4 * 19] > 0.5  # the top ring to the upper bone


def test_at_most_four_influences_with_many_bones():
    bones = [{"id": "b%d" % i, "name": "b", "parent": None, "head": [0, i * 0.3, 0], "tail": [0, i * 0.3 + 0.2, 0]} for i in range(10)]
    joints, weights = rig.envelope_weights(decoded_column(), bones)
    assert len(joints) == 4 * 20 and all(0 <= j < 10 for j in joints)


# --- the skinned GLB --------------------------------------------------------------------------------------------

def test_the_skinned_glb_has_a_skin_joints_and_the_clip():
    clean = rig.validate_params(two_bones())
    from plastis3d_scene import bake

    decoded = bake.decode_mesh(column())
    glb = rig.build_skinned_glb(name="Column", decoded=decoded, params=clean, material={"name": "m", "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1]}})
    g = parse_glb(glb)
    assert len(g["skins"]) == 1 and g["skins"][0]["joints"] == [1, 2] and g["skins"][0]["skeleton"] == 1
    assert g["nodes"][0]["skin"] == 0 and g["nodes"][2]["translation"] == [0, 1, 0]  # upper's head relative to lower
    assert {"JOINTS_0", "WEIGHTS_0"} <= set(g["meshes"][0]["primitives"][0]["attributes"])
    assert g["animations"][0]["name"] == "Bend" and g["animations"][0]["samplers"][0]["interpolation"] == "LINEAR"
    assert g["animations"][0]["channels"][0]["target"] == {"node": 2, "path": "rotation"}


def test_a_mesh_over_the_vertex_cap_is_too_large():
    clean = rig.validate_params(two_bones())
    positions = array("f", [0.0] * (3 * (rig.MAX_RIG_VERTICES + 1)))
    decoded = {"positions": positions, "indices": array("I", [0, 1, 2]), "normals": None, "uvs": None, "colors": None}
    assert code_of(lambda: rig.build_skinned_glb(name="x", decoded=decoded, params=clean, material={})) == "RIG_TOO_LARGE"


# --- the route and the model ----------------------------------------------------------------------------------

def test_rigging_a_shape_makes_a_locked_model_in_one_revision_and_undo_restores_it(client, store):
    sid, rev, nid = scene_with_box()
    r = client.post("/api/plugins/plastis3d/scenes/%s/rigs" % sid, json={"baseRevision": rev, "id": nid, "mesh": column(), "rig": two_bones()})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["scene"]["revision"] == rev + 1
    node = next(n for n in body["nodes"] if n["id"] == nid)
    assert node["kind"] == "model" and node["generator"]["type"] == "rig" and "materialId" not in node and "primitive" not in node
    asset = next(a for a in body["assets"] if a["id"] == node["modelAssetId"])
    assert asset["stats"]["clips"] == 1 and asset["stats"]["skins"] == 1
    base = next(a for a in body["assets"] if a["id"] == node["generator"]["params"]["baseAssetId"])
    assert base["stats"]["skins"] == 0
    undo = client.patch("/api/plugins/plastis3d/scenes/%s" % sid, json={"baseRevision": rev + 1, "ops": [{"op": "undo"}]}).json()
    assert next(n for n in undo["nodes"] if n["id"] == nid)["kind"] == "mesh"


def test_a_rig_can_be_regenerated_and_the_model_stays_locked_to_mesh_edit(client, store):
    sid, rev, nid = scene_with_box()
    url = "/api/plugins/plastis3d/scenes/%s" % sid
    first = client.post(url + "/rigs", json={"baseRevision": rev, "id": nid, "mesh": column(), "rig": two_bones()}).json()
    again = client.post(url + "/rigs", json={"baseRevision": rev + 1, "id": nid, "mesh": column(), "rig": two_bones(clips=[])}).json()
    node = next(n for n in again["nodes"] if n["id"] == nid)
    assert again["scene"]["revision"] == rev + 2 and node["modelAssetId"] != next(n for n in first["nodes"] if n["id"] == nid)["modelAssetId"]
    bake = client.post(url + "/bakes", json={"baseRevision": rev + 2, "nodeId": nid, "mesh": column()})
    assert bake.status_code == 409 and bake.json()["code"] == "NODE_LOCKED"


def test_a_bad_rig_writes_nothing(client, store):
    sid, rev, nid = scene_with_box()
    bad = two_bones()
    bad["bones"][0]["parent"] = "upper"
    r = client.post("/api/plugins/plastis3d/scenes/%s/rigs" % sid, json={"baseRevision": rev, "id": nid, "mesh": column(), "rig": bad})
    assert r.status_code == 400 and r.json()["code"] == "RIG_INVALID"
    assert store.get_scene(sid)["revision"] == rev


def test_a_stale_revision_is_a_conflict(client, store):
    sid, rev, nid = scene_with_box()
    r = client.post("/api/plugins/plastis3d/scenes/%s/rigs" % sid, json={"baseRevision": rev - 1, "id": nid, "mesh": column(), "rig": two_bones()})
    assert r.status_code == 409


def test_a_node_with_clips_cannot_be_rigged(client, store):
    sid, rev, nid = scene_with_box()
    clip = {"name": "Spin", "duration": 1, "channels": [{"target": "rotation", "times": [0, 1], "values": [[0, 0, 0], [0, 90, 0]]}]}
    env = tools.update_node(scene=sid, baseRevision=rev, id=nid, clips=[clip]) if hasattr(tools, "update_node") else None
    if env is None:
        pytest.skip("no update_node tool")
    r = client.post("/api/plugins/plastis3d/scenes/%s/rigs" % sid, json={"baseRevision": env["scene"]["revision"], "id": nid, "mesh": column(), "rig": two_bones()})
    assert r.status_code == 400 and r.json()["code"] == "BAKE_INVALID"


def test_the_export_keeps_the_skin_and_the_clip(client, store):
    sid, rev, nid = scene_with_box()
    client.post("/api/plugins/plastis3d/scenes/%s/rigs" % sid, json={"baseRevision": rev, "id": nid, "mesh": column(), "rig": two_bones()})
    out = export_scene(store.get_scene(sid), store)
    g = parse_glb(out["path"])
    assert len(g.get("skins", [])) == 1 and len(g.get("animations", [])) == 1
    assert any("JOINTS_0" in p["attributes"] for m in g["meshes"] for p in m["primitives"])
