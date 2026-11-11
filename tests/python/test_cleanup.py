"""PR18 tests (Tier 1): cleanup, prune and dedupe.

Each operation, their order, one history entry and a clean undo/redo, the
preview that writes nothing, what is never touched (``m_default``, models,
parts, mesh data, assets), the tool and the route.
"""

import copy
import struct

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from plastis3d_scene import cleanup, tools
from plastis3d_scene.spec import PlastisError
from plastis3d_scene.store import Store

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


def _scene():
    return tools.new_scene(name="Tidy")["scene"]["id"]


def _material(scene_id, rev, material_id, color="#ff0000", **extra):
    return tools.set_material(scene=scene_id, baseRevision=rev, id=material_id, color=color, **extra)["scene"]["revision"]


def _box(scene_id, rev, name, material_id="m_default", parent=None):
    env = tools.add_node(scene=scene_id, baseRevision=rev, kind="mesh", name=name, primitive={"type": "box"},
                         materialId=material_id, transform=T, parent=parent)
    return env["scene"]["revision"], next(n["id"] for n in env["nodes"] if n["name"] == name)


def _group(scene_id, rev, name, parent=None):
    env = tools.add_node(scene=scene_id, baseRevision=rev, kind="group", name=name, transform=T, parent=parent)
    return env["scene"]["revision"], next(n["id"] for n in env["nodes"] if n["name"] == name)


def _materials(scene):
    return [m["id"] for m in scene["materials"]]


# --- prune_materials ------------------------------------------------------------------------------


def test_prune_removes_unused_materials_and_keeps_used_ones_and_the_default():
    scene_id = _scene()
    rev = _material(scene_id, 1, "m_used", "#00ff00")
    rev = _material(scene_id, rev, "m_idle", "#0000ff")
    rev, _ = _box(scene_id, rev, "Crate", "m_used")
    result = tools.cleanup(scene=scene_id, baseRevision=rev, operations=["prune_materials"])
    assert result["cleanup"]["changes"]["materialsRemoved"] == ["m_idle"] and result["cleanup"]["applied"] is True
    assert _materials(result) == ["m_default", "m_used"]
    assert result["scene"]["revision"] == rev + 1


def test_the_default_material_is_never_pruned_even_when_nothing_uses_it():
    scene_id = _scene()
    result = tools.cleanup(scene=scene_id, baseRevision=1, operations=["prune_materials"])
    assert result["cleanup"]["applied"] is False and "m_default" in _materials(result)


def test_a_material_used_only_by_a_part_override_is_kept(store, tmp_path):
    scene_id = _scene()
    obj = tmp_path / "q.obj"
    obj.write_text("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n")
    env = tools.import_model(scene=scene_id, baseRevision=1, path=str(obj))
    part = next(n for n in env["nodes"] if n["kind"] == "part")
    env = tools.set_material(scene=scene_id, baseRevision=env["scene"]["revision"], id="m_skin", color="#123456", assignTo=[part["id"]])
    rev = _material(scene_id, env["scene"]["revision"], "m_idle", "#abcdef")
    result = tools.cleanup(scene=scene_id, baseRevision=rev)
    assert "m_skin" in _materials(result) and "m_idle" not in _materials(result)


# --- dedupe_materials ----------------------------------------------------------------------------


def test_dedupe_merges_identical_materials_and_repoints_nodes():
    scene_id = _scene()
    rev = _material(scene_id, 1, "m_a", "#ff0000", roughness=0.3)
    rev = _material(scene_id, rev, "m_b", "#ff0000", roughness=0.3)
    rev = _material(scene_id, rev, "m_c", "#ff0000", roughness=0.9)  # differs: stays
    rev, first = _box(scene_id, rev, "One", "m_a")
    rev, second = _box(scene_id, rev, "Two", "m_b")
    rev, third = _box(scene_id, rev, "Three", "m_c")
    result = tools.cleanup(scene=scene_id, baseRevision=rev, operations=["dedupe_materials"])
    changes = result["cleanup"]["changes"]
    assert changes["materialsMerged"] == [{"from": "m_b", "into": "m_a"}]
    assert changes["nodesRepointed"] == [second]
    by_id = {n["id"]: n for n in result["nodes"]}
    assert (by_id[first]["materialId"], by_id[second]["materialId"], by_id[third]["materialId"]) == ("m_a", "m_a", "m_c")
    assert "m_b" not in _materials(result)


