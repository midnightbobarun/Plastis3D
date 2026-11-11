"""PR8 tiny-splice tests (Tier 1, stage-3 §5).

Synthetic fixtures built in the test, following the PR6 fixture
pattern (``_SourceBuilder`` packs boxes into GLBs with ``struct``);
the e2e gate test drives the real import engine
(``tools.import_model`` on ``tests/fixtures/two-primitive.glb``'s
four-part cousin, built here) through ``update_node`` /
``set_material`` / ``duplicate_node`` / ``delete_node``, exports,
re-imports the export, and verifies transforms and materials
survived. Refusal tests assert ``EXPORT_FAILED`` and an unchanged
exports dir — no partial file on any cut.

Run: pytest tests/python
"""

import copy
import hashlib
import json
import math
import shutil
import struct
from pathlib import Path

import pytest

from plastis3d_scene import tools as tools_mod
from plastis3d_scene.export_glb import export_scene
from plastis3d_scene.spec import PlastisError
from plastis3d_scene.store import Store

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
FIXTURES = REPO_ROOT / "tests" / "fixtures"

GLB_MAGIC = 0x46546C67
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942

_OMIT = object()
_DEFAULT_SCENES = object()


@pytest.fixture()
def store(tmp_path):
    return Store(tmp_path / "data")


@pytest.fixture()
def data_dir(tmp_path, monkeypatch):
    path = tmp_path / "data"
    monkeypatch.setenv("PLASTIS3D_DATA_DIR", str(path))
    return path


