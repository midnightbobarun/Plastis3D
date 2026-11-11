"""PR12 tests (Tier 1): OBJ, STL and PLY import.

Every fixture is built in the test, well under 100 KB, and lives in
``tmp_path`` (outside the plugin root, which the import denylist
refuses). Nothing is read from the old Plastis web app.
"""

import base64
import hashlib
import json
import math
import os
import struct
import time
from pathlib import Path

import pytest

from plastis3d_scene import glb as glb_mod
from plastis3d_scene import import_model as import_model_mod
from plastis3d_scene import mesh_import, tools
from plastis3d_scene.spec import PlastisError
from plastis3d_scene.store import Store


@pytest.fixture()
def store(tmp_path, monkeypatch):
    data_dir = tmp_path / "data"
    monkeypatch.setenv("PLASTIS3D_DATA_DIR", str(data_dir))
    return Store(data_dir)


def _scene():
    return tools.new_scene(name="Mesh")["scene"]["id"]


def _import(tmp_path, name, content, **kwargs):
    path = tmp_path / "files" / name
    path.parent.mkdir(exist_ok=True)
    path.write_bytes(content if isinstance(content, bytes) else content.encode("utf-8"))
    scene_id = kwargs.pop("scene_id", None) or _scene()
    envelope = tools.import_model(scene=scene_id, baseRevision=kwargs.pop("rev", 1), path=str(path), **kwargs)
    return scene_id, envelope


def _stored_gltf(store, envelope):
    asset = envelope["assets"][0]
    raw = (store.assets_dir / ("%s.glb" % asset["sha256"])).read_bytes()
    scan = glb_mod.scan(raw, source_format="glb", deadline=time.monotonic() + 30)
    return asset, scan


def _accessor_floats(scan, accessor_index):
    accessor = scan.gltf["accessors"][accessor_index]
    view = scan.gltf["bufferViews"][accessor["bufferView"]]
    width = {"VEC2": 2, "VEC3": 3, "VEC4": 4, "SCALAR": 1}[accessor["type"]]
    start = view["byteOffset"] + accessor.get("byteOffset", 0)
    blob = scan.buffers[0]
    return list(struct.unpack_from("<%df" % (accessor["count"] * width), blob, start))


def _accessor_indices(scan, accessor_index):
    accessor = scan.gltf["accessors"][accessor_index]
    view = scan.gltf["bufferViews"][accessor["bufferView"]]
    code = {5123: "H", 5125: "I"}[accessor["componentType"]]
    return list(
        struct.unpack_from(
            "<%d%s" % (accessor["count"], code), scan.buffers[0], view["byteOffset"]
        )
    )


# A unit-ish square as two triangles, 4 vertices.
SQUARE_VERTS = [(0, 0, 0), (180, 0, 0), (180, 90, 0), (0, 90, 0)]


def _binary_stl(triangles, header=b"binary stl"):
    out = bytearray(header.ljust(80, b" "))
    out += struct.pack("<I", len(triangles))
    for tri in triangles:
        out += struct.pack("<3f", 0, 0, 1)
        for vertex in tri:
            out += struct.pack("<3f", *vertex)
        out += b"\x00\x00"
    return bytes(out)


def _ascii_stl(triangles):
    lines = ["solid test"]
    for tri in triangles:
        lines.append("facet normal 0 0 1")
        lines.append("outer loop")
        for vertex in tri:
            lines.append("vertex %r %r %r" % tuple(float(v) for v in vertex))
        lines.append("endloop")
        lines.append("endfacet")
    lines.append("endsolid test")
    return "\n".join(lines) + "\n"


SQUARE_TRIS = [
    (SQUARE_VERTS[0], SQUARE_VERTS[1], SQUARE_VERTS[2]),
    (SQUARE_VERTS[0], SQUARE_VERTS[2], SQUARE_VERTS[3]),
]


# --- STL ----------------------------------------------------------------------------


