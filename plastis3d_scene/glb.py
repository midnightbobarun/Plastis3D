"""Plastis3D — GLB / embedded glTF scan (PR7, Stage 3).

Scan only: this module parses the container, validates the glTF JSON
against the import contract, and computes the asset stats the exploder
and the view need. It never builds a position array, never decodes a
texture, and never opens a URI.

Contract (standalone-editor.md, Import contract; stage-3.md §4.3):

* GLB: 12-byte header (magic ``0x46546C67``, version 2), a JSON chunk
  (cap 32 MiB) and an optional BIN chunk. Embedded glTF (``.gltf``) is
  the JSON document directly; every buffer is a ``data:`` URI there.
* Compressed glTF is refused: ``KHR_draco_mesh_compression``,
  ``EXT_meshopt_compression``, ``KHR_texture_basisu`` in
  ``extensionsRequired`` / ``extensionsUsed`` or on any mesh /
  primitive / node extension object is ``IMPORT_COMPRESSED``.
* Every ``buffer.uri`` / ``image.uri`` must be a ``data:`` URI;
  anything else is ``IMPORT_EXTERNAL_BUFFER`` and is never opened.
* Accessor byte ranges are verified BEFORE any allocation, dense and
  sparse, with ``start + (count - 1) * stride + elementSize`` — never
  ``count * stride``. Invalid enums, a ``byteStride`` smaller than the
  element size, or a ``count`` below 1 is ``IMPORT_TOO_COMPLEX``.
* The unique ``POSITION`` accessor ``count`` sum is capped at
  5,000,000 (``IMPORT_TOO_COMPLEX``).
* A missing primitive ``mode`` reads as 4 (TRIANGLES) and counts toward
  ``tris``. Any other effective mode sets asset ``tris`` to null and
  lists the primitive in ``stats.ignored``; ``tris`` null forces
  ``drawable`` false. ``drawable`` is false above the provisional
  100,000-triangle draw cap, and false when the file is too large for
  the base64 byte route (``MAX_BYTE_ROUTE_BYTES``).

Decisions recorded in
``docs/planning/stages/pr7-decisions-and-follow-ups-2026-11-07.md``:

* D8 — a ``POSITION`` accessor without ``min``/``max`` is
  ``IMPORT_TOO_COMPLEX`` (glTF 2.0 requires them; the stats need bounds
  and no position array is ever built to compute them).
* D9 — asset ``bounds`` is the union over every primitive's POSITION
  bounds, including non-TRIANGLES primitives: it describes the file's
  extent for the stats-and-bounds fallback.
* D10 — a ``.gltf`` buffer without a ``uri`` is ``IMPORT_TOO_COMPLEX``
  (there is no BIN chunk for it to name).

Stdlib only. Python 3.11-compatible.
"""

from __future__ import annotations

import base64
import binascii
import json
import math
import struct
import time
from dataclasses import dataclass, field
from typing import Any, Optional

from .spec import PlastisError

_GLB_MAGIC = 0x46546C67
_GLB_VERSION = 2
_CHUNK_JSON = 0x4E4F534A  # "JSON"
_CHUNK_BIN = 0x004E4942  # "BIN\0"

# 32 MiB JSON chunk cap (stage-3.md §4.3).
MAX_JSON_CHUNK_BYTES = 32 * 1024 * 1024
# 5,000,000 unique POSITION count (standalone-editor.md, Import contract).
MAX_POSITION_COUNT = 5_000_000
# Provisional draw cap (standalone-editor.md, Caps table; PR1 did not
# replace the number).
MAX_DRAWABLE_TRIS = 100_000
# Largest raw asset the base64 byte route can serve: the 16 MiB JSON
# response cap (PR1 §4.8, measured both directions) holds
# ceil(size * 4 / 3) base64 chars, so size <= 16 MiB * 3 / 4.
MAX_BYTE_ROUTE_BYTES = 16 * 1024 * 1024 * 3 // 4  # 12,582,912

_COMPRESSED_EXTENSIONS = frozenset(
    (
        "KHR_draco_mesh_compression",
        "EXT_meshopt_compression",
        "KHR_texture_basisu",
    )
)

