"""PR2 store unit tests (Tier 1, stage-1 §5).

Create/read a scene, revision increments on write, atomic write leaves
no partial file, the default rig (aimed at the origin), and the
read/create routes (GET/POST /scenes, GET /scenes/{id}).

Run: pytest tests/python
"""

import importlib.util
import json
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from plastis3d_scene import primitives, spec
from plastis3d_scene.spec import PlastisError
from plastis3d_scene.store import Store

REPO_ROOT = Path(__file__).resolve().parent.parent.parent


@pytest.fixture
def store(tmp_path):
    return Store(tmp_path / "data")


def _mesh_node(node_id, name="Box"):
    return {
        "id": node_id,
        "name": name,
        "parent": None,
        "kind": "mesh",
        "transform": {"t": [0, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
        "visible": True,
        "primitive": {"type": "box", "width": 1, "height": 1, "depth": 1},
        "materialId": "m_default",
    }


# --- create / read -----------------------------------------------------------


def test_create_scene_has_default_rig(store):
    scene = store.create_scene("Snowman")
    assert scene["id"] == "snowman"
    assert scene["revision"] == 1
    assert scene["schema"] == 3
    assert scene["units"] == "m"
    assert scene["upAxis"] == "Y"
    assert [n["id"] for n in scene["nodes"]] == ["light_key", "cam_main"]
    assert [m["id"] for m in scene["materials"]] == ["m_default"]
    assert scene["assets"] == []
    assert scene["history"] == {"undo": [], "redo": [], "limit": 50}


def test_create_scene_slug_collision_suffixes(store):
    first = store.create_scene("Snowman")
    second = store.create_scene("Snowman")
    third = store.create_scene("Snowman!")
    assert first["id"] == "snowman"
    assert second["id"] == "snowman-2"
    assert third["id"] == "snowman-3"


def test_create_scene_explicit_id_collision(store):
    store.create_scene("Snowman", scene_id="snowman")
    with pytest.raises(PlastisError) as excinfo:
        store.create_scene("Other", scene_id="snowman")
    assert excinfo.value.code == "SCENE_EXISTS"


def test_create_scene_rejects_empty_name(store):
    with pytest.raises(PlastisError) as excinfo:
        store.create_scene("   ")
    assert excinfo.value.code == "SPEC_INVALID"


def test_get_scene_round_trip(store):
    created = store.create_scene("Snowman")
    fetched = store.get_scene("snowman")
    assert fetched == created


def test_get_missing_scene(store):
    with pytest.raises(PlastisError) as excinfo:
        store.get_scene("nope")
    assert excinfo.value.code == "SCENE_NOT_FOUND"


def test_list_scenes(store):
    store.create_scene("Beta")
    store.create_scene("Alpha")
    listed = store.list_scenes()
    assert [s["id"] for s in listed] == ["alpha", "beta"]
    assert listed[0]["revision"] == 1
    assert listed[0]["name"] == "Alpha"
    assert "updatedAt" in listed[0]


def test_scene_id_rejects_path_traversal(store):
    with pytest.raises(PlastisError) as excinfo:
        store.get_scene("../secret")
    assert excinfo.value.code in ("SCENE_NOT_FOUND", "SPEC_INVALID")
    # Nothing outside the scenes dir was touched.
    assert not (store.data_dir.parent / "secret.json").exists()


# --- default rig math (stage-1 §6.1) ------------------------------------------
# Both local -Z axes must point at the origin (dot > 0.9999). The stored
# four-decimal Euler values are verified here, not trusted.


def test_default_rig_aims_at_origin(store):
    scene = store.create_scene("Rig check")
    for node in scene["nodes"]:
        dot = primitives.dot_to_origin(
            node["transform"]["t"], node["transform"]["r"]
        )
        assert dot > 0.9999, "%s local -Z misses the origin (dot=%r)" % (
            node["id"],
            dot,
        )


def test_default_rig_exact_dots():
    # Recomputed 2026-11-06 under the three.js Euler "XYZ" convention
    # (R = Rx * Ry * Rz): both dots are 1.000000 at four-decimal precision.
    assert primitives.dot_to_origin([4, 6, 3], [-63.4349, 30.807, 45.6876]) == pytest.approx(1.0, abs=1e-6)
    assert primitives.dot_to_origin([4, 3, 6], [-26.5651, 30.807, 14.3633]) == pytest.approx(1.0, abs=1e-6)


def test_default_material_values():
    material = spec.default_material()
    assert material.id == "m_default"
    assert material.color == "#c8ccd0"
    assert material.metalness == 0
    assert material.roughness == 0.6
    assert material.emissive == "#000000"
    assert material.opacity == 1


# --- revision / atomic write --------------------------------------------------


def test_revision_increments_on_write(store):
    scene = store.create_scene("Snowman")
    new = json.loads(json.dumps(scene))
    new["nodes"].append(_mesh_node("n_box"))
    result = store.write_scene("snowman", new, base_revision=1)
    assert result["scene"]["revision"] == 2
    assert result["historyTruncated"] is False
    assert store.get_scene("snowman")["revision"] == 2
    new2 = json.loads(json.dumps(result["scene"]))
    new2["nodes"].append(_mesh_node("n_box2"))
    result2 = store.write_scene("snowman", new2, base_revision=2)
    assert result2["scene"]["revision"] == 3


def test_write_rejects_stale_base_revision(store):
    scene = store.create_scene("Snowman")
    new = json.loads(json.dumps(scene))
    new["nodes"].append(_mesh_node("n_box"))
    store.write_scene("snowman", new, base_revision=1)
    stale = json.loads(json.dumps(scene))
    stale["nodes"].append(_mesh_node("n_box2"))
    with pytest.raises(PlastisError) as excinfo:
        store.write_scene("snowman", stale, base_revision=1)
    assert excinfo.value.code == "REVISION_CONFLICT"
    assert excinfo.value.current_revision == 2
    # The failed write changed nothing.
    assert store.get_scene("snowman")["revision"] == 2
    assert len(store.get_scene("snowman")["nodes"]) == 3


def test_write_rejects_wrong_scene_id(store):
    scene = store.create_scene("Snowman")
    new = json.loads(json.dumps(scene))
    new["id"] = "other"
    with pytest.raises(PlastisError) as excinfo:
        store.write_scene("snowman", new, base_revision=1)
    assert excinfo.value.code == "SPEC_INVALID"


def test_atomic_write_leaves_no_partial_file(store):
    scene = store.create_scene("Snowman")
    for i in range(10):
        current = store.get_scene("snowman")
        new = json.loads(json.dumps(current))
        new["nodes"].append(_mesh_node("n_box%d" % i, "Box %d" % i))
        store.write_scene("snowman", new, base_revision=current["revision"])
    # Only the scene file (and no temp/lock residue) lives in scenes/.
    names = sorted(p.name for p in store.scenes_dir.iterdir())
    assert names == [".namespace.lock", "snowman.json", "snowman.lock"]
    # The file is complete, valid JSON at every revision.
    assert store.get_scene("snowman")["revision"] == 11


def test_envelope_shape(store):
    scene = store.create_scene("Snowman")
    envelope = store.envelope(scene, defaults_added=["light_key", "cam_main"])
    assert envelope["ok"] is True
    assert envelope["scene"] == {
        "id": "snowman",
        "revision": 1,
        "schema": 3,
        "units": "m",
        "upAxis": "Y",
    }
    assert envelope["stats"] == {"tris": 0, "verts": 0, "materials": 1, "nodes": 2}
    assert envelope["feedback"] == {
        "canUndo": False,
        "canRedo": False,
        "defaultsAdded": ["light_key", "cam_main"],
        "historyTruncated": False,
    }
    assert "history" not in envelope


# --- read/create routes --------------------------------------------------------
# The routes resolve the store from the environment per request, so a
# function-scoped PLASTIS3D_DATA_DIR points them at the tmp store.


def _load_plugin_api_standalone():
    api_path = REPO_ROOT / "dashboard" / "plugin_api.py"
    saved_modules = {
        k: v
        for k, v in sys.modules.items()
        if k.startswith("plastis3d_scene") or k == "hermes_dashboard_plugin_pr2"
    }
    for key in saved_modules:
        del sys.modules[key]
    spec_module = importlib.util.spec_from_file_location(
        "hermes_dashboard_plugin_pr2", api_path
    )
    assert spec_module is not None and spec_module.loader is not None
    module = importlib.util.module_from_spec(spec_module)
    sys.modules[spec_module.name] = module
    try:
        spec_module.loader.exec_module(module)
    finally:
        # Put the original package modules back: the api module keeps the
        # copies it loaded, and later tests that import lazily must not get a
        # second copy of the package (a second PlastisError class).
        for key in [k for k in sys.modules if k.startswith("plastis3d_scene")]:
            del sys.modules[key]
        sys.modules.update({k: v for k, v in saved_modules.items() if k != "hermes_dashboard_plugin_pr2"})
    return module


@pytest.fixture
def api_client(tmp_path, monkeypatch):
    monkeypatch.setenv("PLASTIS3D_DATA_DIR", str(tmp_path / "data"))
    api = _load_plugin_api_standalone()
    app = FastAPI()
    app.include_router(api.router, prefix="/api/plugins/plastis3d")
    with TestClient(app) as client:
        yield client


def test_route_list_empty(api_client):
    response = api_client.get("/api/plugins/plastis3d/scenes")
    assert response.status_code == 200
    assert response.json() == {"ok": True, "scenes": []}


def test_route_create_and_get(api_client):
    created = api_client.post("/api/plugins/plastis3d/scenes", json={"name": "Snowman"})
    assert created.status_code == 201
    body = created.json()
    assert body["ok"] is True
    assert body["scene"]["id"] == "snowman"
    assert body["scene"]["revision"] == 1
    assert [n["id"] for n in body["nodes"]] == ["light_key", "cam_main"]
    assert body["feedback"]["defaultsAdded"] == ["light_key", "cam_main"]

    listed = api_client.get("/api/plugins/plastis3d/scenes")
    assert listed.status_code == 200
    scenes = listed.json()["scenes"]
    assert len(scenes) == 1
    assert scenes[0]["id"] == "snowman"
    assert scenes[0]["name"] == "Snowman"
    assert scenes[0]["revision"] == 1
    assert isinstance(scenes[0]["updatedAt"], str) and scenes[0]["updatedAt"]

    fetched = api_client.get("/api/plugins/plastis3d/scenes/snowman")
    assert fetched.status_code == 200
    assert fetched.json()["scene"]["id"] == "snowman"
    assert "history" not in fetched.json()


def test_route_create_rejects_empty_name(api_client):
    response = api_client.post("/api/plugins/plastis3d/scenes", json={"name": ""})
    assert response.status_code == 400
    assert response.json()["code"] == "SPEC_INVALID"


def test_route_get_missing_scene(api_client):
    response = api_client.get("/api/plugins/plastis3d/scenes/nope")
    assert response.status_code == 404
    assert response.json()["code"] == "SCENE_NOT_FOUND"


def test_route_create_duplicate_id(api_client):
    api_client.post("/api/plugins/plastis3d/scenes", json={"name": "Snowman"})
    response = api_client.post(
        "/api/plugins/plastis3d/scenes", json={"name": "Other", "id": "snowman"}
    )
    assert response.status_code == 409
    assert response.json()["code"] == "SCENE_EXISTS"


def test_revision_floor_survives_restart_and_stale_delete(tmp_path):
    store = Store(tmp_path)
    scene = store.create_scene("Floor")
    scene = store.write_scene("floor", scene, 1)["scene"]
    with pytest.raises(PlastisError) as conflict:
        store.delete_scene("floor", 1)
    assert conflict.value.code == "REVISION_CONFLICT"
    assert store.get_scene("floor")["revision"] == 2
    store.delete_scene("floor", 2)
    fresh = Store(tmp_path).create_scene("Floor")
    assert fresh["id"] == "floor" and fresh["revision"] == 3
    with pytest.raises(PlastisError) as conflict:
        store.write_scene("floor", fresh, 2)
    assert conflict.value.code == "REVISION_CONFLICT"


def test_copy_preserves_assets_and_nodes(tmp_path):
    store = Store(tmp_path)
    source = store.create_scene("Source")
    copied = store.create_scene("Copy", copy_from="source")
    assert copied["nodes"] == source["nodes"]
    assert copied["assets"] == source["assets"]
    assert copied["history"]["undo"] == []
    store.delete_scene("source", source["revision"])
    assert store.get_scene("copy")["nodes"] == source["nodes"]