@pytest.mark.parametrize("kind", ["binary", "ascii"])
def test_stl_imports_as_one_mesh_with_no_unit_conversion(store, tmp_path, kind):
    data = _binary_stl(SQUARE_TRIS) if kind == "binary" else _ascii_stl(SQUARE_TRIS)
    _scene_id, envelope = _import(tmp_path, "plate.stl", data)
    asset, scan = _stored_gltf(store, envelope)
    assert asset["sourceFormat"] == "stl"
    assert asset["originalName"] == "plate.stl"
    assert asset["stats"]["tris"] == 2
    assert asset["stats"]["verts"] == 6
    assert asset["stats"]["drawable"] is True
    # 180 mm stays 180 units (no axis or unit conversion).
    assert asset["stats"]["bounds"] == {"min": [0.0, 0.0, 0.0], "max": [180.0, 90.0, 0.0]}
    assert asset["id"] == hashlib.sha256(
        (store.assets_dir / ("%s.glb" % asset["sha256"])).read_bytes()
    ).hexdigest()
    parts = [n for n in envelope["nodes"] if n["kind"] == "part"]
    assert len(parts) == 1
    assert (parts[0]["meshIndex"], parts[0]["primitiveIndex"]) == (0, 0)
    assert len(scan.gltf["meshes"]) == 1
    assert len(scan.gltf["meshes"][0]["primitives"]) == 1
    wrapper = [n for n in envelope["nodes"] if n["kind"] == "group" and n["parent"] is None][0]
    assert wrapper["name"] == "plate"
    assert wrapper["transform"]["s"] == [1.0, 1.0, 1.0]


def test_stl_binary_with_solid_header_is_still_binary(store, tmp_path):
    data = _binary_stl(SQUARE_TRIS, header=b"solid exported by a tool")
    _scene_id, envelope = _import(tmp_path, "plate.stl", data)
    assert envelope["assets"][0]["stats"]["tris"] == 2


def test_stl_explode_false_gives_one_locked_model(store, tmp_path):
    _scene_id, envelope = _import(tmp_path, "plate.stl", _binary_stl(SQUARE_TRIS), explode=False)
    models = [n for n in envelope["nodes"] if n["kind"] == "model"]
    assert len(models) == 1
    assert models[0].get("locked", True)


def test_stl_big_endian_and_truncated_are_refused(store, tmp_path):
    big = bytearray(b"x" * 80) + struct.pack(">I", 2) + b"\x00" * 100
    with pytest.raises(PlastisError) as excinfo:
        _import(tmp_path, "be.stl", bytes(big))
    assert excinfo.value.code == "IMPORT_FORMAT"
    assert "big-endian" in str(excinfo.value)

    truncated = _binary_stl(SQUARE_TRIS)[:-20]
    with pytest.raises(PlastisError) as excinfo:
        _import(tmp_path, "cut.stl", truncated)
    assert excinfo.value.code == "IMPORT_FORMAT"
    assert "truncated" in str(excinfo.value)
    assert list(store.assets_dir.iterdir()) == []


def test_stl_ascii_malformed_refused(tmp_path, store):
    bad = "solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nendloop\nendfacet\nendsolid\n"
    with pytest.raises(PlastisError) as excinfo:
        _import(tmp_path, "bad.stl", bad)
    assert excinfo.value.code == "IMPORT_FORMAT"
    nan = _ascii_stl(SQUARE_TRIS).replace("180.0", "nan", 1)
    with pytest.raises(PlastisError) as excinfo:
        _import(tmp_path, "nan.stl", nan)
    assert excinfo.value.code == "IMPORT_FORMAT"
    assert list(store.assets_dir.iterdir()) == []