# componentType -> byte size (standalone-editor.md, Import contract).
_COMPONENT_SIZES = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
# accessor type -> component count.
_TYPE_COMPONENTS = {
    "SCALAR": 1,
    "VEC2": 2,
    "VEC3": 3,
    "VEC4": 4,
    "MAT2": 4,
    "MAT3": 9,
    "MAT4": 16,
}
# Sparse index componentType -> byte size.
_SPARSE_INDEX_SIZES = {5121: 1, 5123: 2, 5125: 4}
# Primitive mode -> name (for ignored entries).
_MODE_NAMES = {
    0: "POINTS",
    1: "LINES",
    2: "LINE_LOOP",
    3: "LINE_STRIP",
    4: "TRIANGLES",
    5: "TRIANGLE_STRIP",
    6: "TRIANGLE_FAN",
}


def _fail(code: str, message: str) -> None:
    raise PlastisError(code, "%s: %s" % (code, message))


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _check_deadline(deadline: float) -> None:
    if time.monotonic() >= deadline:
        _fail(
            "IMPORT_TIMEOUT",
            "import exceeded the 30-second budget; nothing was written",
        )


@dataclass
class ScanResult:
    """What the scan proved about one file.

    ``gltf`` is the parsed JSON document; ``buffers`` is the effective
    byte content of each glTF buffer (the GLB BIN chunk, or each decoded
    ``data:`` URI). ``stats`` is the asset-stats dict for the scene
    asset row; ``parts`` is the same list as ``stats["parts"]``.
    """

    gltf: dict
    buffers: list = field(default_factory=list)
    stats: dict = field(default_factory=dict)
    parts: list = field(default_factory=list)


# --- Container parsing -------------------------------------------------------


def _decode_data_uri(uri: Any, what: str) -> bytes:
    """Decode a ``data:`` URI's base64 payload (D10: the caller already
    proved the ``data:`` prefix). Anything undecodable is malformed
    input, not an external fetch."""
    if not isinstance(uri, str) or not uri.startswith("data:"):
        _fail(
            "IMPORT_EXTERNAL_BUFFER",
            "%s uri is not a data: URI; it is not opened" % what,
        )
    try:
        header, payload = uri.split(",", 1)
    except ValueError:
        _fail("IMPORT_TOO_COMPLEX", "%s data: URI has no payload" % what)
        raise AssertionError("unreachable")
    if not header.lower().endswith(";base64"):
        _fail(
            "IMPORT_TOO_COMPLEX",
            "%s data: URI is not base64-encoded" % what,
        )
        raise AssertionError("unreachable")
    compact = "".join(payload.split())
    try:
        return base64.b64decode(compact, validate=True)
    except (binascii.Error, ValueError):
        _fail("IMPORT_TOO_COMPLEX", "%s data: URI is not valid base64" % what)
        raise AssertionError("unreachable")


