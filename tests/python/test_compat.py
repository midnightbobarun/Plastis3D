"""PR16 tests (Tier 1): the glTF compatibility report.

One test per row of the checklist (standalone-editor.md "three.js game
fitness", C-20), through the pure document checker and through a real scene
with a stored asset; plus the report's own contract: read-only, bounded,
honest about what it skipped, the tool and the route.
"""

import hashlib
import struct
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from plastis3d_scene import compat, tools
from plastis3d_scene.spec import PlastisError
from plastis3d_scene.store import Store

from test_import import _load_plugin_api_standalone
from test_textures import _png


@pytest.fixture()
def data_dir(tmp_path, monkeypatch):
    path = tmp_path / "data"
    monkeypatch.setenv("PLASTIS3D_DATA_DIR", str(path))
    return path


@pytest.fixture()
def store(data_dir):
    return Store(data_dir)


# --- A document builder ------------------------------------------------------------------


def _doc(points=((0, 0, 0), (1, 0, 0), (0, 1, 0)), *, normals=True, indices=None, **extra):
    """``(gltf, buffers)``: one triangle mesh, optional normals and indices."""
    blob = bytearray()
    accessors, views = [], []

    def add(data, component, count, kind, **more):
        views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(data)})
        blob.extend(data)
        accessors.append({"bufferView": len(views) - 1, "componentType": component, "count": count, "type": kind, **more})
        return len(accessors) - 1

    flat = [c for p in points for c in p]
    attrs = {
        "POSITION": add(
            struct.pack("<%df" % len(flat), *flat), 5126, len(points), "VEC3",
            min=[min(p[a] for p in points) for a in range(3)], max=[max(p[a] for p in points) for a in range(3)],
        )
    }
    if normals:
        attrs["NORMAL"] = add(struct.pack("<%df" % len(flat), *([0.0, 0.0, 1.0] * len(points))), 5126, len(points), "VEC3")
    primitive = {"attributes": attrs}
    if indices is not None:
        primitive["indices"] = add(struct.pack("<%dH" % len(indices), *indices), 5123, len(indices), "SCALAR")
    gltf = {
        "asset": {"version": "2.0"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": [primitive]}],
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"byteLength": len(blob)}],
    }
    gltf.update(extra)
    return gltf, [bytes(blob)]


def _check(gltf_buffers, label="model.glb"):
    gltf, buffers = gltf_buffers
    return compat.check_document(gltf, buffers, label=label, deadline=time.monotonic() + 30)


def _codes(result):
    return [i["code"] for i in result["issues"]]


# --- The checklist, row by row ----------------------------------------------------------


def test_a_clean_file_has_no_findings():
    result = _check(_doc())
    assert result["issues"] == [] and result["unchecked"] == []
    assert result["facts"]["tris"] == 1


def test_required_extensions_outside_the_allowed_three_are_errors():
    bad = _check(_doc(extensionsRequired=["KHR_materials_clearcoat", "KHR_lights_punctual"]))
    assert _codes(bad) == ["EXTENSION_REQUIRED"]
    assert "KHR_materials_clearcoat" in bad["issues"][0]["message"]
    assert bad["issues"][0]["severity"] == "error"
    ok = _check(_doc(extensionsRequired=["KHR_lights_punctual", "KHR_materials_unlit", "KHR_texture_transform"]))
    assert ok["issues"] == []


@pytest.mark.parametrize("field", ["extensionsUsed", "extensionsRequired"])
@pytest.mark.parametrize("name", ["KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_texture_basisu"])
def test_compression_extensions_are_errors_once(field, name):
    result = _check(_doc(**{field: [name]}))
    assert _codes(result) == ["COMPRESSED_EXTENSION"]  # not also EXTENSION_REQUIRED
    assert name in result["issues"][0]["message"]


def test_external_buffers_and_images_are_errors():
    gltf, buffers = _doc()
    gltf["buffers"][0]["uri"] = "model.bin"
    gltf["images"] = [{"uri": "wood.png"}, {"uri": "data:image/png;base64,AAAA"}]
    result = _check((gltf, buffers))
    external = [i for i in result["issues"] if i["code"] == "EXTERNAL_URI"]
    assert len(external) == 2 and all(i["severity"] == "error" for i in external)
    assert "1 image points at a file outside" in " ".join(i["message"] for i in external)  # the data: URI is fine