def test_stl_vertex_cap_is_checked_before_allocating(store, tmp_path, monkeypatch):
    # ASCII: counted from the text, before any value is parsed.
    lots = "solid x\nfacet normal 0 0 1\n" + ("vertex 0 0 0\n" * 5_000_001)
    with pytest.raises(PlastisError) as excinfo:
        mesh_import.convert(lots.encode(), "stl", name="x", deadline=time.monotonic() + 30)
    assert excinfo.value.code == "IMPORT_TOO_COMPLEX"
    # Binary: the declared triangle count is checked before the records are read.
    monkeypatch.setattr(mesh_import, "MAX_VERTICES", 5)
    with pytest.raises(PlastisError) as excinfo:
        mesh_import.convert(_binary_stl(SQUARE_TRIS), "stl", name="x", deadline=time.monotonic() + 30)
    assert excinfo.value.code == "IMPORT_TOO_COMPLEX"


# --- OBJ ----------------------------------------------------------------------------

OBJ_QUAD = """# a quad with normals and uvs
mtllib quad.mtl
v 0 0 0
v 2 0 0
v 2 2 0
v 0 2 0
vt 0 0
vt 1 0
vt 1 1
vt 0 1
vn 0 0 1
usemtl red
f 1/1/1 2/2/1 3/3/1 4/4/1
"""
MTL_RED = """newmtl blue
Kd 0 0 1
newmtl red
Kd 1 0 0
d 0.5
map_Kd texture.png
"""


def test_obj_fan_triangulates_with_normals_uvs_and_first_material(store, tmp_path):
    (tmp_path / "files").mkdir()
    (tmp_path / "files" / "quad.mtl").write_text(MTL_RED)
    texture = tmp_path / "files" / "texture.png"
    texture.write_bytes(b"not read")
    _scene_id, envelope = _import(tmp_path, "quad.obj", OBJ_QUAD)
    asset, scan = _stored_gltf(store, envelope)
    assert asset["sourceFormat"] == "obj"
    assert asset["stats"]["tris"] == 2
    assert asset["stats"]["verts"] == 4  # four unique (v, vt, vn) corners
    primitive = scan.gltf["meshes"][0]["primitives"][0]
    assert set(primitive["attributes"]) == {"POSITION", "NORMAL", "TEXCOORD_0"}
    assert _accessor_indices(scan, primitive["indices"]) == [0, 1, 2, 0, 2, 3]
    uvs = _accessor_floats(scan, primitive["attributes"]["TEXCOORD_0"])
    assert uvs[:4] == [0.0, 1.0, 1.0, 1.0]  # v is flipped: glTF's origin is top-left
    material = scan.gltf["materials"][0]
    assert material["name"] == "red"
    assert material["pbrMetallicRoughness"]["baseColorFactor"] == [1.0, 0.0, 0.0, 0.5]
    assert material["alphaMode"] == "BLEND"
    assert any("map_" in line for line in asset["stats"]["ignored"])


def test_obj_negative_indexes_and_second_material_listed(store, tmp_path):
    text = """v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
usemtl first
f -4 -3 -2
usemtl second
f -4 -2 -1
"""
    _scene_id, envelope = _import(tmp_path, "neg.obj", text)
    asset, scan = _stored_gltf(store, envelope)
    assert asset["stats"]["tris"] == 2
    primitive = scan.gltf["meshes"][0]["primitives"][0]
    assert "NORMAL" not in primitive["attributes"]  # no vn: flat shading by the loader
    assert any("first material" in line and "second" in line for line in asset["stats"]["ignored"])
    assert scan.gltf["materials"][0]["name"] == "first"
    # No MTL named: the default colour is kept.
    assert scan.gltf["materials"][0]["pbrMetallicRoughness"]["baseColorFactor"] == [0.8, 0.8, 0.8, 1.0]


def test_obj_default_material_without_usemtl(store, tmp_path):
    text = "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"
    _scene_id, envelope = _import(tmp_path, "tri.obj", text)
    _asset, scan = _stored_gltf(store, envelope)
    assert scan.gltf["materials"][0]["name"] == "m_default"


