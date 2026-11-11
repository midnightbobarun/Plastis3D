"""PR6 export tests (Tier 1, stage-3 §5).

Export through the tool (``plastis3d_export_glb``) AND through the
gateway route (``POST /scenes/{id}/export``): refusal codes, result
shape, no-file-on-failure, and the idempotent per-revision filename.

Run: pytest tests/python
"""

import importlib.util
import json
import os
import struct
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from plastis3d_scene.spec import PlastisError
from plastis3d_scene.store import Store
from plastis3d_scene import tools as tools_mod

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
FAKE_SHA = "a" * 64

BOX_KWARGS = {
    "name": "Box",
    "kind": "mesh",
    "transform": {"t": [0, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
    "primitive": {"type": "box"},
    "materialId": "m_default",
}

# A fake asset row, the same shape test_mutate.py attaches with the
# import_asset op. The row names bytes that are not on disk, so the
# PR8 splice fails closed with EXPORT_FAILED on it (see
# test_export_model_node_missing_asset_file); the row is only what the
# validator needs to accept a model/part reference.
FAKE_ASSET = {
    "id": "a_model",
    "sha256": FAKE_SHA,
    "file": "assets/%s.glb" % FAKE_SHA,
    "format": "glb",
    "bytes": 1234,
    "originalName": "model.glb",
    "sourceFormat": "glb",
    "stats": {"tris": 100, "verts": 50},
}


@pytest.fixture()
def data_dir(tmp_path, monkeypatch):
    path = tmp_path / "data"
    monkeypatch.setenv("PLASTIS3D_DATA_DIR", str(path))
    return path


def _new_scene(name="Export"):
    env = tools_mod.new_scene(name=name)
    assert env["ok"] is True
    return env["scene"]["id"], env["scene"]["revision"]


def _add_box(scene_id, revision, **overrides):
    kwargs = dict(BOX_KWARGS)
    kwargs.update(overrides)
    env = tools_mod.add_node(scene=scene_id, baseRevision=revision, **kwargs)
    return env


def _attach_node_with_asset(store, scene_id, node):
    """Append ``node`` (model/part) plus the fake asset row, via a
    plain scene write — the mutation core rejects authoring model/part
    kinds by hand, which is exactly why the writer must refuse them."""
    scene = store.get_scene(scene_id)
    scene["assets"].append(dict(FAKE_ASSET))
    scene["nodes"].append(node)
    store.write_scene(scene_id, scene, base_revision=scene["revision"])


def _expect_error(code, func, *args, **kwargs):
    with pytest.raises(PlastisError) as excinfo:
        func(*args, **kwargs)
    assert excinfo.value.code == code, excinfo.value
    assert str(excinfo.value).startswith(code)
    return excinfo.value


def _transform(node_id, name, kind, transform=None, **extra):
    node = {
        "id": node_id,
        "name": name,
        "kind": kind,
        "transform": transform or {"t": [0, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
    }
    node.update(extra)
    return node


# --- Tool path ---------------------------------------------------------------

def test_export_empty_default_rig(data_dir):
    scene_id, _ = _new_scene()
    _expect_error("EXPORT_EMPTY", tools_mod.export_glb, scene=scene_id)
    assert list(Store(data_dir).exports_dir.iterdir()) == []


def test_export_mesh_scene_via_tool(data_dir):
    scene_id, revision = _new_scene()
    env = _add_box(scene_id, revision)
    assert env["scene"]["revision"] == 2
    result = tools_mod.export_glb(scene=scene_id)
    assert result["ok"] is True
    assert set(result) == {"ok", "path", "bytes", "revision", "stats", "filename"}
    assert result["revision"] == 2
    assert result["filename"] == "Export.glb"  # the scene's name, as a plain file name
    assert result["path"] == str(Store(data_dir).exports_dir / scene_id / result["filename"])
    assert result["stats"] == {"tris": 12, "verts": 24, "materials": 1, "nodes": 3}
    path = Path(result["path"])
    assert path.is_file()
    assert result["bytes"] == path.stat().st_size
    assert path.read_bytes()[:4] == b"glTF"


def test_export_unknown_scene(data_dir):
    _expect_error("SCENE_NOT_FOUND", tools_mod.export_glb, scene="missing-scene")


def test_export_model_node_missing_asset_file(data_dir):
    # PR8: the splice replaces the EXPORT_IMPORT_UNMERGED refusal. The
    # fake asset row names bytes that are not on disk, so the splice
    # fails closed with EXPORT_FAILED and writes nothing.
    scene_id, revision = _new_scene()
    _add_box(scene_id, revision)
    store = Store(data_dir)
    before = sorted(p.name for p in store.exports_dir.iterdir())
    _attach_node_with_asset(
        store,
        scene_id,
        _transform("n_model", "Model", "model", modelAssetId="a_model"),
    )
    _expect_error("EXPORT_FAILED", tools_mod.export_glb, scene=scene_id)
    assert sorted(p.name for p in store.exports_dir.iterdir()) == before


def test_export_part_node_missing_asset_file(data_dir):
    scene_id, _ = _new_scene()
    store = Store(data_dir)
    _attach_node_with_asset(
        store,
        scene_id,
        _transform(
            "n_part",
            "Part",
            "part",
            modelAssetId="a_model",
            meshIndex=0,
            primitiveIndex=0,
        ),
    )
    _expect_error("EXPORT_FAILED", tools_mod.export_glb, scene=scene_id)
    assert list(store.exports_dir.iterdir()) == []


def test_export_clips_emit_animation(data_dir):
    # PR21 writes primitive clips rather than rejecting or dropping them.
    scene_id, _ = _new_scene()
    store = Store(data_dir)
    scene = store.get_scene(scene_id)
    scene["nodes"].append(
        _transform(
            "n_clip",
            "Clip box",
            "mesh",
            primitive={"type": "box"},
            materialId="m_default",
            clips=[
                {
                    "id": "c_intro",
                    "channels": [
                        {
                            "target": "translation",
                            "times": [0, 1],
                            "values": [[0, 0, 0], [1, 0, 0]],
                        }
                    ],
                }
            ],
        )
    )
    store.write_scene(scene_id, scene, base_revision=scene["revision"])
    result = tools_mod.export_glb(scene=scene_id)
    data = Path(result["path"]).read_bytes()
    json_length = struct.unpack_from("<I", data, 12)[0]
    document = json.loads(data[20:20 + json_length])
    assert document["animations"][0]["channels"][0]["target"]["path"] == "translation"


def test_export_same_revision_overwrites_same_path(data_dir):
    scene_id, revision = _new_scene()
    _add_box(scene_id, revision)
    first = tools_mod.export_glb(scene=scene_id)
    second = tools_mod.export_glb(scene=scene_id)
    assert first["path"] == second["path"]
    assert first["bytes"] == second["bytes"]
    exports = Store(data_dir).exports_dir
    assert [p.name for p in exports.iterdir()] == [scene_id]
    assert [p.name for p in (exports / scene_id).iterdir()] == [first["filename"]]
    assert Path(first["path"]).read_bytes() == Path(second["path"]).read_bytes()


def test_export_does_not_mutate_revision(data_dir):
    scene_id, revision = _new_scene()
    _add_box(scene_id, revision)
    tools_mod.export_glb(scene=scene_id)
    assert Store(data_dir).get_scene(scene_id)["revision"] == 2


def test_envelope_carries_schema_version(data_dir):
    scene_id, _ = _new_scene()
    env = tools_mod.get_scene(scene=scene_id)
    assert env["scene"]["schema"] == 3


# --- Gateway route -----------------------------------------------------------

def _load_plugin_api_standalone():
    """Load plugin_api.py the way the dashboard host does: no package
    context and no sys.path entry for the plugin directory."""
    api_path = REPO_ROOT / "dashboard" / "plugin_api.py"
    saved_path = list(sys.path)
    saved_modules = {
        k: v
        for k, v in sys.modules.items()
        if k in ("plastis3d_scene", "hermes_dashboard_plugin_plastis3d")
    }
    for key in saved_modules:
        del sys.modules[key]
    sys.path = [p for p in sys.path if p != str(REPO_ROOT)]
    try:
        spec = importlib.util.spec_from_file_location(
            "hermes_dashboard_plugin_plastis3d", api_path
        )
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path = saved_path
        for key, mod in saved_modules.items():
            sys.modules[key] = mod


@pytest.fixture(scope="module")
def api_client(tmp_path_factory):
    """One TestClient for the module, pointed at a tmp data dir."""
    data_dir = tmp_path_factory.mktemp("export-api-data")
    previous = os.environ.get("PLASTIS3D_DATA_DIR")
    os.environ["PLASTIS3D_DATA_DIR"] = str(data_dir)
    api = _load_plugin_api_standalone()
    app = FastAPI()
    app.include_router(api.router, prefix="/api/plugins/plastis3d")
    with TestClient(app) as client:
        yield client, data_dir
    if previous is None:
        os.environ.pop("PLASTIS3D_DATA_DIR", None)
    else:
        os.environ["PLASTIS3D_DATA_DIR"] = previous


def _route_create(client, name="Route"):
    response = client.post("/api/plugins/plastis3d/scenes", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()["scene"]["id"]


def test_route_export_empty_default_rig(api_client):
    client, _ = api_client
    scene_id = _route_create(client, "RouteEmpty")
    response = client.post("/api/plugins/plastis3d/scenes/%s/export" % scene_id)
    assert response.status_code == 400
    assert response.json()["code"] == "EXPORT_EMPTY"


def test_route_export_mesh_scene(api_client):
    client, data_dir = api_client
    scene_id = _route_create(client, "RouteMesh")
    response = client.patch(
        "/api/plugins/plastis3d/scenes/%s" % scene_id,
        json={"baseRevision": 1, "ops": [{"op": "add_node", "node": dict(BOX_KWARGS)}]},
    )
    assert response.status_code == 200, response.text
    response = client.post("/api/plugins/plastis3d/scenes/%s/export" % scene_id)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["ok"] is True
    assert set(result) == {"ok", "path", "bytes", "revision", "stats", "filename"}
    assert result["revision"] == 2
    assert result["filename"] == "RouteMesh.glb"
    path = Path(result["path"])
    assert path.is_file()
    assert result["bytes"] == path.stat().st_size
    assert path.read_bytes()[:4] == b"glTF"
    assert path.parent == Path(data_dir) / "exports" / scene_id


def test_route_export_unknown_scene(api_client):
    client, _ = api_client
    response = client.post("/api/plugins/plastis3d/scenes/nope/export")
    assert response.status_code == 404
    assert response.json()["code"] == "SCENE_NOT_FOUND"


def test_route_export_model_node_missing_asset_file(api_client):
    client, data_dir = api_client
    scene_id = _route_create(client, "RouteModel")
    store = Store(data_dir)
    _attach_node_with_asset(
        store,
        scene_id,
        _transform("n_model", "Model", "model", modelAssetId="a_model"),
    )
    response = client.post("/api/plugins/plastis3d/scenes/%s/export" % scene_id)
    assert response.status_code == 400
    assert response.json()["code"] == "EXPORT_FAILED"
    # No file for this scene (other route tests share this data dir,
    # so the exports dir as a whole is not empty).
    assert not [
        p for p in store.exports_dir.iterdir() if p.name.startswith(scene_id)
    ]


def test_mesh_only_export_has_no_rig_and_retains_only_latest(data_dir):
    from plastis3d_scene import mutate
    import struct
    scene_id, revision = _new_scene("Mesh only")
    env = mutate.apply(scene_id, revision, {"op": "build", "nodes": [{"id": "box", **BOX_KWARGS}]}, store=Store(data_dir))
    assert env["feedback"]["defaultsAdded"] == []
    first = tools_mod.export_glb(scene=scene_id)
    raw = Path(first["path"]).read_bytes()
    length = struct.unpack_from("<I", raw, 12)[0]
    gltf = json.loads(raw[20:20 + length])
    assert "cameras" not in gltf
    assert "KHR_lights_punctual" not in gltf.get("extensionsUsed", [])
    import subprocess
    subprocess.run(["node", "--input-type=module", "-e", "import {readFileSync} from 'node:fs'; import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js'; const b=readFileSync(process.argv[1]); await new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength), '');", first["path"]], cwd=REPO_ROOT, check=True, timeout=15)
    store = Store(data_dir)
    other = store.exports_dir / (scene_id + "-2-r3.glb")
    other.write_bytes(b"other")
    mutate.apply(scene_id, env["scene"]["revision"], {"op": "update_node", "id": "box", "name": "Renamed"}, store=store)
    second = tools_mod.export_glb(scene=scene_id)
    # The file keeps its name; the newer export replaced it, and it is still the only one for the scene.
    assert second["path"] == first["path"] and Path(second["path"]).read_bytes() != raw
    assert len(list(Path(second["path"]).parent.iterdir())) == 1
    assert Path(second["path"]).exists() and other.exists()
    store.delete_scene(scene_id, 3)
    assert not Path(second["path"]).exists() and other.exists()


def test_index_component_restart_boundary():
    from plastis3d_scene.export_glb import _pack_indices
    assert _pack_indices([0, 65534])[1] == 5123
    assert _pack_indices([0, 65535])[1] == 5125
    with pytest.raises(PlastisError) as error:
        _pack_indices([0xffffffff])
    assert error.value.code == "EXPORT_FAILED"


def test_failed_export_preserves_previous_success(data_dir):
    scene_id, rev = _new_scene("Keep export")
    _add_box(scene_id, rev)
    previous = Path(tools_mod.export_glb(scene=scene_id)["path"])
    store = Store(data_dir)
    _attach_node_with_asset(store, scene_id, _transform("n_model", "Missing", "model", modelAssetId="a_model"))
    _expect_error("EXPORT_FAILED", tools_mod.export_glb, scene=scene_id)
    assert previous.is_file()


# --- Friendly file names and one retained export per scene -------------------

def test_export_filename_is_the_scene_name_as_a_plain_file_name():
    from plastis3d_scene.export_glb import export_filename

    assert export_filename({"id": "x", "name": "arthalune crate"}) == "arthalune-crate.glb"
    assert export_filename({"id": "x", "name": "  My Crate!! "}) == "My-Crate.glb"
    assert export_filename({"id": "x", "name": "Café au lait"}) == "Cafe-au-lait.glb"
    assert export_filename({"id": "x", "name": "日本語 シーン"}) == "日本語-シーン.glb"
    assert export_filename({"id": "scene-id", "name": "???"}) == "scene-id.glb"
    assert export_filename({"id": "scene-id"}) == "scene-id.glb"
    assert len(export_filename({"id": "x", "name": "a" * 100})) <= 64


def test_two_scenes_with_one_name_do_not_overwrite_each_other(data_dir):
    first, rev1 = _new_scene("Crate")
    second, rev2 = _new_scene("Crate")
    _add_box(first, rev1)
    _add_box(second, rev2)
    a = tools_mod.export_glb(scene=first)
    b = tools_mod.export_glb(scene=second)
    assert a["filename"] == b["filename"] == "Crate.glb"
    assert a["path"] != b["path"]
    assert Path(a["path"]).is_file() and Path(b["path"]).is_file()


def test_a_new_export_replaces_the_old_one_and_deleting_the_scene_removes_it(data_dir):
    scene_id, revision = _new_scene("Crate")
    _add_box(scene_id, revision)
    exports = Store(data_dir).exports_dir
    # An export from before the rename of the file scheme is cleaned up by the next export.
    legacy = exports / ("%s-r1.glb" % scene_id)
    legacy.write_bytes(b"glTF")
    first = tools_mod.export_glb(scene=scene_id)
    assert not legacy.exists()
    folder = exports / scene_id
    assert [p.name for p in folder.iterdir()] == ["Crate.glb"]
    second = tools_mod.export_glb(scene=scene_id)
    assert second["path"] == first["path"] and Path(second["path"]).is_file()
    assert len(list(folder.iterdir())) == 1
    Store(data_dir).delete_exports(scene_id)
    assert not folder.exists()