def test_the_default_material_is_the_keeper_when_it_is_among_the_duplicates():
    scene_id = _scene()
    default = next(m for m in tools.get_scene(scene=scene_id)["materials"] if m["id"] == "m_default")
    rev = 1
    rev = tools.set_material(scene=scene_id, baseRevision=rev, id="m_twin", color=default["color"],
                             roughness=default["roughness"], metalness=default["metalness"])["scene"]["revision"]
    rev, node = _box(scene_id, rev, "Twin user", "m_twin")
    result = tools.cleanup(scene=scene_id, baseRevision=rev, operations=["dedupe_materials"])
    assert result["cleanup"]["changes"]["materialsMerged"] == [{"from": "m_twin", "into": "m_default"}]
    assert next(n for n in result["nodes"] if n["id"] == node)["materialId"] == "m_default"


def test_materials_with_different_names_are_different_materials():
    scene_id = _scene()
    rev = _material(scene_id, 1, "m_a", "#ff0000", name="Brick")
    rev = _material(scene_id, rev, "m_b", "#ff0000", name="Crimson")
    rev, _ = _box(scene_id, rev, "A", "m_a")
    rev, _ = _box(scene_id, rev, "B", "m_b")
    result = tools.cleanup(scene=scene_id, baseRevision=rev, operations=["dedupe_materials"])
    assert result["cleanup"]["applied"] is False and {"m_a", "m_b"} <= set(_materials(result))


def test_a_texture_map_is_part_of_a_materials_identity(store, tmp_path):
    from plastis3d_scene import images
    from test_textures import _png

    scene_id = _scene()
    rev = _material(scene_id, 1, "m_a", "#ffffff")
    rev = _material(scene_id, rev, "m_b", "#ffffff")
    rev, _ = _box(scene_id, rev, "A", "m_a")
    rev, _ = _box(scene_id, rev, "B", "m_b")
    path = tmp_path / "t.png"
    path.write_bytes(_png())
    rev = images.import_image_path(scene_id, store, str(path), base_revision=rev, material_id="m_a", slot="baseColorMap")["scene"]["revision"]
    assert tools.cleanup(scene=scene_id, baseRevision=rev, operations=["dedupe_materials"])["cleanup"]["applied"] is False
    rev = images.import_image_path(scene_id, store, str(path), base_revision=rev, material_id="m_b", slot="baseColorMap")["scene"]["revision"]
    merged = tools.cleanup(scene=scene_id, baseRevision=rev, operations=["dedupe_materials"])
    assert merged["cleanup"]["changes"]["materialsMerged"] == [{"from": "m_b", "into": "m_a"}]
    assert len(merged["assets"]) == 1  # the image asset is left alone


# --- prune_groups ----------------------------------------------------------------------------------


def test_prune_groups_removes_empty_groups_repeatedly_and_keeps_any_with_content():
    scene_id = _scene()
    rev, outer = _group(scene_id, 1, "Outer")
    rev, inner = _group(scene_id, rev, "Inner", parent=outer)  # only holds an empty group
    rev, _ = _group(scene_id, rev, "Loose")
    rev, full = _group(scene_id, rev, "Full")
    rev, _ = _box(scene_id, rev, "Inside", parent=full)
    result = tools.cleanup(scene=scene_id, baseRevision=rev, operations=["prune_groups"])
    removed = {g["name"] for g in result["cleanup"]["changes"]["groupsRemoved"]}
    assert removed == {"Outer", "Inner", "Loose"}
    assert {n["name"] for n in result["nodes"] if n["kind"] == "group"} == {"Full"}


def test_a_group_holding_a_light_or_camera_stays():
    scene_id = _scene()
    rev, group = _group(scene_id, 1, "Rig")
    env = tools.add_node(scene=scene_id, baseRevision=rev, kind="light", name="Lamp", transform=T, parent=group,
                         light={"type": "point", "color": "#ffffff", "intensity": 1})
    result = tools.cleanup(scene=scene_id, baseRevision=env["scene"]["revision"], operations=["prune_groups"])
    assert result["cleanup"]["applied"] is False