def test_non_finite_and_zero_scale_transforms_are_errors():
    gltf, buffers = _doc()
    gltf["nodes"] = [{"mesh": 0, "translation": [float("nan"), 0, 0]}, {"scale": [1, 0, 1]}, {"scale": [2, 2, 2]}]
    gltf["scenes"] = [{"nodes": [0, 1, 2]}]
    assert sorted(_codes(_check((gltf, buffers)))) == ["NON_FINITE_TRANSFORM", "ZERO_SCALE"]


def test_missing_normals_is_a_warning_and_counts_meshes():
    result = _check(_doc(normals=False))
    assert _codes(result) == ["MISSING_NORMALS"]
    assert result["issues"][0]["severity"] == "warning"
    assert "1 triangle mesh has no normals" in result["issues"][0]["message"]


def test_a_normal_map_without_tangents_is_a_warning_and_with_them_is_not():
    gltf, buffers = _doc(materials=[{"normalTexture": {"index": 0}}])
    gltf["meshes"][0]["primitives"][0]["material"] = 0
    gltf["accessors"].append({"bufferView": 0, "componentType": 5126, "type": "VEC2", "count": 3})
    gltf["meshes"][0]["primitives"][0]["attributes"]["TEXCOORD_0"] = len(gltf["accessors"]) - 1
    assert _codes(_check((gltf, buffers))) == ["NORMAL_MAP_NO_TANGENTS"]
    gltf["meshes"][0]["primitives"][0]["attributes"]["TANGENT"] = 0
    assert _codes(_check((gltf, buffers))) == []


def test_more_than_sixteen_materials_is_a_warning():
    assert _codes(_check(_doc(materials=[{}] * 16))) == []
    assert _codes(_check(_doc(materials=[{}] * 17))) == ["MANY_MATERIALS"]


def test_alpha_blend_on_more_than_half_the_materials():
    half = [{"alphaMode": "BLEND"}, {"alphaMode": "OPAQUE"}]
    assert _codes(_check(_doc(materials=half))) == []  # exactly half is not more than half
    assert _codes(_check(_doc(materials=half + [{"alphaMode": "BLEND"}]))) == ["ALPHA_BLEND_MAJORITY"]


def test_clips_and_empty_skins():
    assert _codes(_check(_doc(animations=[{}] * 8))) == []
    assert _codes(_check(_doc(animations=[{}] * 9))) == ["MANY_CLIPS"]
    assert _codes(_check(_doc(skins=[{"joints": []}, {"joints": [0]}]))) == ["SKIN_NO_JOINTS"]


def test_a_large_texture_is_information_and_a_non_power_of_two_one_is_not_a_warning():
    big = _png(3000, 2)  # 3000 is not a power of two: no warning for that (C-20)
    small = _png(1000, 3)
    gltf, buffers = _doc()
    blob = bytearray(buffers[0])
    views = gltf["bufferViews"]
    for data in (big, small):
        views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(data)})
        blob.extend(data)
    gltf["images"] = [{"bufferView": len(views) - 2, "mimeType": "image/png"}, {"bufferView": len(views) - 1, "mimeType": "image/png"}]
    result = _check((gltf, [bytes(blob)]))
    assert _codes(result) == ["TEXTURE_LARGE"]
    assert result["issues"][0]["severity"] == "info"
    assert "3000 x 2" in result["issues"][0]["message"]


@pytest.mark.parametrize("scale, flagged", [(1.0, False), (20000.0, True), (0.0004, True), (180.0, False)])
def test_non_meter_extent(scale, flagged):
    points = [(0, 0, 0), (scale, 0, 0), (0, scale, 0)]
    result = _check(_doc(points))
    assert ("NON_METER_EXTENT" in _codes(result)) is flagged


def test_degenerate_triangles_are_counted():
    # One real triangle, one with a repeated corner, one with collinear corners.
    pts = [(0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 0), (1, 0, 0), (1, 0, 0), (0, 0, 0), (1, 0, 0), (2, 0, 0)]
    result = _check(_doc(pts, indices=list(range(9))))
    assert _codes(result) == ["DEGENERATE_TRIANGLES"]
    assert "2 triangles have" in result["issues"][0]["message"]
    assert _check(_doc()).get("issues") == []


