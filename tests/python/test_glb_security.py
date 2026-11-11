"""PR7 import security tests (Tier 1, stage-3.md §5).

Malicious GLBs against :func:`plastis3d_scene.glb.scan`: truncated
chunks, out-of-bounds accessors (dense and sparse), compressed
rejection, external URIs, and the POSITION-count cap. The scan must
return a stable import code — never a crash, never an allocation
driven by attacker-controlled counts.

Run: pytest tests/python (from tests/python, see the repo README note
on the pytest-9 root-collection quirk) or pytest tests/python/test_glb_security.py
"""

import base64
import json
import math
import struct
import time

import pytest

from plastis3d_scene import glb
from plastis3d_scene.spec import PlastisError

_GLB_MAGIC = 0x46546C67
_CHUNK_JSON = 0x4E4F534A
_CHUNK_BIN = 0x004E4942


def _pack_glb(gltf, bin_data=b""):
    """Pack a glTF dict + BIN bytes as a GLB (test-side builder)."""
    json_bytes = json.dumps(gltf, separators=(",", ":"), sort_keys=True).encode("utf-8")
    json_bytes += b" " * ((-len(json_bytes)) % 4)
    bin_data = bytes(bin_data) + b"\x00" * ((-len(bin_data)) % 4)
    out = (
        struct.pack("<III", _GLB_MAGIC, 2, 12 + 8 + len(json_bytes) + (8 + len(bin_data) if bin_data else 0))
        + struct.pack("<II", len(json_bytes), _CHUNK_JSON)
        + json_bytes
    )
    if bin_data:
        out += struct.pack("<II", len(bin_data), _CHUNK_BIN) + bin_data
    return out


def _base_gltf():
    """One mesh, one TRIANGLES primitive, 36 non-indexed POSITION
    vertices (all zeros), min/max present. Returns (gltf, bin)."""
    positions = [0.0] * (36 * 3)
    blob = struct.pack("<%df" % len(positions), *positions)
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
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(blob)}],
        "buffers": [{"byteLength": len(blob)}],
    }
    return gltf, blob


def _scan(data, source_format="glb"):
    return glb.scan(data, source_format=source_format, deadline=time.monotonic() + 30.0)


def _expect_code(data, code, source_format="glb"):
    with pytest.raises(PlastisError) as excinfo:
        _scan(data, source_format)
    assert excinfo.value.code == code, excinfo.value
    assert str(excinfo.value).startswith(code)


# --- Container ---------------------------------------------------------------


def test_truncated_header():
    _expect_code(b"glTF", "IMPORT_FORMAT")
    _expect_code(b"glTF\x02\x00\x00\x00\x0c", "IMPORT_FORMAT")


def test_bad_magic():
    gltf, blob = _base_gltf()
    data = bytearray(_pack_glb(gltf, blob))
    data[0:4] = b"XXXX"
    _expect_code(bytes(data), "IMPORT_FORMAT")


def test_bad_version():
    gltf, blob = _base_gltf()
    data = bytearray(_pack_glb(gltf, blob))
    data[4:8] = struct.pack("<I", 1)
    _expect_code(bytes(data), "IMPORT_FORMAT")


def test_declared_length_beyond_file():
    gltf, blob = _base_gltf()
    data = bytearray(_pack_glb(gltf, blob))
    data[8:12] = struct.pack("<I", len(data) + 1000)
    _expect_code(bytes(data), "IMPORT_FORMAT")


def test_truncated_json_chunk():
    gltf, blob = _base_gltf()
    packed = _pack_glb(gltf, blob)
    # Claim a JSON chunk longer than the bytes present.
    header = struct.pack("<III", _GLB_MAGIC, 2, 12 + 8 + 10_000)
    chunk_header = struct.pack("<II", 10_000, _CHUNK_JSON)
    _expect_code(header + chunk_header + packed[20:40], "IMPORT_FORMAT")


def test_json_chunk_over_32mib():
    gltf, blob = _base_gltf()
    gltf["asset"]["extras"] = "x" * (32 * 1024 * 1024)
    _expect_code(_pack_glb(gltf, blob), "IMPORT_TOO_COMPLEX")


def test_gltf_text_not_json():
    _expect_code(b"this is not json", "IMPORT_FORMAT", source_format="gltf")


def test_gltf_version_not_2():
    _expect_code(
        json.dumps({"asset": {"version": "1.0"}}).encode("utf-8"),
        "IMPORT_FORMAT",
        source_format="gltf",
    )