def test_an_imported_models_groups_and_parts_are_untouched(store, tmp_path):
    scene_id = _scene()
    obj = tmp_path / "q.obj"
    obj.write_text("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n")
    env = tools.import_model(scene=scene_id, baseRevision=1, path=str(obj))
    before = [n for n in env["nodes"] if n["kind"] in ("group", "part")]
    result = tools.cleanup(scene=scene_id, baseRevision=env["scene"]["revision"])
    assert result["cleanup"]["applied"] is False
    assert [n for n in result["nodes"] if n["kind"] in ("group", "part")] == before


# --- One run, one entry --------------------------------------------------------------------------------


def _messy():
    scene_id = _scene()
    rev = _material(scene_id, 1, "m_a", "#ff0000")
    rev = _material(scene_id, rev, "m_b", "#ff0000")
    rev = _material(scene_id, rev, "m_idle", "#00ff00")
    rev, _ = _box(scene_id, rev, "A", "m_a")
    rev, _ = _box(scene_id, rev, "B", "m_b")
    rev, _ = _group(scene_id, rev, "Empty")
    return scene_id, rev


def test_all_three_operations_in_one_revision_and_one_undo():
    scene_id, rev = _messy()
    before = tools.get_scene(scene=scene_id)
    result = tools.cleanup(scene=scene_id, baseRevision=rev)
    changes = result["cleanup"]["changes"]
    assert changes["materialsMerged"] == [{"from": "m_b", "into": "m_a"}]
    assert changes["materialsRemoved"] == ["m_idle"] and [g["name"] for g in changes["groupsRemoved"]] == ["Empty"]
    assert result["cleanup"]["operations"] == ["dedupe_materials", "prune_materials", "prune_groups"]
    assert result["scene"]["revision"] == rev + 1
    assert result["cleanup"]["summary"] == [
        "Merge 1 identical material into the first of each.",
        "Remove 1 unused material.",
        "Remove 1 empty group.",
    ]
    undone = tools.undo(scene=scene_id, baseRevision=result["scene"]["revision"])
    assert sorted(_materials(undone)) == sorted(_materials(before))
    assert {n["id"]: n for n in undone["nodes"]} == {n["id"]: n for n in before["nodes"]}
    redone = tools.redo(scene=scene_id, baseRevision=undone["scene"]["revision"])
    assert _materials(redone) == _materials(result) and len(redone["nodes"]) == len(result["nodes"])


def test_running_it_twice_changes_nothing_the_second_time():
    scene_id, rev = _messy()
    first = tools.cleanup(scene=scene_id, baseRevision=rev)
    second = tools.cleanup(scene=scene_id, baseRevision=first["scene"]["revision"])
    assert second["cleanup"]["applied"] is False
    assert second["scene"]["revision"] == first["scene"]["revision"]
    assert second["cleanup"]["summary"] == ["Nothing to tidy up."]


def test_dry_run_reports_the_same_changes_and_writes_nothing(store):
    scene_id, rev = _messy()
    before = store.get_scene(scene_id)
    preview = tools.cleanup(scene=scene_id, baseRevision=rev, dryRun=True)
    assert preview["cleanup"]["dryRun"] is True and preview["cleanup"]["applied"] is False
    assert store.get_scene(scene_id) == before
    real = tools.cleanup(scene=scene_id, baseRevision=rev)
    assert real["cleanup"]["changes"] == preview["cleanup"]["changes"]


def test_a_stale_revision_is_a_conflict_for_a_preview_and_for_the_real_thing():
    scene_id, rev = _messy()
    for dry in (True, False):
        with pytest.raises(PlastisError) as excinfo:
            tools.cleanup(scene=scene_id, baseRevision=rev - 1, dryRun=dry)
        assert excinfo.value.code == "REVISION_CONFLICT" and excinfo.value.current_revision == rev


def test_operations_are_validated_and_run_in_a_fixed_order():
    scene_id, rev = _messy()
    for bad in ([], ["inflate"], "prune_groups", [3]):
        with pytest.raises(PlastisError) as excinfo:
            tools.cleanup(scene=scene_id, baseRevision=rev, operations=bad)
        assert excinfo.value.code == "SPEC_INVALID"
    with pytest.raises(PlastisError):
        tools.cleanup(scene=scene_id, baseRevision=rev, dryRun="yes")
    assert cleanup.normalize_operations(["prune_groups", "dedupe_materials"]) == ["dedupe_materials", "prune_groups"]


