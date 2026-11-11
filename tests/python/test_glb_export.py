"""PR6 GLB binary tests (Tier 1, stage-3 §5).

Parse the writer's output with ``struct``: header, chunk types and
lengths, 4-byte alignment, valid glTF 2.0 JSON, node parenting,
quaternion conversion, lights, cameras, and materials — plus the
checked-in oracle fixture, which must match a fresh writer run so it
cannot drift silently.

Run: pytest tests/python
"""

import importlib.util
import json
import math
import struct
import sys
from pathlib import Path

import pytest

from plastis3d_scene.export_glb import export_scene
from plastis3d_scene.spec import PlastisError
from plastis3d_scene.store import Store

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
FIXTURES = REPO_ROOT / "tests" / "fixtures"

GLB_MAGIC = 0x46546C67
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942


def _transform(node_id, name, kind, transform=None, **extra):
    node = {
        "id": node_id,
        "name": name,
        "kind": kind,
        "transform": transform or {"t": [0, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
    }
    node.update(extra)
    return node


@pytest.fixture()
def store(tmp_path):
    return Store(tmp_path / "data")


def _build_scene(store, scene_id, nodes, materials=None):
    """Create a scene (default rig) and append ``nodes``/``materials``."""
    scene = store.create_scene("Binary", scene_id)
    scene["nodes"].extend(nodes)
    if materials is not None:
        scene["materials"].extend(materials)
    return store.write_scene(scene_id, scene, base_revision=1)["scene"]


def _export(store, scene_id, nodes, materials=None, **kwargs):
    scene = _build_scene(store, scene_id, nodes, materials)
    return export_scene(scene, store, **kwargs)


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


def _accessor_values(gltf, bin_data, accessor_index):
    """Flat float/int values of one accessor (POSITION/NORMAL/indices)."""
    accessor = gltf["accessors"][accessor_index]
    view = gltf["bufferViews"][accessor["bufferView"]]
    start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    component = accessor["componentType"]
    count = accessor["count"]
    per = {"SCALAR": 1, "VEC3": 3}[accessor["type"]]
    if component == 5126:  # FLOAT
        fmt = "<%df" % (count * per)
        size = 4 * count * per
    elif component == 5123:  # UNSIGNED_SHORT
        fmt = "<%dH" % (count * per)
        size = 2 * count * per
    elif component == 5125:  # UNSIGNED_INT
        fmt = "<%dI" % (count * per)
        size = 4 * count * per
    else:  # pragma: no cover - the writer only emits the above
        raise AssertionError("unexpected componentType %r" % component)
    return list(struct.unpack(fmt, bin_data[start : start + size]))


def _node_by_name(gltf, name):
    return [n for n in gltf["nodes"] if n["name"] == name][0]


# --- Binary structure ----------------------------------------------------------

def test_glb_header_chunks_and_document(store):
    result = _export(
        store,
        "binary",
        [_transform("n_box", "Box", "mesh", primitive={"type": "box"}, materialId="m_default")],
    )
    gltf, bin_data = _parse_glb(result["path"])
    assert gltf["asset"] == {"version": "2.0", "generator": "plastis3d"}
    assert gltf["scene"] == 0
    assert gltf.get("extensionsRequired", []) == []
    assert gltf["buffers"] == [{"byteLength": len(bin_data)}]
    assert len(gltf["bufferViews"]) == 3  # POSITION + NORMAL + indices
    for view in gltf["bufferViews"]:
        assert view["byteOffset"] % 4 == 0
        assert view["buffer"] == 0


def test_glb_node_count_and_group_parenting(store):
    result = _export(
        store,
        "parenting",
        [
            _transform(
                "n_group",
                "Moved group",
                "group",
                transform={"t": [2, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
            ),
            _transform(
                "n_child",
                "Grouped box",
                "mesh",
                transform={"t": [0, 1, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
                parent="n_group",
                primitive={"type": "box"},
                materialId="m_default",
            ),
        ],
    )
    gltf, _ = _parse_glb(result["path"])
    # Default rig (light + camera) + group + child.
    assert len(gltf["nodes"]) == 4
    group = _node_by_name(gltf, "Moved group")
    child = _node_by_name(gltf, "Grouped box")
    group_index = gltf["nodes"].index(group)
    child_index = gltf["nodes"].index(child)
    assert group.get("children") == [child_index]
    assert "mesh" not in group and "camera" not in group and "light" not in group
    assert child["mesh"] == 0
    assert child["translation"] == [0, 1, 0]
    # The child is a root of nothing: only the group is a scene root.
    assert group_index in gltf["scenes"][0]["nodes"]
    assert child_index not in gltf["scenes"][0]["nodes"]


def test_glb_camera_yfov_radians(store):
    result = _export(
        store,
        "cam",
        [_transform("n_box", "Box", "mesh", primitive={"type": "box"}, materialId="m_default")],
    )
    gltf, _ = _parse_glb(result["path"])
    assert len(gltf["cameras"]) == 1
    camera = gltf["cameras"][0]
    assert camera["type"] == "perspective"
    assert camera["perspective"]["yfov"] == pytest.approx(math.radians(40), abs=1e-6)
    assert camera["perspective"]["znear"] == 0.01
    assert camera["perspective"]["zfar"] == 500.0
    cam_node = _node_by_name(gltf, "Main camera")
    assert cam_node["camera"] == 0


def test_glb_floor_rotation_quaternion(store):
    result = _export(
        store,
        "floor",
        [
            _transform(
                "n_floor",
                "Floor",
                "mesh",
                transform={"t": [0, 0, 0], "r": [-90, 0, 0], "s": [1, 1, 1]},
                primitive={"type": "plane"},
                materialId="m_default",
            )
        ],
    )
    gltf, _ = _parse_glb(result["path"])
    floor = _node_by_name(gltf, "Floor")
    assert floor["rotation"] == pytest.approx(
        [-0.70710678, 0, 0, 0.70710678], abs=1e-6
    )
    # The design's oracle point: (0, 1, 0) under r = [-90, 0, 0] lands
    # on (0, 0, -1). Rotate the point by the exported quaternion.
    x, y, z, w = floor["rotation"]
    px, py, pz = 0.0, 1.0, 0.0
    # q * p * q^-1 for a unit quaternion (vector part only).
    tx = 2.0 * (y * pz - z * py)
    ty = 2.0 * (z * px - x * pz)
    tz = 2.0 * (x * py - y * px)
    rotated = [
        px + w * tx + (y * tz - z * ty),
        py + w * ty + (z * tx - x * tz),
        pz + w * tz + (x * ty - y * tx),
    ]
    assert rotated == pytest.approx([0, 0, -1], abs=1e-5)


def test_glb_directional_light_punctual(store):
    result = _export(
        store,
        "light",
        [_transform("n_box", "Box", "mesh", primitive={"type": "box"}, materialId="m_default")],
    )
    gltf, _ = _parse_glb(result["path"])
    assert gltf.get("extensionsUsed") == ["KHR_lights_punctual"]
    lights = gltf["extensions"]["KHR_lights_punctual"]["lights"]
    assert len(lights) == 1
    assert lights[0]["type"] == "directional"
    assert lights[0]["color"] == [1.0, 1.0, 1.0]
    assert lights[0]["intensity"] == 3
    assert "range" not in lights[0]  # directional lights have no range
    node = _node_by_name(gltf, "Key light")
    assert node["extensions"] == {"KHR_lights_punctual": {"light": 0}}


def test_glb_spot_light_cone_angles(store):
    result = _export(
        store,
        "spot",
        [
            _transform("n_box", "Box", "mesh", primitive={"type": "box"}, materialId="m_default"),
            _transform(
                "n_spot",
                "Spot",
                "light",
                light={
                    "type": "spot",
                    "color": "#ffffff",
                    "intensity": 2.0,
                    "distance": 10,
                    "angle": 45,
                    "penumbra": 0.5,
                },
            )
        ],
    )
    gltf, _ = _parse_glb(result["path"])
    lights = gltf["extensions"]["KHR_lights_punctual"]["lights"]
    spot = [entry for entry in lights if entry["type"] == "spot"][0]
    assert spot["range"] == 10
    assert spot["spot"]["outerConeAngle"] == pytest.approx(math.radians(45), abs=1e-9)
    assert spot["spot"]["innerConeAngle"] == pytest.approx(
        math.radians(45) * 0.5, abs=1e-9
    )
    node = _node_by_name(gltf, "Spot")
    assert node["extensions"]["KHR_lights_punctual"]["light"] == lights.index(spot)


def test_glb_material_mapping(store):
    result = _export(
        store,
        "material",
        [
            _transform(
                "n_box",
                "Box",
                "mesh",
                primitive={"type": "box"},
                materialId="m_red",
            ),
            _transform("n_default", "Default box", "mesh", primitive={"type": "box"}, materialId="m_default")
        ],
        materials=[
            {
                "id": "m_red",
                "color": "#ff0000",
                "emissive": "#000000",
                "metalness": 0.0,
                "roughness": 0.6,
                "opacity": 0.5,
                "doubleSide": True,
            }
        ],
    )
    gltf, _ = _parse_glb(result["path"])
    red = [m for m in gltf["materials"] if m["name"] == "m_red"][0]
    assert red["pbrMetallicRoughness"]["baseColorFactor"] == [1.0, 0.0, 0.0, 0.5]
    assert red["pbrMetallicRoughness"]["metallicFactor"] == 0.0
    assert red["pbrMetallicRoughness"]["roughnessFactor"] == 0.6
    assert red["emissiveFactor"] == [0.0, 0.0, 0.0]
    assert red["alphaMode"] == "BLEND"
    assert red["doubleSided"] is True
    default = [m for m in gltf["materials"] if m["name"] == "m_default"][0]
    assert default["alphaMode"] == "OPAQUE"
    assert default["doubleSided"] is False


def test_glb_position_bounds_and_uint16_indices(store):
    result = _export(
        store,
        "bounds",
        [_transform("n_box", "Box", "mesh", primitive={"type": "box"}, materialId="m_default")],
    )
    gltf, bin_data = _parse_glb(result["path"])
    mesh = gltf["meshes"][0]
    primitive = mesh["primitives"][0]
    position = gltf["accessors"][primitive["attributes"]["POSITION"]]
    assert position["componentType"] == 5126
    assert position["count"] == 24
    assert position["min"] == [-0.5, -0.5, -0.5]
    assert position["max"] == [0.5, 0.5, 0.5]
    indices = gltf["accessors"][primitive["indices"]]
    assert indices["componentType"] == 5123  # UNSIGNED_SHORT
    assert indices["count"] == 36
    values = _accessor_values(gltf, bin_data, primitive["indices"])
    assert max(values) == 23
    assert min(values) == 0


def test_glb_export_timeout_writes_nothing(store):
    scene = _build_scene(
        store,
        "timeout",
        [_transform("n_box", "Box", "mesh", primitive={"type": "box"}, materialId="m_default")],
    )
    with pytest.raises(PlastisError) as excinfo:
        export_scene(scene, store, timeout=0.0)
    assert excinfo.value.code == "EXPORT_TIMEOUT"
    assert list(store.exports_dir.iterdir()) == []


# --- Checked-in oracle fixture -------------------------------------------------

def _load_fixture_generator():
    spec = importlib.util.spec_from_file_location(
        "make_primitive_mesh_glb", FIXTURES / "make_primitive_mesh_glb.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_fixture_matches_fresh_writer_run(store):
    """The checked-in primitive-mesh.json must match a fresh export.

    Rebuilds the oracle scene in a tmp store, exports it, and compares
    the per-primitive quantized hashes read back out of the GLB
    accessors — so neither the JSON nor the GLB can drift silently.
    """
    generator = _load_fixture_generator()
    checked_in = json.loads((FIXTURES / "primitive-mesh.json").read_text(encoding="utf-8"))
    assert generator.build_fixture_json() == checked_in

    scene = generator.build_oracle_scene(store)
    result = export_scene(scene, store)
    gltf, bin_data = _parse_glb(result["path"])
    by_name = {mesh["name"]: mesh for mesh in gltf["meshes"]}
    expected = {entry["type"]: entry for entry in checked_in["primitives"]}
    name_by_type = {
        "box": "Box",
        "sphere": "Sphere",
        "cylinder": "Cylinder",
        "cone": "Cone",
        "torus": "Torus",
        "plane": "Plane",
        "capsule": "Capsule",
    }
    for ptype, entry in expected.items():
        mesh = by_name[name_by_type[ptype]]
        primitive = mesh["primitives"][0]
        positions = _accessor_values(
            gltf, bin_data, primitive["attributes"]["POSITION"]
        )
        normals = _accessor_values(gltf, bin_data, primitive["attributes"]["NORMAL"])
        assert generator.quantized_hash(positions, normals) == entry["hash"]
        assert gltf["accessors"][primitive["attributes"]["POSITION"]]["count"] == entry["verts"]
        assert gltf["accessors"][primitive["indices"]]["count"] == entry["tris"] * 3
    # The floor is a second plane: its hash is the plane hash.
    floor = by_name["Floor"]
    primitive = floor["primitives"][0]
    assert generator.quantized_hash(
        _accessor_values(gltf, bin_data, primitive["attributes"]["POSITION"]),
        _accessor_values(gltf, bin_data, primitive["attributes"]["NORMAL"]),
    ) == expected["plane"]["hash"]
    # The fixture's yfov and group-child claims hold in this GLB too.
    assert gltf["cameras"][0]["perspective"]["yfov"] == pytest.approx(
        checked_in["yfov"], abs=1e-12
    )
    group = _node_by_name(gltf, checked_in["groupChild"]["group"])
    child = _node_by_name(gltf, checked_in["groupChild"]["child"])
    assert gltf["nodes"].index(child) in group["children"]
    # And the checked-in GLB itself parses identically.
    checked_gltf, _ = _parse_glb(FIXTURES / "primitive-mesh.glb")
    assert checked_gltf["asset"] == {"version": "2.0", "generator": "plastis3d"}
    assert len(checked_gltf["nodes"]) == len(gltf["nodes"])