def test_obj_missing_mtl_uses_default_and_says_so(store, tmp_path):
    _scene_id, envelope = _import(tmp_path, "quad.obj", OBJ_QUAD)
    asset, scan = _stored_gltf(store, envelope)
    assert any("not found" in line for line in asset["stats"]["ignored"])
    assert scan.gltf["materials"][0]["pbrMetallicRoughness"]["baseColorFactor"] == [0.8, 0.8, 0.8, 1.0]


@pytest.mark.parametrize("mtllib", ["../secret.mtl", "/etc/hosts", "sub/../../escape.mtl"])
def test_obj_mtllib_outside_directory_is_denied_and_not_opened(store, tmp_path, mtllib):
    (tmp_path / "secret.mtl").write_text("newmtl red\nKd 0 1 0\n")
    (tmp_path / "escape.mtl").write_text("newmtl red\nKd 0 1 0\n")
    text = "mtllib %s\nv 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl red\nf 1 2 3\n" % mtllib
    scene_id = _scene()
    with pytest.raises(PlastisError) as excinfo:
        _import(tmp_path, "evil.obj", text, scene_id=scene_id)
    assert excinfo.value.code == "IMPORT_PATH_DENIED"
    assert list(store.assets_dir.iterdir()) == []
    assert store.get_scene(scene_id)["revision"] == 1


def test_obj_mtllib_symlink_out_of_directory_denied(store, tmp_path):
    outside = tmp_path / "outside.mtl"
    outside.write_text("newmtl red\nKd 0 1 0\n")
    (tmp_path / "files").mkdir()
    (tmp_path / "files" / "link.mtl").symlink_to(outside)
    text = "mtllib link.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl red\nf 1 2 3\n"
    with pytest.raises(PlastisError) as excinfo:
        _import(tmp_path, "linked.obj", text)
    assert excinfo.value.code == "IMPORT_PATH_DENIED"


def test_obj_never_opens_texture_maps(store, tmp_path, monkeypatch):
    (tmp_path / "files").mkdir()
    (tmp_path / "files" / "quad.mtl").write_text(MTL_RED)
    (tmp_path / "files" / "texture.png").write_bytes(b"png")
    opened = []
    real_open = os.open

    def spy(path, *args, **kwargs):
        opened.append(os.fspath(path))
        return real_open(path, *args, **kwargs)

    monkeypatch.setattr(import_model_mod.os, "open", spy)
    _import(tmp_path, "quad.obj", OBJ_QUAD)
    assert not any(p.endswith("texture.png") for p in opened)
    assert any(p.endswith("quad.mtl") for p in opened)


def test_obj_mtl_inode_change_is_denied(store, tmp_path, monkeypatch):
    (tmp_path / "files").mkdir()
    mtl = tmp_path / "files" / "quad.mtl"
    mtl.write_text(MTL_RED)
    other = tmp_path / "other.mtl"
    other.write_text("newmtl red\nKd 0 1 0\n")
    real_open = os.open

    def swap(path, *args, **kwargs):
        if os.fspath(path).endswith("quad.mtl"):
            return real_open(other, *args, **kwargs)
        return real_open(path, *args, **kwargs)

    monkeypatch.setattr(import_model_mod.os, "open", swap)
    with pytest.raises(PlastisError) as excinfo:
        _import(tmp_path, "quad.obj", OBJ_QUAD)
    assert excinfo.value.code == "IMPORT_PATH_DENIED"