def test_the_core_does_not_modify_its_input():
    scene_id, rev = _messy()
    scene = Store().get_scene(scene_id)
    frozen = copy.deepcopy(scene)
    new_scene, changes = cleanup.apply_cleanup(scene)
    assert scene == frozen and new_scene != scene and not cleanup.is_empty(changes)


def test_a_cleanup_never_touches_models_assets_or_mesh_data(store, tmp_path):
    scene_id = _scene()
    stl = bytearray(b"x" * 80) + struct.pack("<I", 1) + struct.pack("<3f", 0, 0, 1)
    for v in ((0, 0, 0), (1, 0, 0), (0, 1, 0)):
        stl += struct.pack("<3f", *v)
    stl += b"\x00\x00"
    path = tmp_path / "p.stl"
    path.write_bytes(bytes(stl))
    env = tools.import_model(scene=scene_id, baseRevision=1, path=str(path), explode=False)
    files = {p.name: p.read_bytes() for p in store.assets_dir.iterdir()}
    rev = _material(scene_id, env["scene"]["revision"], "m_idle")
    result = tools.cleanup(scene=scene_id, baseRevision=rev)
    assert result["cleanup"]["changes"]["materialsRemoved"] == ["m_idle"]
    assert {p.name: p.read_bytes() for p in store.assets_dir.iterdir()} == files
    assert [n for n in result["nodes"] if n["kind"] == "model"] == [n for n in env["nodes"] if n["kind"] == "model"]
    assert result["assets"] == env["assets"]


def test_the_op_is_not_allowed_in_a_patch_and_refuses_an_empty_run(store):
    scene_id, rev = _messy()
    from plastis3d_scene import mutate

    with pytest.raises(PlastisError):
        mutate.apply_patch(scene_id, rev, [{"op": "cleanup"}], store=store)
    tidy = tools.cleanup(scene=scene_id, baseRevision=rev)
    with pytest.raises(PlastisError) as excinfo:
        mutate.apply(scene_id, tidy["scene"]["revision"], {"op": "cleanup"}, store=store)
    assert "nothing to tidy" in str(excinfo.value)


# --- The tool and the route ----------------------------------------------------------------------------


def test_the_tool_is_registered_and_mutating():
    entry = next(t for t in tools.tool_schemas() if t["name"] == "plastis3d_cleanup")
    params = entry["schema"]["parameters"]
    assert params["required"] == ["scene", "baseRevision"]
    assert params["properties"]["operations"]["items"]["enum"] == ["dedupe_materials", "prune_materials", "prune_groups", "weld"]
    assert "dryRun" in params["properties"]


@pytest.fixture()
def client(data_dir):
    api = _load_plugin_api_standalone()
    app = FastAPI()
    app.include_router(api.router, prefix="/api/plugins/plastis3d")
    with TestClient(app) as c:
        yield c


def test_route_previews_and_applies(client):
    base = "/api/plugins/plastis3d/scenes"
    sid = client.post(base, json={"name": "R"}).json()["scene"]["id"]
    ops = [{"op": "set_material", "material": {"id": "m_idle", "color": "#00ff00"}}]
    rev = client.patch("%s/%s" % (base, sid), json={"baseRevision": 1, "ops": ops}).json()["scene"]["revision"]
    preview = client.post("%s/%s/cleanup" % (base, sid), json={"baseRevision": rev, "dryRun": True}).json()
    assert preview["cleanup"]["changes"]["materialsRemoved"] == ["m_idle"] and preview["scene"]["revision"] == rev
    applied = client.post("%s/%s/cleanup" % (base, sid), json={"baseRevision": rev}).json()
    assert applied["cleanup"]["applied"] is True and applied["scene"]["revision"] == rev + 1
    stale = client.post("%s/%s/cleanup" % (base, sid), json={"baseRevision": rev})
    assert stale.status_code == 409
    assert client.post("%s/%s/cleanup" % (base, sid), json={"baseRevision": rev + 1, "operations": ["inflate"]}).status_code == 400
    assert client.post("%s/%s/cleanup" % (base, sid), json={"baseRevision": rev + 1, "dryRun": "x"}).status_code == 400
    assert client.post("%s/nope/cleanup" % base, json={"baseRevision": 1}).status_code == 404
    assert client.post("%s/%s/cleanup" % (base, sid), content=b"[]").status_code == 400