def test_the_degenerate_scan_is_bounded_and_says_what_it_skipped(monkeypatch):
    pts = [(0, 0, 0), (1, 0, 0), (0, 1, 0)] * 4
    monkeypatch.setattr(compat, "MAX_DEGENERATE_SCAN_TRIS", 3)
    result = _check(_doc(pts, indices=list(range(12))))
    assert result["unchecked"] and "more than 3 triangles" in result["unchecked"][0]["reason"]
    # An expired deadline stops the scan mid-way and says so.
    monkeypatch.setattr(compat, "MAX_DEGENERATE_SCAN_TRIS", 500_000)
    gltf, buffers = _doc(pts, indices=list(range(12)))
    expired = compat.check_document(gltf, buffers, label="m", deadline=time.monotonic() - 1)
    assert any("time budget" in u["reason"] for u in expired["unchecked"])


# --- A scene --------------------------------------------------------------------------------------


def _scene():
    return tools.new_scene(name="Check")["scene"]["id"]


def _file(tmp_path, name, content):
    path = tmp_path / name
    path.write_bytes(content if isinstance(content, bytes) else content.encode())
    return str(path)


def _stl(triangles):
    out = bytearray(b"x" * 80) + struct.pack("<I", len(triangles))
    for tri in triangles:
        out += struct.pack("<3f", 0, 0, 1)
        for v in tri:
            out += struct.pack("<3f", *v)
        out += b"\x00\x00"
    return bytes(out)


def test_an_empty_scene_has_a_clean_report():
    scene_id = _scene()
    report = tools.check_gltf(scene=scene_id)
    assert report["ok"] is True and report["issues"] == []
    assert report["summary"] == {"errors": 0, "warnings": 0, "infos": 0}
    assert report["target"] == {"kind": "scene"}
    assert report["scene"] == scene_id and report["revision"] == 1


def test_the_report_reads_a_stored_asset(store, tmp_path):
    scene_id = _scene()
    # An STL has no normals and (here) one zero-area triangle.
    path = _file(tmp_path, "plate.stl", _stl([((0, 0, 0), (1, 0, 0), (0, 1, 0)), ((0, 0, 0), (0, 0, 0), (0, 0, 0))]))
    env = tools.import_model(scene=scene_id, baseRevision=1, path=path)
    report = tools.check_gltf(scene=scene_id)
    assert sorted(i["code"] for i in report["issues"]) == ["DEGENERATE_TRIANGLES", "MISSING_NORMALS"]
    assert report["ok"] is True  # warnings do not fail it
    owner = next(n["id"] for n in env["nodes"] if n["kind"] == "part")
    assert {i["where"] for i in report["issues"]} == {"node " + owner}
    assert all(i["provenance"] == "output" and i["nodeIds"] == [owner] for i in report["issues"])
    assert {source["where"] for i in report["issues"] for source in i["sourceFindings"]} == {"plate.stl"}
    narrowed = tools.check_gltf(scene=scene_id, assetId=env["assets"][0]["id"])
    assert narrowed["target"] == {"kind": "asset", "assetId": env["assets"][0]["id"]}
    assert sorted(i["code"] for i in narrowed["issues"]) == ["DEGENERATE_TRIANGLES", "MISSING_NORMALS"]
    assert narrowed["stats"]["tris"] == 2


def test_an_imported_asset_is_checked_once_however_many_nodes_use_it(store, tmp_path):
    scene_id = _scene()
    path = _file(tmp_path, "plate.stl", _stl([((0, 0, 0), (1, 0, 0), (0, 1, 0))]))
    env = tools.import_model(scene=scene_id, baseRevision=1, path=path)
    env = tools.import_model(scene=scene_id, baseRevision=env["scene"]["revision"], path=path, name="Again")
    report = tools.check_gltf(scene=scene_id)
    assert [i["code"] for i in report["issues"]].count("MISSING_NORMALS") == 1
    assert report["stats"]["assetsChecked"] == 1


def test_an_unknown_or_non_model_asset_is_not_found(store, tmp_path):
    scene_id = _scene()
    with pytest.raises(PlastisError) as excinfo:
        tools.check_gltf(scene=scene_id, assetId="f" * 64)
    assert excinfo.value.code == "ASSET_NOT_FOUND"
    with pytest.raises(PlastisError) as excinfo:
        tools.check_gltf(scene="nope")
    assert excinfo.value.code == "SCENE_NOT_FOUND"
    with pytest.raises(PlastisError) as excinfo:
        tools.check_gltf(scene=scene_id, assetId=5)
    assert excinfo.value.code == "SPEC_INVALID"


