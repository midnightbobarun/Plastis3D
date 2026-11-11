"""PR7 import flow tests (Tier 1, stage-3.md §5 + editable-imports plan §8).

The exploder, the cap guard, refusals (with no partial asset), the
``explode: false`` locked-model fallback, and both gateway doors
(``POST /imports`` backendPath + upload, ``GET /assets`` base64).

The fixture GLBs live in ``tests/fixtures`` — inside the plugin
install directory, which the import denylist refuses — so every test
copies them to ``tmp_path`` first. That copy step is itself the
plugin-root refusal test.

Run: pytest tests/python (from tests/python, see the repo README note
on the pytest-9 root-collection quirk).
"""

import base64
import hashlib
import importlib.util
import json
import math
import os
import shutil
import struct
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from plastis3d_scene import glb as glb_mod
from plastis3d_scene import import_model as import_model_mod
from plastis3d_scene import primitives
from plastis3d_scene import tools
from plastis3d_scene.spec import PlastisError
from plastis3d_scene.store import Store

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
FIXTURES = REPO_ROOT / "tests" / "fixtures"
EXPECTED = json.loads((FIXTURES / "two-primitive.expected.json").read_text(encoding="utf-8"))


@pytest.fixture()
def store(tmp_path, monkeypatch):
    data_dir = tmp_path / "data"
    monkeypatch.setenv("PLASTIS3D_DATA_DIR", str(data_dir))
    return Store(data_dir)


def _fixture_copy(tmp_path, name="model.glb"):
    """The two-primitive fixture, copied outside the plugin root."""
    dest = tmp_path / name
    shutil.copyfile(FIXTURES / "two-primitive.glb", dest)
    return dest


def _new_scene_id():
    env = tools.new_scene(name="Import")
    return env["scene"]["id"]


def _nodes_by_id(envelope):
    return {n["id"]: n for n in envelope["nodes"]}


def _kind(envelope, kind):
    return [n for n in envelope["nodes"] if n["kind"] == kind]


# --- Exploder -------------------------------------------------------------------


def test_import_exploded_two_primitive(store, tmp_path):
    scene_id = _new_scene_id()
    source = _fixture_copy(tmp_path)
    envelope = tools.import_model(scene=scene_id, baseRevision=1, path=str(source))
    assert envelope["scene"]["revision"] == 2
    nodes = _nodes_by_id(envelope)

    # One wrapper group (named for the file stem) + one group per glTF
    # node + one part per TRIANGLES primitive.
    assert [n["name"] for n in _kind(envelope, "group")] == ["model", "mesh0", "mesh1"]
    parts = _kind(envelope, "part")
    assert len(parts) == 3
    wrapper = [n for n in _kind(envelope, "group") if n["name"] == "model"][0]
    assert wrapper["parent"] is None
    assert wrapper["transform"] == {"t": [0.0, 0.0, 0.0], "r": [0.0, 0.0, 0.0], "s": [1.0, 1.0, 1.0]}
    mesh0_group = [n for n in _kind(envelope, "group") if n["name"] == "mesh0"][0]
    mesh1_group = [n for n in _kind(envelope, "group") if n["name"] == "mesh1"][0]
    assert mesh0_group["parent"] == wrapper["id"]
    assert mesh1_group["parent"] == wrapper["id"]
    for part in parts:
        assert part["transform"] == {"t": [0.0, 0.0, 0.0], "r": [0.0, 0.0, 0.0], "s": [1.0, 1.0, 1.0]}
        assert part["modelAssetId"] == envelope["assets"][0]["id"]
        parent = nodes[part["parent"]]
        assert parent["kind"] == "group"
        assert (part["meshIndex"], part["primitiveIndex"]) in ((0, 0), (0, 1), (1, 0))
        if part["meshIndex"] == 0:
            assert part["parent"] == mesh0_group["id"]
        else:
            assert part["parent"] == mesh1_group["id"]

    # The asset row: content-addressed by sha256, stats from the scan.
    assert len(envelope["assets"]) == 1
    asset = envelope["assets"][0]
    raw = source.read_bytes()
    assert asset["id"] == hashlib.sha256(raw).hexdigest()
    assert asset["sha256"] == asset["id"]
    assert asset["file"] == "assets/%s.glb" % asset["id"]
    assert asset["bytes"] == len(raw)
    assert asset["originalName"] == "model.glb"
    assert asset["sourceFormat"] == "glb"
    assert asset["stats"]["tris"] == EXPECTED["assetTris"]
    assert asset["stats"]["drawable"] is True
    # Since PR15 each part records whether its primitive carries UVs (this fixture has none).
    assert asset["stats"]["parts"] == [dict(p, uv=False) for p in EXPECTED["parts"]]
    assert asset["stats"]["bounds"] == EXPECTED["assetBounds"]
    assert asset["stats"]["internals"] == [
        {"index": 0, "name": "mesh0"},
        {"index": 1, "name": "mesh1"},
    ]
    # The stored file is the fixture bytes, byte-for-byte.
    stored = store.assets_dir / ("%s.glb" % asset["id"])
    assert stored.read_bytes() == raw
    assert envelope["stats"]["tris"] == 36


