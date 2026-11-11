"""PR2 validator tests (Tier 1, stage-1 §5).

Parametric tests for all primitive schemas and segment ranges, plus the
negative cases: parent cycles (A->B->C->A), non-finite numbers (NaN,
Inf), scale=0, invalid color hexes, and the ``part`` validator rules.

Run: pytest tests/python
"""

import pytest

from plastis3d_scene import primitives, spec
from plastis3d_scene.spec import PlastisError
from plastis3d_scene.validate import collect_errors, is_valid, validate_scene

# --- fixtures ------------------------------------------------------------------


def base_scene():
    return spec.new_scene_dict("snowman", "Snowman")


def mesh_node(node_id="n_box", name="Box", material_id="m_default", **overrides):
    node = {
        "id": node_id,
        "name": name,
        "parent": None,
        "kind": "mesh",
        "transform": {"t": [0, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
        "visible": True,
        "primitive": {"type": "box", "width": 1, "height": 1, "depth": 1},
        "materialId": material_id,
    }
    node.update(overrides)
    return node


def asset_row(asset_id="a_model"):
    return {
        "id": asset_id,
        "sha256": "0" * 64,
        "file": "assets/" + "0" * 64 + ".glb",
        "format": "glb",
        "bytes": 1234,
        "originalName": "model.glb",
        "sourceFormat": "glb",
        "stats": {
            "tris": 12,
            "verts": 24,
            "bounds": {"min": [-1, -1, -1], "max": [1, 1, 1]},
            "parts": [
                {
                    "meshIndex": 0,
                    "primitiveIndex": 0,
                    "tris": 12,
                    "verts": 24,
                    "bounds": {"min": [-1, -1, -1], "max": [1, 1, 1]},
                }
            ],
        },
    }


def assert_invalid(scene, code="SPEC_INVALID", path=None):
    errors = collect_errors(scene)
    assert errors, "expected a validation error, got none"
    assert errors[0].code == code, "first error %r, want %s" % (errors[0].to_dict(), code)
    if path is not None:
        assert errors[0].path == path, "path %r, want %r" % (errors[0].path, path)
    with pytest.raises(PlastisError):
        validate_scene(scene)


def assert_valid(scene):
    assert is_valid(scene), collect_errors(scene)


# --- the default scene ----------------------------------------------------------


def test_default_scene_is_valid():
    assert_valid(base_scene())


def test_default_scene_with_mesh_is_valid():
    scene = base_scene()
    scene["nodes"].append(mesh_node())
    assert_valid(scene)


# --- primitive schemas (parametric) ---------------------------------------------


@pytest.mark.parametrize(
    "primitive",
    [
        {"type": "box"},
        {"type": "box", "width": 2, "height": 0.5, "depth": 3},
        {"type": "sphere"},
        {"type": "sphere", "radius": 1, "widthSegments": 3, "heightSegments": 64},
        {"type": "cylinder"},
        {"type": "cylinder", "radiusTop": 0.1, "radiusBottom": 2, "height": 5, "radialSegments": 64},
        {"type": "cone"},
        {"type": "cone", "radius": 1, "height": 2, "radialSegments": 3},
        {"type": "torus"},
        {"type": "torus", "radius": 1, "tube": 0.2, "radialSegments": 3, "tubularSegments": 3},
        {"type": "plane"},
        {"type": "plane", "width": 4, "height": 2},
        {"type": "capsule"},
        {"type": "capsule", "radius": 0.1, "length": 2, "capSegments": 3, "radialSegments": 3},
    ],
)
def test_primitive_schemas_valid(primitive):
    scene = base_scene()
    node = mesh_node()
    node["primitive"] = primitive
    scene["nodes"].append(node)
    assert_valid(scene)
    # The analytic counter agrees with the generated mesh.
    generated = primitives.generate(primitive)
    counts = primitives.count_primitive(primitive)
    assert len(generated["positions"]) // 3 == counts["verts"]
    assert len(generated["indices"]) // 3 == counts["tris"]


@pytest.mark.parametrize("segments", [3, 4, 32, 64])
def test_segment_range_edges_valid(segments):
    for primitive in [
        {"type": "sphere", "widthSegments": segments, "heightSegments": segments},
        {"type": "cylinder", "radialSegments": segments},
        {"type": "cone", "radialSegments": segments},
        {"type": "torus", "radialSegments": segments, "tubularSegments": segments},
        {"type": "capsule", "capSegments": segments, "radialSegments": segments},
    ]:
        scene = base_scene()
        node = mesh_node()
        node["primitive"] = primitive
        scene["nodes"].append(node)
        assert_valid(scene)


@pytest.mark.parametrize("segments", [2, 65, 0, -1, 3.5, "16", True])
def test_segment_range_edges_invalid(segments):
    scene = base_scene()
    node = mesh_node()
    node["primitive"] = {"type": "sphere", "widthSegments": segments, "heightSegments": 12}
    scene["nodes"].append(node)
    assert_invalid(scene, path="/nodes/2/primitive/widthSegments")


@pytest.mark.parametrize(
    "primitive",
    [
        {"type": "box", "width": 0},
        {"type": "box", "width": -1},
        {"type": "sphere", "radius": 0},
        {"type": "torus", "tube": -0.1},
        {"type": "capsule", "length": float("nan")},
        {"type": "unknown"},
        {"type": "box", "radius": 1},  # unknown param for box
        {"width": 1},  # missing type
    ],
)
def test_primitive_params_invalid(primitive):
    scene = base_scene()
    node = mesh_node()
    node["primitive"] = primitive
    scene["nodes"].append(node)
    assert_invalid(scene)


def test_plane_faces_positive_z():
    mesh = primitives.generate({"type": "plane", "width": 2, "height": 2})
    assert mesh["normals"] == [0.0, 0.0, 1.0] * 4
    assert mesh["positions"] == [-1.0, -1.0, 0.0, 1.0, -1.0, 0.0, 1.0, 1.0, 0.0, -1.0, 1.0, 0.0]


def test_floor_rotation_maps_oracle_point():
    # The design oracle: (0, 1, 0) through r=[-90, 0, 0] is (0, 0, -1).
    matrix = primitives.rotation_matrix_xyz([-90, 0, 0])
    point = [0, 1, 0]
    rotated = [sum(matrix[i][k] * point[k] for k in range(3)) for i in range(3)]
    assert rotated == pytest.approx([0.0, 0.0, -1.0], abs=1e-12)


# --- negative: transforms ---------------------------------------------------------


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
def test_nonfinite_transform_numbers(bad):
    scene = base_scene()
    node = mesh_node()
    node["transform"]["t"][0] = bad
    scene["nodes"].append(node)
    assert_invalid(scene, path="/nodes/2/transform/t")


def test_nonfinite_rotation_and_scale():
    scene = base_scene()
    node = mesh_node()
    node["transform"]["r"][1] = float("inf")
    scene["nodes"].append(node)
    assert_invalid(scene, path="/nodes/2/transform/r")
    scene = base_scene()
    node = mesh_node()
    node["transform"]["s"][2] = float("nan")
    scene["nodes"].append(node)
    assert_invalid(scene, path="/nodes/2/transform/s")


@pytest.mark.parametrize("axis", [0, 1, 2])
def test_scale_zero(axis):
    scene = base_scene()
    node = mesh_node()
    node["transform"]["s"][axis] = 0
    scene["nodes"].append(node)
    assert_invalid(scene, path="/nodes/2/transform/s/%d" % axis)


def test_scale_negative_is_valid():
    # Negative scale (a mirror) is legal; only zero breaks normals/picking.
    scene = base_scene()
    node = mesh_node()
    node["transform"]["s"] = [-1, 1, 1]
    scene["nodes"].append(node)
    assert_valid(scene)


# --- negative: colors ---------------------------------------------------------------


@pytest.mark.parametrize("bad_color", ["#gggggg", "#12345", "#1234567", "red", 123456, ""])
def test_invalid_color_hex(bad_color):
    scene = base_scene()
    scene["materials"][0]["color"] = bad_color
    assert_invalid(scene, path="/materials/0/color")


def test_invalid_emissive_and_light_color():
    scene = base_scene()
    scene["materials"][0]["emissive"] = "#xyzxyz"
    assert_invalid(scene, path="/materials/0/emissive")
    scene = base_scene()
    scene["nodes"][0]["light"]["color"] = "white"
    assert_invalid(scene, path="/nodes/0/light/color")


def test_material_range_fields():
    scene = base_scene()
    scene["materials"][0]["metalness"] = 1.5
    assert_invalid(scene, path="/materials/0/metalness")
    scene = base_scene()
    scene["materials"][0]["roughness"] = -0.1
    assert_invalid(scene, path="/materials/0/roughness")
    scene = base_scene()
    scene["materials"][0]["opacity"] = float("nan")
    assert_invalid(scene, path="/materials/0/opacity")


# --- negative: graph integrity ---------------------------------------------------------


def test_parent_cycle_abc():
    scene = base_scene()
    a = mesh_node("n_a", "A", parent="n_c")
    b = mesh_node("n_b", "B", parent="n_a")
    c = mesh_node("n_c", "C", parent="n_b")
    scene["nodes"].extend([a, b, c])
    errors = collect_errors(scene)
    assert any("cycle" in e.message for e in errors), errors
    assert errors[0].code == "SPEC_INVALID"


def test_parent_self_cycle():
    scene = base_scene()
    node = mesh_node("n_a", "A", parent="n_a")
    scene["nodes"].append(node)
    errors = collect_errors(scene)
    assert any("cycle" in e.message for e in errors)


def test_missing_parent_reference():
    scene = base_scene()
    node = mesh_node("n_a", "A", parent="n_ghost")
    scene["nodes"].append(node)
    assert_invalid(scene, path="/nodes/2/parent")


def test_missing_material_reference():
    scene = base_scene()
    node = mesh_node("n_a", "A", material_id="m_ghost")
    scene["nodes"].append(node)
    assert_invalid(scene, path="/nodes/2/materialId")


def test_mesh_without_material():
    scene = base_scene()
    node = mesh_node()
    del node["materialId"]
    scene["nodes"].append(node)
    assert_invalid(scene, path="/nodes/2/materialId")


def test_duplicate_node_ids():
    scene = base_scene()
    scene["nodes"].append(mesh_node("n_box"))
    scene["nodes"].append(mesh_node("n_box"))
    assert_invalid(scene, path="/nodes/3/id")


# --- closed schema -----------------------------------------------------------------------


def test_unknown_node_key_fails():
    scene = base_scene()
    node = mesh_node()
    node["surprise"] = True
    scene["nodes"].append(node)
    assert_invalid(scene, path="/nodes/2/surprise")


def test_unknown_material_key_fails():
    scene = base_scene()
    scene["materials"][0]["surprise"] = 1
    assert_invalid(scene, path="/materials/0/surprise")


def test_unknown_top_level_key_fails():
    scene = base_scene()
    scene["surprise"] = True
    assert_invalid(scene, path="/surprise")


def test_unknown_kind_fails():
    scene = base_scene()
    node = mesh_node()
    node["kind"] = "blob"
    scene["nodes"].append(node)
    assert_invalid(scene, path="/nodes/2/kind")


def test_schema_version_and_units():
    scene = base_scene()
    scene["schema"] = 4
    # PR6: an integer schema newer than this build's is its own code,
    # so the reader never strips fields it does not understand.
    assert_invalid(scene, code="SCHEMA_NEWER", path="/schema")
    scene = base_scene()
    scene["schema"] = "1"
    assert_invalid(scene, code="SPEC_INVALID", path="/schema")
    scene = base_scene()
    scene["schema"] = 0
    assert_invalid(scene, code="SPEC_INVALID", path="/schema")
    scene = base_scene()
    scene["units"] = "cm"
    assert_invalid(scene, path="/units")
    scene = base_scene()
    scene["upAxis"] = "Z"
    assert_invalid(scene, path="/upAxis")


# --- part rules ------------------------------------------------------------------------------


def part_node(**overrides):
    node = {
        "id": "n_part",
        "name": "Part",
        "parent": None,
        "kind": "part",
        "transform": {"t": [0, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
        "visible": True,
        "modelAssetId": "a_model",
        "meshIndex": 0,
        "primitiveIndex": 0,
    }
    node.update(overrides)
    return node


def test_part_without_material_id_is_valid():
    scene = base_scene()
    scene["assets"].append(asset_row())
    scene["nodes"].append(part_node())
    assert_valid(scene)


def test_part_with_valid_material_override_is_valid():
    scene = base_scene()
    scene["assets"].append(asset_row())
    scene["nodes"].append(part_node(materialId="m_default"))
    assert_valid(scene)


@pytest.mark.parametrize("missing", ["modelAssetId", "meshIndex", "primitiveIndex"])
def test_part_missing_required_field(missing):
    scene = base_scene()
    scene["assets"].append(asset_row())
    node = part_node()
    del node[missing]
    scene["nodes"].append(node)
    assert_invalid(scene, path="/nodes/2/" + missing)


def test_part_with_unknown_material_id():
    scene = base_scene()
    scene["assets"].append(asset_row())
    scene["nodes"].append(part_node(materialId="m_ghost"))
    assert_invalid(scene, path="/nodes/2/materialId")


def test_part_with_unknown_asset_id():
    scene = base_scene()
    scene["assets"].append(asset_row())
    scene["nodes"].append(part_node(modelAssetId="a_ghost"))
    assert_invalid(scene, path="/nodes/2/modelAssetId")


def test_model_with_material_id_is_opaque():
    scene = base_scene()
    scene["assets"].append(asset_row())
    node = part_node()
    node["kind"] = "model"
    node["id"] = "n_model"
    del node["meshIndex"]
    del node["primitiveIndex"]
    node["materialId"] = "m_default"
    scene["nodes"].append(node)
    assert_invalid(scene, code="MODEL_MATERIAL_OPAQUE", path="/nodes/2/materialId")


def test_model_node_is_valid():
    scene = base_scene()
    scene["assets"].append(asset_row())
    node = part_node()
    node["kind"] = "model"
    node["id"] = "n_model"
    del node["meshIndex"]
    del node["primitiveIndex"]
    scene["nodes"].append(node)
    assert_valid(scene)


def test_part_stats_validated():
    scene = base_scene()
    asset = asset_row()
    asset["stats"]["parts"][0]["bounds"]["min"] = [1, 0, 0]
    asset["stats"]["parts"][0]["bounds"]["max"] = [0, 0, 0]
    scene["assets"].append(asset)
    scene["nodes"].append(part_node())
    assert_invalid(scene, path="/assets/0/stats/parts/0/bounds")


# --- lights / cameras / clips / texture maps ---------------------------------------------------


def test_spot_light_valid():
    scene = base_scene()
    scene["nodes"][0]["light"] = {
        "type": "spot",
        "color": "#ffffff",
        "intensity": 2.5,
        "distance": 10,
        "decay": 2,
        "angle": 30,
        "penumbra": 0.5,
    }
    assert_valid(scene)


def test_spot_fields_rejected_on_directional():
    scene = base_scene()
    scene["nodes"][0]["light"]["angle"] = 30
    assert_invalid(scene, path="/nodes/0/light/angle")


def test_spot_angle_out_of_range():
    scene = base_scene()
    scene["nodes"][0]["light"] = {
        "type": "spot",
        "color": "#ffffff",
        "intensity": 1,
        "angle": 100,
        "penumbra": 0.5,
    }
    assert_invalid(scene, path="/nodes/0/light/angle")


def test_light_decay_must_be_two():
    scene = base_scene()
    scene["nodes"][0]["light"]["decay"] = 1
    assert_invalid(scene, path="/nodes/0/light/decay")


def test_camera_validation():
    scene = base_scene()
    scene["nodes"][1]["camera"]["fov"] = 200
    assert_invalid(scene, path="/nodes/1/camera/fov")
    scene = base_scene()
    scene["nodes"][1]["camera"]["far"] = 0.001
    assert_invalid(scene, path="/nodes/1/camera/far")


def image_asset_row(asset_id="a_img", fmt="png", width=64, height=32):
    sha = "1" * 64
    return {
        "id": asset_id,
        "sha256": sha,
        "file": "assets/%s.%s" % (sha, "png" if fmt == "png" else "jpg"),
        "format": fmt,
        "bytes": 400,
        "originalName": "wood.png",
        "sourceFormat": fmt,
        "stats": {"width": width, "height": height},
    }


def test_texture_map_fields_valid_and_checked():
    scene = base_scene()
    scene["assets"].append(image_asset_row())
    scene["materials"][0]["baseColorMap"] = "a_img"
    scene["materials"][0]["normalMap"] = "a_img"
    assert_valid(scene)
    scene = base_scene()
    scene["materials"][0]["baseColorMap"] = "a_ghost"
    assert_invalid(scene, path="/materials/0/baseColorMap")
    # A model asset is not an image.
    scene = base_scene()
    scene["assets"].append(asset_row())
    scene["materials"][0]["baseColorMap"] = "a_model"
    assert_invalid(scene, path="/materials/0/baseColorMap")


def test_clip_fields_valid():
    scene = base_scene()
    node = mesh_node()
    node["clips"] = [
        {
            "id": "clip_a",
            "name": "Bounce",
            "duration": 2.0,
            "channels": [
                {
                    "target": "translation",
                    "times": [0, 1, 2],
                    "values": [[0, 0, 0], [0, 1, 0], [0, 0, 0]],
                }
            ],
        }
    ]
    scene["nodes"].append(node)
    assert_valid(scene)


def test_clip_times_must_match_values_and_be_ordered():
    scene = base_scene()
    node = mesh_node()
    node["clips"] = [
        {
            "channels": [
                {"target": "scale", "times": [0, 2, 1], "values": [[1, 1, 1]] * 3}
            ]
        }
    ]
    scene["nodes"].append(node)
    assert_invalid(scene, path="/nodes/2/clips/0/channels/0/times")
    scene = base_scene()
    node = mesh_node()
    node["clips"] = [
        {
            "channels": [
                {"target": "scale", "times": [0, 1], "values": [[1, 1, 1]] * 3}
            ]
        }
    ]
    scene["nodes"].append(node)
    assert_invalid(scene, path="/nodes/2/clips/0/channels/0")


# --- caps ----------------------------------------------------------------------------------------


def test_node_cap():
    scene = base_scene()
    for i in range(2000):
        scene["nodes"].append(
            {
                "id": "n_%04d" % i,
                "name": "G",
                "parent": None,
                "kind": "group",
                "transform": {"t": [0, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
                "visible": True,
            }
        )
    # 2 rig nodes + 2000 groups = 2002 > 2000.
    assert_invalid(scene, code="LIMIT_NODES", path="/nodes")


def test_material_cap():
    scene = base_scene()
    for i in range(256):
        scene["materials"].append(
            {"id": "m_%04d" % i, "color": "#ffffff", "emissive": "#000000"}
        )
    assert_invalid(scene, code="LIMIT_MATERIALS", path="/materials")


def test_asset_cap():
    scene = base_scene()
    for i in range(65):
        asset = asset_row("a_%04d" % i)
        scene["assets"].append(asset)
    assert_invalid(scene, code="LIMIT_ASSETS", path="/assets")


def test_history_limit_enforced():
    scene = base_scene()
    scene["history"]["undo"] = [
        {"label": "x", "at": "2026-11-06T00:00:00Z"} for _ in range(51)
    ]
    assert_invalid(scene, path="/history/undo")