def test_a_missing_or_changed_asset_file_is_an_error_finding_not_a_crash(store, tmp_path):
    scene_id = _scene()
    env = tools.import_model(scene=scene_id, baseRevision=1, path=_file(tmp_path, "p.stl", _stl([((0, 0, 0), (1, 0, 0), (0, 1, 0))])))
    stored = store.assets_dir / (env["assets"][0]["sha256"] + ".glb")
    original = stored.read_bytes()
    stored.write_bytes(original + b"\x00")
    report = tools.check_gltf(scene=scene_id)
    assert [i["code"] for i in report["issues"]] == ["ASSET_FILE_CHANGED"] and report["ok"] is False
    stored.unlink()
    report = tools.check_gltf(scene=scene_id)
    assert [i["code"] for i in report["issues"]] == ["ASSET_FILE_MISSING"] and report["ok"] is False


def test_triangle_thresholds_use_the_scene_total():
    scene_id = _scene()
    sphere = {"type": "sphere", "widthSegments": 64, "heightSegments": 64}  # 8,064 triangles each
    nodes = [
        {"name": "S%d" % i, "kind": "mesh", "primitive": sphere, "materialId": "m_default",
         "transform": {"t": [0, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]}}
        for i in range(12)
    ]
    env = tools.build_scene(scene=scene_id, baseRevision=1, nodes=nodes)
    assert "TRIANGLES_MOBILE" not in [i["code"] for i in tools.check_gltf(scene=scene_id)["issues"]]  # 96,768
    nodes += [dict(nodes[0], name="Extra%d" % i) for i in range(3)]  # 121,000+
    tools.build_scene(scene=scene_id, baseRevision=env["scene"]["revision"], nodes=nodes)
    issues = tools.check_gltf(scene=scene_id)["issues"]
    assert [i["code"] for i in issues if i["code"].startswith("TRIANGLES")] == ["TRIANGLES_MOBILE"]
    more = nodes + [dict(nodes[0], name="More%d" % i) for i in range(50)]
    tools.build_scene(scene=scene_id, baseRevision=3, nodes=more)
    heavy = [i["code"] for i in tools.check_gltf(scene=scene_id)["issues"] if i["code"].startswith("TRIANGLES")]
    assert heavy == ["TRIANGLES_HEAVY"]  # heavy replaces mobile, never both


def test_scene_level_materials_and_units():
    scene_id = _scene()
    rev = 1
    for i in range(17):
        rev = tools.set_material(scene=scene_id, baseRevision=rev, id="m_%d" % i, color="#ffffff", opacity=0.5)["scene"]["revision"]
    codes = [i["code"] for i in tools.check_gltf(scene=scene_id)["issues"]]
    assert "MANY_MATERIALS" in codes and "ALPHA_BLEND_MAJORITY" in codes
    tools.add_node(scene=scene_id, baseRevision=rev, kind="mesh", name="Tiny", primitive={"type": "box"},
                   materialId="m_default", transform={"t": [0, 0, 0], "r": [0, 0, 0], "s": [0.0002, 0.0002, 0.0002]})
    issues = tools.check_gltf(scene=scene_id)["issues"]
    tiny = [i for i in issues if i["code"] == "NON_METER_EXTENT"]
    assert tiny and tiny[0]["where"] == "Tiny"


def test_the_report_is_read_only_and_repeatable(store, tmp_path):
    scene_id = _scene()
    tools.import_model(scene=scene_id, baseRevision=1, path=_file(tmp_path, "p.stl", _stl([((0, 0, 0), (1, 0, 0), (0, 1, 0))])))
    before = store.get_scene(scene_id)
    files = sorted(p.name for p in store.assets_dir.iterdir())
    first = tools.check_gltf(scene=scene_id)
    second = tools.check_gltf(scene=scene_id)
    assert first == second
    assert store.get_scene(scene_id) == before
    assert sorted(p.name for p in store.assets_dir.iterdir()) == files
    assert list(store.exports_dir.iterdir()) == []