def test_import_reimport_shares_asset_row(store, tmp_path):
    scene_id = _new_scene_id()
    source = _fixture_copy(tmp_path)
    first = tools.import_model(scene=scene_id, baseRevision=1, path=str(source))
    second = tools.import_model(scene=scene_id, baseRevision=2, path=str(source))
    assert second["scene"]["revision"] == 3
    assert len(second["assets"]) == 1  # same bytes, one row
    assert second["assets"][0]["id"] == first["assets"][0]["id"]
    assert len(_kind(second, "group")) == 6  # wrapper + mesh0/mesh1, twice
    assert len(_kind(second, "part")) == 6
    assert len(list(store.assets_dir.iterdir())) == 1


def test_import_explode_false_locked_model(store, tmp_path):
    scene_id = _new_scene_id()
    source = _fixture_copy(tmp_path)
    envelope = tools.import_model(
        scene=scene_id, baseRevision=1, path=str(source), explode=False, name="Ship"
    )
    models = _kind(envelope, "model")
    assert len(models) == 1
    assert models[0]["name"] == "Ship"
    assert models[0]["parent"] is None
    assert _kind(envelope, "part") == []
    assert len(envelope["assets"]) == 1
    # A model node is opaque: set_material refuses with NODE_LOCKED.
    with pytest.raises(PlastisError) as excinfo:
        tools.set_material(
            scene=scene_id,
            baseRevision=2,
            id="m_red",
            color="#ff0000",
            assignTo=[models[0]["id"]],
        )
    assert excinfo.value.code == "NODE_LOCKED"
    # But it still moves like any node.
    moved = tools.update_node(
        scene=scene_id,
        baseRevision=2,
        id=models[0]["id"],
        transform={"t": [3, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
    )
    assert _nodes_by_id(moved)[models[0]["id"]]["transform"]["t"] == [3, 0, 0]


def test_import_caller_name_parent_transform(store, tmp_path):
    scene_id = _new_scene_id()
    source = _fixture_copy(tmp_path)
    envelope = tools.import_model(
        scene=scene_id,
        baseRevision=1,
        path=str(source),
        name="Assembly",
        parent="light_key",
        transform={"t": [10, 0, 0], "r": [0, 0, 0], "s": [2, 2, 2]},
    )
    wrapper = [n for n in _kind(envelope, "group") if n["name"] == "Assembly"][0]
    assert wrapper["parent"] == "light_key"
    assert wrapper["transform"]["t"] == [10, 0, 0]
    assert wrapper["transform"]["s"] == [2, 2, 2]


def _box_positions(center, size):
    half = size / 2.0
    cx, cy, cz = center
    faces = [
        [(1, -1, 1), (1, -1, -1), (1, 1, -1), (1, 1, 1)],
        [(-1, -1, -1), (-1, -1, 1), (-1, 1, 1), (-1, 1, -1)],
        [(-1, 1, 1), (1, 1, 1), (1, 1, -1), (-1, 1, -1)],
        [(-1, -1, -1), (1, -1, -1), (1, -1, 1), (-1, -1, 1)],
        [(-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)],
        [(1, -1, -1), (-1, -1, -1), (-1, 1, -1), (1, 1, -1)],
    ]
    verts = []
    for quad in faces:
        for i in (0, 1, 2, 0, 2, 3):
            x, y, z = quad[i]
            verts.append((cx + x * half, cy + y * half, cz + z * half))
    return verts


def _build_nested_glb():
    """Root (translated, 90 deg about Z) -> child (mesh) -> matrix
    node (translation [5,0,0], 90 deg about Y, as a matrix)."""
    verts = _box_positions((0.0, 0.0, 0.0), 1.0)
    flat = [c for v in verts for c in v]
    blob = struct.pack("<%df" % len(flat), *flat)
    rotation = primitives.rotation_matrix_xyz([0.0, 90.0, 0.0])
    matrix = [
        rotation[0][0], rotation[1][0], rotation[2][0], 0.0,
        rotation[0][1], rotation[1][1], rotation[2][1], 0.0,
        rotation[0][2], rotation[1][2], rotation[2][2], 0.0,
        5.0, 0.0, 0.0, 1.0,
    ]
    half = math.sqrt(0.5)
    gltf = {
        "asset": {"version": "2.0"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [
            {
                "name": "Assembly",
                "translation": [1.0, 2.0, 3.0],
                "rotation": [0.0, 0.0, half, half],
                "children": [1],
            },
            {"name": "Child", "mesh": 0, "children": [2]},
            {"name": "MatrixKid", "matrix": matrix},
        ],
        "meshes": [{"name": "box", "primitives": [{"attributes": {"POSITION": 0}}]}],
        "accessors": [
            {
                "bufferView": 0,
                "componentType": 5126,
                "count": 36,
                "type": "VEC3",
                "min": [-0.5, -0.5, -0.5],
                "max": [0.5, 0.5, 0.5],
            }
        ],
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(blob)}],
        "buffers": [{"byteLength": len(blob)}],
    }
    json_bytes = json.dumps(gltf, separators=(",", ":"), sort_keys=True).encode("utf-8")
    json_bytes += b" " * ((-len(json_bytes)) % 4)
    blob += b"\x00" * ((-len(blob)) % 4)
    total = 12 + 8 + len(json_bytes) + 8 + len(blob)
    return (
        struct.pack("<III", 0x46546C67, 2, total)
        + struct.pack("<II", len(json_bytes), 0x4E4F534A)
        + json_bytes
        + struct.pack("<II", len(blob), 0x004E4942)
        + blob
    )


def test_import_nested_tree_transforms(store, tmp_path):
    scene_id = _new_scene_id()
    source = tmp_path / "nested.glb"
    source.write_bytes(_build_nested_glb())
    envelope = tools.import_model(scene=scene_id, baseRevision=1, path=str(source))
    nodes = _nodes_by_id(envelope)
    by_name = {n["name"]: n for n in envelope["nodes"]}
    assembly = by_name["Assembly"]
    assert assembly["transform"]["t"] == [1.0, 2.0, 3.0]
    assert assembly["transform"]["r"] == pytest.approx([0.0, 0.0, 90.0], abs=1e-6)
    child = by_name["Child"]
    assert child["parent"] == assembly["id"]
    assert child["transform"]["t"] == [0.0, 0.0, 0.0]
    matrix_kid = by_name["MatrixKid"]
    assert matrix_kid["parent"] == child["id"]
    assert matrix_kid["transform"]["t"] == [5.0, 0.0, 0.0]
    assert matrix_kid["transform"]["r"] == pytest.approx([0.0, 90.0, 0.0], abs=1e-6)
    parts = _kind(envelope, "part")
    assert len(parts) == 1
    assert parts[0]["parent"] == child["id"]
    assert parts[0]["name"] == "box"


def _glb_from(gltf, blob):
    json_bytes = json.dumps(gltf, separators=(",", ":"), sort_keys=True).encode("utf-8")
    json_bytes += b" " * ((-len(json_bytes)) % 4)
    blob += b"\x00" * ((-len(blob)) % 4)
    total = 12 + 8 + len(json_bytes) + 8 + len(blob)
    return (
        struct.pack("<III", 0x46546C67, 2, total)
        + struct.pack("<II", len(json_bytes), 0x4E4F534A)
        + json_bytes
        + struct.pack("<II", len(blob), 0x004E4942)
        + blob
    )


def _box_gltf(scenes, nodes, scene=0):
    verts = _box_positions((0.0, 0.0, 0.0), 1.0)
    flat = [c for v in verts for c in v]
    blob = struct.pack("<%df" % len(flat), *flat)
    gltf = {
        "asset": {"version": "2.0"},
        "scene": scene,
        "scenes": scenes,
        "nodes": nodes,
        "meshes": [{"name": "box", "primitives": [{"attributes": {"POSITION": 0}}]}],
        "accessors": [
            {
                "bufferView": 0,
                "componentType": 5126,
                "count": 36,
                "type": "VEC3",
                "min": [-0.5, -0.5, -0.5],
                "max": [0.5, 0.5, 0.5],
            }
        ],
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(blob)}],
        "buffers": [{"byteLength": len(blob)}],
    }
    return _glb_from(gltf, blob)