@pytest.mark.parametrize(
    "body",
    [
        "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 9\n",  # index out of range
        "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 0 1 2\n",  # index 0
        "v 0 0 0\nv 1 0 x\nv 0 1 0\nf 1 2 3\n",  # not numeric
        "v 0 0 0\nv 1 0 0\nv 0 1 0\n",  # no faces
        "v 0 0 0\nv 1e999 0 0\nv 0 1 0\nf 1 2 3\n",  # not finite
        "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1/1 2/1 3/1\n",  # vt index with no vt lines
    ],
)
def test_obj_malformed_refused_and_writes_nothing(store, tmp_path, body):
    scene_id = _scene()
    with pytest.raises(PlastisError) as excinfo:
        _import(tmp_path, "bad.obj", body, scene_id=scene_id)
    assert excinfo.value.code == "IMPORT_FORMAT"
    assert list(store.assets_dir.iterdir()) == []
    assert store.get_scene(scene_id)["revision"] == 1


def test_obj_vertex_cap_refused_before_parsing(store, tmp_path):
    body = b"v 0 0 0\n" * 5_000_001
    with pytest.raises(PlastisError) as excinfo:
        mesh_import.convert(body, "obj", name="x", deadline=time.monotonic() + 30)
    assert excinfo.value.code == "IMPORT_TOO_COMPLEX"


def test_obj_lines_and_points_are_reported_not_imported(store, tmp_path):
    text = "v 0 0 0\nv 1 0 0\nv 0 1 0\nl 1 2\np 3\nf 1 2 3\n"
    _scene_id, envelope = _import(tmp_path, "mix.obj", text)
    assert any("line or point" in line for line in envelope["assets"][0]["stats"]["ignored"])


# --- PLY ----------------------------------------------------------------------------


def _ply_header(fmt, vertices, faces, colors=True, normals=False, extra=""):
    props = ["property float x", "property float y", "property float z"]
    if normals:
        props += ["property float nx", "property float ny", "property float nz"]
    if colors:
        props += ["property uchar red", "property uchar green", "property uchar blue"]
    return (
        "ply\nformat %s 1.0\ncomment made by a test\n%selement vertex %d\n%s\n"
        "element face %d\nproperty list uchar int vertex_indices\nend_header\n"
        % (fmt, extra, vertices, "\n".join(props), faces)
    )


PLY_COLORS = [(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0)]


def _ply_ascii():
    lines = [_ply_header("ascii", 4, 1).rstrip("\n")]
    for (x, y, z), (r, g, b) in zip(SQUARE_VERTS, PLY_COLORS):
        lines.append("%s %s %s %d %d %d" % (x, y, z, r, g, b))
    lines.append("4 0 1 2 3")  # a quad: fan-triangulated
    return ("\n".join(lines) + "\n").encode()


def _ply_binary(endian):
    out = bytearray(_ply_header("binary_little_endian" if endian == "<" else "binary_big_endian", 4, 1).encode())
    for (x, y, z), (r, g, b) in zip(SQUARE_VERTS, PLY_COLORS):
        out += struct.pack(endian + "3f3B", x, y, z, r, g, b)
    out += struct.pack(endian + "B4i", 4, 0, 1, 2, 3)
    return bytes(out)


@pytest.mark.parametrize(
    "data",
    [_ply_ascii(), _ply_binary("<"), _ply_binary(">")],
    ids=["ascii", "little_endian", "big_endian"],
)
def test_ply_all_encodings_give_colours_and_fan_triangles(store, tmp_path, data):
    _scene_id, envelope = _import(tmp_path, "model.ply", data)
    asset, scan = _stored_gltf(store, envelope)
    assert asset["sourceFormat"] == "ply"
    assert asset["stats"]["tris"] == 2
    assert asset["stats"]["verts"] == 4
    assert asset["stats"]["bounds"]["max"] == [180.0, 90.0, 0.0]
    primitive = scan.gltf["meshes"][0]["primitives"][0]
    assert _accessor_indices(scan, primitive["indices"]) == [0, 1, 2, 0, 2, 3]
    color_accessor = scan.gltf["accessors"][primitive["attributes"]["COLOR_0"]]
    assert color_accessor["componentType"] == 5121 and color_accessor["normalized"] is True
    assert color_accessor["type"] == "VEC4"
    view = scan.gltf["bufferViews"][color_accessor["bufferView"]]
    raw = scan.buffers[0][view["byteOffset"] : view["byteOffset"] + 16]
    assert list(raw) == [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]