def test_findings_are_ordered_errors_first(store, tmp_path):
    scene_id = _scene()
    env = tools.import_model(scene=scene_id, baseRevision=1, path=_file(tmp_path, "p.stl", _stl([((0, 0, 0), (1, 0, 0), (0, 1, 0))])))
    big = [{"name": "N", "kind": "mesh", "primitive": {"type": "box"}, "materialId": "m_default",
            "transform": {"t": [0, 0, 0], "r": [0, 0, 0], "s": [20000, 1, 1]}}]
    tools.add_node(scene=scene_id, baseRevision=env["scene"]["revision"], **big[0])
    severities = [i["severity"] for i in tools.check_gltf(scene=scene_id)["issues"]]
    assert severities == sorted(severities, key={"error": 0, "warning": 1, "info": 2}.get)


# --- The tool and the route ----------------------------------------------------------------------


def test_the_tool_is_registered_read_only_and_takes_no_revision():
    entry = next(t for t in tools.tool_schemas() if t["name"] == "plastis3d_check_gltf")
    props = entry["schema"]["parameters"]["properties"]
    assert set(props) == {"scene", "assetId"}
    assert entry["schema"]["parameters"]["required"] == ["scene"]
    assert "baseRevision" not in props


@pytest.fixture()
def client(data_dir):
    api = _load_plugin_api_standalone()
    app = FastAPI()
    app.include_router(api.router, prefix="/api/plugins/plastis3d")
    with TestClient(app) as c:
        yield c


def test_route_returns_the_same_report(client, tmp_path):
    sid = client.post("/api/plugins/plastis3d/scenes", json={"name": "R"}).json()["scene"]["id"]
    env = client.post(
        "/api/plugins/plastis3d/scenes/%s/imports" % sid,
        json={"backendPath": _file(tmp_path, "p.stl", _stl([((0, 0, 0), (1, 0, 0), (0, 1, 0))])), "baseRevision": 1},
    ).json()
    response = client.get("/api/plugins/plastis3d/scenes/%s/check" % sid)
    assert response.status_code == 200
    body = response.json()
    assert [i["code"] for i in body["issues"]] == ["MISSING_NORMALS"]
    assert body["revision"] == env["scene"]["revision"]
    narrowed = client.get("/api/plugins/plastis3d/scenes/%s/check" % sid, params={"assetId": env["assets"][0]["id"]})
    assert narrowed.json()["target"]["kind"] == "asset"
    assert client.get("/api/plugins/plastis3d/scenes/%s/check" % sid, params={"assetId": "x" * 64}).status_code == 404
    assert client.get("/api/plugins/plastis3d/scenes/nope/check").status_code == 404


def test_spec_normal_maps_report_tangent_prerequisites_on_shapes_and_selected_parts(store, tmp_path):
    from plastis3d_scene import images
    from test_textures import OBJ_WITH_UV
    sid = _scene()
    env = tools.add_node(scene=sid, baseRevision=1, name="Mapped shape", kind="mesh", primitive={"type": "box"}, materialId="m_default", transform={"t": [0, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]})
    env = images.import_image_bytes(sid, store, _png(), original_name="bump.png", base_revision=env["scene"]["revision"], material_id="m_default", slot="normalMap")
    report = tools.check_gltf(scene=sid)
    assert "NORMAL_MAP_NO_TANGENTS" in [i["code"] for i in report["issues"]]
    sid2 = _scene()
    env = tools.import_model(scene=sid2, baseRevision=1, path=_file(tmp_path, "uv.obj", OBJ_WITH_UV.encode()))
    part = next(n for n in env["nodes"] if n["kind"] == "part")
    env = tools.set_material(scene=sid2, baseRevision=env["scene"]["revision"], id="m_bump", color="#ffffff", assignTo=[part["id"]])
    images.import_image_bytes(sid2, store, _png(), original_name="bump.png", base_revision=env["scene"]["revision"], material_id="m_bump", slot="normalMap")
    report = tools.check_gltf(scene=sid2)
    findings = [i for i in report["issues"] if i["code"] == "NORMAL_MAP_NO_TANGENTS"]
    assert len(findings) == 1 and findings[0]["where"] == "node " + part["id"]
    assert "NORMAL_MAP_NO_UV" not in [i["code"] for i in report["issues"]]
    assert not [u for u in report["unchecked"] if "normal-map prerequisites" in u["what"]]


