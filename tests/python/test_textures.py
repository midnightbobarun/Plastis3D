"""PR15 tests (Tier 1): texture maps (C-07, C-08, C-15).

Image header inspection, the one-mutation import (path and upload doors),
undo and redo, clearing, the part-UV rule, the decoded-pixel budget, export
(embedded images, one texture per image, UVs where a texture needs them,
re-import), the HTTP routes and the primitive UV conventions. Every image
is built in the test; nothing is read from the plugin directory.
"""

import base64
import copy
import hashlib
import json
import math
import os
import struct
import time
import zlib
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from plastis3d_scene import images, primitives, tools
from plastis3d_scene import spec as spec_mod
from plastis3d_scene.spec import PlastisError
from plastis3d_scene.store import Store

from test_import import _load_plugin_api_standalone
from test_splice import _parse_glb


@pytest.fixture()
def data_dir(tmp_path, monkeypatch):
    path = tmp_path / "data"
    monkeypatch.setenv("PLASTIS3D_DATA_DIR", str(path))
    return path


@pytest.fixture()
def store(data_dir):
    return Store(data_dir)


# --- Image builders ---------------------------------------------------------------


def _png(width=4, height=2, *, color=6, depth=8, interlace=0, seed=0):
    """A real PNG (RGBA unless ``color`` says otherwise); ``seed`` changes its bytes."""
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color]

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    row = bytes([0]) + bytes((seed + i * 7) % 256 for i in range(width * channels * depth // 8))
    raw = row * height
    ihdr = struct.pack(">IIBBBBB", width, height, depth, color, 0, 0, interlace)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


def _jpeg(width=8, height=4, *, sof=0xC0, components=3, precision=8):
    """A JPEG with a valid frame header; the entropy data is not decodable,
    which is fine: Python reads only the header and never decodes."""
    sof_body = struct.pack(">BHHB", precision, height, width, components) + b"\x01\x11\x00" * components
    segment = lambda marker, body: bytes([0xFF, marker]) + struct.pack(">H", len(body) + 2) + body
    return (
        b"\xff\xd8"
        + segment(0xE0, b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00")
        + segment(sof, sof_body)
        + b"\xff\xda\x00\x02\xff\xd9"
    )


def _scene():
    return tools.new_scene(name="Textures")["scene"]["id"]


def _with_box(scene_id, rev=1):
    """A box on a fresh material ``m_wood``; returns the next revision."""
    env = tools.set_material(scene=scene_id, baseRevision=rev, id="m_wood", color="#aa8855")
    env = tools.add_node(
        scene=scene_id,
        baseRevision=env["scene"]["revision"],
        kind="mesh",
        name="Crate",
        primitive={"type": "box"},
        materialId="m_wood",
        transform={"t": [0, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
    )
    return env["scene"]["revision"]


def _file(tmp_path, name, data):
    path = tmp_path / "pics" / name
    path.parent.mkdir(exist_ok=True)
    path.write_bytes(data)
    return str(path)


def _material(scene, material_id="m_wood"):
    return next(m for m in scene["materials"] if m["id"] == material_id)


# --- Header inspection ---------------------------------------------------------------


@pytest.mark.parametrize(
    "data, expected",
    [
        (_png(4, 2), ("png", 4, 2)),
        (_png(3, 5, color=2), ("png", 3, 5)),
        (_png(2, 2, color=0, depth=16), ("png", 2, 2)),
        (_png(8, 8, interlace=1), ("png", 8, 8)),
        (_jpeg(8, 4), ("jpeg", 8, 4)),
        (_jpeg(640, 480, sof=0xC2), ("jpeg", 640, 480)),  # progressive
        (_jpeg(7, 9, components=1), ("jpeg", 7, 9)),  # grey
    ],
)
def test_inspect_reads_format_and_size_from_the_header(data, expected):
    info = images.inspect_image(data)
    assert (info["format"], info["width"], info["height"]) == expected


@pytest.mark.parametrize(
    "data, code, word",
    [
        (b"GIF89a" + b"\x00" * 40, "IMPORT_FORMAT", "PNG and JPEG"),
        (b"RIFF\x00\x00\x00\x00WEBPVP8 " + b"\x00" * 40, "IMPORT_FORMAT", "PNG and JPEG"),
        (b"\xabKTX 20\xbb\r\n\x1a\n" + b"\x00" * 60, "IMPORT_COMPRESSED", "KTX2"),
        (b"", "IMPORT_FORMAT", "PNG and JPEG"),
        (_png(4, 4)[:20], "IMPORT_FORMAT", "too short"),
        (_jpeg(8, 4, components=4), "IMPORT_FORMAT", "CMYK"),
        (_jpeg(8, 4, sof=0xC9), "IMPORT_FORMAT", "arithmetic"),
        (_jpeg(8, 4, sof=0xC3), "IMPORT_FORMAT", "lossless"),
        (_jpeg(8, 4, precision=12), "IMPORT_FORMAT", "8-bit"),
        (b"\xff\xd8\xff\xd9", "IMPORT_FORMAT", "no frame header"),
        (_png(0, 4), "IMPORT_FORMAT", "zero dimension"),
        (_png(4097, 2), "IMPORT_TOO_COMPLEX", "4096"),
        (_png(4096, 4097), "IMPORT_TOO_COMPLEX", "pixels"),
        (_jpeg(5000, 100), "IMPORT_TOO_COMPLEX", "4096"),
    ],
)
def test_inspect_refuses_by_name(data, code, word):
    with pytest.raises(PlastisError) as excinfo:
        images.inspect_image(data)
    assert excinfo.value.code == code
    assert word in str(excinfo.value)


def test_png_with_a_damaged_header_or_bad_combination_is_refused():
    damaged = bytearray(_png(4, 4))
    damaged[20] ^= 0xFF  # inside IHDR: the CRC no longer matches
    with pytest.raises(PlastisError) as excinfo:
        images.inspect_image(bytes(damaged))
    assert "damaged" in str(excinfo.value)
    with pytest.raises(PlastisError):
        images.inspect_image(_png(4, 4, color=2, depth=4))  # 4-bit truecolour does not exist


def test_a_four_thousand_pixel_image_fits():
    assert images.inspect_image(_png(4096, 4096))["width"] == 4096


# --- The import: one mutation ----------------------------------------------------------


def test_path_import_attaches_the_asset_and_the_slot_in_one_revision(store, tmp_path):
    scene_id = _scene()
    rev = _with_box(scene_id)
    data = _png(4, 2)
    envelope = images.import_image_path(
        scene_id, store, _file(tmp_path, "wood.png", data),
        base_revision=rev, material_id="m_wood", slot="baseColorMap",
    )
    assert envelope["scene"]["revision"] == rev + 1
    sha = hashlib.sha256(data).hexdigest()
    asset = next(a for a in envelope["assets"] if a["id"] == sha)
    assert asset["format"] == "png" and asset["sourceFormat"] == "png"
    assert asset["file"] == "assets/%s.png" % sha
    assert asset["stats"] == {"width": 4, "height": 2}
    assert asset["originalName"] == "wood.png" and asset["bytes"] == len(data)
    assert (store.assets_dir / (sha + ".png")).read_bytes() == data
    assert _material(envelope)["baseColorMap"] == sha


def test_a_jpeg_is_stored_with_a_jpg_extension(store, tmp_path):
    scene_id = _scene()
    rev = _with_box(scene_id)
    data = _jpeg(8, 4)
    envelope = images.import_image_path(
        scene_id, store, _file(tmp_path, "photo.jpeg", data),
        base_revision=rev, material_id="m_wood", slot="normalMap",
    )
    asset = envelope["assets"][-1]
    assert asset["format"] == "jpeg" and asset["file"].endswith(".jpg")
    assert (store.assets_dir / (asset["sha256"] + ".jpg")).is_file()


def test_undo_removes_the_slot_and_the_asset_row_and_redo_restores_them(store, tmp_path):
    scene_id = _scene()
    rev = _with_box(scene_id)
    envelope = images.import_image_path(
        scene_id, store, _file(tmp_path, "wood.png", _png()),
        base_revision=rev, material_id="m_wood", slot="baseColorMap",
    )
    undone = tools.undo(scene=scene_id, baseRevision=envelope["scene"]["revision"])
    assert "baseColorMap" not in _material(undone)
    assert undone["assets"] == []
    redone = tools.redo(scene=scene_id, baseRevision=undone["scene"]["revision"])
    assert _material(redone)["baseColorMap"] == envelope["assets"][0]["id"]
    assert len(redone["assets"]) == 1


def test_the_same_image_in_two_slots_shares_one_asset(store, tmp_path):
    scene_id = _scene()
    rev = _with_box(scene_id)
    path = _file(tmp_path, "wood.png", _png())
    first = images.import_image_path(scene_id, store, path, base_revision=rev,
                                     material_id="m_wood", slot="baseColorMap")
    second = images.import_image_path(scene_id, store, path, base_revision=first["scene"]["revision"],
                                      material_id="m_wood", slot="normalMap")
    assert len(second["assets"]) == 1
    material = _material(second)
    assert material["baseColorMap"] == material["normalMap"] == second["assets"][0]["id"]
    assert len(list(store.assets_dir.iterdir())) == 1
    # Undoing the second pick keeps the asset, which the first slot still uses.
    undone = tools.undo(scene=scene_id, baseRevision=second["scene"]["revision"])
    assert len(undone["assets"]) == 1 and "normalMap" not in _material(undone)


def test_an_emissive_map_lifts_a_black_emissive_colour_to_white(store, tmp_path):
    scene_id = _scene()
    rev = _with_box(scene_id)
    assert _material(store.get_scene(scene_id))["emissive"] == "#000000"
    envelope = images.import_image_path(
        scene_id, store, _file(tmp_path, "glow.png", _png()),
        base_revision=rev, material_id="m_wood", slot="emissiveMap",
    )
    assert _material(envelope)["emissive"] == "#ffffff"
    # A colour the author chose is left alone.
    scene_id = _scene()
    rev = _with_box(scene_id)
    env = tools.set_material(scene=scene_id, baseRevision=rev, id="m_wood", emissive="#ff0000")
    env = images.import_image_path(
        scene_id, store, _file(tmp_path, "glow2.png", _png(seed=9)),
        base_revision=env["scene"]["revision"], material_id="m_wood", slot="emissiveMap",
    )
    assert _material(env)["emissive"] == "#ff0000"


def test_clearing_a_map_is_an_ordinary_set_material(store, tmp_path):
    scene_id = _scene()
    rev = _with_box(scene_id)
    env = images.import_image_path(
        scene_id, store, _file(tmp_path, "wood.png", _png()),
        base_revision=rev, material_id="m_wood", slot="baseColorMap",
    )
    cleared = tools.set_material(
        scene=scene_id, baseRevision=env["scene"]["revision"], id="m_wood", baseColorMap=None
    )
    assert "baseColorMap" not in _material(cleared)
    # The asset stays for the sweep; the slot can point at it again.
    sha = cleared["assets"][0]["id"]
    again = tools.set_material(scene=scene_id, baseRevision=cleared["scene"]["revision"],
                               id="m_wood", normalMap=sha)
    assert _material(again)["normalMap"] == sha


def test_the_agent_can_name_an_image_in_the_scene_but_not_an_unknown_or_model_asset(store, tmp_path):
    scene_id = _scene()
    rev = _with_box(scene_id)
    with pytest.raises(PlastisError) as excinfo:
        tools.set_material(scene=scene_id, baseRevision=rev, id="m_wood", baseColorMap="f" * 64)
    assert excinfo.value.code == "SPEC_INVALID" and "unknown asset" in str(excinfo.value)
    assert store.get_scene(scene_id)["revision"] == rev


@pytest.mark.parametrize(
    "case",
    ["no_material", "bad_slot", "not_image", "too_big_dims", "missing_file", "glb_door", "denied", "relative"],
)
def test_refusals_write_nothing(store, tmp_path, case):
    scene_id = _scene()
    rev = _with_box(scene_id)
    kwargs = dict(base_revision=rev, material_id="m_wood", slot="baseColorMap")
    if case == "no_material":
        path, code = _file(tmp_path, "a.png", _png()), "MATERIAL_NOT_FOUND"
        kwargs["material_id"] = "m_ghost"
    elif case == "bad_slot":
        path, code = _file(tmp_path, "a.png", _png()), "SPEC_INVALID"
        kwargs["slot"] = "occlusionMap"
    elif case == "not_image":
        path, code = _file(tmp_path, "a.png", b"GIF89a" + b"\x00" * 30), "IMPORT_FORMAT"
    elif case == "too_big_dims":
        path, code = _file(tmp_path, "a.png", _png(5000, 2)), "IMPORT_TOO_COMPLEX"
    elif case == "missing_file":
        path, code = str(tmp_path / "nope.png"), "IMPORT_NOT_FOUND"
    elif case == "glb_door":
        path, code = _file(tmp_path, "a.glb", b"glTF"), "IMPORT_FORMAT"
    elif case == "denied":
        secret = tmp_path / "credentials.json"
        secret.write_bytes(b"{}")
        link = tmp_path / "pic.png"
        link.symlink_to(secret)
        path, code = str(link), "IMPORT_PATH_DENIED"
    else:
        path, code = "relative/a.png", "IMPORT_PATH_DENIED"
    with pytest.raises(PlastisError) as excinfo:
        images.import_image_path(scene_id, store, path, **kwargs)
    assert excinfo.value.code == code, excinfo.value
    assert list(store.assets_dir.iterdir()) == []
    after = store.get_scene(scene_id)
    assert after["revision"] == rev and after["assets"] == []


def test_the_model_door_still_refuses_images_and_says_why(store, tmp_path):
    scene_id = _scene()
    with pytest.raises(PlastisError) as excinfo:
        tools.import_model(scene=scene_id, baseRevision=1, path=_file(tmp_path, "wood.png", _png()))
    assert excinfo.value.code == "IMPORT_FORMAT"


def test_an_oversize_file_is_refused_before_it_is_stored(store, tmp_path, monkeypatch):
    scene_id = _scene()
    rev = _with_box(scene_id)
    monkeypatch.setattr(images, "MAX_IMAGE_BYTES", 100)
    path = _file(tmp_path, "big.png", _png(64, 64))
    with pytest.raises(PlastisError) as excinfo:
        images.import_image_path(scene_id, store, path, base_revision=rev,
                                 material_id="m_wood", slot="baseColorMap")
    assert excinfo.value.code == "IMPORT_TOO_LARGE"
    assert list(store.assets_dir.iterdir()) == []


def test_the_decoded_pixel_budget_covers_every_image_the_materials_use(store, tmp_path, monkeypatch):
    monkeypatch.setattr(spec_mod, "MAX_SCENE_IMAGE_PIXELS", 100)
    import plastis3d_scene.validate as validate_mod
    monkeypatch.setattr(validate_mod, "MAX_SCENE_IMAGE_PIXELS", 100)
    scene_id = _scene()
    rev = _with_box(scene_id)
    env = images.import_image_path(
        scene_id, store, _file(tmp_path, "a.png", _png(8, 8)),  # 64 px
        base_revision=rev, material_id="m_wood", slot="baseColorMap",
    )
    with pytest.raises(PlastisError) as excinfo:
        images.import_image_path(
            scene_id, store, _file(tmp_path, "b.png", _png(8, 8, seed=3)),  # 64 more
            base_revision=env["scene"]["revision"], material_id="m_wood", slot="normalMap",
        )
    assert excinfo.value.code == "IMPORT_TOO_COMPLEX" and "budget" in str(excinfo.value)
    assert len(list(store.assets_dir.iterdir())) == 1  # only the first image


def test_the_upload_door_takes_bytes(store):
    scene_id = _scene()
    rev = _with_box(scene_id)
    data = _png()
    env = images.import_image_bytes(
        scene_id, store, data, original_name="upload.png",
        base_revision=rev, material_id="m_wood", slot="metallicRoughnessMap",
    )
    assert _material(env)["metallicRoughnessMap"] == hashlib.sha256(data).hexdigest()
    assert env["assets"][0]["originalName"] == "upload.png"


# --- The part-UV rule (C-08) -----------------------------------------------------------

OBJ_WITH_UV = "v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\nf 1/1 2/2 3/3 4/4\n"
OBJ_NO_UV = "v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n"


def _import_part(scene_id, tmp_path, text, name):
    path = _file(tmp_path, name, text.encode())
    env = tools.import_model(scene=scene_id, baseRevision=1, path=path)
    part = next(n for n in env["nodes"] if n["kind"] == "part")
    return env, part


def test_a_part_with_uvs_can_be_textured_and_one_without_is_refused(store, tmp_path):
    scene_id = _scene()
    env, part = _import_part(scene_id, tmp_path, OBJ_WITH_UV, "uv.obj")
    assert env["assets"][0]["stats"]["parts"][0]["uv"] is True
    env = tools.set_material(scene=scene_id, baseRevision=env["scene"]["revision"],
                             id="m_skin", color="#ffffff", assignTo=[part["id"]])
    env = images.import_image_path(
        scene_id, store, _file(tmp_path, "skin.png", _png()),
        base_revision=env["scene"]["revision"], material_id="m_skin", slot="baseColorMap",
    )
    assert _material(env, "m_skin")["baseColorMap"]

    scene_two = _scene()
    env, part = _import_part(scene_two, tmp_path, OBJ_NO_UV, "nouv.obj")
    assert env["assets"][0]["stats"]["parts"][0]["uv"] is False
    env = tools.set_material(scene=scene_two, baseRevision=env["scene"]["revision"],
                             id="m_skin", color="#ffffff", assignTo=[part["id"]])
    with pytest.raises(PlastisError) as excinfo:
        images.import_image_path(
            scene_two, store, _file(tmp_path, "skin2.png", _png(seed=5)),
            base_revision=env["scene"]["revision"], material_id="m_skin", slot="baseColorMap",
        )
    assert excinfo.value.code == "TEXTURE_NO_UV"
    assert "no UV coordinates" in str(excinfo.value)
    refused = hashlib.sha256(_png(seed=5)).hexdigest()
    assert not (store.assets_dir / (refused + ".png")).exists()  # the refused image was never stored


def test_moving_a_textured_material_onto_a_uv_less_part_is_refused(store, tmp_path):
    scene_id = _scene()
    rev = _with_box(scene_id)
    env = images.import_image_path(
        scene_id, store, _file(tmp_path, "wood.png", _png()),
        base_revision=rev, material_id="m_wood", slot="baseColorMap",
    )
    imported = tmp_path / "nouv.obj"
    imported.write_text(OBJ_NO_UV)
    env = tools.import_model(scene=scene_id, baseRevision=env["scene"]["revision"], path=str(imported))
    part = next(n for n in env["nodes"] if n["kind"] == "part")
    with pytest.raises(PlastisError) as excinfo:
        tools.set_material(scene=scene_id, baseRevision=env["scene"]["revision"],
                           id="m_wood", assignTo=[part["id"]])
    assert excinfo.value.code == "TEXTURE_NO_UV"


# --- Export ------------------------------------------------------------------------------


def _export(scene_id):
    return _parse_glb(tools.export_glb(scene=scene_id)["path"])


def _accessor_floats(gltf, blob, index):
    accessor = gltf["accessors"][index]
    view = gltf["bufferViews"][accessor["bufferView"]]
    width = {"VEC2": 2, "VEC3": 3, "SCALAR": 1}[accessor["type"]]
    return list(struct.unpack_from("<%df" % (accessor["count"] * width), blob, view["byteOffset"]))


def test_export_embeds_the_image_and_writes_uvs(store, tmp_path):
    scene_id = _scene()
    rev = _with_box(scene_id)
    data = _png(4, 2)
    images.import_image_path(scene_id, store, _file(tmp_path, "wood.png", data),
                             base_revision=rev, material_id="m_wood", slot="baseColorMap")
    gltf, blob = _export(scene_id)
    assert len(gltf["images"]) == 1 and len(gltf["textures"]) == 1 and len(gltf["samplers"]) == 1
    image = gltf["images"][0]
    view = gltf["bufferViews"][image["bufferView"]]
    assert image["mimeType"] == "image/png"
    assert blob[view["byteOffset"] : view["byteOffset"] + view["byteLength"]] == data
    assert "target" not in view  # an image view is not a vertex or index view
    assert gltf["samplers"][0] == {"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}
    material = next(m for m in gltf["materials"] if m["name"] == "m_wood")
    assert material["pbrMetallicRoughness"]["baseColorTexture"] == {"index": 0}
    assert gltf["textures"][0] == {"sampler": 0, "source": 0}
    box = next(m for m in gltf["meshes"] if m["name"] == "Crate")
    uv_accessor = box["primitives"][0]["attributes"]["TEXCOORD_0"]
    expected = primitives.generate({"type": "box"})["uvs"]
    got = _accessor_floats(gltf, blob, uv_accessor)
    assert got == pytest.approx(expected, abs=1e-6)
    assert gltf["accessors"][uv_accessor]["count"] == len(expected) // 2


def test_every_slot_has_its_own_property_and_one_image_is_one_texture(store, tmp_path):
    scene_id = _scene()
    rev = _with_box(scene_id)
    shared = _file(tmp_path, "shared.png", _png())
    other = _file(tmp_path, "normal.png", _png(seed=11))
    for slot, path in (("baseColorMap", shared), ("emissiveMap", shared),
                       ("normalMap", other), ("metallicRoughnessMap", other)):
        rev = images.import_image_path(scene_id, store, path, base_revision=rev,
                                       material_id="m_wood", slot=slot)["scene"]["revision"]
    gltf, _blob = _export(scene_id)
    assert len(gltf["images"]) == 2 and len(gltf["textures"]) == 2
    material = next(m for m in gltf["materials"] if m["name"] == "m_wood")
    pbr = material["pbrMetallicRoughness"]
    assert pbr["baseColorTexture"]["index"] == material["emissiveTexture"]["index"]
    assert pbr["metallicRoughnessTexture"]["index"] == material["normalTexture"]["index"]
    assert pbr["baseColorTexture"]["index"] != pbr["metallicRoughnessTexture"]["index"]
    assert material["normalTexture"]["scale"] == 1.0
    assert material["emissiveFactor"] == [1.0, 1.0, 1.0]  # lifted so the map shows


def test_an_untextured_export_has_no_images_no_samplers_and_no_uvs(store, tmp_path):
    scene_id = _scene()
    _with_box(scene_id)
    gltf, _blob = _export(scene_id)
    assert "images" not in gltf and "textures" not in gltf and "samplers" not in gltf
    assert all("TEXCOORD_0" not in p["attributes"] for m in gltf["meshes"] for p in m["primitives"])


@pytest.mark.parametrize("primitive_type", primitives.PRIMITIVE_TYPES)
def test_every_primitive_exports_uvs_when_textured(store, tmp_path, primitive_type):
    scene_id = _scene()
    env = tools.set_material(scene=scene_id, baseRevision=1, id="m_t", color="#ffffff")
    env = tools.add_node(scene=scene_id, baseRevision=env["scene"]["revision"], kind="mesh",
                         name="Shape", primitive={"type": primitive_type}, materialId="m_t",
                         transform={"t": [0, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]})
    images.import_image_path(scene_id, store, _file(tmp_path, "t.png", _png()),
                             base_revision=env["scene"]["revision"], material_id="m_t", slot="baseColorMap")
    gltf, blob = _export(scene_id)
    shape = next(m for m in gltf["meshes"] if m["name"] == "Shape")
    attrs = shape["primitives"][0]["attributes"]
    assert gltf["accessors"][attrs["TEXCOORD_0"]]["count"] == gltf["accessors"][attrs["POSITION"]]["count"]


def test_a_textured_part_keeps_its_uvs_in_the_export(store, tmp_path):
    scene_id = _scene()
    env, part = _import_part(scene_id, tmp_path, OBJ_WITH_UV, "uv.obj")
    env = tools.set_material(scene=scene_id, baseRevision=env["scene"]["revision"],
                             id="m_skin", color="#ffffff", assignTo=[part["id"]])
    images.import_image_path(scene_id, store, _file(tmp_path, "skin.png", _png()),
                             base_revision=env["scene"]["revision"], material_id="m_skin", slot="baseColorMap")
    gltf, _blob = _export(scene_id)
    skin = next(m for m in gltf["materials"] if m["name"] == "m_skin")
    assert "baseColorTexture" in skin["pbrMetallicRoughness"]
    assert any("TEXCOORD_0" in p["attributes"] for m in gltf["meshes"] for p in m["primitives"])


def test_the_export_survives_reimport_and_undo(store, tmp_path):
    scene_id = _scene()
    rev = _with_box(scene_id)
    env = images.import_image_path(scene_id, store, _file(tmp_path, "wood.png", _png()),
                                   base_revision=rev, material_id="m_wood", slot="baseColorMap")
    exported = tools.export_glb(scene=scene_id)
    # The exported GLB is a valid asset for our own scan (images inside).
    import time
    from plastis3d_scene import glb as glb_mod
    scan = glb_mod.scan(Path(exported["path"]).read_bytes(), source_format="glb", deadline=time.monotonic() + 30)
    assert scan.gltf["images"][0]["mimeType"] == "image/png"
    # Undo the pick: the next export has no texture again.
    tools.undo(scene=scene_id, baseRevision=env["scene"]["revision"])
    gltf, _ = _export(scene_id)
    assert "textures" not in gltf


def test_a_missing_or_altered_image_file_fails_the_export_closed(store, tmp_path):
    scene_id = _scene()
    rev = _with_box(scene_id)
    env = images.import_image_path(scene_id, store, _file(tmp_path, "wood.png", _png()),
                                   base_revision=rev, material_id="m_wood", slot="baseColorMap")
    image_file = store.assets_dir / Path(env["assets"][0]["file"]).name
    image_file.write_bytes(_png(seed=99))
    with pytest.raises(PlastisError) as excinfo:
        tools.export_glb(scene=scene_id)
    assert excinfo.value.code == "EXPORT_FAILED" and "sha256" in str(excinfo.value)
    image_file.unlink()
    with pytest.raises(PlastisError) as excinfo:
        tools.export_glb(scene=scene_id)
    assert "missing on disk" in str(excinfo.value)
    assert list(store.exports_dir.iterdir()) == []


# --- Routes -------------------------------------------------------------------------------


@pytest.fixture()
def client(data_dir):
    api = _load_plugin_api_standalone()
    app = FastAPI()
    app.include_router(api.router, prefix="/api/plugins/plastis3d")
    with TestClient(app) as c:
        yield c


def _route_scene(client):
    sid = client.post("/api/plugins/plastis3d/scenes", json={"name": "R"}).json()["scene"]["id"]
    rev = client.patch(
        "/api/plugins/plastis3d/scenes/%s" % sid,
        json={"baseRevision": 1, "ops": [{"op": "set_material", "material": {"id": "m_wood", "color": "#aa8855"}}]},
    ).json()["scene"]["revision"]
    return sid, rev


def test_route_upload_then_get_asset_returns_the_image(client):
    sid, rev = _route_scene(client)
    data = _png()
    response = client.post(
        "/api/plugins/plastis3d/scenes/%s/images" % sid,
        json={"baseRevision": rev, "materialId": "m_wood", "slot": "baseColorMap",
              "upload": {"filename": "wood.png", "contentType": "image/png",
                         "bytes": base64.b64encode(data).decode()}},
    )
    assert response.status_code == 200, response.text
    sha = hashlib.sha256(data).hexdigest()
    assert response.json()["assets"][0]["id"] == sha
    got = client.get("/api/plugins/plastis3d/assets/%s" % sha).json()
    assert got["ok"] and got["format"] == "png" and got["mimeType"] == "image/png"
    assert base64.b64decode(got["bytes"]) == data


def test_route_backend_path(client, tmp_path):
    sid, rev = _route_scene(client)
    response = client.post(
        "/api/plugins/plastis3d/scenes/%s/images" % sid,
        json={"baseRevision": rev, "materialId": "m_wood", "slot": "normalMap",
              "backendPath": _file(tmp_path, "n.png", _png())},
    )
    assert response.status_code == 200, response.text


@pytest.mark.parametrize(
    "body, status, code",
    [
        ({"materialId": "m_wood", "slot": "baseColorMap", "backendPath": "/x.png"}, 400, "SPEC_INVALID"),
        ({"baseRevision": 2, "materialId": "m_wood", "slot": "baseColorMap"}, 400, "SPEC_INVALID"),
        ({"baseRevision": 2, "materialId": "m_wood", "slot": "baseColorMap", "backendPath": "/x.png",
          "upload": {"filename": "a.png", "bytes": "AA=="}}, 400, "SPEC_INVALID"),
        ({"baseRevision": 2, "materialId": "m_wood", "slot": "baseColorMap",
          "upload": {"filename": "a.png", "bytes": "!!!"}}, 400, "SPEC_INVALID"),
        ({"baseRevision": 2, "materialId": "m_wood", "slot": "baseColorMap",
          "upload": {"filename": "a.png", "bytes": base64.b64encode(b"GIF89a....").decode()}}, 400, "IMPORT_FORMAT"),
        ({"baseRevision": 99, "materialId": "m_wood", "slot": "baseColorMap",
          "upload": {"filename": "a.png", "bytes": base64.b64encode(_png()).decode()}}, 409, "REVISION_CONFLICT"),
        ({"baseRevision": 2, "materialId": "m_ghost", "slot": "baseColorMap",
          "upload": {"filename": "a.png", "bytes": base64.b64encode(_png()).decode()}}, 404, "MATERIAL_NOT_FOUND"),
    ],
)
def test_route_errors(client, body, status, code):
    sid, _rev = _route_scene(client)
    response = client.post("/api/plugins/plastis3d/scenes/%s/images" % sid, json=body)
    assert response.status_code == status, response.text
    assert response.json()["code"] == code


def test_texture_no_uv_is_a_400_with_its_own_code(client, tmp_path):
    sid, rev = _route_scene(client)
    obj = _file(tmp_path, "nouv.obj", OBJ_NO_UV.encode())
    env = client.post("/api/plugins/plastis3d/scenes/%s/imports" % sid,
                      json={"backendPath": obj, "baseRevision": rev}).json()
    part = next(n for n in env["nodes"] if n["kind"] == "part")
    env = client.patch(
        "/api/plugins/plastis3d/scenes/%s" % sid,
        json={"baseRevision": env["scene"]["revision"],
              "ops": [{"op": "set_material", "material": {"id": "m_wood"}, "assignTo": [part["id"]]}]},
    ).json()
    response = client.post(
        "/api/plugins/plastis3d/scenes/%s/images" % sid,
        json={"baseRevision": env["scene"]["revision"], "materialId": "m_wood", "slot": "baseColorMap",
              "upload": {"filename": "a.png", "bytes": base64.b64encode(_png()).decode()}},
    )
    assert response.status_code == 400 and response.json()["code"] == "TEXTURE_NO_UV"


def test_a_patch_can_clear_but_not_attach_a_new_image(client):
    sid, rev = _route_scene(client)
    response = client.patch(
        "/api/plugins/plastis3d/scenes/%s" % sid,
        json={"baseRevision": rev, "ops": [{"op": "set_material_map", "materialId": "m_wood",
                                             "slot": "baseColorMap", "asset": {}}]},
    )
    assert response.status_code == 400  # not allowed in a patch


# --- UV conventions (C-08) ---------------------------------------------------------------------


@pytest.mark.parametrize("primitive_type", primitives.PRIMITIVE_TYPES)
def test_every_primitive_has_one_uv_per_vertex_in_range(primitive_type):
    mesh = primitives.generate({"type": primitive_type})
    verts = len(mesh["positions"]) // 3
    assert len(mesh["uvs"]) == 2 * verts == 2 * len(mesh["normals"]) // 3
    assert primitives.count_primitive({"type": primitive_type})["verts"] == verts
    v_values = mesh["uvs"][1::2]
    assert min(v_values) >= -1e-9 and max(v_values) <= 1 + 1e-9  # v never wraps
    assert all(math.isfinite(x) for x in mesh["uvs"])


def test_the_plane_and_the_box_face_show_an_upright_image():
    plane = primitives.generate({"type": "plane"})
    # The plane faces +Z: its top-left corner (-x, +y) samples the image's top-left (0, 0).
    positions, uvs = plane["positions"], plane["uvs"]
    for i in range(4):
        x, y = positions[3 * i], positions[3 * i + 1]
        assert uvs[2 * i] == (0.0 if x < 0 else 1.0)
        assert uvs[2 * i + 1] == (0.0 if y > 0 else 1.0)
    box = primitives.generate({"type": "box"})
    for i in range(len(box["positions"]) // 3):
        nx, ny, nz = box["normals"][3 * i : 3 * i + 3]
        x, y, z = box["positions"][3 * i : 3 * i + 3]
        u, v = box["uvs"][2 * i : 2 * i + 2]
        if nz == 1.0:  # front face: top is up, left is -x
            assert (u, v) == (0.0 if x < 0 else 1.0, 0.0 if y > 0 else 1.0)
        if ny == 1.0:  # top face: image top toward -Z
            assert v == (0.0 if z < 0 else 1.0)


def test_pole_vertices_sit_at_the_middle_of_their_triangle():
    sphere = primitives.generate({"type": "sphere"})
    uvs, idx = sphere["uvs"], sphere["indices"]
    ws = primitives.PRIMITIVE_DEFAULTS["sphere"]["widthSegments"]
    top_row = range(0, ws + 1)  # iy == 0
    for t in range(0, len(idx), 3):
        tri = idx[t : t + 3]
        apexes = [i for i in tri if i in top_row]
        if apexes:
            base = [uvs[2 * i] for i in tri if i not in top_row]
            assert uvs[2 * apexes[0]] == pytest.approx(sum(base) / 2)


def test_the_checked_in_uv_fixture_matches_the_generators():
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "make_primitive_uvs_json", Path(__file__).resolve().parent.parent / "fixtures" / "make_primitive_uvs_json.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    fresh = json.dumps(module.build(), indent=0, sort_keys=True) + "\n"
    assert module.PATH.read_text(encoding="utf-8") == fresh


def _legacy_part_scene(store, tmp_path, *, uv=True, remove_parts=False):
    sid = _scene()
    env, part = _import_part(sid, tmp_path, OBJ_WITH_UV if uv else OBJ_NO_UV, "legacy.obj")
    env = tools.set_material(scene=sid, baseRevision=env["scene"]["revision"], id="m_skin", color="#ffffff", assignTo=[part["id"]])
    scene = store.get_scene(sid)
    if remove_parts:
        scene["assets"][0]["stats"].pop("parts")
    else:
        for row in scene["assets"][0]["stats"]["parts"]:
            row.pop("uv", None)
    # Simulate a previously valid on-disk pre-PR15 metadata record, not a user edit.
    store.scene_path(sid).write_text(json.dumps(scene))
    return sid, part


@pytest.mark.parametrize("remove_parts", [False, True])
def test_legacy_uv_recovery_is_read_only_and_assignment_is_one_revision(store, tmp_path, remove_parts):
    sid, part = _legacy_part_scene(store, tmp_path, remove_parts=remove_parts)
    before = store.get_scene(sid)
    feedback = tools.get_scene(scene=sid)
    assert feedback["assets"][0]["stats"]["parts"][0]["uv"] is True
    assert store.get_scene(sid) == before
    env = images.import_image_bytes(sid, store, _png(), original_name="skin.png", base_revision=before["revision"], material_id="m_skin", slot="baseColorMap")
    assert env["scene"]["revision"] == before["revision"] + 1
    assert _material(env, "m_skin")["baseColorMap"]
    undone = tools.undo(scene=sid, baseRevision=env["scene"]["revision"])
    assert not _material(undone, "m_skin").get("baseColorMap")
    redone = tools.redo(scene=sid, baseRevision=undone["scene"]["revision"])
    assert _material(redone, "m_skin")["baseColorMap"]


def test_legacy_absent_uv_and_unreadable_source_are_not_positive_proof(store, tmp_path):
    sid, _ = _legacy_part_scene(store, tmp_path, uv=False)
    before = store.get_scene(sid)
    assert tools.get_scene(scene=sid)["assets"][0]["stats"]["parts"][0]["uv"] is False
    with pytest.raises(PlastisError) as info:
        images.import_image_bytes(sid, store, _png(), original_name="skin.png", base_revision=before["revision"], material_id="m_skin", slot="baseColorMap")
    assert info.value.code == "TEXTURE_NO_UV"
    assert store.get_scene(sid) == before
    # A cached false fact cannot be reused if the source disappears or changes.
    asset = before["assets"][0]
    (store.assets_dir / (asset["sha256"] + ".glb")).unlink()
    unknown = tools.get_scene(scene=sid)["assets"][0]["stats"]["parts"][0]
    assert "uv" not in unknown
    with pytest.raises(PlastisError, match="could not be verified"):
        images.import_image_bytes(sid, store, _png(), original_name="skin.png", base_revision=before["revision"], material_id="m_skin", slot="baseColorMap")


def test_legacy_uv_cache_is_bounded_profile_scoped_and_scans_outside_profile_lock(store, tmp_path, monkeypatch):
    from plastis3d_scene import asset_facts
    from plastis3d_scene.store import Store
    sid, _ = _legacy_part_scene(store, tmp_path)
    scene = store.get_scene(sid)
    asset_facts._cache.clear()
    scans = []
    original = asset_facts.glb.scan
    def scan(*args, **kwargs):
        with store.asset_lock():  # CPU work must not retain the profile lock.
            pass
        scans.append(1)
        return original(*args, **kwargs)
    monkeypatch.setattr(asset_facts.glb, "scan", scan)
    assert asset_facts.enrich_legacy_uvs(scene, store)["assets"][0]["stats"]["parts"][0]["uv"]
    asset_facts.enrich_legacy_uvs(scene, store)
    assert len(scans) == 1
    other = Store(tmp_path / "other-profile")
    # No cross-profile positive cache proof, even for the same content hash.
    unknown = asset_facts.enrich_legacy_uvs(scene, other)
    assert "uv" not in unknown["assets"][0]["stats"]["parts"][0]
    monkeypatch.setattr(asset_facts, "MAX_CACHED_FACTS", 1)
    model = scene["assets"][0]
    (other.assets_dir / (model["sha256"] + ".glb")).write_bytes((store.assets_dir / (model["sha256"] + ".glb")).read_bytes())
    assert asset_facts.enrich_legacy_uvs(scene, other)["assets"][0]["stats"]["parts"][0]["uv"]
    assert len(asset_facts._cache) == 1


def test_legacy_uv_recovery_applies_to_patch_assignment_and_real_get_route(store, tmp_path):
    from plastis3d_scene import mutate
    sid, part = _legacy_part_scene(store, tmp_path)
    # Recover via the actual route, without persisting on GET.
    api = _load_plugin_api_standalone()
    before = store.get_scene(sid)
    feedback = api.get_scene(sid)
    assert feedback.status_code == 200
    assert json.loads(feedback.body)["assets"][0]["stats"]["parts"][0]["uv"]
    assert store.get_scene(sid) == before
    # Add a map to an unassigned material, then assign it with the batch door.
    env = tools.set_material(scene=sid, baseRevision=before["revision"], id="m_other", color="#ffffff")
    env = images.import_image_bytes(sid, store, _png(), original_name="skin.png", base_revision=env["scene"]["revision"], material_id="m_other", slot="normalMap")
    current = store.get_scene(sid)
    for row in current["assets"][0]["stats"]["parts"]:
        row.pop("uv", None)
    store.scene_path(sid).write_text(json.dumps(current))
    result = mutate.apply_patch(sid, current["revision"], [{"op": "update_node", "id": part["id"], "materialId": "m_other"}], store=store)
    assert next(n for n in result["nodes"] if n["id"] == part["id"])["materialId"] == "m_other"
    assert result["scene"]["revision"] == current["revision"] + 1


def test_legacy_uv_facts_follow_nonzero_primitive_indices(store, tmp_path):
    from plastis3d_scene import glb, import_model
    from test_import import _glb_from
    sid, _ = _legacy_part_scene(store, tmp_path)
    old = store.get_scene(sid)
    source = store.assets_dir / (old["assets"][0]["sha256"] + ".glb")
    scan = glb.scan(source.read_bytes(), source_format="glb", deadline=time.monotonic() + 10)
    doc = copy.deepcopy(scan.gltf)
    with_uv = copy.deepcopy(doc["meshes"][0]["primitives"][0])
    doc["meshes"][0]["primitives"] = [copy.deepcopy(with_uv), with_uv]
    doc["meshes"][0]["primitives"][0]["attributes"].pop("TEXCOORD_0")
    other_sid = _scene()
    env = import_model.import_bytes(other_sid, store, _glb_from(doc, scan.buffers[0]), original_name="two.glb", source_format="glb", base_revision=1)
    saved = store.get_scene(other_sid)
    for row in saved["assets"][0]["stats"]["parts"]:
        row.pop("uv")
    store.scene_path(other_sid).write_text(json.dumps(saved))
    result = tools.get_scene(scene=other_sid)
    facts = {(row["meshIndex"], row["primitiveIndex"]): row["uv"] for row in result["assets"][0]["stats"]["parts"]}
    assert facts == {(0, 0): False, (0, 1): True}
    assert store.get_scene(other_sid) == saved