def test_ply_skips_unknown_elements_and_properties_and_says_so(store, tmp_path):
    header = (
        "ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\n"
        "property float z\nproperty float quality\nelement face 1\n"
        "property list uchar int vertex_indices\nelement edge 1\n"
        "property int vertex1\nproperty int vertex2\nend_header\n"
    )
    body = "0 0 0 9\n1 0 0 9\n0 1 0 9\n3 0 1 2\n0 1\n"
    _scene_id, envelope = _import(tmp_path, "extra.ply", header + body)
    ignored = " ".join(envelope["assets"][0]["stats"]["ignored"])
    assert "edge" in ignored and "quality" in ignored
    assert envelope["assets"][0]["stats"]["tris"] == 1


def test_ply_binary_with_skipped_variable_element(store, tmp_path):
    header = (
        "ply\nformat binary_little_endian 1.0\nelement vertex 3\nproperty float x\n"
        "property float y\nproperty float z\nelement face 1\n"
        "property list uchar int vertex_indices\nproperty uchar flag\n"
        "end_header\n"
    ).encode()
    body = b"".join(struct.pack("<3f", *v) for v in [(0, 0, 0), (1, 0, 0), (0, 1, 0)])
    body += struct.pack("<B3iB", 3, 0, 1, 2, 7)
    _scene_id, envelope = _import(tmp_path, "flag.ply", header + body)
    assert envelope["assets"][0]["stats"]["tris"] == 1


@pytest.mark.parametrize(
    "mutate, expect",
    [
        (lambda d: d.replace(b"format binary_little_endian 1.0", b"format binary_little_endian 2.0"), "1.0"),
        (lambda d: d[:-6], "truncated"),
        (lambda d: d.replace(b"element face 1", b"element face 0"), "faces"),
        (lambda d: d.replace(b"vertex_indices", b"weird_name"), "vertex_indices"),
        (lambda d: d.replace(b"property float x", b"property float q"), "'x'"),
        (lambda d: d.replace(b"property list uchar int", b"property list float int"), "integer"),
    ],
)
def test_ply_refusals(store, tmp_path, mutate, expect):
    scene_id = _scene()
    with pytest.raises(PlastisError) as excinfo:
        _import(tmp_path, "bad.ply", mutate(_ply_binary("<")), scene_id=scene_id)
    assert excinfo.value.code == "IMPORT_FORMAT"
    assert expect in str(excinfo.value)
    assert list(store.assets_dir.iterdir()) == []


def test_ply_declared_vertex_cap_refused_before_reading(store, tmp_path):
    header = (
        "ply\nformat binary_little_endian 1.0\nelement vertex 5000001\nproperty float x\n"
        "property float y\nproperty float z\nelement face 1\n"
        "property list uchar int vertex_indices\nend_header\n"
    ).encode()
    with pytest.raises(PlastisError) as excinfo:
        _import(tmp_path, "huge.ply", header)
    assert excinfo.value.code == "IMPORT_TOO_COMPLEX"


def test_ply_declared_count_larger_than_the_file_is_truncated_not_allocated(store, tmp_path):
    header = (
        "ply\nformat binary_little_endian 1.0\nelement vertex 4000000\nproperty float x\n"
        "property float y\nproperty float z\nelement face 1\n"
        "property list uchar int vertex_indices\nend_header\n"
    ).encode()
    with pytest.raises(PlastisError) as excinfo:
        _import(tmp_path, "lies.ply", header + b"\x00" * 24)
    assert excinfo.value.code == "IMPORT_FORMAT"
    assert "truncated" in str(excinfo.value)