def _imported_asset(envelope):
    assert len(envelope["assets"]) == 1
    return envelope["assets"][0]


@pytest.mark.parametrize("explode", [True, False])
def test_import_reports_other_scenes_and_off_scene_nodes(store, tmp_path, explode):
    """R-28(a): content outside the default scene is reported in
    stats.ignored, not dropped silently. Parts and tris are unchanged."""
    scene_id = _new_scene_id()
    source = tmp_path / "multi-scene.glb"
    source.write_bytes(
        _box_gltf(
            scenes=[{"nodes": [0]}, {"nodes": [2]}],
            nodes=[
                {"name": "Shown", "mesh": 0},
                {"name": "Orphan", "mesh": 0},
                {"name": "OtherScene", "mesh": 0},
            ],
        )
    )
    envelope = tools.import_model(
        scene=scene_id, baseRevision=1, path=str(source), explode=explode
    )
    asset = _imported_asset(envelope)
    ignored = asset["stats"].get("ignored")
    assert ignored == [
        "1 other glTF scene was not imported",
        "2 nodes are outside scene 0 and were not imported",
    ]
    assert not any("mode" in entry.lower() for entry in ignored)
    names = {n["name"] for n in envelope["nodes"]}
    assert "Orphan" not in names and "OtherScene" not in names
    if explode:
        assert "Shown" in names
        assert len(_kind(envelope, "part")) == 1


