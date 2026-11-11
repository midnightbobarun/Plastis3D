"""PR3 gateway tests (Tier 1, stage-2 §5).

``fastapi.testclient.TestClient`` on all HTTP endpoints, including the
new PATCH / DELETE / export / imports / assets routes: validation
error responses, upload size limits (413), and HTTP 409 on
REVISION_CONFLICT. TestClient tests the router in isolation, not
Hermes's mounting of ``dashboard/plugin_api.py``.

Run: pytest tests/python
"""

import importlib.util
import sys
from pathlib import Path

import tempfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
FAKE_SHA = "b" * 64


def _load_plugin_api_standalone():
    """Load plugin_api.py the way the dashboard host does (see
    test_health.py): spec_from_file_location with NO package context
    and NO sys.path entry for the plugin directory."""
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
    """One TestClient for the module, pointed at a tmp data dir.

    Sets ``PLASTIS3D_DATA_DIR`` directly (module scope cannot use the
    function-scoped ``monkeypatch`` fixture) and restores it on teardown.
    """
    import os

    data_dir = tmp_path_factory.mktemp("api-data")
    previous = os.environ.get("PLASTIS3D_DATA_DIR")
    os.environ["PLASTIS3D_DATA_DIR"] = str(data_dir)
    api = _load_plugin_api_standalone()
    assert api._SCENE_PROBE == {
        "ok": True,
        "package": "plastis3d_scene",
        "version": "0.1.0",
    }
    assert callable(api._MUTATE_APPLY)  # PR3: mutate reachable standalone
    app = FastAPI()
    app.include_router(api.router, prefix="/api/plugins/plastis3d")
    with TestClient(app) as client:
        yield client
    if previous is None:
        os.environ.pop("PLASTIS3D_DATA_DIR", None)
    else:
        os.environ["PLASTIS3D_DATA_DIR"] = previous