def test_ply_face_index_out_of_range_refused(store, tmp_path):
    data = _ply_ascii().replace(b"4 0 1 2 3", b"4 0 1 2 9")
    with pytest.raises(PlastisError) as excinfo:
        _import(tmp_path, "oob.ply", data)
    assert excinfo.value.code == "IMPORT_FORMAT"


def test_ply_normals_become_normal_attribute(store, tmp_path):
    header = _ply_header("ascii", 3, 1, colors=False, normals=True)
    body = "0 0 0 0 0 1\n1 0 0 0 0 1\n0 1 0 0 0 1\n3 0 1 2\n"
    _scene_id, envelope = _import(tmp_path, "n.ply", header + body)
    _asset, scan = _stored_gltf(store, envelope)
    attrs = scan.gltf["meshes"][0]["primitives"][0]["attributes"]
    assert "NORMAL" in attrs and "COLOR_0" not in attrs


# --- Shared behaviour -----------------------------------------------------------------


def test_deadline_is_honoured(store, tmp_path):
    with pytest.raises(PlastisError) as excinfo:
        mesh_import.convert(_binary_stl(SQUARE_TRIS), "stl", name="x", deadline=time.monotonic() - 1)
    assert excinfo.value.code == "IMPORT_TIMEOUT"


def test_reimport_of_the_same_file_shares_one_asset(store, tmp_path):
    scene_id, first = _import(tmp_path, "plate.stl", _binary_stl(SQUARE_TRIS))
    path = tmp_path / "files" / "plate.stl"
    second = tools.import_model(scene=scene_id, baseRevision=first["scene"]["revision"], path=str(path))
    assert len(second["assets"]) == 1
    assert len(list(store.assets_dir.iterdir())) == 1


def test_denylist_still_applies_to_mesh_files(store, tmp_path):
    secret = tmp_path / "credentials.json"
    secret.write_bytes(b"{}")
    link = tmp_path / "thing.stl"
    link.symlink_to(secret)
    with pytest.raises(PlastisError) as excinfo:
        tools.import_model(scene=_scene(), baseRevision=1, path=str(link))
    assert excinfo.value.code == "IMPORT_PATH_DENIED"


def test_undo_removes_the_import(store, tmp_path):
    scene_id, envelope = _import(tmp_path, "plate.stl", _binary_stl(SQUARE_TRIS))
    undone = tools.undo(scene=scene_id, baseRevision=envelope["scene"]["revision"])
    assert not [n for n in undone["nodes"] if n["kind"] in ("part", "model")]


@pytest.mark.parametrize(
    "name, data",
    [
        ("plate.stl", _binary_stl(SQUARE_TRIS)),
        ("quad.obj", OBJ_QUAD),
        ("model.ply", _ply_binary("<")),
    ],
)
def test_exported_glb_carries_the_mesh(store, tmp_path, name, data):
    scene_id, _envelope = _import(tmp_path, name, data)
    exported = tools.export_glb(scene=scene_id)
    raw = Path(exported["path"]).read_bytes()
    # The file the exporter wrote is a valid GLB that our own scan accepts,
    # and its stats count the imported mesh once (the part and its source
    # mesh share one accessor).
    glb_mod.scan(raw, source_format="glb", deadline=time.monotonic() + 30)
    assert exported["stats"]["tris"] == 2
    assert exported["stats"]["verts"] in (4, 6)


# --- Gateway upload door --------------------------------------------------------------


def test_upload_door_reads_mtl_sidecar(store, tmp_path):
    scene_id = _scene()
    envelope = import_model_mod.import_bytes(
        scene_id,
        store,
        OBJ_QUAD.encode(),
        original_name="quad.obj",
        source_format="obj",
        base_revision=1,
        sidecars={"quad.mtl": MTL_RED.encode()},
    )
    _asset, scan = _stored_gltf(store, envelope)
    assert scan.gltf["materials"][0]["pbrMetallicRoughness"]["baseColorFactor"] == [1.0, 0.0, 0.0, 0.5]