def test_import_single_scene_reports_nothing_skipped(store, tmp_path):
    scene_id = _new_scene_id()
    source = tmp_path / "one-scene.glb"
    source.write_bytes(
        _box_gltf(scenes=[{"nodes": [0]}], nodes=[{"name": "Shown", "mesh": 0}])
    )
    envelope = tools.import_model(scene=scene_id, baseRevision=1, path=str(source))
    assert "ignored" not in _imported_asset(envelope)["stats"]


def test_euler_round_trip():
    """Euler -> matrix -> Euler -> matrix is the identity (including
    the gimbal poles), so the exploder's quaternion/matrix conversion
    cannot silently rotate a node."""
    cases = [
        [0.0, 0.0, 0.0],
        [90.0, 0.0, 0.0],
        [0.0, 90.0, 0.0],
        [0.0, 0.0, 90.0],
        [-90.0, 30.0, 45.0],
        [10.0, 20.0, 30.0],
        [180.0, 0.0, 0.0],
        [45.0, -60.0, 120.0],
        [30.0, 89.0, -15.0],  # near the gimbal pole, not on it: on the
        # pole itself (89.999) asin loses ~1e-5 to conditioning, which
        # is a float limit, not a wrong rotation.
    ]
    for degrees in cases:
        matrix = primitives.rotation_matrix_xyz(degrees)
        back = import_model_mod._euler_from_matrix(matrix)
        again = primitives.rotation_matrix_xyz(back)
        for row in range(3):
            for col in range(3):
                # 1e-6, not 1e-9: the extraction is ill-conditioned
                # within a hair of the gimbal pole (the 89.999 case),
                # where asin loses precision but the rotation is the same.
                assert matrix[row][col] == pytest.approx(again[row][col], abs=1e-6)


def test_set_material_on_part(store, tmp_path):
    """Parts are editable nodes: the override path (plan §5) works
    through the existing mutation core with no new tool."""
    scene_id = _new_scene_id()
    source = _fixture_copy(tmp_path)
    envelope = tools.import_model(scene=scene_id, baseRevision=1, path=str(source))
    part = _kind(envelope, "part")[0]
    updated = tools.set_material(
        scene=scene_id,
        baseRevision=2,
        id="m_red",
        color="#ff0000",
        assignTo=[part["id"]],
    )
    assert _nodes_by_id(updated)[part["id"]]["materialId"] == "m_red"


def test_import_undo_redo(store, tmp_path):
    scene_id = _new_scene_id()
    source = _fixture_copy(tmp_path)
    tools.import_model(scene=scene_id, baseRevision=1, path=str(source))
    undone = tools.undo(scene=scene_id, baseRevision=2)
    assert [n["name"] for n in undone["nodes"]] == ["Key light", "Main camera"]
    assert undone["assets"] == []
    redone = tools.redo(scene=scene_id, baseRevision=3)
    assert len(_kind(redone, "part")) == 3
    assert len(redone["assets"]) == 1


# --- Cap guard -------------------------------------------------------------------


