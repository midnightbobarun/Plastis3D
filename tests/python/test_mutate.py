"""PR3 mutation-core tests (Tier 1, stage-2 §5).

Covers ``plastis3d_scene.mutate.apply`` / ``apply_patch``: every op,
``baseRevision`` enforcement, history maps with null for absent ids,
last-camera re-add in one entry, referenced-material delete refusal,
part/model duplicate + delete behaviour, undo/redo round-trips, the
two-process lock test (holder alive 45 s), the dead-pid steal, and the
100-increment revision test.

Run: pytest tests/python
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from plastis3d_scene import mutate
from plastis3d_scene.spec import PlastisError
from plastis3d_scene.store import Store

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
HOLDER = Path(__file__).resolve().parent / "_lock_holder.py"

BOX = {
    "name": "Box",
    "kind": "mesh",
    "transform": {"t": [0, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
    "primitive": {"type": "box"},
    "materialId": "m_default",
}
FAKE_SHA = "a" * 64


@pytest.fixture()
def data_dir(tmp_path, monkeypatch):
    """Isolated store; PLASTIS3D_DATA_DIR wins over any host home."""
    path = tmp_path / "data"
    monkeypatch.setenv("PLASTIS3D_DATA_DIR", str(path))
    return path


@pytest.fixture()
def store(data_dir):
    return Store(data_dir)


def _create(store, name="Test"):
    return mutate.apply(None, None, {"op": "create", "name": name}, store=store)


def _add_box(store, scene_id, revision, name="Box"):
    node = dict(BOX)
    node["name"] = name
    env = mutate.apply(
        scene_id, revision, {"op": "add_node", "node": node}, store=store
    )
    added = [n for n in env["nodes"] if n["name"] == name][0]
    return env, added["id"]


def _node(env, node_id):
    return [n for n in env["nodes"] if n["id"] == node_id][0]


# --- create / add / update / revision -----------------------------------------

def test_create_add_update_revision_flow(store):
    env = _create(store, "Flow")
    assert env["ok"] is True
    assert env["scene"] == {"id": "flow", "revision": 1, "schema": 3, "units": "m", "upAxis": "Y"}
    assert env["feedback"]["defaultsAdded"] == ["light_key", "cam_main"]
    assert env["feedback"]["canUndo"] is False
    assert [n["id"] for n in env["nodes"]] == ["light_key", "cam_main"]

    env, box_id = _add_box(store, "flow", 1)
    assert env["scene"]["revision"] == 2
    assert env["feedback"]["canUndo"] is True
    assert env["feedback"]["canRedo"] is False
    assert env["stats"]["nodes"] == 3
    assert env["stats"]["tris"] == 12  # one box; rig nodes add none

    env = mutate.apply(
        "flow",
        2,
        {
            "op": "update_node",
            "id": box_id,
            "transform": {"t": [1, 2, 3], "r": [0, 0, 0], "s": [2, 2, 2]},
        },
        store=store,
    )
    assert env["scene"]["revision"] == 3
    assert _node(env, box_id)["transform"]["t"] == [1, 2, 3]


def test_revision_conflict_no_write_no_retry(store):
    _create(store, "Flow")
    _add_box(store, "flow", 1)
    with pytest.raises(PlastisError) as excinfo:
        mutate.apply(
            "flow", 1, {"op": "add_node", "node": dict(BOX)}, store=store
        )
    assert excinfo.value.code == "REVISION_CONFLICT"
    assert excinfo.value.current_revision == 2
    assert store.get_scene("flow")["revision"] == 2


def test_base_revision_required(store):
    _create(store, "Flow")
    with pytest.raises(PlastisError) as excinfo:
        mutate.apply("flow", None, {"op": "add_node", "node": dict(BOX)}, store=store)
    assert excinfo.value.code == "SPEC_INVALID"


def test_unknown_scene_and_node(store):
    with pytest.raises(PlastisError) as excinfo:
        mutate.apply("nope", 1, {"op": "add_node", "node": dict(BOX)}, store=store)
    assert excinfo.value.code == "SCENE_NOT_FOUND"
    _create(store, "Flow")
    with pytest.raises(PlastisError) as excinfo:
        mutate.apply("flow", 1, {"op": "delete_node", "id": "n_missing"}, store=store)
    assert excinfo.value.code == "NODE_NOT_FOUND"


def test_update_node_cannot_change_kind(store):
    env = _create(store, "Flow")
    env, box_id = _add_box(store, "flow", 1)
    with pytest.raises(PlastisError) as excinfo:
        mutate.apply(
            "flow", 2, {"op": "update_node", "id": box_id, "kind": "group"}, store=store
        )
    assert excinfo.value.code == "SPEC_INVALID"


# --- build --------------------------------------------------------------------

def test_build_replaces_readds_rig_keeps_assets(store):
    env = _create(store, "Flow")
    env, box_id = _add_box(store, "flow", 1)
    # Attach a fake asset row via import_asset so build must keep it.
    asset = {
        "id": "a_model",
        "sha256": FAKE_SHA,
        "file": "assets/%s.glb" % FAKE_SHA,
        "format": "glb",
        "bytes": 1234,
        "originalName": "model.glb",
        "sourceFormat": "glb",
        "stats": {"tris": 100, "verts": 50},
    }
    env = mutate.apply(
        "flow",
        2,
        {
            "op": "import_asset",
            "asset": asset,
            "nodes": [
                {
                    "id": "n_model",
                    "name": "Model",
                    "kind": "model",
                    "transform": {"t": [0, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
                    "modelAssetId": "a_model",
                }
            ],
        },
        store=store,
    )
    assert env["scene"]["revision"] == 3
    env = mutate.apply(
        "flow",
        3,
        {
            "op": "build",
            "nodes": [
                {
                    "id": "n_sphere",
                    "name": "Sphere",
                    "kind": "mesh",
                    "transform": {"t": [0, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
                    "primitive": {"type": "sphere"},
                    "materialId": "m_default",
                }
            ],
            "materials": [
                {
                    "id": "m_default",
                    "color": "#c8ccd0",
                    "emissive": "#000000",
                    "metalness": 0,
                    "roughness": 0.6,
                    "opacity": 1,
                    "doubleSide": False,
                }
            ],
        },
        store=store,
    )
    assert env["scene"]["revision"] == 4
    assert env["feedback"]["defaultsAdded"] == []
    assert [a["id"] for a in env["assets"]] == ["a_model"]  # kept
    assert [n["id"] for n in env["nodes"]] == ["n_sphere"]
    # Undo of build restores the old node/material set exactly.
    scene = store.get_scene("flow")
    entry = scene["history"]["undo"][-1]
    assert entry["undo"]["nodes"]["n_sphere"] is None
    assert entry["undo"]["nodes"]["n_model"]["kind"] == "model"
    assert entry["undo"]["nodes"][box_id]["name"] == "Box"
    assert "assets" not in entry["undo"]  # build never puts assets in maps


def test_build_rejects_model_and_part_kinds(store):
    _create(store, "Flow")
    node = {
        "id": "n_model",
        "name": "Model",
        "kind": "model",
        "transform": {"t": [0, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
        "modelAssetId": "a_model",
    }
    with pytest.raises(PlastisError) as excinfo:
        mutate.apply("flow", 1, {"op": "build", "nodes": [node]}, store=store)
    assert excinfo.value.code == "SPEC_INVALID"


# --- set_material / delete_material --------------------------------------------

def test_set_material_upsert_assign_and_part_override(store):
    env = _create(store, "Flow")
    env, box_id = _add_box(store, "flow", 1)
    env = mutate.apply(
        "flow",
        2,
        {
            "op": "set_material",
            "material": {"id": "m_red", "color": "#ff0000"},
            "assignTo": [box_id],
        },
        store=store,
    )
    assert env["scene"]["revision"] == 3
    assert _node(env, box_id)["materialId"] == "m_red"
    material = [m for m in env["materials"] if m["id"] == "m_red"][0]
    assert material["color"] == "#ff0000"
    assert material["roughness"] == 0.6  # server default filled in
    # Update the same material in place (merge, no duplicate row).
    env = mutate.apply(
        "flow",
        3,
        {"op": "set_material", "material": {"id": "m_red", "roughness": 0.1}},
        store=store,
    )
    materials = [m for m in env["materials"] if m["id"] == "m_red"]
    assert len(materials) == 1
    assert materials[0]["roughness"] == 0.1
    assert materials[0]["color"] == "#ff0000"


def test_set_material_on_model_is_node_locked(store):
    env = _create(store, "Flow")
    asset = {
        "id": "a_model",
        "sha256": FAKE_SHA,
        "file": "assets/%s.glb" % FAKE_SHA,
        "format": "glb",
        "bytes": 10,
        "originalName": "m.glb",
        "sourceFormat": "glb",
        "stats": {},
    }
    mutate.apply(
        "flow",
        1,
        {
            "op": "import_asset",
            "asset": asset,
            "nodes": [
                {
                    "id": "n_model",
                    "name": "Model",
                    "kind": "model",
                    "transform": {"t": [0, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
                    "modelAssetId": "a_model",
                }
            ],
        },
        store=store,
    )
    with pytest.raises(PlastisError) as excinfo:
        mutate.apply(
            "flow",
            2,
            {
                "op": "set_material",
                "material": {"id": "m_red", "color": "#ff0000"},
                "assignTo": ["n_model"],
            },
            store=store,
        )
    assert excinfo.value.code == "NODE_LOCKED"
    assert "MODEL_MATERIAL_OPAQUE" in str(excinfo.value)
    assert store.get_scene("flow")["revision"] == 2  # nothing written


def test_referenced_material_delete_refused(store):
    env = _create(store, "Flow")
    env, box_id = _add_box(store, "flow", 1)
    with pytest.raises(PlastisError) as excinfo:
        mutate.apply("flow", 2, {"op": "delete_material", "id": "m_default"}, store=store)
    assert excinfo.value.code == "SPEC_INVALID"
    assert excinfo.value.path == "/materials/m_default"
    assert box_id in str(excinfo.value)
    assert store.get_scene("flow")["revision"] == 2
    # An unreferenced material deletes cleanly.
    mutate.apply(
        "flow",
        2,
        {"op": "set_material", "material": {"id": "m_spare", "color": "#00ff00"}},
        store=store,
    )
    env = mutate.apply("flow", 3, {"op": "delete_material", "id": "m_spare"}, store=store)
    assert env["scene"]["revision"] == 4
    assert [m["id"] for m in env["materials"]] == ["m_default"]


# --- duplicate / delete --------------------------------------------------------

def test_duplicate_node_subtree_shares_materials(store):
    env = _create(store, "Flow")
    env = mutate.apply(
        "flow",
        1,
        {
            "op": "add_node",
            "node": {
                "id": "n_group",
                "name": "Group",
                "kind": "group",
                "transform": {"t": [0, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
            },
        },
        store=store,
    )
    env, box_id = _add_box(store, "flow", 2)
    mutate.apply(
        "flow",
        3,
        {"op": "update_node", "id": box_id, "parent": "n_group"},
        store=store,
    )
    env = mutate.apply("flow", 4, {"op": "duplicate_node", "id": "n_group"}, store=store)
    assert env["scene"]["revision"] == 5
    copies = [n for n in env["nodes"] if n["name"] == "Group copy"]
    assert len(copies) == 1
    copy_group = copies[0]
    assert copy_group["id"] != "n_group"
    copy_box = [n for n in env["nodes"] if n["parent"] == copy_group["id"]]
    assert len(copy_box) == 1
    assert copy_box[0]["materialId"] == "m_default"  # shared, not copied
    assert copy_box[0]["transform"] == _node(env, box_id)["transform"]
    assert copy_box[0]["id"] != box_id


def test_duplicate_model_keeps_kind_and_asset(store):
    _create(store, "Flow")
    asset = {
        "id": "a_model",
        "sha256": FAKE_SHA,
        "file": "assets/%s.glb" % FAKE_SHA,
        "format": "glb",
        "bytes": 10,
        "originalName": "m.glb",
        "sourceFormat": "glb",
        "stats": {"tris": 7, "verts": 4},
    }
    mutate.apply(
        "flow",
        1,
        {
            "op": "import_asset",
            "asset": asset,
            "nodes": [
                {
                    "id": "n_model",
                    "name": "Model",
                    "kind": "model",
                    "transform": {"t": [1, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
                    "modelAssetId": "a_model",
                }
            ],
        },
        store=store,
    )
    env = mutate.apply("flow", 2, {"op": "duplicate_node", "id": "n_model"}, store=store)
    models = [n for n in env["nodes"] if n["kind"] == "model"]
    assert len(models) == 2
    assert models[1]["modelAssetId"] == "a_model"
    assert models[1]["transform"] == {"t": [1, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]}
    assert models[1]["id"] != "n_model"
    assert len(env["assets"]) == 1  # same sha256 bytes, no second row


def test_delete_last_camera_readds_in_one_entry(store):
    env = _create(store, "Flow")
    env = mutate.apply("flow", 1, {"op": "delete_node", "id": "cam_main"}, store=store)
    assert env["scene"]["revision"] == 2
    assert env["feedback"]["defaultsAdded"] == []
    assert not any(n["kind"] == "camera" for n in env["nodes"])
    scene = store.get_scene("flow")
    entry = scene["history"]["undo"][-1]
    # cam_main was deleted, so undo maps it to the OLD node (undo restores
    # it) and redo maps it to the re-added default node.
    assert entry["undo"]["nodes"]["cam_main"]["camera"]["fov"] == 40.0
    assert entry["redo"]["nodes"]["cam_main"] is None
    # Undo brings the deleted camera back; redo re-applies the delete.
    env = mutate.apply("flow", 2, {"op": "undo"}, store=store)
    assert env["scene"]["revision"] == 3
    assert _node(env, "cam_main")["transform"]["t"] == [4, 3, 6]
    env = mutate.apply("flow", 3, {"op": "redo"}, store=store)
    assert env["scene"]["revision"] == 4
    assert not any(n["kind"] == "camera" for n in env["nodes"])


def test_delete_subtree_keeps_asset_row(store):
    _create(store, "Flow")
    asset = {
        "id": "a_model",
        "sha256": FAKE_SHA,
        "file": "assets/%s.glb" % FAKE_SHA,
        "format": "glb",
        "bytes": 10,
        "originalName": "m.glb",
        "sourceFormat": "glb",
        "stats": {},
    }
    mutate.apply(
        "flow",
        1,
        {
            "op": "import_asset",
            "asset": asset,
            "nodes": [
                {
                    "id": "n_model",
                    "name": "Model",
                    "kind": "model",
                    "transform": {"t": [0, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
                    "modelAssetId": "a_model",
                }
            ],
        },
        store=store,
    )
    env = mutate.apply("flow", 2, {"op": "delete_node", "id": "n_model"}, store=store)
    assert [n["id"] for n in env["nodes"]] == ["light_key", "cam_main"]
    assert [a["id"] for a in env["assets"]] == ["a_model"]


# --- parts ---------------------------------------------------------------------

def _attach_part_scene(store):
    """A scene with one asset row, one model node, and one part node."""
    _create(store, "Flow")
    asset = {
        "id": "a_model",
        "sha256": FAKE_SHA,
        "file": "assets/%s.glb" % FAKE_SHA,
        "format": "glb",
        "bytes": 10,
        "originalName": "m.glb",
        "sourceFormat": "glb",
        "stats": {
            "tris": 12,
            "verts": 8,
            "parts": [
                {
                    "meshIndex": 0,
                    "primitiveIndex": 0,
                    "tris": 12,
                    "verts": 8,
                    "bounds": {"min": [0, 0, 0], "max": [1, 1, 1]},
                }
            ],
        },
    }
    mutate.apply(
        "flow",
        1,
        {
            "op": "import_asset",
            "asset": asset,
            "nodes": [
                {
                    "id": "n_model",
                    "name": "Model",
                    "kind": "model",
                    "transform": {"t": [0, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
                    "modelAssetId": "a_model",
                }
            ],
        },
        store=store,
    )
    # Part nodes enter through import in PR7; here the test writes one
    # directly with the store so the mutation core can be exercised.
    scene = store.get_scene("flow")
    scene["nodes"].append(
        {
            "id": "n_part",
            "name": "Part 0",
            "parent": "n_model",
            "kind": "part",
            "transform": {"t": [0, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
            "visible": True,
            "modelAssetId": "a_model",
            "meshIndex": 0,
            "primitiveIndex": 0,
        }
    )
    store.write_scene("flow", scene, 2, None)
    return store.get_scene("flow")


def test_part_duplicate_delete_and_material_override(store):
    scene = _attach_part_scene(store)
    assert scene["revision"] == 3
    # Duplicate the part: same asset/indexes, own transform and id.
    env = mutate.apply("flow", 3, {"op": "duplicate_node", "id": "n_part"}, store=store)
    parts = [n for n in env["nodes"] if n["kind"] == "part"]
    assert len(parts) == 2
    assert parts[1]["modelAssetId"] == "a_model"
    assert parts[1]["meshIndex"] == 0 and parts[1]["primitiveIndex"] == 0
    assert parts[1]["id"] != "n_part"
    # Material override on the part via assignTo.
    env = mutate.apply(
        "flow",
        4,
        {
            "op": "set_material",
            "material": {"id": "m_blue", "color": "#0000ff"},
            "assignTo": ["n_part"],
        },
        store=store,
    )
    assert _node(env, "n_part")["materialId"] == "m_blue"
    # Update the part's transform like any other node.
    env = mutate.apply(
        "flow",
        5,
        {
            "op": "update_node",
            "id": "n_part",
            "transform": {"t": [0, 1, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
        },
        store=store,
    )
    assert _node(env, "n_part")["transform"]["t"] == [0, 1, 0]
    # Delete the part: just that part goes; the asset row stays.
    env = mutate.apply("flow", 6, {"op": "delete_node", "id": "n_part"}, store=store)
    assert [n["id"] for n in env["nodes"] if n["kind"] == "part"] != ["n_part"]
    assert "n_part" not in {n["id"] for n in env["nodes"]}
    assert [a["id"] for a in env["assets"]] == ["a_model"]


# --- undo / redo ---------------------------------------------------------------

def test_undo_redo_round_trip_and_history_empty(store):
    _create(store, "Flow")
    env, box_id = _add_box(store, "flow", 1)
    env = mutate.apply(
        "flow", 2, {"op": "update_node", "id": box_id, "name": "Renamed"}, store=store
    )
    assert _node(env, box_id)["name"] == "Renamed"
    env = mutate.apply("flow", 3, {"op": "undo"}, store=store)
    assert env["scene"]["revision"] == 4
    assert _node(env, box_id)["name"] == "Box"
    assert env["feedback"]["canUndo"] is True  # the add is still undoable
    assert env["feedback"]["canRedo"] is True
    env = mutate.apply("flow", 4, {"op": "undo"}, store=store)
    assert env["scene"]["revision"] == 5
    assert box_id not in {n["id"] for n in env["nodes"]}
    env = mutate.apply("flow", 5, {"op": "redo"}, store=store)
    assert box_id in {n["id"] for n in env["nodes"]}
    env = mutate.apply("flow", 6, {"op": "redo"}, store=store)
    assert _node(env, box_id)["name"] == "Renamed"
    assert env["feedback"]["canRedo"] is False
    # A new mutation after undo clears the redo stack.
    env = mutate.apply("flow", 7, {"op": "undo"}, store=store)
    env = mutate.apply("flow", 8, {"op": "undo"}, store=store)
    assert env["feedback"]["canRedo"] is True
    env, _ = _add_box(store, "flow", 9, name="Second")
    assert env["feedback"]["canRedo"] is False
    with pytest.raises(PlastisError) as excinfo:
        mutate.apply("flow", env["scene"]["revision"], {"op": "redo"}, store=store)
    assert excinfo.value.code == "HISTORY_EMPTY"
    # Undo past the beginning is HISTORY_EMPTY too.
    scene = store.get_scene("flow")
    for _ in range(len(scene["history"]["undo"])):
        scene = store.get_scene("flow")
        mutate.apply("flow", scene["revision"], {"op": "undo"}, store=store)
    scene = store.get_scene("flow")
    with pytest.raises(PlastisError) as excinfo:
        mutate.apply("flow", scene["revision"], {"op": "undo"}, store=store)
    assert excinfo.value.code == "HISTORY_EMPTY"


def test_undo_add_node_history_maps_use_null(store):
    _create(store, "Flow")
    _add_box(store, "flow", 1)
    scene = store.get_scene("flow")
    entry = scene["history"]["undo"][-1]
    box_id = [n["id"] for n in scene["nodes"] if n["name"] == "Box"][0]
    assert entry["undo"]["nodes"][box_id] is None  # absent before the add
    assert entry["redo"]["nodes"][box_id]["name"] == "Box"


# --- PATCH ---------------------------------------------------------------------

def test_patch_batch_is_one_entry_one_revision(store):
    _create(store, "Flow")
    env = mutate.apply_patch(
        "flow",
        1,
        [
            {"op": "add_node", "node": dict(BOX, name="A")},
            {"op": "add_node", "node": dict(BOX, name="B")},
            {"op": "set_material", "material": {"id": "m_red", "color": "#ff0000"}},
        ],
        store=store,
    )
    assert env["scene"]["revision"] == 2  # one bump for three ops
    assert env["stats"]["nodes"] == 4  # rig (2) + two boxes
    scene = store.get_scene("flow")
    assert len(scene["history"]["undo"]) == 1
    assert scene["history"]["undo"][0]["label"] == "patch (3 ops)"
    # Undoing the patch removes both boxes and the material at once.
    env = mutate.apply("flow", 2, {"op": "undo"}, store=store)
    assert [n["name"] for n in env["nodes"]] == ["Key light", "Main camera"]
    assert [m["id"] for m in env["materials"]] == ["m_default"]


def test_patch_rejects_too_many_ops_and_undo(store):
    _create(store, "Flow")
    ops = [{"op": "add_node", "node": dict(BOX, name="N%d" % i)} for i in range(33)]
    with pytest.raises(PlastisError) as excinfo:
        mutate.apply_patch("flow", 1, ops, store=store)
    assert excinfo.value.code == "SPEC_INVALID"
    # undo/redo mixed into a batch stays SPEC_INVALID (one batch = one
    # history entry); only a single-op undo/redo patch is accepted.
    with pytest.raises(PlastisError) as excinfo:
        mutate.apply_patch(
            "flow", 1, [{"op": "add_node", "node": dict(BOX)}, {"op": "undo"}], store=store
        )
    assert excinfo.value.code == "SPEC_INVALID"
    # A lone undo on an empty history is HISTORY_EMPTY, not SPEC_INVALID.
    with pytest.raises(PlastisError) as excinfo:
        mutate.apply_patch("flow", 1, [{"op": "undo"}], store=store)
    assert excinfo.value.code == "HISTORY_EMPTY"
    assert store.get_scene("flow")["revision"] == 1


def test_patch_single_undo_and_redo_pop_history(store):
    """A-4: the desktop sends undo/redo as a one-op PATCH. It must pop the
    history (not append an entry), bump the revision once, and redo must
    restore what undo removed."""
    _create(store, "Flow")
    env, box_id = _add_box(store, "flow", 1)
    assert env["scene"]["revision"] == 2
    undone = mutate.apply_patch("flow", 2, [{"op": "undo"}], store=store)
    assert undone["scene"]["revision"] == 3
    assert box_id not in {n["id"] for n in undone["nodes"]}
    assert undone["feedback"]["canRedo"] is True
    redone = mutate.apply_patch("flow", 3, [{"op": "redo"}], store=store)
    assert redone["scene"]["revision"] == 4
    assert box_id in {n["id"] for n in redone["nodes"]}
    assert redone["feedback"]["canRedo"] is False
    # A stale base revision is still a conflict.
    with pytest.raises(PlastisError) as excinfo:
        mutate.apply_patch("flow", 2, [{"op": "undo"}], store=store)
    assert excinfo.value.code == "REVISION_CONFLICT"


# --- revision scale + two-process lock ------------------------------------------

def test_100_increment_revision(store):
    _create(store, "Flow")
    revision = 1
    for i in range(100):
        env = mutate.apply(
            "flow",
            revision,
            {"op": "add_node", "node": dict(BOX, name="Box %d" % i)},
            store=store,
        )
        revision = env["scene"]["revision"]
    assert revision == 101
    scene = store.get_scene("flow")
    assert scene["revision"] == 101
    assert len(scene["nodes"]) == 102  # rig + 100 boxes
    assert len(scene["history"]["undo"]) == 50  # ring buffer cap


def test_two_process_lock_holder_alive_45s(store, tmp_path):
    """Design's lock test: holder alive 45 s; a second process gets
    STORE_BUSY inside 2 s and the scene file is unchanged."""
    _create(store, "Flow")
    before = (store.scene_path("flow")).read_bytes()
    holder = subprocess.Popen(
        [
            sys.executable,
            str(HOLDER),
            str(REPO_ROOT),
            str(store.data_dir),
            "flow",
            "--hold",
            "45",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        assert holder.stdout.readline().startswith("holding ")
        started = time.monotonic()
        with pytest.raises(PlastisError) as excinfo:
            mutate.apply(
                "flow", 1, {"op": "add_node", "node": dict(BOX)}, store=store
            )
        elapsed = time.monotonic() - started
        assert excinfo.value.code == "STORE_BUSY"
        assert elapsed < 10, "STORE_BUSY took %.1fs (lock wait is 2 s)" % elapsed
        assert elapsed >= 1.5, "STORE_BUSY returned too fast (%.1fs)" % elapsed
        assert (store.scene_path("flow")).read_bytes() == before
        assert store.get_scene("flow")["revision"] == 1
    finally:
        holder.terminate()
        try:
            holder.wait(timeout=10)
        except subprocess.TimeoutExpired:
            holder.kill()
            holder.wait(timeout=10)


def test_dead_pid_lock_is_stolen(store):
    """A lockfile whose pid is dead must not wedge the scene."""
    _create(store, "Flow")
    dead_pid = 999999  # no such process on this machine
    store.lock_path("flow").write_text(
        json.dumps({"pid": dead_pid, "monotonic": 0.0}), encoding="utf-8"
    )
    env, _ = _add_box(store, "flow", 1)
    assert env["scene"]["revision"] == 2
    assert store.lock_path("flow").exists()


def test_reserved_fields_rejected_only_on_mutation(store):
    from plastis3d_scene.spec import PlastisError
    _create(store, "Flow")
    with pytest.raises(PlastisError) as error:
        mutate.apply("flow", 1, {"op": "set_material", "material": {"id": "m_default", "baseColorMap": "missing"}}, store=store)
    assert error.value.code == "SPEC_INVALID" and "baseColorMap" in str(error.value)
    with pytest.raises(PlastisError) as error:
        mutate.apply("flow", 1, {"op": "update_node", "id": "cam_main", "clips": [{"name": "clip"}]}, store=store)
    assert error.value.code == "SPEC_INVALID" and "clips" in str(error.value)
    assert store.get_scene("flow")["revision"] == 1


def test_import_asset_requires_nodes_list(store):
    """The PR3 single-``"node"`` shape is gone (R-20): ``nodes`` is required."""
    store.create_scene("Legacy", scene_id="legacy")
    sha = "cd" * 32
    with pytest.raises(PlastisError) as info:
        mutate.apply(
            "legacy",
            1,
            {
                "op": "import_asset",
                "asset": {
                    "id": "a_model",
                    "sha256": sha,
                    "file": "assets/%s.glb" % sha,
                    "format": "glb",
                    "bytes": 10,
                    "stats": {},
                },
                "node": {
                    "id": "n_model",
                    "name": "Model",
                    "kind": "model",
                    "transform": {"t": [0, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
                    "modelAssetId": "a_model",
                },
            },
            store=store,
        )
    assert info.value.code == "SPEC_INVALID"
    assert info.value.path == "/nodes"
    assert store.get_scene("legacy")["revision"] == 1


def test_scene_rename_history_and_origins(store, monkeypatch):
    events = []
    monkeypatch.setattr(mutate, "broadcast", lambda event, payload: events.append(payload))
    env = _create(store)
    sid = env["scene"]["id"]
    mutate.apply(sid, 1, {"op": "set_scene_name", "name": "Renamed"}, store=store, origin="tool")
    assert store.get_scene(sid)["name"] == "Renamed"
    assert events[-1]["origin"] == "tool"
    mutate.apply(sid, 2, {"op": "undo"}, store=store)
    assert store.get_scene(sid)["name"] == "Test"
    mutate.apply(sid, 3, {"op": "redo"}, store=store)
    assert store.get_scene(sid)["name"] == "Renamed"
    assert events[-1]["origin"] == "ui"
    with pytest.raises(PlastisError):
        mutate.apply(sid, 4, {"op": "set_scene_name", "name": " "}, store=store)
    assert store.get_scene(sid)["revision"] == 4
    mutate.apply_patch(sid, 4, [{"op": "set_scene_name", "name": "Patched"}], store=store)
    mutate.apply(sid, 5, {"op": "undo"}, store=store)
    assert store.get_scene(sid)["name"] == "Renamed"