def test_gltf_json_over_32mib():
    payload = {"asset": {"version": "2.0"}, "extras": "x" * (32 * 1024 * 1024)}
    _expect_code(
        json.dumps(payload).encode("utf-8"), "IMPORT_TOO_COMPLEX", source_format="gltf"
    )


# --- Compressed glTF -----------------------------------------------------------


@pytest.mark.parametrize("extension", sorted(glb._COMPRESSED_EXTENSIONS))
def test_compressed_in_extensions_required(extension):
    gltf, blob = _base_gltf()
    gltf["extensionsRequired"] = [extension]
    gltf["extensionsUsed"] = [extension]
    _expect_code(_pack_glb(gltf, blob), "IMPORT_COMPRESSED")


@pytest.mark.parametrize("extension", sorted(glb._COMPRESSED_EXTENSIONS))
def test_compressed_in_extensions_used_only(extension):
    gltf, blob = _base_gltf()
    gltf["extensionsUsed"] = [extension]
    _expect_code(_pack_glb(gltf, blob), "IMPORT_COMPRESSED")


def test_compressed_on_primitive_extension():
    gltf, blob = _base_gltf()
    gltf["meshes"][0]["primitives"][0]["extensions"] = {
        "KHR_draco_mesh_compression": {"bufferView": 0}
    }
    _expect_code(_pack_glb(gltf, blob), "IMPORT_COMPRESSED")


# --- External URIs ---------------------------------------------------------------


@pytest.mark.parametrize(
    "uri", ["model.bin", "file:///etc/passwd", "https://example.invalid/m.bin", "/abs/path.bin"]
)
def test_external_buffer_uri(uri):
    gltf, blob = _base_gltf()
    gltf["buffers"] = [{"byteLength": len(blob), "uri": uri}]
    gltf["bufferViews"] = []
    gltf["accessors"] = []
    gltf["meshes"] = []
    gltf["nodes"] = []
    gltf["scenes"] = [{"nodes": []}]
    _expect_code(_pack_glb(gltf), "IMPORT_EXTERNAL_BUFFER")


def test_external_image_uri():
    gltf, blob = _base_gltf()
    gltf["images"] = [{"uri": "https://example.invalid/tex.png"}]
    _expect_code(_pack_glb(gltf, blob), "IMPORT_EXTERNAL_BUFFER")


def test_data_uri_buffer_in_gltf_scans():
    gltf, blob = _base_gltf()
    encoded = base64.b64encode(blob).decode("ascii")
    gltf["buffers"] = [{"byteLength": len(blob), "uri": "data:application/octet-stream;base64,%s" % encoded}]
    result = _scan(json.dumps(gltf).encode("utf-8"), source_format="gltf")
    assert result.stats["tris"] == 12
    assert result.stats["drawable"] is True


def test_gltf_buffer_without_uri():
    gltf, blob = _base_gltf()
    gltf["buffers"] = [{"byteLength": len(blob)}]
    _expect_code(
        json.dumps(gltf).encode("utf-8"), "IMPORT_TOO_COMPLEX", source_format="gltf"
    )


def test_gltf_buffer_bad_base64():
    gltf, blob = _base_gltf()
    gltf["buffers"] = [{"byteLength": 4, "uri": "data:;base64,!!!not-base64!!!"}]
    _expect_code(
        json.dumps(gltf).encode("utf-8"), "IMPORT_TOO_COMPLEX", source_format="gltf"
    )


# --- Accessor ranges ---------------------------------------------------------------


def test_accessor_dense_out_of_bounds():
    gltf, blob = _base_gltf()
    gltf["accessors"][0]["count"] = 37  # needs 444 bytes; the view has 432
    _expect_code(_pack_glb(gltf, blob), "IMPORT_TOO_COMPLEX")


def test_interleaved_accessor_last_byte_formula():
    """The design's inequality, not count*stride: 2 vertices, stride
    24, element 12 — the last byte is start + (2-1)*24 + 12 = 36, which
    fits a 36-byte view. count*stride (48) would wrongly refuse it."""
    gltf, blob = _base_gltf()
    interleaved = bytearray(36)
    gltf["accessors"][0]["count"] = 2
    gltf["accessors"][0]["min"] = [0.0, 0.0, 0.0]
    gltf["accessors"][0]["max"] = [0.0, 0.0, 0.0]
    gltf["bufferViews"][0] = {
        "buffer": 0,
        "byteOffset": 0,
        "byteLength": 36,
        "byteStride": 24,
    }
    gltf["buffers"][0]["byteLength"] = 36
    result = _scan(_pack_glb(gltf, bytes(interleaved)))
    assert result.parts[0]["verts"] == 2
    assert result.parts[0]["tris"] == 0  # 2 verts, non-indexed: 0 whole triangles