def test_upload_door_without_sidecar_uses_default_colour(store, tmp_path):
    scene_id = _scene()
    envelope = import_model_mod.import_bytes(
        scene_id,
        store,
        OBJ_QUAD.encode(),
        original_name="quad.obj",
        source_format="obj",
        base_revision=1,
    )
    asset, scan = _stored_gltf(store, envelope)
    assert scan.gltf["materials"][0]["pbrMetallicRoughness"]["baseColorFactor"] == [0.8, 0.8, 0.8, 1.0]
    assert any("not uploaded" in line for line in asset["stats"]["ignored"])


@pytest.mark.parametrize(
    "sidecars",
    [
        {"../x.mtl": b"x"},
        {"a/b.mtl": b"x"},
        {"": b"x"},
        {"a.mtl": "text"},
        {"a%d.mtl" % i: b"x" for i in range(5)},
    ],
)
def test_sidecar_validation(store, sidecars):
    with pytest.raises(PlastisError) as excinfo:
        import_model_mod.import_bytes(
            _scene(),
            store,
            OBJ_QUAD.encode(),
            original_name="quad.obj",
            source_format="obj",
            base_revision=1,
            sidecars=sidecars,
        )
    assert excinfo.value.code == "SPEC_INVALID"
    assert list(store.assets_dir.iterdir()) == []


def test_unknown_source_format_refused(store):
    with pytest.raises(PlastisError) as excinfo:
        import_model_mod.import_bytes(
            _scene(), store, b"x", original_name="a.dae", source_format="dae", base_revision=1
        )
    assert excinfo.value.code == "IMPORT_FORMAT"


def test_route_upload_accepts_each_format_and_sidecars(tmp_path):
    from test_import import _load_plugin_api_standalone  # reuse the host-style loader
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    previous = os.environ.get("PLASTIS3D_DATA_DIR")
    os.environ["PLASTIS3D_DATA_DIR"] = str(tmp_path / "route-data")
    try:
        api = _load_plugin_api_standalone()
        app = FastAPI()
        app.include_router(api.router, prefix="/api/plugins/plastis3d")
        with TestClient(app) as client:
            def b64(data):
                return base64.b64encode(data if isinstance(data, bytes) else data.encode()).decode()

            def new_scene():
                return client.post("/api/plugins/plastis3d/scenes", json={"name": "R"}).json()["scene"]["id"]

            cases = [
                ("plate.stl", _binary_stl(SQUARE_TRIS), None),
                ("model.ply", _ply_binary("<"), None),
                ("quad.obj", OBJ_QUAD.encode(), [{"filename": "quad.mtl", "bytes": b64(MTL_RED)}]),
            ]
            for filename, data, sidecars in cases:
                upload = {"filename": filename, "bytes": b64(data)}
                if sidecars:
                    upload["sidecars"] = sidecars
                response = client.post(
                    "/api/plugins/plastis3d/scenes/%s/imports" % new_scene(),
                    json={"upload": upload, "baseRevision": 1},
                )
                assert response.status_code == 200, response.text
                assert response.json()["assets"][0]["sourceFormat"] == filename.split(".")[1]
            bad = client.post(
                "/api/plugins/plastis3d/scenes/%s/imports" % new_scene(),
                json={
                    "upload": {
                        "filename": "quad.obj",
                        "bytes": b64(OBJ_QUAD),
                        "sidecars": [{"filename": "q.mtl", "bytes": "!!!"}],
                    },
                    "baseRevision": 1,
                },
            )
            assert bad.status_code == 400
            assert bad.json()["error"]["code"] == "SPEC_INVALID" if "error" in bad.json() else True
    finally:
        if previous is None:
            os.environ.pop("PLASTIS3D_DATA_DIR", None)
        else:
            os.environ["PLASTIS3D_DATA_DIR"] = previous