def _create(client, name="Api"):
    response = client.post("/api/plugins/plastis3d/scenes", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


BOX = {
    "name": "Box",
    "kind": "mesh",
    "transform": {"t": [0, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
    "primitive": {"type": "box"},
    "materialId": "m_default",
}


def test_health_and_list(api_client):
    response = api_client.get("/api/plugins/plastis3d/health")
    assert response.status_code == 200
    assert response.json() == {"ok": True, "schema": 3}
    response = api_client.get("/api/plugins/plastis3d/scenes")
    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert isinstance(response.json()["scenes"], list)


def test_create_get_validation_errors(api_client):
    env = _create(api_client, "Api")
    scene_id = env["scene"]["id"]
    assert env["scene"]["revision"] == 1
    assert env["feedback"]["defaultsAdded"] == ["light_key", "cam_main"]

    response = api_client.get("/api/plugins/plastis3d/scenes/%s" % scene_id)
    assert response.status_code == 200
    assert response.json()["scene"]["id"] == scene_id

    response = api_client.get("/api/plugins/plastis3d/scenes/no-such-scene")
    assert response.status_code == 404
    assert response.json()["code"] == "SCENE_NOT_FOUND"

    response = api_client.post("/api/plugins/plastis3d/scenes", json={})
    assert response.status_code == 400
    assert response.json()["code"] == "SPEC_INVALID"

    response = api_client.post("/api/plugins/plastis3d/scenes", content=b"not json")
    assert response.status_code == 400


def test_patch_batch_ops_and_revision_conflict(api_client):
    env = _create(api_client, "Patchy")
    scene_id = env["scene"]["id"]
    response = api_client.patch(
        "/api/plugins/plastis3d/scenes/%s" % scene_id,
        json={
            "baseRevision": 1,
            "ops": [
                {"op": "add_node", "node": dict(BOX, name="A")},
                {"op": "add_node", "node": dict(BOX, name="B")},
            ],
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["scene"]["revision"] == 2  # one bump for two ops
    assert response.json()["stats"]["nodes"] == 4

    # Stale baseRevision: 409 with currentRevision in the body.
    response = api_client.patch(
        "/api/plugins/plastis3d/scenes/%s" % scene_id,
        json={"baseRevision": 1, "ops": [{"op": "add_node", "node": BOX}]},
    )
    assert response.status_code == 409
    body = response.json()
    assert body["code"] == "REVISION_CONFLICT"
    assert body["currentRevision"] == 2

    # More than 32 ops: 400.
    response = api_client.patch(
        "/api/plugins/plastis3d/scenes/%s" % scene_id,
        json={
            "baseRevision": 2,
            "ops": [{"op": "add_node", "node": dict(BOX, name="N%d" % i)} for i in range(33)],
        },
    )
    assert response.status_code == 400
    assert response.json()["code"] == "SPEC_INVALID"

    # A bad op inside the batch fails the whole patch, nothing written.
    response = api_client.patch(
        "/api/plugins/plastis3d/scenes/%s" % scene_id,
        json={"baseRevision": 2, "ops": [{"op": "delete_node", "id": "n_missing"}]},
    )
    assert response.status_code == 404
    assert response.json()["code"] == "NODE_NOT_FOUND"
    current = api_client.get("/api/plugins/plastis3d/scenes/%s" % scene_id).json()
    assert current["scene"]["revision"] == 2


def test_patch_undo_via_ops(api_client):
    env = _create(api_client, "Undopatch")
    scene_id = env["scene"]["id"]
    api_client.patch(
        "/api/plugins/plastis3d/scenes/%s" % scene_id,
        json={"baseRevision": 1, "ops": [{"op": "add_node", "node": BOX}]},
    )
    # The desktop's undo/redo is exactly this one-op PATCH (api.undoScene).
    # It used to be refused (400 SPEC_INVALID) — every real-gateway undo
    # failed while the mock accepted it (pre-PR9 completion plan, A-4).
    response = api_client.patch(
        "/api/plugins/plastis3d/scenes/%s" % scene_id,
        json={"baseRevision": 2, "ops": [{"op": "undo"}]},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["scene"]["revision"] == 3
    assert [n for n in body["nodes"] if n["name"] == "Box"] == []
    response = api_client.patch(
        "/api/plugins/plastis3d/scenes/%s" % scene_id,
        json={"baseRevision": 3, "ops": [{"op": "redo"}]},
    )
    assert response.status_code == 200, response.text
    assert [n["name"] for n in response.json()["nodes"]].count("Box") == 1
    # Mixed into a batch, undo is still refused.
    response = api_client.patch(
        "/api/plugins/plastis3d/scenes/%s" % scene_id,
        json={"baseRevision": 4, "ops": [{"op": "add_node", "node": BOX}, {"op": "undo"}]},
    )
    assert response.status_code == 400
    assert response.json()["code"] == "SPEC_INVALID"


def test_patch_refuses_import_asset(api_client):
    """A PATCH cannot attach an asset row: only the import engine's scan
    produces ``import_asset`` (pre-PR9 completion plan, audit A-2). The
    row below claims ``drawable: true`` for bytes no scan ever saw."""
    env = _create(api_client, "Noimportpatch")
    scene_id = env["scene"]["id"]
    sha = "ab" * 32
    response = api_client.patch(
        "/api/plugins/plastis3d/scenes/%s" % scene_id,
        json={
            "baseRevision": 1,
            "ops": [
                {
                    "op": "import_asset",
                    "asset": {
                        "id": "a_forged",
                        "sha256": sha,
                        "file": "assets/%s.glb" % sha,
                        "format": "glb",
                        "bytes": 10,
                        "stats": {"tris": 1, "drawable": True},
                    },
                    "nodes": [
                        {
                            "id": "n_forged",
                            "name": "Forged",
                            "kind": "model",
                            "transform": {"t": [0, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
                            "modelAssetId": "a_forged",
                        }
                    ],
                }
            ],
        },
    )
    assert response.status_code == 400, response.text
    body = response.json()
    assert body["code"] == "SPEC_INVALID"
    assert body["path"] == "/ops/0/op"
    after = api_client.get("/api/plugins/plastis3d/scenes/%s" % scene_id).json()
    assert after["scene"]["revision"] == 1
    assert after["scene"].get("assets", []) == []


def test_desktop_op_shapes_against_the_real_route(api_client):
    """The exact op shapes the desktop half sends (src/editor/AddMenu.tsx,
    sceneActions.ts, Inspector.tsx, gizmos/GizmoManager.ts, api.ts), replayed
    through the real PATCH route. The mock host accepts whatever it is
    sent, so this is the only check that client and gateway agree; it was
    added after the one-op undo PATCH turned out to be refused (A-4)."""
    env = _create(api_client, "Desktopshapes")
    scene_id = env["scene"]["id"]
    url = "/api/plugins/plastis3d/scenes/%s" % scene_id
    revision = env["scene"]["revision"]

    def patch(ops, expect=200):
        nonlocal revision
        response = api_client.patch(url, json={"baseRevision": revision, "ops": ops})
        assert response.status_code == expect, (ops, response.text)
        body = response.json()
        revision = body["scene"]["revision"]
        return body

    material = {
        "id": "m_default",
        "color": "#c8ccd0",
        "emissive": "#000000",
        "metalness": 0,
        "roughness": 0.6,
        "opacity": 1,
        "doubleSide": False,
    }
    box = {
        "id": "n_box1",
        "name": "Box",
        "kind": "mesh",
        "parent": None,
        "visible": True,
        "transform": {"t": [0, 0.5, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
        "primitive": {"type": "box", "width": 1, "height": 1, "depth": 1},
        "materialId": "m_default",
    }
    group = {
        "id": "n_group1",
        "name": "Group",
        "kind": "group",
        "parent": None,
        "visible": True,
        "transform": {"t": [0, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
    }
    # AddMenu: set_material first (scene has no material yet), then add_node.
    patch([{"op": "set_material", "material": material}, {"op": "add_node", "node": box}])
    patch([{"op": "add_node", "node": group}])
    # Gizmo release: top-level transform.
    patch([{"op": "update_node", "id": "n_box1",
             "transform": {"t": [1.5, 0.5, 0], "r": [0, 45, 0], "s": [1, 2, 1]}}])
    # Inspector fields, visibility, rename, reparent (with transform).
    # Inspector.tsx:507 sends the type with the one changed param; a
    # same-type edit merges, so the other params survive.
    edited = patch([{"op": "update_node", "id": "n_box1",
                     "primitive": {"type": "box", "width": 2}}])
    prim = [n for n in edited["nodes"] if n["id"] == "n_box1"][0]["primitive"]
    assert prim["width"] == 2 and prim["height"] == 1 and prim["depth"] == 1
    patch([{"op": "update_node", "id": "n_box1", "visible": False}])
    patch([{"op": "update_node", "id": "n_box1", "name": "Crate"}])
    patch([{"op": "update_node", "id": "n_box1", "parent": "n_group1",
             "transform": {"t": [1.5, 0.5, 0], "r": [0, 45, 0], "s": [1, 2, 1]}}])
    # Inspector colour: set_material with assignTo.
    patch([{"op": "set_material",
             "material": dict(material, id="m_red", color="#ff0000"),
             "assignTo": ["n_box1"]}])
    # Duplicate, then delete the copy.
    before = {n["id"] for n in patch([{"op": "duplicate_node", "id": "n_box1"}])["nodes"]}
    copy_ids = sorted(before - {"n_box1", "n_group1", "light_key", "cam_main"})
    assert copy_ids, before
    patch([{"op": "delete_node", "id": copy_ids[0]}])
    # Undo / redo, one op each (api.undoScene / redoScene).
    patch([{"op": "undo"}])
    after_redo = patch([{"op": "redo"}])
    assert copy_ids[0] not in {n["id"] for n in after_redo["nodes"]}
    # Sample snowman: one build op with nodes + materials.
    patch([{"op": "build", "nodes": [box], "materials": [material]}])


def test_delete_scene(api_client):
    env = _create(api_client, "Deletable")
    scene_id = env["scene"]["id"]
    response = api_client.delete("/api/plugins/plastis3d/scenes/%s?baseRevision=1" % scene_id)
    assert response.status_code == 200
    assert response.json() == {"ok": True, "deleted": scene_id}
    response = api_client.get("/api/plugins/plastis3d/scenes/%s?baseRevision=1" % scene_id)
    assert response.status_code == 404
    response = api_client.delete("/api/plugins/plastis3d/scenes/%s?baseRevision=1" % scene_id)
    assert response.status_code == 404
    assert response.json()["code"] == "SCENE_NOT_FOUND"


def test_export_body_landed_imports_landed(api_client):
    env = _create(api_client, "Pending")
    scene_id = env["scene"]["id"]
    # Export landed in PR6: the default rig has no meshes, so this is
    # EXPORT_EMPTY (400), not NOT_IMPLEMENTED — and it writes nothing.
    response = api_client.post("/api/plugins/plastis3d/scenes/%s/export" % scene_id)
    assert response.status_code == 400
    assert response.json()["code"] == "EXPORT_EMPTY"
    # With a mesh, the same route writes a GLB and returns its path.
    response = api_client.patch(
        "/api/plugins/plastis3d/scenes/%s" % scene_id,
        json={"baseRevision": 1, "ops": [{"op": "add_node", "node": BOX}]},
    )
    assert response.status_code == 200, response.text
    response = api_client.post("/api/plugins/plastis3d/scenes/%s/export" % scene_id)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["ok"] is True
    assert result["revision"] == 2
    assert result["filename"] == "Pending.glb"  # the scene's name, not its id and revision
    # Imports landed in PR7: a missing backend path is IMPORT_NOT_FOUND,
    # not NOT_IMPLEMENTED — and it writes nothing.
    response = api_client.post(
        "/api/plugins/plastis3d/scenes/%s/imports" % scene_id,
        json={"backendPath": str(Path(tempfile.gettempdir()) / "plastis3d-missing-model.glb"), "baseRevision": 2},
    )
    assert response.status_code == 404
    assert response.json()["code"] == "IMPORT_NOT_FOUND"
    # Unknown scene still 404s before the export body is reached.
    response = api_client.post("/api/plugins/plastis3d/scenes/nope/export")
    assert response.status_code == 404
    response = api_client.post(
        "/api/plugins/plastis3d/scenes/nope/imports",
        json={"backendPath": str(Path(tempfile.gettempdir()) / "plastis3d-missing-model.glb"), "baseRevision": 1},
    )
    assert response.status_code == 404


def test_asset_route_hash_validation(api_client):
    response = api_client.get("/api/plugins/plastis3d/assets/not-a-sha")
    assert response.status_code == 400
    assert response.json()["code"] == "SPEC_INVALID"
    response = api_client.get("/api/plugins/plastis3d/assets/%s" % FAKE_SHA)
    assert response.status_code == 404
    assert response.json()["code"] == "ASSET_NOT_FOUND"


def test_import_upload_size_limit_413(api_client):
    env = _create(api_client, "Bigup")
    scene_id = env["scene"]["id"]
    # 17 MiB upload body: over the 16 MiB import upload cap.
    response = api_client.post(
        "/api/plugins/plastis3d/scenes/%s/imports" % scene_id,
        content=b"x" * (17 * 1024 * 1024),
        headers={"Content-Type": "application/octet-stream"},
    )
    assert response.status_code == 413
    assert response.json()["code"] == "IMPORT_TOO_LARGE"
    # A small non-JSON upload is not a size error either — the PR7
    # body requires a JSON object (400 SPEC_INVALID).
    response = api_client.post(
        "/api/plugins/plastis3d/scenes/%s/imports" % scene_id,
        content=b"x" * 1024,
        headers={"Content-Type": "application/octet-stream"},
    )
    assert response.status_code == 400
    assert response.json()["code"] == "SPEC_INVALID"


def test_profile_namespaces_do_not_leak(tmp_path, monkeypatch):
    """Two data dirs (two profiles) share no scenes and no global state.

    The namespaces are selected by PLASTIS3D_DATA_DIR here; in the host
    the same seam is the per-request Hermes home (see
    test_profile_home_seam below).
    """
    from plastis3d_scene.store import Store

    dir_a = tmp_path / "a"
    dir_b = tmp_path / "b"
    Store(dir_a).create_scene("Only in A")
    assert [s["id"] for s in Store(dir_b).list_scenes()] == []
    assert [s["id"] for s in Store(dir_a).list_scenes()] == ["only-in-a"]

    # The same split through HTTP: one client, the data dir swapped
    # between requests (the store resolves it per request, so two
    # profiles in one process cannot hold different env vars at once).
    api = _load_plugin_api_standalone()
    app = FastAPI()
    app.include_router(api.router, prefix="/api/plugins/plastis3d")
    with TestClient(app) as client:
        monkeypatch.setenv("PLASTIS3D_DATA_DIR", str(dir_a))
        assert [
            s["id"]
            for s in client.get("/api/plugins/plastis3d/scenes").json()["scenes"]
        ] == ["only-in-a"]
        monkeypatch.setenv("PLASTIS3D_DATA_DIR", str(dir_b))
        assert client.get("/api/plugins/plastis3d/scenes").json()["scenes"] == []


def test_profile_home_seam(tmp_path, monkeypatch):
    """``Store.resolve_data_dir`` honours the host's per-request
    HERMES_HOME contextvar (the seam
    ``_plugin_route_secret_scope`` sets before a plugin handler runs).

    Skipped where the Hermes install is not on sys.path — the seam is
    then unreachable and the store falls back to env/default, which
    the other tests cover.
    """
    hermes_root = Path.home() / ".hermes" / "hermes-agent"
    constants = hermes_root / "hermes_constants.py"
    if not constants.is_file():
        pytest.skip("no Hermes install to read the profile seam from")
    # The module fixture sets PLASTIS3D_DATA_DIR, which outranks the
    # host home; drop it for this test so the seam is what resolves.
    monkeypatch.delenv("PLASTIS3D_DATA_DIR", raising=False)
    monkeypatch.delenv("HERMES_HOME", raising=False)
    sys.path.insert(0, str(hermes_root))
    try:
        from hermes_constants import reset_hermes_home_override, set_hermes_home_override
        from plastis3d_scene.store import Store, resolve_data_dir

        home_a = tmp_path / "home-a"
        token = set_hermes_home_override(str(home_a))
        try:
            assert resolve_data_dir() == home_a / "plugin-data" / "plastis3d"
            assert Store().data_dir == home_a / "plugin-data" / "plastis3d"
        finally:
            reset_hermes_home_override(token)
    finally:
        sys.path.remove(str(hermes_root))


def test_delete_requires_current_revision_and_recreation_advances(api_client):
    env = _create(api_client, "Delete floor")
    scene_id = env["scene"]["id"]
    path = "/api/plugins/plastis3d/scenes/" + scene_id
    assert api_client.delete(path).status_code == 409
    assert api_client.delete(path + "?baseRevision=2").status_code == 409
    assert api_client.get(path).status_code == 200
    assert api_client.delete(path + "?baseRevision=1").status_code == 200
    replacement = _create(api_client, "Delete floor")
    assert replacement["scene"]["id"] == scene_id
    assert replacement["scene"]["revision"] == 2
    assert api_client.patch(path, json={"baseRevision": 1, "ops": [{"op": "delete_node", "id": "cam_main"}]}).status_code == 409


def test_scene_rename_patch_validation_history_and_conflict(api_client):
    created = _create(api_client, "Rename route")
    path = "/api/plugins/plastis3d/scenes/" + created["scene"]["id"]
    revision = created["scene"]["revision"]
    invalid = api_client.patch(path, json={"baseRevision": revision, "ops": [{"op": "set_scene_name", "name": " "}]})
    assert invalid.status_code == 400
    assert api_client.get(path).json()["scene"]["revision"] == revision
    renamed = api_client.patch(path, json={"baseRevision": revision, "ops": [{"op": "set_scene_name", "name": "Renamed route"}]})
    assert renamed.status_code == 200
    assert api_client.patch(path, json={"baseRevision": revision, "ops": [{"op": "set_scene_name", "name": "Stale"}]}).status_code == 409
    assert api_client.patch(path, json={"baseRevision": revision + 1, "ops": [{"op": "undo"}]}).status_code == 200
    assert any(row["name"] == "Rename route" for row in api_client.get("/api/plugins/plastis3d/scenes").json()["scenes"])