def test_accessor_bad_component_type():
    gltf, blob = _base_gltf()
    gltf["accessors"][0]["componentType"] = 5127
    _expect_code(_pack_glb(gltf, blob), "IMPORT_TOO_COMPLEX")


def test_accessor_bad_type():
    gltf, blob = _base_gltf()
    gltf["accessors"][0]["type"] = "VEC5"
    _expect_code(_pack_glb(gltf, blob), "IMPORT_TOO_COMPLEX")


def test_accessor_count_zero():
    gltf, blob = _base_gltf()
    gltf["accessors"][0]["count"] = 0
    _expect_code(_pack_glb(gltf, blob), "IMPORT_TOO_COMPLEX")


def test_bytestride_smaller_than_element():
    gltf, blob = _base_gltf()
    gltf["bufferViews"][0]["byteStride"] = 8  # VEC3 float32 needs 12
    _expect_code(_pack_glb(gltf, blob), "IMPORT_TOO_COMPLEX")


def test_buffer_bytelength_beyond_bin():
    gltf, blob = _base_gltf()
    gltf["buffers"][0]["byteLength"] = len(blob) + 4
    _expect_code(_pack_glb(gltf, blob), "IMPORT_TOO_COMPLEX")


def _sparse_gltf(indices_over=False, values_over=False, count_over=False):
    """A POSITION accessor with no dense bufferView and a sparse
    override: 3 sparse entries over a 4-byte index view and a 36-byte
    value view (both inside one 40-byte buffer)."""
    gltf, blob = _base_gltf()
    index_blob = struct.pack("<HHH", 0, 1, 2)  # 6 bytes
    value_blob = struct.pack("<9f", *([0.0] * 9))  # 36 bytes
    bin_data = index_blob + b"\x00\x00" + value_blob  # 44 bytes
    sparse_count = 4 if count_over else 3
    index_length = 4 if indices_over else 6  # 3 indices x 2 bytes need 6
    value_length = 24 if values_over else 36  # 3 values x 12 bytes need 36
    gltf["accessors"][0] = {
        "componentType": 5126,
        "count": 3,
        "type": "VEC3",
        "min": [0.0, 0.0, 0.0],
        "max": [0.0, 0.0, 0.0],
        "sparse": {
            "count": sparse_count,
            "indices": {"bufferView": 0, "componentType": 5123},
            "values": {"bufferView": 1},
        },
    }
    gltf["bufferViews"] = [
        {"buffer": 0, "byteOffset": 0, "byteLength": index_length},
        {"buffer": 0, "byteOffset": 8, "byteLength": value_length},
    ]
    gltf["buffers"] = [{"byteLength": len(bin_data)}]
    return gltf, bin_data


def test_sparse_indices_out_of_bounds():
    gltf, bin_data = _sparse_gltf(indices_over=True)
    _expect_code(_pack_glb(gltf, bin_data), "IMPORT_TOO_COMPLEX")


def test_sparse_values_out_of_bounds():
    gltf, bin_data = _sparse_gltf(values_over=True)
    _expect_code(_pack_glb(gltf, bin_data), "IMPORT_TOO_COMPLEX")


def test_sparse_count_exceeds_accessor():
    gltf, bin_data = _sparse_gltf(count_over=True)
    _expect_code(_pack_glb(gltf, bin_data), "IMPORT_TOO_COMPLEX")


def test_sparse_valid_scans():
    gltf, bin_data = _sparse_gltf()
    result = _scan(_pack_glb(gltf, bin_data))
    assert result.parts[0]["verts"] == 3


# --- POSITION count cap ---------------------------------------------------------------


def test_position_count_cap():
    """5,000,001 unique POSITION vertices, no bufferView (so no dense
    range can mask the cap): the cap fires before any allocation."""
    gltf, blob = _base_gltf()
    gltf["accessors"][0] = {
        "componentType": 5126,
        "count": 5_000_001,
        "type": "VEC3",
        "min": [0.0, 0.0, 0.0],
        "max": [0.0, 0.0, 0.0],
    }
    gltf["bufferViews"] = []
    gltf["buffers"] = []
    _expect_code(_pack_glb(gltf), "IMPORT_TOO_COMPLEX")