@pytest.mark.parametrize("component, code, values, expected", [
    (5120, "b", [-128, 127, 0], [-1, 1, 0]),
    (5121, "B", [0, 255, 128], [0, 1, 128 / 255]),
    (5122, "h", [-32768, 32767, 0], [-1, 1, 0]),
    (5123, "H", [0, 65535, 32768], [0, 1, 32768 / 65535]),
])
def test_normalized_interleaved_accessor_values(component, code, values, expected):
    size = struct.calcsize(code)
    stride = 4 * size
    data = b"\0" * stride + struct.pack("<3%s" % code, *values) + b"\0" * size
    doc = {"accessors": [{"bufferView": 0, "componentType": component, "type": "VEC3", "count": 1, "byteOffset": stride, "normalized": True}], "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(data), "byteStride": stride}]}
    view = compat._read_accessor(doc, [data], 0, tuple(compat._COMPONENT))
    assert view[0] == pytest.approx(expected)
    with pytest.raises(IndexError):
        view[1]


def test_accessor_invalid_bounds_and_geometry_indices_are_errors():
    doc, buffers = _doc(indices=[0, 1, 99])
    result = _check((doc, buffers))
    assert "INVALID_GEOMETRY" in _codes(result)
    assert any(i["severity"] == "error" for i in result["issues"] if i["code"] == "INVALID_GEOMETRY")
    doc["bufferViews"][0]["byteStride"] = 1
    result = _check((doc, buffers))
    assert "INVALID_GEOMETRY" in _codes(result)


def test_small_indexed_scan_does_not_expand_a_large_position_accessor():
    import tracemalloc
    count = 1_000_000
    data = bytes(count * 12)
    doc = {"accessors": [{"bufferView": 0, "componentType": 5126, "type": "VEC3", "count": count}, {"bufferView": 1, "componentType": 5121, "type": "SCALAR", "count": 3}], "bufferViews": [{"buffer": 0, "byteLength": len(data)}, {"buffer": 1, "byteLength": 3}], "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1}]}]}
    tracemalloc.start()
    try:
        assert compat._count_degenerate(doc, [data, bytes([0, 1, 2])], time.monotonic() + 10) == (1, 1, None)
        assert tracemalloc.get_traced_memory()[1] < 1024 * 1024
    finally:
        tracemalloc.stop()


def test_document_transform_diagnostics_retain_exact_output_node_indices():
    doc, buffers = _doc()
    doc["nodes"] += [{"scale": [0, 1, 1]}, {"translation": [float("inf"), 0, 0]}]
    result = _check((doc, buffers))
    assert next(i for i in result["issues"] if i["code"] == "ZERO_SCALE")["nodeIndices"] == [1]
    assert next(i for i in result["issues"] if i["code"] == "NON_FINITE_TRANSFORM")["nodeIndices"] == [2]


def test_normalized_extent_uses_decoded_units_and_signed_clamp():
    doc, _ = _doc(normals=False)
    accessor = doc["accessors"][0]
    accessor.update(componentType=5120, normalized=True, min=[-128, 0, 0], max=[127, 0, 0])
    assert compat._extent(doc) == 2
    accessor.update(componentType=5123, min=[0, 0, 0], max=[65535, 0, 0])
    assert compat._extent(doc) == 1



def test_source_and_output_normal_map_requires_actual_texture_coordinates():
    doc, buffers = _doc()
    doc["materials"] = [{"normalTexture": {"index": 0}}]
    doc["meshes"][0]["primitives"][0]["material"] = 0
    result = _check((doc, buffers))
    issue = next(i for i in result["issues"] if i["code"] == "NORMAL_MAP_NO_UV")
    assert issue["severity"] == "error" and issue["primitiveRefs"] == [[0, 0]]
    doc["accessors"].append({"bufferView": 0, "componentType": 5126, "type": "VEC2", "count": 3})
    doc["meshes"][0]["primitives"][0]["attributes"]["TEXCOORD_0"] = len(doc["accessors"]) - 1
    assert "NORMAL_MAP_NO_UV" not in _codes(_check((doc, buffers)))
    attrs = doc["meshes"][0]["primitives"][0]["attributes"]
    attrs["TEXCOORD_1"] = attrs.pop("TEXCOORD_0")
    doc["materials"][0]["normalTexture"]["texCoord"] = 1
    assert "NORMAL_MAP_NO_UV" not in _codes(_check((doc, buffers)))
    doc["materials"][0]["normalTexture"]["texCoord"] = 0
    doc["materials"][0]["normalTexture"]["extensions"] = {"KHR_texture_transform": {"texCoord": 1}}
    assert "NORMAL_MAP_NO_UV" not in _codes(_check((doc, buffers)))