def _transform(node_id, name, kind, transform=None, **extra):
    node = {
        "id": node_id,
        "name": name,
        "kind": kind,
        "transform": transform or {"t": [0, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
    }
    node.update(extra)
    return node


# --- Synthetic source-GLB builder ----------------------------------------------

_FACES = [
    [(1, -1, 1), (1, -1, -1), (1, 1, -1), (1, 1, 1)],
    [(-1, -1, -1), (-1, -1, 1), (-1, 1, 1), (-1, 1, -1)],
    [(-1, 1, 1), (1, 1, 1), (1, 1, -1), (-1, 1, -1)],
    [(-1, -1, -1), (1, -1, -1), (1, -1, 1), (-1, -1, 1)],
    [(-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)],
    [(1, -1, -1), (-1, -1, -1), (-1, 1, -1), (1, 1, -1)],
]


def _box_positions(center, size):
    half = size / 2.0
    cx, cy, cz = center
    verts = []
    for quad in _FACES:
        for i in (0, 1, 2, 0, 2, 3):
            x, y, z = quad[i]
            verts.append((cx + x * half, cy + y * half, cz + z * half))
    return verts


def _bounds_of(verts):
    return {
        "min": [min(v[a] for v in verts) for a in range(3)],
        "max": [max(v[a] for v in verts) for a in range(3)],
    }


class _SourceBuilder:
    """Packs non-indexed POSITION-only boxes into one BIN chunk."""

    def __init__(self):
        self.bin = bytearray()
        self.views = []
        self.accessors = []

    def add_raw(self, blob: bytes) -> int:
        """Append ``blob`` as a bufferView; returns the view index."""
        view = {"buffer": 0, "byteOffset": len(self.bin), "byteLength": len(blob)}
        self.bin.extend(blob)
        self.views.append(view)
        return len(self.views) - 1

    def positions(self, center, size):
        """One box: returns ``(accessor index, bounds dict)``."""
        verts = _box_positions(center, size)
        flat = [c for v in verts for c in v]
        blob = struct.pack("<%df" % len(flat), *flat)
        view_index = self.add_raw(blob)
        bounds = _bounds_of(verts)
        accessor = {
            "bufferView": view_index,
            "componentType": 5126,
            "count": len(verts),
            "type": "VEC3",
            "min": bounds["min"],
            "max": bounds["max"],
        }
        self.accessors.append(accessor)
        return len(self.accessors) - 1, bounds

    def pack(self, gltf):
        gltf = copy.deepcopy(gltf)
        gltf["bufferViews"] = self.views
        gltf["accessors"] = self.accessors
        gltf["buffers"] = [{"byteLength": len(self.bin)}]
        json_bytes = json.dumps(gltf, separators=(",", ":"), sort_keys=True).encode("utf-8")
        json_bytes += b" " * ((-len(json_bytes)) % 4)
        bin_data = bytes(self.bin)
        bin_data += b"\x00" * ((-len(bin_data)) % 4)
        total = 12 + 8 + len(json_bytes) + 8 + len(bin_data)
        return (
            struct.pack("<III", GLB_MAGIC, 2, total)
            + struct.pack("<II", len(json_bytes), CHUNK_JSON)
            + json_bytes
            + struct.pack("<II", len(bin_data), CHUNK_BIN)
            + bin_data
        )


def _three_part_source(
    *,
    materials=None,
    textures=None,
    images=None,
    samplers=None,
    cameras=None,
    nodes=None,
    scenes=_DEFAULT_SCENES,
    scene=_OMIT,
    extra=None,
    prim_material=None,
    prim_mode=None,
):
    """The standard 3-part asset: mesh0 = boxes at (0,0,0) and (2,0,0),
    mesh1 = box at (0,3,0) size 2. Returns ``(glb bytes, stats.parts)``.

    ``scenes`` may be a list (default ``[{"nodes": [0, 1]}]``), ``None``
    (the key is omitted), or ``[]`` (explicitly empty). ``scene`` is
    the ``scene`` index, omitted unless given. ``extra`` merges into
    the top-level document. ``prim_material`` / ``prim_mode`` map
    ``(meshIndex, primitiveIndex)`` to a value.
    """
    builder = _SourceBuilder()
    acc0, bounds0 = builder.positions((0.0, 0.0, 0.0), 1.0)
    acc1, bounds1 = builder.positions((2.0, 0.0, 0.0), 1.0)
    acc2, bounds2 = builder.positions((0.0, 3.0, 0.0), 2.0)
    parts = [
        {"meshIndex": 0, "primitiveIndex": 0, "tris": 12, "verts": 36, "bounds": bounds0},
        {"meshIndex": 0, "primitiveIndex": 1, "tris": 12, "verts": 36, "bounds": bounds1},
        {"meshIndex": 1, "primitiveIndex": 0, "tris": 12, "verts": 36, "bounds": bounds2},
    ]

    def prim(acc, mesh_index, prim_index):
        entry = {"attributes": {"POSITION": acc}}
        if prim_material and (mesh_index, prim_index) in prim_material:
            entry["material"] = prim_material[(mesh_index, prim_index)]
        if prim_mode and (mesh_index, prim_index) in prim_mode:
            entry["mode"] = prim_mode[(mesh_index, prim_index)]
        return entry

    gltf: dict = {
        "asset": {"version": "2.0", "generator": "plastis3d test_splice"},
        "nodes": nodes if nodes is not None else [
            {"mesh": 0, "name": "mesh0"},
            {"mesh": 1, "name": "mesh1"},
        ],
        "meshes": [
            {"name": "mesh0", "primitives": [prim(acc0, 0, 0), prim(acc1, 0, 1)]},
            {"name": "mesh1", "primitives": [prim(acc2, 1, 0)]},
        ],
    }
    if scenes is _DEFAULT_SCENES:
        gltf["scenes"] = [{"nodes": [0, 1]}]
    elif scenes is not None:
        gltf["scenes"] = scenes
    if scene is not _OMIT:
        gltf["scene"] = scene
    if materials is not None:
        gltf["materials"] = materials
    if textures is not None:
        gltf["textures"] = textures
    if images is not None:
        gltf["images"] = images
    if samplers is not None:
        gltf["samplers"] = samplers
    if cameras is not None:
        gltf["cameras"] = cameras
    if extra:
        gltf.update(extra)
    return builder.pack(gltf), parts


def _four_part_glb():
    """A 4-part asset for the e2e gate test: mesh0 = boxes at (0,0,0)
    and (2,0,0); mesh1 = boxes at (0,3,0) size 2 and (4,0,0)."""
    builder = _SourceBuilder()
    acc0, _ = builder.positions((0.0, 0.0, 0.0), 1.0)
    acc1, _ = builder.positions((2.0, 0.0, 0.0), 1.0)
    acc2, _ = builder.positions((0.0, 3.0, 0.0), 2.0)
    acc3, _ = builder.positions((4.0, 0.0, 0.0), 1.0)
    gltf = {
        "asset": {"version": "2.0", "generator": "plastis3d test_splice"},
        "scenes": [{"nodes": [0, 1]}],
        "nodes": [
            {"mesh": 0, "name": "mesh0"},
            {"mesh": 1, "name": "mesh1"},
        ],
        "meshes": [
            {
                "name": "mesh0",
                "primitives": [
                    {"attributes": {"POSITION": acc0}},
                    {"attributes": {"POSITION": acc1}},
                ],
            },
            {
                "name": "mesh1",
                "primitives": [
                    {"attributes": {"POSITION": acc2}},
                    {"attributes": {"POSITION": acc3}},
                ],
            },
        ],
    }
    return builder.pack(gltf)


# --- Scene / export helpers --------------------------------------------------------

def _stats_for(parts):
    return {
        "tris": sum(p["tris"] for p in parts),
        "verts": sum(p["verts"] for p in parts),
        "materials": 0,
        "meshes": 2,
        "clips": 0,
        "skins": 0,
        "drawable": True,
        "parts": parts,
    }


def _scene_with(store, scene_id, nodes, assets=(), materials=None):
    """Create a scene (default rig) with ``nodes`` and asset rows.

    ``assets`` is ``[(glb_bytes, stats), ...]``; each row's id is the
    sha256 and the file is written to the store's assets dir. Returns
    the written scene dict (revision 2).
    """
    scene = store.create_scene("Splice", scene_id)
    for glb_bytes, stats in assets:
        sha = hashlib.sha256(glb_bytes).hexdigest()
        (store.assets_dir / ("%s.glb" % sha)).write_bytes(glb_bytes)
        scene["assets"].append(
            {
                "id": sha,
                "sha256": sha,
                "file": "assets/%s.glb" % sha,
                "format": "glb",
                "bytes": len(glb_bytes),
                "originalName": "model.glb",
                "sourceFormat": "glb",
                "stats": stats,
            }
        )
    scene["nodes"].extend(nodes)
    if materials:
        scene["materials"].extend(materials)
    return store.write_scene(scene_id, scene, base_revision=1)["scene"]


def _sha(glb_bytes):
    return hashlib.sha256(glb_bytes).hexdigest()


def _parse_glb(path):
    """``(gltf dict, BIN bytes)`` with header/chunk checks applied."""
    data = Path(path).read_bytes()
    magic, version, total = struct.unpack("<III", data[:12])
    assert magic == GLB_MAGIC
    assert version == 2
    assert total == len(data)
    json_len, json_type = struct.unpack("<II", data[12:20])
    assert json_type == CHUNK_JSON
    assert json_len % 4 == 0, "JSON chunk must be 4-byte aligned"
    gltf = json.loads(data[20 : 20 + json_len])
    offset = 20 + json_len
    bin_len, bin_type = struct.unpack("<II", data[offset : offset + 8])
    assert bin_type == CHUNK_BIN
    assert bin_len % 4 == 0, "BIN chunk must be 4-byte aligned"
    assert 12 + 8 + json_len + 8 + bin_len == total
    return gltf, data[offset + 8 : offset + 8 + bin_len]


def _export_and_parse(store, scene):
    result = export_scene(scene, store)
    assert result["ok"] is True
    return result, _parse_glb(result["path"])


def _nodes_by_name(gltf, name):
    return [n for n in gltf["nodes"] if n.get("name") == name]


def _node_by_name(gltf, name):
    matches = _nodes_by_name(gltf, name)
    assert len(matches) == 1, "expected one node named %r, got %d" % (name, len(matches))
    return matches[0]


def _model_node(store, scene_id, asset_sha, name="Model", transform=None, node_id="n_model"):
    return _transform(
        node_id, name, "model", transform=transform, modelAssetId=asset_sha
    )


def _part_node(node_id, name, asset_sha, mesh_index, prim_index, transform=None, **extra):
    return _transform(
        node_id,
        name,
        "part",
        transform=transform,
        modelAssetId=asset_sha,
        meshIndex=mesh_index,
        primitiveIndex=prim_index,
        **extra,
    )


def _expect_failed(store, scene):
    """Export ``scene``; expect EXPORT_FAILED and an unchanged exports dir."""
    before = sorted(p.name for p in store.exports_dir.iterdir())
    with pytest.raises(PlastisError) as excinfo:
        export_scene(scene, store)
    assert excinfo.value.code == "EXPORT_FAILED", excinfo.value
    assert str(excinfo.value).startswith("EXPORT_FAILED")
    assert sorted(p.name for p in store.exports_dir.iterdir()) == before


# --- Accepted cases ------------------------------------------------------------

def test_splice_moved_group_parents_box_keeps_local_trs(store):
    glb_bytes, parts = _three_part_source()
    sha = _sha(glb_bytes)
    scene = _scene_with(
        store,
        "group",
        [
            _transform(
                "n_group", "Moved group", "group",
                transform={"t": [2, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
            ),
            _transform(
                "n_child", "Grouped box", "mesh",
                transform={"t": [0, 1, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
                parent="n_group",
                primitive={"type": "box"},
                materialId="m_default",
            ),
            _model_node(store, "group", sha, transform={"t": [5, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]}),
        ],
        assets=[(glb_bytes, _stats_for(parts))],
    )
    _, (gltf, _) = _export_and_parse(store, scene)
    group = _node_by_name(gltf, "Moved group")
    child = _node_by_name(gltf, "Grouped box")
    assert gltf["nodes"].index(child) in group["children"]
    assert child["translation"] == [0, 1, 0]
    assert group["translation"] == [2, 0, 0]
    assert gltf["nodes"].index(child) not in gltf["scenes"][0]["nodes"]


def test_splice_moved_model_node_changes_trs(store):
    glb_bytes, parts = _three_part_source()
    sha = _sha(glb_bytes)
    scene = _scene_with(
        store,
        "moved-model",
        [_model_node(store, "moved-model", sha, transform={"t": [3, 4, 5], "r": [0, 90, 0], "s": [1, 1, 1]})],
        assets=[(glb_bytes, _stats_for(parts))],
    )
    _, (gltf, _) = _export_and_parse(store, scene)
    model = _node_by_name(gltf, "Model")
    assert model["translation"] == [3, 4, 5]
    assert model["rotation"] == pytest.approx(
        [0.0, math.sqrt(0.5), 0.0, math.sqrt(0.5)], abs=1e-6
    )
    assert "mesh" not in model
    # The imported roots hang under the model node, in source order.
    assert len(model["children"]) == 2
    roots = [gltf["nodes"][i] for i in model["children"]]
    assert [n["name"] for n in roots] == ["mesh0", "mesh1"]
    assert roots[0]["mesh"] == 0
    assert roots[1]["mesh"] == 1


def test_splice_spec_child_of_model_sits_beside_imported_roots(store):
    glb_bytes, parts = _three_part_source()
    sha = _sha(glb_bytes)
    scene = _scene_with(
        store,
        "spec-child",
        [
            _model_node(store, "spec-child", sha),
            _transform(
                "n_box", "Model box", "mesh",
                parent="n_model",
                primitive={"type": "box"},
                materialId="m_default",
            ),
        ],
        assets=[(glb_bytes, _stats_for(parts))],
    )
    _, (gltf, _) = _export_and_parse(store, scene)
    model = _node_by_name(gltf, "Model")
    box = _node_by_name(gltf, "Model box")
    children = [gltf["nodes"][i] for i in model["children"]]
    assert [n["name"] for n in children] == ["mesh0", "mesh1", "Model box"]
    assert gltf["nodes"].index(box) == model["children"][2]


def test_splice_two_nodes_share_one_buffer(store):
    glb_bytes, parts = _three_part_source()
    sha = _sha(glb_bytes)
    scene = _scene_with(
        store,
        "shared",
        [
            _transform("n_a", "ModelA", "model", modelAssetId=sha),
            _transform("n_b", "ModelB", "model", modelAssetId=sha),
        ],
        assets=[(glb_bytes, _stats_for(parts))],
    )
    _, (gltf, _) = _export_and_parse(store, scene)
    # One buffer, one copy of the source views/accessors/meshes.
    assert gltf["buffers"] == [{"byteLength": gltf["buffers"][0]["byteLength"]}]
    assert len(gltf["buffers"]) == 1
    assert len(gltf["bufferViews"]) == 3
    assert len(gltf["accessors"]) == 3
    assert len(gltf["meshes"]) == 2
    # Two model nodes, distinct indexes, same shared meshes.
    model_a = _node_by_name(gltf, "ModelA")
    model_b = _node_by_name(gltf, "ModelB")
    assert model_a is not model_b
    roots_a = [gltf["nodes"][i] for i in model_a["children"]]
    roots_b = [gltf["nodes"][i] for i in model_b["children"]]
    assert [n.get("mesh") for n in roots_a] == [0, 1]
    assert [n.get("mesh") for n in roots_b] == [0, 1]
    assert model_a["children"] != model_b["children"]
    # The shared mesh's primitives reference the same accessors.
    mesh0 = gltf["meshes"][0]
    assert mesh0["primitives"][0]["attributes"]["POSITION"] == 0
    assert mesh0["primitives"][1]["attributes"]["POSITION"] == 1


def test_splice_omitted_mode_exports(store):
    # The standard fixture omits `mode` on every primitive; it reads
    # as TRIANGLES (4) and exports. The copied primitives keep no mode.
    glb_bytes, parts = _three_part_source()
    sha = _sha(glb_bytes)
    scene = _scene_with(
        store, "omitted-mode",
        [_model_node(store, "omitted-mode", sha)],
        assets=[(glb_bytes, _stats_for(parts))],
    )
    _, (gltf, _) = _export_and_parse(store, scene)
    for mesh in gltf["meshes"]:
        for primitive in mesh["primitives"]:
            assert "mode" not in primitive


def test_splice_part_node_single_primitive_mesh_with_own_transform(store):
    glb_bytes, parts = _three_part_source()
    sha = _sha(glb_bytes)
    scene = _scene_with(
        store,
        "part",
        [
            _part_node(
                "n_part", "Part", sha, 0, 1,
                transform={"t": [7, 0, 0], "r": [0, 0, 30], "s": [1, 1, 1]},
            ),
        ],
        assets=[(glb_bytes, _stats_for(parts))],
    )
    _, (gltf, bin_data) = _export_and_parse(store, scene)
    part = _node_by_name(gltf, "Part")
    assert part["translation"] == [7, 0, 0]
    assert part["rotation"] == pytest.approx(
        [0.0, 0.0, math.sin(math.radians(15)), math.cos(math.radians(15))], abs=1e-6
    )
    mesh = gltf["meshes"][part["mesh"]]
    assert mesh["name"] == "mesh0"
    assert len(mesh["primitives"]) == 1
    primitive = mesh["primitives"][0]
    # The exact second source primitive survives; unused source geometry is gone.
    assert primitive["attributes"] == {"POSITION": 0}
    assert len(gltf["meshes"]) == len(gltf["accessors"]) == len(gltf["bufferViews"]) == 1
    accessor = gltf["accessors"][0]
    assert {"min": accessor["min"], "max": accessor["max"]} == parts[1]["bounds"]
    expected = [v for point in _box_positions((2.0, 0.0, 0.0), 1.0) for v in point]
    assert list(struct.unpack("<%df" % len(expected), bin_data)) == expected
    assert gltf["buffers"][0]["byteLength"] == 36 * 12
    assert "material" not in primitive  # the source primitive has none


def test_splice_duplicate_parts_share_mesh(store):
    glb_bytes, parts = _three_part_source()
    sha = _sha(glb_bytes)
    scene = _scene_with(
        store,
        "dup-parts",
        [
            _part_node("n_p1", "Part one", sha, 0, 0),
            _part_node(
                "n_p2", "Part two", sha, 0, 0,
                transform={"t": [1, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
            ),
        ],
        assets=[(glb_bytes, _stats_for(parts))],
    )
    _, (gltf, _) = _export_and_parse(store, scene)
    one = _node_by_name(gltf, "Part one")
    two = _node_by_name(gltf, "Part two")
    assert one["mesh"] == two["mesh"]
    assert gltf["nodes"].index(one) != gltf["nodes"].index(two)
    # Only the live single-primitive mesh remains; both instances share it.
    assert len(gltf["meshes"]) == 1
    assert one["mesh"] == two["mesh"] == 0
    assert len(gltf["accessors"]) == len(gltf["bufferViews"]) == 1


def test_splice_part_material_override_written_once(store):
    src_material = {
        "name": "srcmat",
        "pbrMetallicRoughness": {
            "baseColorFactor": [0.0, 1.0, 0.0, 1.0],
            "metallicFactor": 0.0,
            "roughnessFactor": 0.5,
        },
    }
    glb_bytes, parts = _three_part_source(
        materials=[src_material],
        prim_material={(0, 0): 0, (0, 1): 0},
    )
    sha = _sha(glb_bytes)
    red = {
        "id": "m_red",
        "color": "#ff0000",
        "emissive": "#000000",
        "metalness": 0.0,
        "roughness": 0.6,
        "opacity": 1.0,
        "doubleSide": False,
    }
    scene = _scene_with(
        store,
        "override",
        [
            _part_node("n_p1", "Red one", sha, 0, 0, materialId="m_red"),
            _part_node("n_p2", "Red two", sha, 0, 0, materialId="m_red"),
            _part_node("n_p3", "Plain", sha, 0, 1),
        ],
        assets=[(glb_bytes, _stats_for(parts))],
        materials=[red],
    )
    _, (gltf, _) = _export_and_parse(store, scene)
    names = [m["name"] for m in gltf["materials"]]
    assert names.count("m_red") == 1  # the override, written once
    assert names.count("srcmat") == 1  # the copied source material
    red_index = names.index("m_red")
    assert gltf["materials"][red_index]["pbrMetallicRoughness"]["baseColorFactor"] == [1.0, 0.0, 0.0, 1.0]
    red_one = _node_by_name(gltf, "Red one")
    red_two = _node_by_name(gltf, "Red two")
    plain = _node_by_name(gltf, "Plain")
    # Both overridden parts share one mesh, re-pointed at m_red.
    assert red_one["mesh"] == red_two["mesh"]
    assert gltf["meshes"][red_one["mesh"]]["primitives"][0]["material"] == red_index
    # The part without an override keeps the source material.
    assert gltf["meshes"][plain["mesh"]]["primitives"][0]["material"] == names.index("srcmat")
    assert plain["mesh"] != red_one["mesh"]


def test_splice_material_extension_rides_along_and_texture_indexes_shift(store):
    """Clearcoat on copied material JSON rides along; core + extension
    texture indexes shift by the per-asset texture base."""
    image_b64 = (
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    )
    material_a = {
        "name": "matA",
        "pbrMetallicRoughness": {
            "baseColorFactor": [1.0, 1.0, 1.0, 1.0],
            "baseColorTexture": {"index": 0},
            "metallicFactor": 0.0,
            "roughnessFactor": 0.5,
        },
        "extensions": {
            "KHR_materials_clearcoat": {
                "clearcoatFactor": 0.5,
                "clearcoatTexture": {"index": 0},
            }
        },
    }
    glb_a, parts_a = _three_part_source(
        materials=[material_a],
        textures=[{"source": 0, "sampler": 0}],
        images=[{"uri": "data:image/png;base64,%s" % image_b64}],
        samplers=[{}],
        prim_material={(0, 0): 0},
        extra={"extensionsUsed": ["KHR_materials_clearcoat"]},
    )
    material_b = {
        "name": "matB",
        "pbrMetallicRoughness": {
            "baseColorFactor": [0.0, 0.0, 1.0, 1.0],
            "baseColorTexture": {"index": 0},
            "metallicFactor": 0.0,
            "roughnessFactor": 0.5,
        },
    }
    glb_b, parts_b = _three_part_source(
        materials=[material_b],
        textures=[{"source": 0, "sampler": 0}],
        images=[{"uri": "data:image/png;base64,%s" % image_b64}],
        samplers=[{}],
        prim_material={(0, 0): 0},
    )
    sha_a, sha_b = _sha(glb_a), _sha(glb_b)
    scene = _scene_with(
        store,
        "textures",
        [
            _model_node(store, "textures", sha_a, name="ModelA", node_id="n_a"),
            _model_node(store, "textures", sha_b, name="ModelB", node_id="n_b"),
        ],
        assets=[(glb_a, _stats_for(parts_a)), (glb_b, _stats_for(parts_b))],
    )
    _, (gltf, _) = _export_and_parse(store, scene)
    assert len(gltf["textures"]) == 2
    assert len(gltf["images"]) == 2
    assert gltf["textures"][0]["source"] == 0
    assert gltf["textures"][1]["source"] == 1
    mat_a = [m for m in gltf["materials"] if m["name"] == "matA"][0]
    mat_b = [m for m in gltf["materials"] if m["name"] == "matB"][0]
    # Asset A's texture base is 0; asset B's is 1.
    assert mat_a["pbrMetallicRoughness"]["baseColorTexture"]["index"] == 0
    assert mat_b["pbrMetallicRoughness"]["baseColorTexture"]["index"] == 1
    assert mat_a["extensions"]["KHR_materials_clearcoat"]["clearcoatFactor"] == 0.5
    assert mat_a["extensions"]["KHR_materials_clearcoat"]["clearcoatTexture"]["index"] == 0
    assert gltf.get("extensionsUsed") == [
        "KHR_lights_punctual",
        "KHR_materials_clearcoat",
    ]


def test_splice_copied_camera_precedes_spec_camera(store):
    glb_bytes, parts = _three_part_source(
        cameras=[
            {
                "type": "perspective",
                "perspective": {"yfov": 0.9, "znear": 0.1, "zfar": 50.0},
            }
        ],
        nodes=[
            {"mesh": 0, "name": "mesh0"},
            {"mesh": 1, "name": "mesh1"},
            {"camera": 0, "name": "SrcCam"},
        ],
        scenes=[{"nodes": [0, 1, 2]}],
    )
    sha = _sha(glb_bytes)
    scene = _scene_with(
        store, "camera",
        [_model_node(store, "camera", sha)],
        assets=[(glb_bytes, _stats_for(parts))],
    )
    _, (gltf, _) = _export_and_parse(store, scene)
    assert len(gltf["cameras"]) == 2
    assert gltf["cameras"][0]["perspective"]["yfov"] == 0.9  # spliced, first
    assert gltf["cameras"][1]["perspective"]["yfov"] == pytest.approx(
        math.radians(40), abs=1e-9
    )  # cam_main, second
    src_cam = _node_by_name(gltf, "SrcCam")
    assert src_cam["camera"] == 0
    main_cam = _node_by_name(gltf, "Main camera")
    assert main_cam["camera"] == 1


def test_splice_absent_scenes_uses_unparented_roots(store):
    glb_bytes, parts = _three_part_source(scenes=None)
    sha = _sha(glb_bytes)
    scene = _scene_with(
        store, "no-scenes",
        [_model_node(store, "no-scenes", sha)],
        assets=[(glb_bytes, _stats_for(parts))],
    )
    _, (gltf, _) = _export_and_parse(store, scene)
    model = _node_by_name(gltf, "Model")
    roots = [gltf["nodes"][i] for i in model["children"]]
    assert [n["name"] for n in roots] == ["mesh0", "mesh1"]


def test_splice_other_scenes_reported_ignored(store):
    glb_bytes, parts = _three_part_source(
        scenes=[{"nodes": [0]}, {"nodes": [1]}]
    )
    sha = _sha(glb_bytes)
    scene = _scene_with(
        store, "other-scenes",
        [_model_node(store, "other-scenes", sha)],
        assets=[(glb_bytes, _stats_for(parts))],
    )
    result, (gltf, _) = _export_and_parse(store, scene)
    model = _node_by_name(gltf, "Model")
    # Only the default scene's root is copied.
    assert [gltf["nodes"][i]["name"] for i in model["children"]] == ["mesh0"]
    assert result["stats"]["ignored"] == [
        "asset %s: 1 other scene(s) not copied" % sha
    ]


def test_splice_missing_asset_file_fails(store):
    glb_bytes, parts = _three_part_source()
    sha = _sha(glb_bytes)
    scene = _scene_with(
        store, "missing-file",
        [_model_node(store, "missing-file", sha)],
        assets=[(glb_bytes, _stats_for(parts))],
    )
    (store.assets_dir / ("%s.glb" % sha)).unlink()
    _expect_failed(store, scene)


def test_splice_export_timeout_writes_nothing(store):
    glb_bytes, parts = _three_part_source()
    sha = _sha(glb_bytes)
    scene = _scene_with(
        store, "timeout",
        [_model_node(store, "timeout", sha)],
        assets=[(glb_bytes, _stats_for(parts))],
    )
    with pytest.raises(PlastisError) as excinfo:
        export_scene(scene, store, timeout=0.0)
    assert excinfo.value.code == "EXPORT_TIMEOUT"
    assert list(store.exports_dir.iterdir()) == []

# --- Refusals: one fixture per cut in (8) ------------------------------------

def _refusal_scene(store, scene_id, glb_bytes, parts):
    sha = _sha(glb_bytes)
    return _scene_with(
        store, scene_id,
        [_model_node(store, scene_id, sha)],
        assets=[(glb_bytes, _stats_for(parts))],
    )


def test_splice_refuses_present_mode_other_than_4(store):
    glb_bytes, parts = _three_part_source(prim_mode={(0, 0): 1})
    _expect_failed(store, _refusal_scene(store, "mode", glb_bytes, parts))


def test_splice_refuses_sparse_accessor(store):
    builder = _SourceBuilder()
    acc0, _ = builder.positions((0.0, 0.0, 0.0), 1.0)
    # A sparse accessor with valid index/value ranges (the scan passes
    # it); the splice refuses it for being sparse.
    index_view = builder.add_raw(struct.pack("<H", 0))
    value_view = builder.add_raw(struct.pack("<fff", 9.0, 9.0, 9.0))
    sparse = {
        "bufferView": acc0,
        "componentType": 5126,
        "count": 36,
        "type": "VEC3",
        "min": [-0.5, -0.5, -0.5],
        "max": [0.5, 0.5, 0.5],
        "sparse": {
            "count": 1,
            "indices": {"bufferView": index_view, "componentType": 5123},
            "values": {"bufferView": value_view},
        },
    }
    builder.accessors[acc0] = sparse
    gltf = {
        "asset": {"version": "2.0", "generator": "plastis3d test_splice"},
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": "mesh0"}],
        "meshes": [{"name": "mesh0", "primitives": [{"attributes": {"POSITION": acc0}}]}],
    }
    glb_bytes = builder.pack(gltf)
    parts = [{"meshIndex": 0, "primitiveIndex": 0, "tris": 12, "verts": 36,
              "bounds": {"min": [-0.5, -0.5, -0.5], "max": [0.5, 0.5, 0.5]}}]
    _expect_failed(store, _refusal_scene(store, "sparse", glb_bytes, parts))


# Skins, animations and morph targets are rebased since PR13; their
# acceptance and refusal cuts live in test_deformable_splice.py.


def test_splice_refuses_nonempty_extensions_required(store):
    glb_bytes, parts = _three_part_source(
        extra={"extensionsRequired": ["KHR_materials_clearcoat"]}
    )
    _expect_failed(store, _refusal_scene(store, "extreq", glb_bytes, parts))


def test_splice_copies_punctual_light_and_rebases_its_index(store):
    # Imported light indexes must not point at the scene's own default light.
    lights = [{"type": "directional", "color": [1.0, 1.0, 1.0], "intensity": 1.0}]
    glb_bytes, parts = _three_part_source(
        nodes=[
            {
                "mesh": 0,
                "name": "mesh0",
                "extensions": {"KHR_lights_punctual": {"light": 0}},
            },
            {"mesh": 1, "name": "mesh1"},
        ],
        extra={
            "extensions": {"KHR_lights_punctual": {"lights": lights}},
            "extensionsUsed": ["KHR_lights_punctual"],
        },
    )
    scene = _refusal_scene(store, "node-ext", glb_bytes, parts)
    second = copy.deepcopy(next(n for n in scene["nodes"] if n["kind"] == "model"))
    second["id"] = "second-model"
    scene["nodes"].append(second)
    result = export_scene(scene, store)
    gltf, _ = _parse_glb(result["path"])
    output_lights = gltf["extensions"]["KHR_lights_punctual"]["lights"]
    references = [node["extensions"]["KHR_lights_punctual"]["light"] for node in gltf["nodes"] if "KHR_lights_punctual" in node.get("extensions", {})]
    assert len(references) == len(output_lights) == 3  # scene light plus two instances
    assert len(set(references)) == 3
    assert output_lights[references[-2]] == lights[0]
    assert output_lights[references[-1]] == lights[0]
    assert gltf["extensionsUsed"].count("KHR_lights_punctual") == 1


@pytest.mark.parametrize("extensions", [{"VENDOR_node": {}}, ["invalid"]])
def test_splice_still_refuses_unknown_node_extension(store, extensions):
    data, parts = _three_part_source(nodes=[{"mesh": 0, "extensions": extensions}, {"mesh": 1}])
    _expect_failed(store, _refusal_scene(store, "unknown-node-ext", data, parts))


def test_splice_refuses_extensions_used_not_on_material_or_texture(store):
    glb_bytes, parts = _three_part_source(
        extra={"extensionsUsed": ["KHR_materials_unlit"]}
    )
    _expect_failed(store, _refusal_scene(store, "extused", glb_bytes, parts))


def test_splice_refuses_index_outside_copied_set(store):
    # Primitive material 7 with only one material in the file.
    glb_bytes, parts = _three_part_source(
        materials=[
            {
                "name": "only",
                "pbrMetallicRoughness": {
                    "baseColorFactor": [1.0, 1.0, 1.0, 1.0],
                    "metallicFactor": 0.0,
                    "roughnessFactor": 0.5,
                },
            }
        ],
        prim_material={(0, 0): 7},
    )
    _expect_failed(store, _refusal_scene(store, "bad-index", glb_bytes, parts))


def test_splice_refuses_empty_scenes(store):
    glb_bytes, parts = _three_part_source(scenes=[])
    _expect_failed(store, _refusal_scene(store, "empty-scenes", glb_bytes, parts))


def test_splice_refuses_out_of_range_scene_index(store):
    glb_bytes, parts = _three_part_source(scene=5)
    _expect_failed(store, _refusal_scene(store, "bad-scene", glb_bytes, parts))


def test_splice_refuses_top_level_extensions_only(store):
    # No node extension, no extensionsUsed name to trip first: the
    # top-level extensions object alone is refused because it is
    # never copied.
    glb_bytes, parts = _three_part_source(
        extra={"extensions": {"VENDOR_document": {}}}
    )
    _expect_failed(store, _refusal_scene(store, "top-ext", glb_bytes, parts))


@pytest.mark.parametrize("explode", [True, False])
@pytest.mark.parametrize("source", ["primitive", "imported"])
@pytest.mark.parametrize("same_scene", [True, False])
def test_saved_glb_can_be_reopened_and_saved_repeatedly(store, explode, source, same_scene):
    from plastis3d_scene.import_model import import_bytes

    # Default scenes include a camera and a punctual light, as in the editor.
    scene = store.create_scene("Original", "original")
    if source == "primitive":
        scene["nodes"].append({"id": "box", "name": "Box", "kind": "mesh", "primitive": {"type": "box"}, "materialId": "m_default", "transform": {"t": [0, 0.5, 0], "r": [0, 0, 0], "s": [1, 1, 1]}})
        scene = store.write_scene(scene["id"], scene, base_revision=1)["scene"]
    else:
        import_bytes(scene["id"], store, (FIXTURES / "two-primitive.glb").read_bytes(), original_name="external.glb", source_format="glb", base_revision=1, explode=explode)
        scene = store.get_scene(scene["id"])
    first = export_scene(scene, store)
    data = Path(first["path"]).read_bytes()
    for cycle in range(3):
        reopened = store.get_scene(scene["id"]) if same_scene else store.create_scene("Reopened", "reopened-%d" % cycle)
        import_bytes(reopened["id"], store, data, original_name="saved.glb", source_format="glb", base_revision=reopened["revision"], explode=explode)
        result = export_scene(store.get_scene(reopened["id"]), store)
        # Open adds a file to the scene; repeatedly opening a whole-scene
        # export doubles the geometry when the existing objects stay there.
        assert result["stats"]["tris"] == first["stats"]["tris"] * (2 ** (cycle + 1) if same_scene else 1)
        document, _ = _parse_glb(result["path"])
        lights = document["extensions"]["KHR_lights_punctual"]["lights"]
        for node in document["nodes"]:
            if "KHR_lights_punctual" in node.get("extensions", {}):
                assert 0 <= node["extensions"]["KHR_lights_punctual"]["light"] < len(lights)
        data = Path(result["path"]).read_bytes()


# --- E2E gate test (stage-3 §5) -------------------------------------------------

def _parts_by_index(envelope):
    return {
        (n["meshIndex"], n["primitiveIndex"]): n
        for n in envelope["nodes"]
        if n["kind"] == "part"
    }


def test_e2e_import_edit_export_reimport(data_dir, tmp_path):
    """Import a 4-part GLB, move one part, recolor another, duplicate a
    third, delete a fourth, export, re-import the export, and verify
    the transforms and materials survived."""
    store = Store(data_dir)
    source = tmp_path / "four.glb"
    source.write_bytes(_four_part_glb())
    scene_id = tools_mod.new_scene(name="E2E")["scene"]["id"]
    envelope = tools_mod.import_model(scene=scene_id, baseRevision=1, path=str(source))
    revision = envelope["scene"]["revision"]
    parts = _parts_by_index(envelope)
    assert len(parts) == 4
    moved = parts[(0, 0)]
    recolored = parts[(0, 1)]
    duplicated = parts[(1, 0)]
    deleted = parts[(1, 1)]

    envelope = tools_mod.update_node(
        scene=scene_id, baseRevision=revision, id=moved["id"],
        transform={"t": [1, 2, 3], "r": [0, 0, 0], "s": [1, 1, 1]},
    )
    revision = envelope["scene"]["revision"]
    envelope = tools_mod.set_material(
        scene=scene_id, baseRevision=revision, id="m_red", color="#ff0000",
        assignTo=[recolored["id"]],
    )
    revision = envelope["scene"]["revision"]
    envelope = tools_mod.duplicate_node(
        scene=scene_id, baseRevision=revision, id=duplicated["id"]
    )
    revision = envelope["scene"]["revision"]
    envelope = tools_mod.delete_node(
        scene=scene_id, baseRevision=revision, id=deleted["id"]
    )
    revision = envelope["scene"]["revision"]

    result = tools_mod.export_glb(scene=scene_id)
    assert result["ok"] is True
    assert result["revision"] == revision
    gltf, _ = _parse_glb(result["path"])

    # The moved part's exported node carries the move.
    moved_node = [n for n in gltf["nodes"] if n["name"] == moved["name"]
                  and n.get("translation") == [1, 2, 3]]
    assert len(moved_node) == 1
    # The recolored part's primitive material is red.
    recolored_nodes = [n for n in gltf["nodes"] if n["name"] == recolored["name"]]
    assert len(recolored_nodes) == 1
    prim = gltf["meshes"][recolored_nodes[0]["mesh"]]["primitives"][0]
    material = gltf["materials"][prim["material"]]
    assert material["pbrMetallicRoughness"]["baseColorFactor"] == [1.0, 0.0, 0.0, 1.0]
    # The duplicated part appears twice, on the same shared mesh: the
    # original ("mesh1 0") and the copy ("mesh1 0 copy").
    dup_orig = [n for n in gltf["nodes"] if n["name"] == duplicated["name"]]
    assert len(dup_orig) == 1
    shared_mesh = dup_orig[0]["mesh"]
    assert len([n for n in gltf["nodes"] if n.get("mesh") == shared_mesh]) == 2
    # The deleted part is gone as a node (its spec name no longer
    # appears), and exactly the four surviving part nodes are present.
    # Note: the deleted part's bytes still ride along inside the
    # unreferenced whole-mesh copy (meshes are copied wholesale per
    # asset) — the node is gone, so re-import does not resurrect it.
    assert [n for n in gltf["nodes"] if n["name"] == deleted["name"]] == []
    part_names = sorted(
        n["name"] for n in gltf["nodes"]
        if n["name"] in (moved["name"], recolored["name"], duplicated["name"],
                         duplicated["name"] + " copy")
    )
    assert part_names == sorted([
        moved["name"], recolored["name"], duplicated["name"],
        duplicated["name"] + " copy",
    ])

    # Re-import the export into a fresh scene.
    new_id = tools_mod.new_scene(name="E2E round trip")["scene"]["id"]
    envelope = tools_mod.import_model(
        scene=new_id, baseRevision=1, path=result["path"]
    )
    new_parts = [n for n in envelope["nodes"] if n["kind"] == "part"]
    assert len(new_parts) == 4
    # The moved part: its parent group carries the move.
    moved_groups = [
        n for n in envelope["nodes"]
        if n["kind"] == "group" and n.get("transform", {}).get("t") == [1, 2, 3]
    ]
    assert len(moved_groups) == 1
    moved_children = [
        n for n in envelope["nodes"] if n.get("parent") == moved_groups[0]["id"]
    ]
    assert len(moved_children) == 1 and moved_children[0]["kind"] == "part"
    # The recolored part: its primitive's material in the new asset is red.
    new_asset = envelope["assets"][0]
    new_gltf, _ = _parse_glb(store.assets_dir / ("%s.glb" % new_asset["id"]))
    recolored_groups = [
        n for n in envelope["nodes"]
        if n["kind"] == "group" and n["name"] == recolored["name"]
    ]
    assert len(recolored_groups) == 1
    recolored_parts = [
        n for n in envelope["nodes"]
        if n.get("parent") == recolored_groups[0]["id"] and n["kind"] == "part"
    ]
    assert len(recolored_parts) == 1
    part = recolored_parts[0]
    new_prim = new_gltf["meshes"][part["meshIndex"]]["primitives"][part["primitiveIndex"]]
    new_material = new_gltf["materials"][new_prim["material"]]
    assert new_material["pbrMetallicRoughness"]["baseColorFactor"] == [1.0, 0.0, 0.0, 1.0]
    # The duplicate survived as two parts on one mesh/primitive: the
    # re-imported groups carry the exported node names ("mesh1 0"
    # and "mesh1 0 copy"); their child parts share (meshIndex,
    # primitiveIndex) in the new asset.
    dup_groups = [
        n for n in envelope["nodes"]
        if n["kind"] == "group"
        and n["name"] in (duplicated["name"], duplicated["name"] + " copy")
    ]
    assert len(dup_groups) == 2
    dup_parts = []
    for group in dup_groups:
        children = [
            n for n in envelope["nodes"]
            if n.get("parent") == group["id"] and n["kind"] == "part"
        ]
        assert len(children) == 1
        dup_parts.append(children[0])
    assert (dup_parts[0]["meshIndex"], dup_parts[0]["primitiveIndex"]) == (
        dup_parts[1]["meshIndex"], dup_parts[1]["primitiveIndex"],
    )


def test_e2e_explode_false_locked_model_flow(data_dir, tmp_path):
    """The same flow with explode: false: locked-model behavior, and
    the export has the pre-plan design's shape — one model node, the
    imported roots under it, plus a spec child beside them."""
    store = Store(data_dir)
    source = tmp_path / "four.glb"
    source.write_bytes(_four_part_glb())
    scene_id = tools_mod.new_scene(name="Locked")["scene"]["id"]
    envelope = tools_mod.import_model(
        scene=scene_id, baseRevision=1, path=str(source), explode=False, name="Ship"
    )
    revision = envelope["scene"]["revision"]
    models = [n for n in envelope["nodes"] if n["kind"] == "model"]
    assert len(models) == 1
    model = models[0]
    assert model["name"] == "Ship"
    # Locked-model behavior: set_material refuses, update_node moves.
    with pytest.raises(PlastisError) as excinfo:
        tools_mod.set_material(
            scene=scene_id, baseRevision=revision, id="m_red", color="#ff0000",
            assignTo=[model["id"]],
        )
    assert excinfo.value.code == "NODE_LOCKED"
    envelope = tools_mod.update_node(
        scene=scene_id, baseRevision=revision, id=model["id"],
        transform={"t": [3, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
    )
    revision = envelope["scene"]["revision"]
    envelope = tools_mod.add_node(
        scene=scene_id, baseRevision=revision, name="Ship box", kind="mesh",
        parent=model["id"], transform={"t": [0, 1, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
        primitive={"type": "box"}, materialId="m_default",
    )
    revision = envelope["scene"]["revision"]
    result = tools_mod.export_glb(scene=scene_id)
    assert result["ok"] is True
    gltf, _ = _parse_glb(result["path"])
    ship = _node_by_name(gltf, "Ship")
    assert ship["translation"] == [3, 0, 0]
    assert "mesh" not in ship
    children = [gltf["nodes"][i] for i in ship["children"]]
    assert [n["name"] for n in children] == ["mesh0", "mesh1", "Ship box"]


# --- Checked-in oracle fixture parity ------------------------------------------

def _load_splice_fixture_generator():
    import importlib.util
    import sys

    spec = importlib.util.spec_from_file_location(
        "make_spliced_export_glb", FIXTURES / "make_spliced_export_glb.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_oracle_fixture_matches_fresh_writer_run(tmp_path):
    """The checked-in spliced-export.glb must match a fresh export of
    the oracle scene, so the Node oracle fixture cannot drift
    silently. The build is deterministic: rebuilding twice in two
    tmp stores yields identical bytes."""
    generator = _load_splice_fixture_generator()
    checked_in = json.loads((FIXTURES / "spliced-export.expected.json").read_text(encoding="utf-8"))
    assert generator.build_expected() == checked_in
    first = generator.build_glb(tmp_path / "one")
    second = generator.build_glb(tmp_path / "two")
    # Determinism on THIS machine is byte-exact.
    assert first == second
    fixture = (FIXTURES / "spliced-export.glb").read_bytes()
    if first == fixture:
        return
    # Cross-platform: the fixture was generated on Linux (glibc libm).
    # Node rotations come from math.cos/math.sin (Euler -> quaternion),
    # and another libm (macOS) may differ by 1 ULP, which changes the
    # JSON text (and so every chunk offset) but not what the file means.
    # The BIN chunk must still match byte for byte; the JSON must match
    # exactly except floats, which may differ by a few ULP (decided in
    # pre-PR9 step 6, 2026-11-08: environmental, not drift).
    fresh = tmp_path / "fresh.glb"
    fresh.write_bytes(first)
    fresh_gltf, fresh_bin = _parse_glb(fresh)
    fixture_gltf, fixture_bin = _parse_glb(FIXTURES / "spliced-export.glb")
    assert fresh_bin == fixture_bin
    _assert_json_close(fresh_gltf, fixture_gltf, "$")


def _assert_json_close(a, b, where):
    """Structural JSON equality; floats compare within 1e-12 relative."""
    if isinstance(a, float) or isinstance(b, float):
        assert isinstance(a, (int, float)) and isinstance(b, (int, float)), where
        assert math.isclose(a, b, rel_tol=1e-12, abs_tol=1e-15), (where, a, b)
        return
    assert type(a) is type(b), (where, a, b)
    if isinstance(a, dict):
        assert a.keys() == b.keys(), where
        for key in a:
            _assert_json_close(a[key], b[key], f"{where}.{key}")
    elif isinstance(a, list):
        assert len(a) == len(b), where
        for i, (x, y) in enumerate(zip(a, b)):
            _assert_json_close(x, y, f"{where}[{i}]")
    else:
        assert a == b, (where, a, b)