def test_position_count_at_cap_scans():
    gltf, blob = _base_gltf()
    gltf["accessors"][0] = {
        "componentType": 5126,
        "count": 5_000_000,
        "type": "VEC3",
        "min": [0.0, 0.0, 0.0],
        "max": [0.0, 0.0, 0.0],
    }
    gltf["bufferViews"] = []
    gltf["buffers"] = []
    result = _scan(_pack_glb(gltf))
    assert result.stats["verts"] == 5_000_000
    assert result.stats["drawable"] is False  # tris 1,666,666 > 100,000


def test_missing_position_min_max():
    gltf, blob = _base_gltf()
    del gltf["accessors"][0]["min"]
    del gltf["accessors"][0]["max"]
    _expect_code(_pack_glb(gltf, blob), "IMPORT_TOO_COMPLEX")


# --- Modes, tris, drawable ---------------------------------------------------------------


def test_omitted_mode_counts_as_triangles():
    result = _scan(_pack_glb(*_base_gltf()))
    assert result.stats["tris"] == 12
    assert result.stats["drawable"] is True
    assert result.parts[0]["tris"] == 12


def test_non_triangles_mode_nulls_tris():
    gltf, blob = _base_gltf()
    gltf["meshes"][0]["primitives"][0]["mode"] = 1  # LINES
    result = _scan(_pack_glb(gltf, blob))
    assert "tris" not in result.stats
    assert result.stats["drawable"] is False
    assert result.parts == []
    assert any("LINES" in entry for entry in result.stats["ignored"])


def test_indexed_tris():
    gltf, blob = _base_gltf()
    positions = struct.pack("<9f", *([0.0] * 9))
    indices = struct.pack("<6H", 0, 1, 2, 0, 2, 1)
    bin_data = positions + indices
    gltf["accessors"] = [
        {
            "bufferView": 0,
            "componentType": 5126,
            "count": 3,
            "type": "VEC3",
            "min": [0.0, 0.0, 0.0],
            "max": [0.0, 0.0, 0.0],
        },
        {"bufferView": 1, "componentType": 5123, "count": 6, "type": "SCALAR"},
    ]
    gltf["bufferViews"] = [
        {"buffer": 0, "byteOffset": 0, "byteLength": len(positions)},
        {"buffer": 0, "byteOffset": len(positions), "byteLength": len(indices)},
    ]
    gltf["buffers"] = [{"byteLength": len(bin_data)}]
    gltf["meshes"][0]["primitives"][0]["indices"] = 1
    result = _scan(_pack_glb(gltf, bin_data))
    assert result.parts[0]["tris"] == 2
    assert result.parts[0]["verts"] == 3
    assert result.stats["tris"] == 2


def test_cameras_and_lights_ignored():
    gltf, blob = _base_gltf()
    gltf["cameras"] = [{"type": "perspective", "perspective": {"yfov": 0.7, "znear": 0.1}}]
    gltf["extensions"] = {"KHR_lights_punctual": {"lights": [{"type": "point"}]}}
    gltf["nodes"] = [
        {"mesh": 0, "name": "root"},
        {"camera": 0, "name": "cam"},
        {"extensions": {"KHR_lights_punctual": {"light": 0}}, "name": "lamp"},
    ]
    gltf["scenes"] = [{"nodes": [0, 1, 2]}]
    result = _scan(_pack_glb(gltf, blob))
    assert any("camera 1" in entry for entry in result.stats["ignored"])
    assert any("light 2" in entry for entry in result.stats["ignored"])
    assert result.stats["tris"] == 12


# --- Structure -------------------------------------------------------------------


def test_node_mesh_index_out_of_range():
    gltf, blob = _base_gltf()
    gltf["nodes"][0]["mesh"] = 5
    _expect_code(_pack_glb(gltf, blob), "IMPORT_TOO_COMPLEX")


def test_scene_root_out_of_range():
    gltf, blob = _base_gltf()
    gltf["scenes"] = [{"nodes": [9]}]
    _expect_code(_pack_glb(gltf, blob), "IMPORT_TOO_COMPLEX")


def test_primitive_without_position():
    gltf, blob = _base_gltf()
    gltf["meshes"][0]["primitives"][0]["attributes"] = {"NORMAL": 0}
    _expect_code(_pack_glb(gltf, blob), "IMPORT_TOO_COMPLEX")


def test_scan_timeout():
    gltf, blob = _base_gltf()
    with pytest.raises(PlastisError) as excinfo:
        glb.scan(_pack_glb(gltf, blob), source_format="glb", deadline=time.monotonic() - 1.0)
    assert excinfo.value.code == "IMPORT_TIMEOUT"