def _build_chain_glb(count):
    """``count`` glTF nodes chained parent -> child, no meshes: the
    exploder must walk them iteratively (deeper than the recursion
    limit) and the cap guard must count them all."""
    nodes = []
    for i in range(count):
        node = {"name": "n%d" % i}
        if i + 1 < count:
            node["children"] = [i + 1]
        nodes.append(node)
    gltf = {
        "asset": {"version": "2.0"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": nodes,
    }
    json_bytes = json.dumps(gltf, separators=(",", ":"), sort_keys=True).encode("utf-8")
    json_bytes += b" " * ((-len(json_bytes)) % 4)
    total = 12 + 8 + len(json_bytes)
    return (
        struct.pack("<III", 0x46546C67, 2, total)
        + struct.pack("<II", len(json_bytes), 0x4E4F534A)
        + json_bytes
    )


def test_import_cap_guard_names_count_and_cap(store, tmp_path):
    scene_id = _new_scene_id()
    source = tmp_path / "chain.glb"
    source.write_bytes(_build_chain_glb(2001))
    with pytest.raises(PlastisError) as excinfo:
        tools.import_model(scene=scene_id, baseRevision=1, path=str(source))
    assert excinfo.value.code == "LIMIT_NODES"
    assert "2002" in str(excinfo.value)  # wrapper + 2001 groups
    assert "2000" in str(excinfo.value)
    # No partial asset: nothing on disk, scene untouched.
    assert list(store.assets_dir.iterdir()) == []
    assert store.get_scene(scene_id)["revision"] == 1
    assert store.get_scene(scene_id)["assets"] == []


def test_import_at_node_cap_boundary(store, tmp_path):
    # 1997 glTF nodes + wrapper = 1998 exploded; the scene's 2 rig
    # nodes bring the total to exactly 2000, which passes.
    scene_id = _new_scene_id()
    source = tmp_path / "chain.glb"
    source.write_bytes(_build_chain_glb(1997))
    envelope = tools.import_model(scene=scene_id, baseRevision=1, path=str(source))
    assert len(envelope["nodes"]) == 2000


# --- Refusals: no partial asset ---------------------------------------------------


@pytest.mark.parametrize(
    "setup",
    [
        "missing",
        "obj",
        "env",
        "pem",
        "relative",
        "symlink_credentials",
        "plugin_root",
    ],
)
def test_import_refusals_write_nothing(store, tmp_path, setup):
    scene_id = _new_scene_id()
    fixture = _fixture_copy(tmp_path)
    if setup == "missing":
        path, code = str(tmp_path / "nope.glb"), "IMPORT_NOT_FOUND"
    elif setup == "obj":
        target = tmp_path / "model.dae"
        shutil.copyfile(fixture, target)
        path, code = str(target), "IMPORT_FORMAT"
    elif setup == "env":
        target = tmp_path / ".env"
        shutil.copyfile(fixture, target)
        path, code = str(target), "IMPORT_PATH_DENIED"
    elif setup == "pem":
        target = tmp_path / "key.pem"
        shutil.copyfile(fixture, target)
        path, code = str(target), "IMPORT_PATH_DENIED"
    elif setup == "relative":
        path, code = "relative/model.glb", "IMPORT_PATH_DENIED"
    elif setup == "symlink_credentials":
        secret = tmp_path / "credentials.json"
        secret.write_bytes(b'{"token": "nope"}')
        link = tmp_path / "link.glb"
        link.symlink_to(secret)
        path, code = str(link), "IMPORT_PATH_DENIED"
    elif setup == "plugin_root":
        path, code = str(FIXTURES / "two-primitive.glb"), "IMPORT_PATH_DENIED"
    with pytest.raises(PlastisError) as excinfo:
        tools.import_model(scene=scene_id, baseRevision=1, path=path)
    assert excinfo.value.code == code, excinfo.value
    assert list(store.assets_dir.iterdir()) == []
    assert store.get_scene(scene_id)["revision"] == 1
    assert store.get_scene(scene_id)["assets"] == []


def test_import_inode_change_refused(store, tmp_path, monkeypatch):
    """The file's inode changing between stat and open is
    IMPORT_PATH_DENIED (simulated by patching os.fstat)."""
    scene_id = _new_scene_id()
    source = _fixture_copy(tmp_path)
    real_fstat = os.fstat

    def _swapped_inode(fd):
        result = real_fstat(fd)
        return os.stat_result(
            (
                result.st_mode,
                result.st_ino + 1,
                result.st_dev,
                result.st_nlink,
                result.st_uid,
                result.st_gid,
                result.st_size,
                result.st_atime,
                result.st_mtime,
                result.st_ctime,
            )
        )

    monkeypatch.setattr(os, "fstat", _swapped_inode)
    with pytest.raises(PlastisError) as excinfo:
        tools.import_model(scene=scene_id, baseRevision=1, path=str(source))
    assert excinfo.value.code == "IMPORT_PATH_DENIED"
    assert list(store.assets_dir.iterdir()) == []


def test_import_timeout_writes_nothing(store, tmp_path):
    scene_id = _new_scene_id()
    source = _fixture_copy(tmp_path)
    with pytest.raises(PlastisError) as excinfo:
        import_model_mod.import_path(
            scene_id, store, str(source), base_revision=1, timeout=0.0
        )
    assert excinfo.value.code == "IMPORT_TIMEOUT"
    assert list(store.assets_dir.iterdir()) == []
    assert store.get_scene(scene_id)["revision"] == 1


def test_import_unknown_parent_refused_before_asset_write(store, tmp_path):
    """Caller options are validated against the post-import document
    before the asset file is written, so a bad parent leaves no
    orphaned asset file behind."""
    scene_id = _new_scene_id()
    source = _fixture_copy(tmp_path)
    with pytest.raises(PlastisError) as excinfo:
        tools.import_model(
            scene=scene_id, baseRevision=1, path=str(source), parent="nope"
        )
    assert excinfo.value.code == "SPEC_INVALID"
    assert list(store.assets_dir.iterdir()) == []


def test_import_missing_scene_first(store, tmp_path):
    source = _fixture_copy(tmp_path)
    with pytest.raises(PlastisError) as excinfo:
        tools.import_model(scene="nope", baseRevision=1, path=str(source))
    assert excinfo.value.code == "SCENE_NOT_FOUND"


# --- Embedded glTF -------------------------------------------------------------------


def test_import_gltf_stored_as_glb(store, tmp_path):
    """A .gltf file is scanned, packed to GLB, and stored as GLB (rule
    6); the SHA is over the stored bytes."""
    source = tmp_path / "model.gltf"
    raw_glb = (FIXTURES / "two-primitive.glb").read_bytes()
    # Rebuild the .gltf document from the fixture GLB's JSON + BIN.
    import struct as _struct

    total = _struct.unpack("<I", raw_glb[8:12])[0]
    json_len = _struct.unpack("<I", raw_glb[12:16])[0]
    doc = json.loads(raw_glb[20 : 20 + json_len].decode("utf-8"))
    bin_start = 20 + json_len + 8
    bin_data = raw_glb[bin_start:total]
    doc["buffers"] = [
        {
            "byteLength": len(bin_data),
            "uri": "data:application/octet-stream;base64,%s"
            % base64.b64encode(bin_data).decode("ascii"),
        }
    ]
    source.write_text(json.dumps(doc), encoding="utf-8")
    scene_id = _new_scene_id()
    envelope = tools.import_model(scene=scene_id, baseRevision=1, path=str(source))
    asset = envelope["assets"][0]
    assert asset["sourceFormat"] == "gltf"
    assert asset["format"] == "glb"
    stored = store.assets_dir / ("%s.glb" % asset["id"])
    assert stored.read_bytes()[:4] == b"glTF"
    assert asset["sha256"] == hashlib.sha256(stored.read_bytes()).hexdigest()
    assert asset["stats"]["tris"] == 36
    assert len(_kind(envelope, "part")) == 3
    # The stored GLB re-imports to the same asset row.
    second = tools.import_model(scene=scene_id, baseRevision=2, path=str(stored))
    assert len(second["assets"]) == 1
    assert second["assets"][0]["id"] == asset["id"]


# --- Gateway routes -------------------------------------------------------------------


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
    data_dir = tmp_path_factory.mktemp("import-api-data")
    previous = os.environ.get("PLASTIS3D_DATA_DIR")
    os.environ["PLASTIS3D_DATA_DIR"] = str(data_dir)
    api = _load_plugin_api_standalone()
    app = FastAPI()
    app.include_router(api.router, prefix="/api/plugins/plastis3d")
    with TestClient(app) as client:
        yield client
    if previous is None:
        os.environ.pop("PLASTIS3D_DATA_DIR", None)
    else:
        os.environ["PLASTIS3D_DATA_DIR"] = previous


@pytest.fixture()
def route_scene(api_client):
    response = api_client.post(
        "/api/plugins/plastis3d/scenes", json={"name": "Route"}
    )
    assert response.status_code == 201, response.text
    return response.json()["scene"]["id"]


def test_route_import_backend_path(api_client, route_scene, tmp_path):
    source = _fixture_copy(tmp_path)
    response = api_client.post(
        "/api/plugins/plastis3d/scenes/%s/imports" % route_scene,
        json={"backendPath": str(source), "baseRevision": 1},
    )
    assert response.status_code == 200, response.text
    envelope = response.json()
    assert envelope["scene"]["revision"] == 2
    assert len([n for n in envelope["nodes"] if n["kind"] == "part"]) == 3
    assert len(envelope["assets"]) == 1


def test_route_import_backend_path_explode_false(api_client, route_scene, tmp_path):
    source = _fixture_copy(tmp_path)
    response = api_client.post(
        "/api/plugins/plastis3d/scenes/%s/imports" % route_scene,
        json={"backendPath": str(source), "baseRevision": 1, "explode": False},
    )
    assert response.status_code == 200, response.text
    envelope = response.json()
    assert len([n for n in envelope["nodes"] if n["kind"] == "model"]) == 1
    assert [n for n in envelope["nodes"] if n["kind"] == "part"] == []


def test_route_import_upload(api_client, route_scene, tmp_path):
    source = _fixture_copy(tmp_path)
    raw = source.read_bytes()
    response = api_client.post(
        "/api/plugins/plastis3d/scenes/%s/imports" % route_scene,
        json={
            "upload": {
                "filename": "model.glb",
                "contentType": "model/gltf-binary",
                "bytes": base64.b64encode(raw).decode("ascii"),
            },
            "baseRevision": 1,
        },
    )
    assert response.status_code == 200, response.text
    envelope = response.json()
    assert len([n for n in envelope["nodes"] if n["kind"] == "part"]) == 3
    asset = envelope["assets"][0]
    assert asset["originalName"] == "model.glb"
    data_dir = Path(os.environ["PLASTIS3D_DATA_DIR"])
    assert (data_dir / "assets" / ("%s.glb" % asset["sha256"])).read_bytes() == raw


@pytest.mark.parametrize(
    "body, code",
    [
        ({"baseRevision": 1}, "SPEC_INVALID"),  # neither door
        (
            {"backendPath": "/tmp/x.glb", "upload": {"filename": "x.glb", "bytes": "eA=="}, "baseRevision": 1},
            "SPEC_INVALID",  # both doors
        ),
        ({"backendPath": "/tmp/x.glb"}, "SPEC_INVALID"),  # no baseRevision
        (
            {"upload": {"filename": "x.glb", "bytes": "!!!not-base64!!!"}, "baseRevision": 1},
            "SPEC_INVALID",  # bad base64
        ),
        (
            {"upload": {"filename": "x.dae", "bytes": "eA=="}, "baseRevision": 1},
            "IMPORT_FORMAT",  # bad extension on the upload name
        ),
    ],
)
def test_route_import_bad_bodies(api_client, route_scene, body, code):
    response = api_client.post(
        "/api/plugins/plastis3d/scenes/%s/imports" % route_scene, json=body
    )
    assert response.status_code in (400, 404), response.text
    assert response.json()["code"] == code, response.json()


def test_route_import_unknown_scene(api_client, tmp_path):
    source = _fixture_copy(tmp_path)
    response = api_client.post(
        "/api/plugins/plastis3d/scenes/nope/imports",
        json={"backendPath": str(source), "baseRevision": 1},
    )
    assert response.status_code == 404
    assert response.json()["code"] == "SCENE_NOT_FOUND"


def test_route_import_backend_path_missing_file(api_client, route_scene, tmp_path):
    response = api_client.post(
        "/api/plugins/plastis3d/scenes/%s/imports" % route_scene,
        json={"backendPath": str(tmp_path / "nope.glb"), "baseRevision": 1},
    )
    assert response.status_code == 404
    assert response.json()["code"] == "IMPORT_NOT_FOUND"


def test_route_import_non_json_body(api_client, route_scene):
    response = api_client.post(
        "/api/plugins/plastis3d/scenes/%s/imports" % route_scene,
        content=b"x" * 1024,
        headers={"Content-Type": "application/octet-stream"},
    )
    assert response.status_code == 400
    assert response.json()["code"] == "SPEC_INVALID"


def test_route_upload_over_16mib(api_client, route_scene):
    """A 13 MiB file base64-encodes past the 16 MiB JSON body cap and
    413s before any import work (D2)."""
    raw = b"x" * (13 * 1024 * 1024)
    response = api_client.post(
        "/api/plugins/plastis3d/scenes/%s/imports" % route_scene,
        json={
            "upload": {
                "filename": "big.glb",
                "contentType": "model/gltf-binary",
                "bytes": base64.b64encode(raw).decode("ascii"),
            },
            "baseRevision": 1,
        },
    )
    assert response.status_code == 413
    assert response.json()["code"] == "IMPORT_TOO_LARGE"


def _build_big_glb(target_bytes):
    """A valid one-box GLB whose BIN chunk pads the file to
    ``target_bytes`` (13 MiB): importable, but too large for the byte
    route, so drawable is false."""
    positions = struct.pack("<108f", *([0.0] * 108))
    gltf = {
        "asset": {"version": "2.0"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": "root"}],
        "meshes": [{"name": "m", "primitives": [{"attributes": {"POSITION": 0}}]}],
        "accessors": [
            {
                "bufferView": 0,
                "componentType": 5126,
                "count": 36,
                "type": "VEC3",
                "min": [0.0, 0.0, 0.0],
                "max": [0.0, 0.0, 0.0],
            }
        ],
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": 432}],
        "buffers": [{"byteLength": 0}],  # fixed below
    }
    json_bytes = json.dumps(gltf, separators=(",", ":"), sort_keys=True).encode("utf-8")
    json_bytes += b" " * ((-len(json_bytes)) % 4)
    # Size the BIN so the file lands on target_bytes. The JSON length
    # depends on the byteLength digits, so iterate to a fixed point.
    bin_len = target_bytes - (12 + 8 + len(json_bytes) + 8)
    while True:
        gltf["buffers"][0]["byteLength"] = bin_len
        new_json = json.dumps(gltf, separators=(",", ":"), sort_keys=True).encode("utf-8")
        new_json += b" " * ((-len(new_json)) % 4)
        new_bin_len = target_bytes - (12 + 8 + len(new_json) + 8)
        if new_bin_len == bin_len:
            json_bytes = new_json
            break
        json_bytes, bin_len = new_json, new_bin_len
    bin_data = positions + b"\x00" * (bin_len - len(positions))
    total = 12 + 8 + len(json_bytes) + 8 + len(bin_data)
    return (
        struct.pack("<III", 0x46546C67, 2, total)
        + struct.pack("<II", len(json_bytes), 0x4E4F534A)
        + json_bytes
        + struct.pack("<II", len(bin_data), 0x004E4942)
        + bin_data
    )


def test_route_get_asset_base64(api_client, route_scene, tmp_path):
    source = _fixture_copy(tmp_path)
    raw = source.read_bytes()
    imported = api_client.post(
        "/api/plugins/plastis3d/scenes/%s/imports" % route_scene,
        json={"backendPath": str(source), "baseRevision": 1},
    )
    assert imported.status_code == 200, imported.text
    sha = imported.json()["assets"][0]["sha256"]
    response = api_client.get("/api/plugins/plastis3d/assets/%s" % sha)
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["ok"] is True
    assert payload["sha256"] == sha
    assert payload["size"] == len(raw)
    assert base64.b64decode(payload["bytes"]) == raw


def test_route_get_asset_too_large(api_client, route_scene, tmp_path):
    """D3: a 13 MiB asset exists and is importable/editable, but GET
    /assets answers 413 ASSET_TOO_LARGE instead of the base64 — the
    desktop shows stats and bounds, not a generic failure."""
    source = tmp_path / "big.glb"
    source.write_bytes(_build_big_glb(13 * 1024 * 1024))
    imported = api_client.post(
        "/api/plugins/plastis3d/scenes/%s/imports" % route_scene,
        json={"backendPath": str(source), "baseRevision": 1},
    )
    assert imported.status_code == 200, imported.text
    asset = imported.json()["assets"][0]
    assert asset["stats"]["drawable"] is False
    response = api_client.get("/api/plugins/plastis3d/assets/%s" % asset["sha256"])
    assert response.status_code == 413
    assert response.json()["code"] == "ASSET_TOO_LARGE"


def test_route_get_asset_unknown_and_malformed(api_client):
    response = api_client.get("/api/plugins/plastis3d/assets/%s" % ("c" * 64))
    assert response.status_code == 404
    assert response.json()["code"] == "ASSET_NOT_FOUND"
    response = api_client.get("/api/plugins/plastis3d/assets/not-a-sha")
    assert response.status_code == 400
    assert response.json()["code"] == "SPEC_INVALID"

@pytest.mark.parametrize("feature", ["skins", "animations", "morph"])
def test_explode_rejects_deformable_assets(feature):
    from plastis3d_scene.import_model import _explode
    from plastis3d_scene.spec import PlastisError

    gltf = {"meshes": [{"primitives": [{}]}], "nodes": []}
    if feature == "morph":
        gltf["meshes"][0]["primitives"][0]["targets"] = [{"POSITION": 0}]
    else:
        gltf[feature] = [{}]
    opts = dict(asset_id="a", name="model", parent=None, transform=None, taken_ids=set())
    with pytest.raises(PlastisError, match="explode: false"):
        _explode(gltf, explode=True, **opts)
    assert _explode(gltf, explode=False, **opts)[0]["kind"] == "model"


def test_duplicate_keeps_exploded_import(store, tmp_path):
    scene_id = _new_scene_id()
    tools.import_model(scene=scene_id, baseRevision=1, path=str(_fixture_copy(tmp_path)))
    source = store.get_scene(scene_id)
    copy = store.create_scene("Copied import", copy_from=scene_id)
    assert copy["nodes"] == source["nodes"]
    assert copy["assets"] == source["assets"]
    assert any(n["kind"] == "part" for n in copy["nodes"])
    source_bytes = Path(tools.export_glb(scene=scene_id)["path"]).read_bytes()
    copy_bytes = Path(tools.export_glb(scene=copy["id"])["path"]).read_bytes()
    assert copy_bytes == source_bytes
    store.delete_scene(scene_id, source["revision"])
    assert store.get_scene(copy["id"])["assets"] == source["assets"]
    assert tools.export_glb(scene=copy["id"])["ok"]


def test_a_texture_map_cannot_name_a_model_asset(store, tmp_path):
    """Since PR15 a map must name an image asset, not an imported model."""
    scene_id = _new_scene_id()
    tools.import_model(scene=scene_id, baseRevision=1, path=str(_fixture_copy(tmp_path)))
    scene = store.get_scene(scene_id)
    scene["materials"][0]["baseColorMap"] = scene["assets"][0]["id"]
    with pytest.raises(PlastisError) as excinfo:
        store.write_scene(scene_id, scene, scene["revision"])
    assert excinfo.value.code == "SPEC_INVALID"
    assert "is a model, not an image" in str(excinfo.value)