def _parse_glb(data: bytes) -> tuple:
    """Split GLB bytes into ``(gltf dict, bin chunk or b"")``."""
    if len(data) < 12:
        _fail("IMPORT_FORMAT", "file is %d bytes, shorter than the 12-byte GLB header" % len(data))
    magic, version, total = struct.unpack("<III", data[:12])
    if magic != _GLB_MAGIC:
        _fail("IMPORT_FORMAT", "bad GLB magic 0x%08x (expected 0x46546c67)" % magic)
    if version != _GLB_VERSION:
        _fail("IMPORT_FORMAT", "unsupported GLB version %d (expected 2)" % version)
    if total > len(data):
        _fail(
            "IMPORT_FORMAT",
            "GLB declares %d bytes but the file has %d" % (total, len(data)),
        )
    offset = 12
    if offset + 8 > total:
        _fail("IMPORT_FORMAT", "GLB has no JSON chunk")
    chunk_length, chunk_type = struct.unpack("<II", data[offset : offset + 8])
    if chunk_type != _CHUNK_JSON:
        _fail("IMPORT_FORMAT", "first GLB chunk is not JSON (type 0x%08x)" % chunk_type)
    if chunk_length > MAX_JSON_CHUNK_BYTES:
        _fail(
            "IMPORT_TOO_COMPLEX",
            "JSON chunk is %d bytes, over the 32 MiB cap" % chunk_length,
        )
    json_start = offset + 8
    json_end = json_start + chunk_length
    if json_end > total:
        _fail("IMPORT_FORMAT", "JSON chunk overruns the declared GLB length")
    try:
        gltf = json.loads(data[json_start:json_end].decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        _fail("IMPORT_FORMAT", "JSON chunk is not valid UTF-8 JSON")
        raise AssertionError("unreachable")
    offset = json_end
    bin_data = b""
    if offset < total:
        if offset + 8 > total:
            _fail("IMPORT_FORMAT", "truncated BIN chunk header")
        bin_length, bin_type = struct.unpack("<II", data[offset : offset + 8])
        if bin_type != _CHUNK_BIN:
            _fail("IMPORT_TOO_COMPLEX", "second GLB chunk is not BIN (type 0x%08x)" % bin_type)
        bin_start = offset + 8
        bin_end = bin_start + bin_length
        if bin_end > total:
            _fail("IMPORT_FORMAT", "BIN chunk overruns the declared GLB length")
        bin_data = data[bin_start:bin_end]
        offset = bin_end
        if offset < total:
            _fail("IMPORT_TOO_COMPLEX", "GLB has a chunk after BIN")
    if not isinstance(gltf, dict):
        _fail("IMPORT_FORMAT", "glTF JSON chunk is not an object")
    return gltf, bin_data


def _parse_gltf_text(data: bytes) -> dict:
    """Parse an embedded glTF (``.gltf``) document."""
    if len(data) > MAX_JSON_CHUNK_BYTES:
        _fail(
            "IMPORT_TOO_COMPLEX",
            "glTF JSON is %d bytes, over the 32 MiB cap" % len(data),
        )
    try:
        gltf = json.loads(data.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        _fail("IMPORT_FORMAT", "glTF file is not valid UTF-8 JSON")
        raise AssertionError("unreachable")
    if not isinstance(gltf, dict):
        _fail("IMPORT_FORMAT", "glTF JSON is not an object")
    return gltf


def _resolve_buffers(gltf: dict, bin_data: bytes, source_format: str) -> list:
    """Effective bytes per glTF buffer.

    GLB: buffer 0 is the BIN chunk; any further buffer must be a
    ``data:`` URI. Embedded glTF: every buffer must be a ``data:`` URI
    (D10: a buffer with no URI has no bytes at all). A declared
    ``byteLength`` beyond the available bytes is ``IMPORT_TOO_COMPLEX``.
    """
    buffers_in = gltf.get("buffers", [])
    if not isinstance(buffers_in, list):
        _fail("IMPORT_TOO_COMPLEX", "buffers must be an array")
    buffers: list = []
    for index, buffer_in in enumerate(buffers_in):
        if not isinstance(buffer_in, dict):
            _fail("IMPORT_TOO_COMPLEX", "buffer %d must be an object" % index)
        declared = buffer_in.get("byteLength")
        if not _is_int(declared) or declared < 0:
            _fail(
                "IMPORT_TOO_COMPLEX",
                "buffer %d byteLength must be an integer >= 0" % index,
            )
        uri = buffer_in.get("uri")
        if uri is None:
            if source_format == "glb" and index == 0:
                content = bin_data
            else:
                _fail(
                    "IMPORT_TOO_COMPLEX",
                    "buffer %d has no uri and names no BIN chunk" % index,
                )
                raise AssertionError("unreachable")
        else:
            content = _decode_data_uri(uri, "buffer %d" % index)
        if declared > len(content):
            _fail(
                "IMPORT_TOO_COMPLEX",
                "buffer %d declares byteLength %d but only %d bytes are present"
                % (index, declared, len(content)),
            )
        buffers.append(content[:declared])
    return buffers


# --- Structural checks -------------------------------------------------------


def _check_compressed(gltf: dict) -> None:
    """Any compressed extension anywhere is ``IMPORT_COMPRESSED``."""
    for key in ("extensionsRequired", "extensionsUsed"):
        names = gltf.get(key) or []
        if not isinstance(names, list):
            _fail("IMPORT_TOO_COMPLEX", "%s must be an array" % key)
        for name in names:
            if name in _COMPRESSED_EXTENSIONS:
                _fail(
                    "IMPORT_COMPRESSED",
                    "%s names %s; compressed glTF is refused, never decoded" % (key, name),
                )

    def _walk_extensions(value: Any, where: str) -> None:
        if isinstance(value, dict):
            extensions = value.get("extensions")
            if isinstance(extensions, dict):
                for name in extensions:
                    if name in _COMPRESSED_EXTENSIONS:
                        _fail(
                            "IMPORT_COMPRESSED",
                            "%s uses %s; compressed glTF is refused, never decoded"
                            % (where, name),
                        )
            for key, child in value.items():
                if key != "extensions":
                    _walk_extensions(child, where)
        elif isinstance(value, list):
            for item in value:
                _walk_extensions(item, where)

    for where in ("meshes", "nodes", "materials", "textures", "images"):
        _walk_extensions(gltf.get(where) or [], where)


def _check_uris(gltf: dict) -> None:
    """Every buffer / image URI must be ``data:`` (never opened)."""
    for index, buffer_in in enumerate(gltf.get("buffers", []) or []):
        if isinstance(buffer_in, dict) and "uri" in buffer_in:
            uri = buffer_in.get("uri")
            if not isinstance(uri, str) or not uri.startswith("data:"):
                _fail(
                    "IMPORT_EXTERNAL_BUFFER",
                    "buffer %d uri is not a data: URI; it is not opened" % index,
                )
    for index, image in enumerate(gltf.get("images", []) or []):
        if isinstance(image, dict) and "uri" in image:
            uri = image.get("uri")
            if not isinstance(uri, str) or not uri.startswith("data:"):
                _fail(
                    "IMPORT_EXTERNAL_BUFFER",
                    "image %d uri is not a data: URI; it is not opened" % index,
                )


def _require_list(gltf: dict, key: str) -> list:
    value = gltf.get(key)
    if value is None:
        return []
    if not isinstance(value, list):
        _fail("IMPORT_TOO_COMPLEX", "%s must be an array" % key)
    return value


def _require_index(value: Any, count: int, what: str) -> int:
    if not _is_int(value) or value < 0 or value >= count:
        _fail("IMPORT_TOO_COMPLEX", "%s is out of range" % what)
        raise AssertionError("unreachable")
    return value


def _check_accessor_ranges(
    gltf: dict, buffers: list, deadline: float
) -> None:
    """Verify every accessor's byte range before any allocation.

    ``start + (count - 1) * stride + elementSize`` for the dense view
    and for each sparse view; never ``count * stride``. ``count`` below
    1, an unknown ``componentType`` / ``type``, or a ``byteStride``
    smaller than the element size is ``IMPORT_TOO_COMPLEX``.
    """
    accessors = _require_list(gltf, "accessors")
    views = _require_list(gltf, "bufferViews")

    def _view_range(view_index: int, what: str) -> tuple:
        _require_index(view_index, len(views), "%s bufferView" % what)
        view = views[view_index]
        if not isinstance(view, dict):
            _fail("IMPORT_TOO_COMPLEX", "%s bufferView must be an object" % what)
        buffer_index = view.get("buffer")
        _require_index(buffer_index, len(buffers), "%s buffer" % what)
        view_offset = view.get("byteOffset", 0)
        view_length = view.get("byteLength")
        if not _is_int(view_offset) or view_offset < 0:
            _fail("IMPORT_TOO_COMPLEX", "%s bufferView byteOffset is invalid" % what)
        if not _is_int(view_length) or view_length < 0:
            _fail("IMPORT_TOO_COMPLEX", "%s bufferView byteLength is invalid" % what)
        if view_offset + view_length > len(buffers[buffer_index]):
            _fail(
                "IMPORT_TOO_COMPLEX",
                "%s bufferView [%d, %d) exceeds buffer %d (%d bytes)"
                % (what, view_offset, view_offset + view_length, buffer_index, len(buffers[buffer_index])),
            )
        return view_offset, view_length

    for index, accessor in enumerate(accessors):
        if index % 1024 == 0:
            _check_deadline(deadline)
        what = "accessor %d" % index
        if not isinstance(accessor, dict):
            _fail("IMPORT_TOO_COMPLEX", "%s must be an object" % what)
        component_type = accessor.get("componentType")
        if component_type not in _COMPONENT_SIZES:
            _fail("IMPORT_TOO_COMPLEX", "%s componentType %r is not a glTF enum" % (what, component_type))
        accessor_type = accessor.get("type")
        if accessor_type not in _TYPE_COMPONENTS:
            _fail("IMPORT_TOO_COMPLEX", "%s type %r is not a glTF enum" % (what, accessor_type))
        count = accessor.get("count")
        if not _is_int(count) or count < 1:
            _fail("IMPORT_TOO_COMPLEX", "%s count must be an integer >= 1" % what)
        element_size = _COMPONENT_SIZES[component_type] * _TYPE_COMPONENTS[accessor_type]
        byte_offset = accessor.get("byteOffset", 0)
        if not _is_int(byte_offset) or byte_offset < 0:
            _fail("IMPORT_TOO_COMPLEX", "%s byteOffset is invalid" % what)
        view_index = accessor.get("bufferView")
        if view_index is not None:
            view_offset, view_length = _view_range(view_index, what)
            view = views[view_index]
            stride = view.get("byteStride", element_size)
            if not _is_int(stride) or stride < element_size:
                _fail(
                    "IMPORT_TOO_COMPLEX",
                    "%s byteStride %r is smaller than the element size %d"
                    % (what, stride, element_size),
                )
            start = view_offset + byte_offset
            end = start + (count - 1) * stride + element_size
            if end > view_offset + view_length:
                _fail(
                    "IMPORT_TOO_COMPLEX",
                    "%s byte range [%d, %d) exceeds its bufferView (%d bytes)"
                    % (what, start, end, view_length),
                )
        sparse = accessor.get("sparse")
        if sparse is not None:
            if not isinstance(sparse, dict):
                _fail("IMPORT_TOO_COMPLEX", "%s sparse must be an object" % what)
            sparse_count = sparse.get("count")
            if not _is_int(sparse_count) or sparse_count < 0:
                _fail("IMPORT_TOO_COMPLEX", "%s sparse count is invalid" % what)
            if sparse_count > count:
                _fail(
                    "IMPORT_TOO_COMPLEX",
                    "%s sparse count %d exceeds accessor count %d" % (what, sparse_count, count),
                )
            if sparse_count == 0:
                continue
            indices = sparse.get("indices")
            values = sparse.get("values")
            if not isinstance(indices, dict) or not isinstance(values, dict):
                _fail("IMPORT_TOO_COMPLEX", "%s sparse needs indices and values" % what)
            index_type = indices.get("componentType")
            if index_type not in _SPARSE_INDEX_SIZES:
                _fail(
                    "IMPORT_TOO_COMPLEX",
                    "%s sparse index componentType %r is not a glTF enum" % (what, index_type),
                )
            index_size = _SPARSE_INDEX_SIZES[index_type]
            for side, size in (("indices", index_size), ("values", element_size)):
                part = sparse[side]
                part_view = part.get("bufferView")
                if part_view is None:
                    _fail("IMPORT_TOO_COMPLEX", "%s sparse %s needs a bufferView" % (what, side))
                part_offset, part_length = _view_range(part_view, "%s sparse %s" % (what, side))
                part_byte_offset = part.get("byteOffset", 0)
                if not _is_int(part_byte_offset) or part_byte_offset < 0:
                    _fail("IMPORT_TOO_COMPLEX", "%s sparse %s byteOffset is invalid" % (what, side))
                start = part_offset + part_byte_offset
                end = start + (sparse_count - 1) * size + size
                if end > part_offset + part_length:
                    _fail(
                        "IMPORT_TOO_COMPLEX",
                        "%s sparse %s byte range [%d, %d) exceeds its bufferView (%d bytes)"
                        % (what, side, start, end, part_length),
                    )


def _check_structure(gltf: dict) -> None:
    """Index and shape checks the range pass does not cover: mesh /
    node / scene references must name real entries."""
    meshes = _require_list(gltf, "meshes")
    accessors = _require_list(gltf, "accessors")
    nodes = _require_list(gltf, "nodes")
    scenes = _require_list(gltf, "scenes")
    cameras = _require_list(gltf, "cameras")
    extensions = gltf.get("extensions")
    lights = []
    if isinstance(extensions, dict):
        punctual = extensions.get("KHR_lights_punctual")
        if isinstance(punctual, dict):
            lights = punctual.get("lights", [])
    if not isinstance(lights, list):
        _fail("IMPORT_TOO_COMPLEX", "KHR_lights_punctual lights must be an array")
    for mesh_index, mesh in enumerate(meshes):
        if not isinstance(mesh, dict):
            _fail("IMPORT_TOO_COMPLEX", "mesh %d must be an object" % mesh_index)
        primitives = mesh.get("primitives")
        if not isinstance(primitives, list) or not primitives:
            _fail("IMPORT_TOO_COMPLEX", "mesh %d needs a non-empty primitives array" % mesh_index)
        for prim_index, primitive in enumerate(primitives):
            what = "mesh %d primitive %d" % (mesh_index, prim_index)
            if not isinstance(primitive, dict):
                _fail("IMPORT_TOO_COMPLEX", "%s must be an object" % what)
            attributes = primitive.get("attributes")
            if not isinstance(attributes, dict):
                _fail("IMPORT_TOO_COMPLEX", "%s needs an attributes object" % what)
            position = attributes.get("POSITION")
            if position is None:
                _fail("IMPORT_TOO_COMPLEX", "%s has no POSITION attribute" % what)
            _require_index(position, len(accessors), "%s POSITION accessor" % what)
            for attr, acc_index in attributes.items():
                _require_index(acc_index, len(accessors), "%s attribute %s accessor" % (what, attr))
            indices = primitive.get("indices")
            if indices is not None:
                _require_index(indices, len(accessors), "%s indices accessor" % what)
            mode = primitive.get("mode", 4)
            if not _is_int(mode) or mode not in _MODE_NAMES:
                _fail("IMPORT_TOO_COMPLEX", "%s mode %r is not a glTF enum" % (what, mode))
    for node_index, node in enumerate(nodes):
        if not isinstance(node, dict):
            _fail("IMPORT_TOO_COMPLEX", "node %d must be an object" % node_index)
        what = "node %d" % node_index
        if "mesh" in node:
            _require_index(node["mesh"], len(meshes), "%s mesh" % what)
        if "camera" in node:
            _require_index(node["camera"], len(cameras), "%s camera" % what)
        if "skin" in node:
            _require_index(node["skin"], len(_require_list(gltf, "skins")), "%s skin" % what)
        children = node.get("children")
        if children is not None:
            if not isinstance(children, list):
                _fail("IMPORT_TOO_COMPLEX", "%s children must be an array" % what)
            for child in children:
                _require_index(child, len(nodes), "%s child" % what)
        extensions = node.get("extensions")
        if isinstance(extensions, dict) and "KHR_lights_punctual" in extensions:
            light_ref = extensions["KHR_lights_punctual"]
            if not isinstance(light_ref, dict) or "light" not in light_ref:
                _fail("IMPORT_TOO_COMPLEX", "%s KHR_lights_punctual needs a light index" % what)
            _require_index(light_ref["light"], len(lights), "%s light" % what)
    scene_index = gltf.get("scene", 0)
    if scenes:
        if not _is_int(scene_index) or scene_index < 0 or scene_index >= len(scenes):
            _fail("IMPORT_TOO_COMPLEX", "scene index %r is out of range" % (scene_index,))
        for node_index in scenes[scene_index].get("nodes", []) or []:
            _require_index(node_index, len(nodes), "scene root node")
    for scene in scenes:
        if not isinstance(scene, dict):
            _fail("IMPORT_TOO_COMPLEX", "scene must be an object")
        for node_index in scene.get("nodes", []) or []:
            _require_index(node_index, len(nodes), "scene node")


# --- Stats -------------------------------------------------------------------


def _position_bounds(accessor: dict, what: str) -> tuple:
    """``(min, max)`` for a POSITION accessor (D8: missing min/max is
    ``IMPORT_TOO_COMPLEX`` — glTF 2.0 requires them and no position
    array is ever built to compute them)."""
    for key in ("min", "max"):
        value = accessor.get(key)
        if (
            not isinstance(value, list)
            or len(value) != 3
            or not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in value)
        ):
            _fail(
                "IMPORT_TOO_COMPLEX",
                "%s POSITION accessor needs finite %s [x, y, z]" % (what, key),
            )
    lo, hi = accessor["min"], accessor["max"]
    for axis in range(3):
        if lo[axis] > hi[axis]:
            _fail("IMPORT_TOO_COMPLEX", "%s POSITION bounds min exceeds max" % what)
    return [float(v) for v in lo], [float(v) for v in hi]


def _compute_stats(gltf: dict, file_size: int) -> tuple:
    """Per-part and asset stats. Returns ``(parts, ignored, stats)``.

    Only TRIANGLES primitives become parts. A non-TRIANGLES primitive
    is listed in ``ignored`` and nulls the asset ``tris`` (which forces
    ``drawable`` false); glTF cameras and lights are listed the same
    way. Asset ``bounds`` unions every primitive's POSITION bounds (D9).
    """
    accessors = _require_list(gltf, "accessors")
    meshes = _require_list(gltf, "meshes")
    nodes = _require_list(gltf, "nodes")
    parts: list = []
    ignored: list = []
    position_accessors: set = set()
    total_tris: Optional[int] = 0
    all_min: Optional[list] = None
    all_max: Optional[list] = None

    for mesh_index, mesh in enumerate(meshes):
        for prim_index, primitive in enumerate(mesh.get("primitives", [])):
            what = "mesh %d primitive %d" % (mesh_index, prim_index)
            position_index = primitive["attributes"]["POSITION"]
            position_accessors.add(position_index)
            position = accessors[position_index]
            lo, hi = _position_bounds(position, what)
            if all_min is None:
                all_min, all_max = list(lo), list(hi)
            else:
                for axis in range(3):
                    all_min[axis] = min(all_min[axis], lo[axis])
                    all_max[axis] = max(all_max[axis], hi[axis])
            mode = primitive.get("mode", 4)
            if mode != 4:
                ignored.append(
                    "%s: mode %d (%s) is not TRIANGLES; skipped"
                    % (what, mode, _MODE_NAMES[mode])
                )
                total_tris = None
                continue
            verts = position["count"]
            indices = primitive.get("indices")
            if indices is not None:
                tris = accessors[indices]["count"] // 3
            else:
                tris = verts // 3
            if total_tris is not None:
                total_tris += tris
            parts.append(
                {
                    "meshIndex": mesh_index,
                    "primitiveIndex": prim_index,
                    "tris": tris,
                    "verts": verts,
                    "bounds": {"min": lo, "max": hi},
                    # PR15: a texture needs TEXCOORD_0 on the part's primitive.
                    "uv": "TEXCOORD_0" in primitive["attributes"],
                }
            )

    for node_index, node in enumerate(nodes):
        name = node.get("name")
        label = "%r" % name if isinstance(name, str) and name else "node %d" % node_index
        if "camera" in node:
            ignored.append("camera %d (%s): glTF cameras are not imported" % (node_index, label))
        extensions = node.get("extensions")
        if isinstance(extensions, dict) and "KHR_lights_punctual" in extensions:
            ignored.append("light %d (%s): glTF lights are not imported" % (node_index, label))

    verts = sum(accessors[i]["count"] for i in position_accessors)
    if verts > MAX_POSITION_COUNT:
        _fail(
            "IMPORT_TOO_COMPLEX",
            "unique POSITION count %d exceeds the 5,000,000 cap" % verts,
        )
    drawable = (
        total_tris is not None
        and total_tris <= MAX_DRAWABLE_TRIS
        and file_size <= MAX_BYTE_ROUTE_BYTES
    )
    stats: dict = {
        "verts": verts,
        "materials": len(_require_list(gltf, "materials")),
        "meshes": len(meshes),
        "clips": len(_require_list(gltf, "animations")),
        "skins": len(_require_list(gltf, "skins")),
        "drawable": drawable,
        "parts": parts,
    }
    if total_tris is not None:
        stats["tris"] = total_tris
    if all_min is not None:
        stats["bounds"] = {"min": all_min, "max": all_max}
    if ignored:
        stats["ignored"] = ignored
    return parts, ignored, stats


# --- Entry point ---------------------------------------------------------------


def scan(data: bytes, *, source_format: str, deadline: float) -> ScanResult:
    """Scan one file's bytes. Raises :class:`PlastisError` with a stable
    import code on any refusal; returns the parsed document, the
    effective buffer bytes, and the asset stats on success.

    ``source_format`` is ``"glb"`` or ``"gltf"``. ``deadline`` is a
    ``time.monotonic()`` value; a past deadline raises
    ``IMPORT_TIMEOUT`` before any work.
    """
    _check_deadline(deadline)
    if source_format == "glb":
        gltf, bin_data = _parse_glb(data)
        buffers = _resolve_buffers(gltf, bin_data, source_format)
    elif source_format == "gltf":
        gltf = _parse_gltf_text(data)
        buffers = _resolve_buffers(gltf, b"", source_format)
    else:
        _fail("IMPORT_FORMAT", "unknown source format %r" % source_format)
        raise AssertionError("unreachable")
    _check_deadline(deadline)
    asset = gltf.get("asset")
    if not isinstance(asset, dict) or asset.get("version") != "2.0":
        _fail("IMPORT_FORMAT", "glTF asset version must be 2.0")
    _check_compressed(gltf)
    _check_uris(gltf)
    _check_deadline(deadline)
    _check_accessor_ranges(gltf, buffers, deadline)
    _check_structure(gltf)
    _check_deadline(deadline)
    parts, _ignored, stats = _compute_stats(gltf, len(data))
    return ScanResult(gltf=gltf, buffers=buffers, stats=stats, parts=parts)


def build_glb(gltf: dict, buffers: list) -> bytes:
    """Pack a parsed glTF document plus its buffer bytes as one GLB.

    Used for ``.gltf`` input (standalone-editor.md rule 6: embedded
    glTF is stored as GLB): the buffers are concatenated into a single
    BIN chunk (each base 4-byte aligned) and every bufferView is
    re-pointed at buffer 0 with its offset rebased. The JSON chunk is
    the same document with the single-buffer ``buffers`` array.
    """
    remapped = json.loads(json.dumps(gltf))
    bin_data = bytearray()
    bases: list = []
    for content in buffers:
        pad = (-len(bin_data)) % 4
        if pad:
            bin_data.extend(b"\x00" * pad)
        bases.append(len(bin_data))
        bin_data.extend(content)
    for view in remapped.get("bufferViews", []) or []:
        buffer_index = view.get("buffer", 0)
        view["buffer"] = 0
        view["byteOffset"] = bases[buffer_index] + view.get("byteOffset", 0)
    remapped["buffers"] = [{"byteLength": len(bin_data)}]
    json_bytes = json.dumps(remapped, separators=(",", ":"), sort_keys=True).encode("utf-8")
    json_bytes += b" " * ((-len(json_bytes)) % 4)
    bin_bytes = bytes(bin_data)
    bin_bytes += b"\x00" * ((-len(bin_bytes)) % 4)
    total = 12 + 8 + len(json_bytes) + 8 + len(bin_bytes)
    return (
        struct.pack("<III", _GLB_MAGIC, _GLB_VERSION, total)
        + struct.pack("<II", len(json_bytes), _CHUNK_JSON)
        + json_bytes
        + struct.pack("<II", len(bin_bytes), _CHUNK_BIN)
        + bin_bytes
    )
