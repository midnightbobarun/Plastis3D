"""Plastis3D — OBJ, STL and PLY readers (PR12, Stage 3 §4.5).

Each reader turns one file into **one one-mesh GLB** (one node, one mesh,
one TRIANGLES primitive). The rest of the import flow then treats it as a
GLB: ``glb.scan`` checks it, the asset is content-addressed by the stored
GLB's sha256, and PR8's splice exports it. Nothing here touches the scene
store or the lock; the parsers run before either, under the import
deadline.

Contract (standalone-editor.md, "Import contract / After the pin"):

* **STL**: ASCII, and binary little-endian. A binary file whose declared
  triangle count only fits big-endian, or that is truncated, is refused.
  Facet normals and the attribute bytes are ignored (the loader derives
  flat normals).
* **OBJ**: ``v`` / ``vt`` / ``vn`` / ``f`` including negative indexes.
  n-gons are fan-triangulated from the first corner. One mesh, and the
  **first** material only: further ``usemtl`` names are listed in
  ``stats.ignored``. ``mtllib`` is read only through the caller's loader,
  which confines it to the OBJ's own directory (path door) or to the
  uploaded sidecars (upload door). ``map_*`` lines are never opened.
* **PLY**: ``ascii``, ``binary_little_endian`` and ``binary_big_endian``;
  triangle and polygon faces (fan-triangulated); ``red/green/blue(/alpha)``
  vertex colours become ``COLOR_0``; ``nx/ny/nz`` become ``NORMAL``. Other
  elements and properties are skipped, and named in ``ignored``.
* **No axis conversion and no unit conversion.** A 180 mm STL stays 180
  units.

Caps are checked **before** the arrays are built: more than 5,000,000
vertices (or triangles) is ``IMPORT_TOO_COMPLEX``. Every loop checks the
deadline. Stdlib only.
"""

from __future__ import annotations

import math
import re
import struct
import sys
import time
from array import array
from typing import Any, Callable, Optional

from . import glb as _glb
from .spec import PlastisError

MAX_VERTICES = _glb.MAX_POSITION_COUNT  # 5,000,000
MAX_TRIANGLES = 5_000_000
MAX_MTL_BYTES = 1024 * 1024
_CHECK_EVERY = 4096  # deadline poll interval, in lines / faces

MESH_FORMATS = ("obj", "stl", "ply")

DEFAULT_MATERIAL_NAME = "m_default"
_DEFAULT_COLOR = [0.8, 0.8, 0.8, 1.0]

# An MTL loader takes the name written after `mtllib` and returns
# ``(bytes | None, note | None)``: the file's bytes when it was read, or
# ``None`` plus a short reason to put in ``stats.ignored``. It raises
# PlastisError(IMPORT_PATH_DENIED) when the name escapes its directory.
MtlLoader = Callable[[str], tuple]


def _fail(code: str, message: str) -> None:
    raise PlastisError(code, "%s: %s" % (code, message))


def _check_deadline(deadline: float) -> None:
    if time.monotonic() >= deadline:
        _fail(
            "IMPORT_TIMEOUT",
            "import exceeded the 30-second budget; nothing was written",
        )


def _too_complex(what: str, count: int, cap: int) -> None:
    _fail(
        "IMPORT_TOO_COMPLEX",
        "%s count %d exceeds the %s cap" % (what, count, format(cap, ",")),
    )


# --- GLB assembly ----------------------------------------------------------------


def _pad4(buf: bytearray) -> None:
    buf.extend(b"\x00" * ((-len(buf)) % 4))


def _le_bytes(values: array) -> bytes:
    """An ``array`` as little-endian bytes (glTF is little-endian)."""
    if sys.byteorder == "big":
        values = array(values.typecode, values)
        values.byteswap()
    return values.tobytes()


def _bounds(positions: array) -> tuple:
    xs, ys, zs = positions[0::3], positions[1::3], positions[2::3]
    lo = [float(min(xs)), float(min(ys)), float(min(zs))]
    hi = [float(max(xs)), float(max(ys)), float(max(zs))]
    return lo, hi


def _build_glb(
    *,
    name: str,
    positions: array,
    indices: Optional[array],
    normals: Optional[array],
    uvs: Optional[array],
    colors: Optional[bytes],
    material: dict,
) -> bytes:
    """One node, one mesh, one TRIANGLES primitive, as GLB bytes."""
    vertex_count = len(positions) // 3
    if vertex_count < 3:
        _fail("IMPORT_FORMAT", "the file has no triangles")
    blob = bytearray()
    views: list = []
    accessors: list = []

    def add_view(data: bytes, target: int) -> int:
        _pad4(blob)
        views.append(
            {
                "buffer": 0,
                "byteOffset": len(blob),
                "byteLength": len(data),
                "target": target,
            }
        )
        blob.extend(data)
        return len(views) - 1

    def add_accessor(view: int, component: int, count: int, kind: str, **extra: Any) -> int:
        accessor = {
            "bufferView": view,
            "componentType": component,
            "count": count,
            "type": kind,
        }
        accessor.update(extra)
        accessors.append(accessor)
        return len(accessors) - 1

    lo, hi = _bounds(positions)
    attributes = {
        "POSITION": add_accessor(
            add_view(_le_bytes(positions), 34962),
            5126,
            vertex_count,
            "VEC3",
            min=lo,
            max=hi,
        )
    }
    if normals is not None:
        attributes["NORMAL"] = add_accessor(
            add_view(_le_bytes(normals), 34962), 5126, vertex_count, "VEC3"
        )
    if uvs is not None:
        attributes["TEXCOORD_0"] = add_accessor(
            add_view(_le_bytes(uvs), 34962), 5126, vertex_count, "VEC2"
        )
    if colors is not None:
        attributes["COLOR_0"] = add_accessor(
            add_view(colors, 34962), 5121, vertex_count, "VEC4", normalized=True
        )
    primitive: dict = {"attributes": attributes, "mode": 4, "material": 0}
    if indices is not None:
        index_type = 5123 if vertex_count <= 65535 else 5125
        packed = array("H" if index_type == 5123 else "I", indices)
        if index_type == 5125 and packed.itemsize != 4:  # pragma: no cover
            packed = array("L", indices)
        primitive["indices"] = add_accessor(
            add_view(_le_bytes(packed), 34963),
            index_type,
            len(indices),
            "SCALAR",
        )
    _pad4(blob)
    gltf = {
        "asset": {"version": "2.0", "generator": "Plastis3D mesh import"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"name": name[:64] or "Mesh", "mesh": 0}],
        "meshes": [{"name": name[:64] or "Mesh", "primitives": [primitive]}],
        "materials": [material],
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"byteLength": len(blob)}],
    }
    return _glb.build_glb(gltf, [bytes(blob)])


def _material(
    name: str = DEFAULT_MATERIAL_NAME, color: Optional[list] = None
) -> dict:
    rgba = list(color) if color is not None else list(_DEFAULT_COLOR)
    material: dict = {
        "name": name[:64] or DEFAULT_MATERIAL_NAME,
        "pbrMetallicRoughness": {
            "baseColorFactor": rgba,
            "metallicFactor": 0.0,
            "roughnessFactor": 0.8,
        },
    }
    if rgba[3] < 1.0:
        material["alphaMode"] = "BLEND"
    return material


def _check_finite(values: array, what: str) -> None:
    if not all(map(math.isfinite, values)):
        _fail("IMPORT_FORMAT", "%s contains a value that is not a finite number" % what)


def _float_array(values: list, what: str) -> array:
    try:
        out = array("f", values)
    except (OverflowError, ValueError):
        _fail("IMPORT_FORMAT", "%s has a value too large for a 32-bit float" % what)
        raise AssertionError("unreachable")
    _check_finite(out, what)
    return out


# --- STL -------------------------------------------------------------------------

_STL_VERTEX = re.compile(
    rb"vertex[ \t]+([^\s]+)[ \t]+([^\s]+)[ \t]+([^\s]+)", re.IGNORECASE
)


def _stl_binary_triangle_count(data: bytes) -> Optional[int]:
    """The triangle count when ``data`` is a well-formed binary STL."""
    if len(data) < 84:
        return None
    (count,) = struct.unpack_from("<I", data, 80)
    if 84 + 50 * count == len(data):
        return count
    return None


def _read_stl(data: bytes, deadline: float) -> tuple:
    count = _stl_binary_triangle_count(data)
    ignored: list = []
    if count is not None:
        if count == 0:
            _fail("IMPORT_FORMAT", "the STL file has no triangles")
        if count * 3 > MAX_VERTICES:
            _too_complex("vertex", count * 3, MAX_VERTICES)
        coords = array("f")
        # Each 50-byte record: normal (3 floats), 3 vertices (9 floats), 2 attr bytes.
        record = struct.Struct("<12fH")
        for index, fields in enumerate(record.iter_unpack(memoryview(data)[84:])):
            if index % _CHECK_EVERY == 0:
                _check_deadline(deadline)
            coords.extend(fields[3:12])
        _check_finite(coords, "the STL file")
        return coords, ignored
    looks_ascii = data.lstrip()[:5].lower() == b"solid" and b"facet" in data[:4096].lower()
    if not looks_ascii:
        if len(data) >= 84:
            (declared,) = struct.unpack_from(">I", data, 80)
            if 84 + 50 * declared == len(data):
                _fail(
                    "IMPORT_FORMAT",
                    "this looks like a big-endian binary STL; only little-endian is read",
                )
            (declared_le,) = struct.unpack_from("<I", data, 80)
            if declared_le * 50 + 84 > len(data):
                _fail(
                    "IMPORT_FORMAT",
                    "the binary STL is truncated: it declares %d triangles but is %d bytes"
                    % (declared_le, len(data)),
                )
        _fail("IMPORT_FORMAT", "this is not an ASCII or binary STL file")
    # ASCII. Count first so an oversized file is refused before parsing.
    approx = data.lower().count(b"vertex")
    if approx > MAX_VERTICES:
        _too_complex("vertex", approx, MAX_VERTICES)
    if approx == 0:
        _fail("IMPORT_FORMAT", "the ASCII STL file has no vertices")
    if approx % 3 != 0:
        _fail("IMPORT_FORMAT", "the ASCII STL file has a facet without three vertices")
    values: list = []
    for index, match in enumerate(_STL_VERTEX.finditer(data)):
        if index % _CHECK_EVERY == 0:
            _check_deadline(deadline)
        try:
            values.append(float(match.group(1)))
            values.append(float(match.group(2)))
            values.append(float(match.group(3)))
        except ValueError:
            _fail("IMPORT_FORMAT", "the ASCII STL file has a vertex that is not numeric")
    if len(values) != approx * 3:
        _fail("IMPORT_FORMAT", "the ASCII STL file has a malformed vertex line")
    return _float_array(values, "the STL file"), ignored


# --- OBJ -------------------------------------------------------------------------


def _obj_lines(data: bytes) -> list:
    text = data.decode("utf-8", errors="replace")
    if "\\\n" in text or "\\\r\n" in text:
        text = text.replace("\\\r\n", " ").replace("\\\n", " ")
    return text.splitlines()


def _parse_mtl(data: bytes, wanted: str) -> Optional[list]:
    """``[r, g, b, a]`` for material ``wanted``, else ``None``.

    Only ``newmtl``, ``Kd`` and ``d`` are read. Every other line,
    including every ``map_*`` texture reference, is ignored and no file it
    names is ever opened.
    """
    current: Optional[str] = None
    found = False
    color = [0.8, 0.8, 0.8]
    alpha = 1.0
    for raw in data.decode("utf-8", errors="replace").splitlines():
        parts = raw.strip().split()
        if not parts:
            continue
        key = parts[0].lower()
        if key == "newmtl":
            if found:
                break
            current = " ".join(parts[1:])
            found = current == wanted
        elif found and key == "kd" and len(parts) >= 4:
            try:
                color = [min(1.0, max(0.0, float(v))) for v in parts[1:4]]
            except ValueError:
                pass
        elif found and key == "d" and len(parts) >= 2:
            try:
                alpha = min(1.0, max(0.0, float(parts[1])))
            except ValueError:
                pass
    if not found:
        return None
    return color + [alpha]


def _read_obj(
    data: bytes, deadline: float, mtl_loader: Optional[MtlLoader]
) -> tuple:
    approx_v = data.count(b"\nv ") + (1 if data.startswith(b"v ") else 0)
    if approx_v > MAX_VERTICES:
        _too_complex("vertex", approx_v, MAX_VERTICES)
    lines = _obj_lines(data)
    positions: list = []
    texcoords: list = []
    normals_in: list = []
    ignored: list = []
    mtllib: Optional[str] = None
    extra_mtllibs = 0
    first_material: Optional[str] = None
    extra_materials: list = []
    skipped_primitives = 0
    saw_map = False

    # Output vertex dedupe: (v, vt, vn) tuple -> output index.
    remap: dict = {}
    corner_keys: list = []  # in output-vertex order
    indices = array("I")
    has_all_uv = True
    has_all_normal = True
    degenerate = 0

    def resolve(token: str, count: int, what: str) -> Optional[int]:
        if not token:
            return None
        try:
            number = int(token)
        except ValueError:
            _fail("IMPORT_FORMAT", "the OBJ file has a non-numeric %s index %r" % (what, token))
            raise AssertionError("unreachable")
        if number == 0:
            _fail("IMPORT_FORMAT", "the OBJ file has a %s index of 0 (indexes start at 1)" % what)
        index = number - 1 if number > 0 else count + number
        if not 0 <= index < count:
            _fail("IMPORT_FORMAT", "the OBJ file has a %s index %d outside 1..%d" % (what, number, count))
        return index

    for line_no, raw in enumerate(lines):
        if line_no % _CHECK_EVERY == 0:
            _check_deadline(deadline)
        line = raw.strip()
        if not line or line[0] == "#":
            continue
        parts = line.split()
        key = parts[0]
        if key == "v":
            if len(parts) < 4:
                _fail("IMPORT_FORMAT", "the OBJ file has a vertex line with fewer than 3 numbers")
            try:
                positions.append((float(parts[1]), float(parts[2]), float(parts[3])))
            except ValueError:
                _fail("IMPORT_FORMAT", "the OBJ file has a vertex that is not numeric")
            if len(positions) > MAX_VERTICES:
                _too_complex("vertex", len(positions), MAX_VERTICES)
        elif key == "vt":
            if len(parts) < 3:
                _fail("IMPORT_FORMAT", "the OBJ file has a texture coordinate with fewer than 2 numbers")
            try:
                texcoords.append((float(parts[1]), float(parts[2])))
            except ValueError:
                _fail("IMPORT_FORMAT", "the OBJ file has a texture coordinate that is not numeric")
        elif key == "vn":
            if len(parts) < 4:
                _fail("IMPORT_FORMAT", "the OBJ file has a normal with fewer than 3 numbers")
            try:
                normals_in.append((float(parts[1]), float(parts[2]), float(parts[3])))
            except ValueError:
                _fail("IMPORT_FORMAT", "the OBJ file has a normal that is not numeric")
        elif key == "f":
            corners = parts[1:]
            if len(corners) < 3:
                degenerate += 1
                continue
            resolved: list = []
            for corner in corners:
                fields = corner.split("/")
                if len(fields) > 3:
                    _fail("IMPORT_FORMAT", "the OBJ file has a face corner %r with too many fields" % corner)
                v = resolve(fields[0], len(positions), "vertex")
                if v is None:
                    _fail("IMPORT_FORMAT", "the OBJ file has an empty face corner")
                vt = resolve(fields[1], len(texcoords), "texture coordinate") if len(fields) > 1 else None
                vn = resolve(fields[2], len(normals_in), "normal") if len(fields) > 2 else None
                if vt is None:
                    has_all_uv = False
                if vn is None:
                    has_all_normal = False
                key_tuple = (v, vt, vn)
                out = remap.get(key_tuple)
                if out is None:
                    out = len(corner_keys)
                    if out >= MAX_VERTICES:
                        _too_complex("vertex", out + 1, MAX_VERTICES)
                    remap[key_tuple] = out
                    corner_keys.append(key_tuple)
                resolved.append(out)
            if (len(indices) // 3) + len(resolved) - 2 > MAX_TRIANGLES:
                _too_complex("triangle", (len(indices) // 3) + len(resolved) - 2, MAX_TRIANGLES)
            first = resolved[0]
            for i in range(1, len(resolved) - 1):
                indices.extend((first, resolved[i], resolved[i + 1]))
        elif key == "usemtl":
            name = " ".join(parts[1:])
            if first_material is None:
                first_material = name
            elif name != first_material and name not in extra_materials:
                extra_materials.append(name)
        elif key == "mtllib":
            if mtllib is None and len(parts) > 1:
                mtllib = " ".join(parts[1:])
            else:
                extra_mtllibs += 1
        elif key in ("l", "p"):
            skipped_primitives += 1
        elif key.startswith("map_"):
            saw_map = True

    if not indices:
        _fail("IMPORT_FORMAT", "the OBJ file has no faces")
    if degenerate:
        ignored.append("%d face%s with fewer than 3 corners skipped" % (degenerate, "" if degenerate == 1 else "s"))
    if skipped_primitives:
        ignored.append(
            "%d line or point element%s skipped (only faces are imported)"
            % (skipped_primitives, "" if skipped_primitives == 1 else "s")
        )
    if extra_materials:
        ignored.append(
            "only the first material (%r) is kept; also named: %s"
            % (first_material, ", ".join(repr(n) for n in extra_materials[:8]))
        )
    if extra_mtllibs:
        ignored.append("%d further mtllib line%s ignored" % (extra_mtllibs, "" if extra_mtllibs == 1 else "s"))

    # Material: first `usemtl` name, colour from the first MTL only.
    color: Optional[list] = None
    material_name = DEFAULT_MATERIAL_NAME
    if first_material is not None:
        material_name = first_material
    if mtllib is not None and first_material is not None and mtl_loader is not None:
        mtl_bytes, note = mtl_loader(mtllib)
        if mtl_bytes is None:
            if note:
                ignored.append(note)
        else:
            color = _parse_mtl(mtl_bytes, first_material)
            if color is None:
                ignored.append("material %r was not found in %s; the default colour is used" % (first_material, mtllib))
            if b"map_" in mtl_bytes.lower():
                saw_map = True
    elif mtllib is not None and first_material is not None and mtl_loader is None:
        ignored.append("%s was not read; the default colour is used" % mtllib)
    if saw_map:
        ignored.append("texture maps (map_*) are not imported; the colour only is used")

    # Arrays: output vertices in first-use order.
    flat: list = []
    for v, _vt, _vn in corner_keys:
        flat.extend(positions[v])
    out_positions = _float_array(flat, "the OBJ file")
    del flat
    out_normals: Optional[array] = None
    if has_all_normal and normals_in:
        flat = []
        for _v, _vt, vn in corner_keys:
            flat.extend(normals_in[vn])  # type: ignore[index]
        out_normals = _float_array(flat, "the OBJ normals")
        del flat
    out_uvs: Optional[array] = None
    if has_all_uv and texcoords:
        flat = []
        for _v, vt, _vn in corner_keys:
            u, v_coord = texcoords[vt]  # type: ignore[index]
            flat.extend((u, 1.0 - v_coord))  # OBJ v is bottom-up; glTF is top-down
        out_uvs = _float_array(flat, "the OBJ texture coordinates")
        del flat
    return (out_positions, indices, out_normals, out_uvs, color, material_name), ignored


# --- PLY -------------------------------------------------------------------------

_PLY_TYPES = {
    "char": ("b", 1),
    "int8": ("b", 1),
    "uchar": ("B", 1),
    "uint8": ("B", 1),
    "short": ("h", 2),
    "int16": ("h", 2),
    "ushort": ("H", 2),
    "uint16": ("H", 2),
    "int": ("i", 4),
    "int32": ("i", 4),
    "uint": ("I", 4),
    "uint32": ("I", 4),
    "float": ("f", 4),
    "float32": ("f", 4),
    "double": ("d", 8),
    "float64": ("d", 8),
}


class _PlyElement:
    def __init__(self, name: str, count: int) -> None:
        self.name = name
        self.count = count
        # (name, scalar_type) or (name, ("list", count_type, item_type))
        self.props: list = []

    @property
    def fixed(self) -> bool:
        return all(not isinstance(kind, tuple) for _n, kind in self.props)


def _ply_header(data: bytes) -> tuple:
    """``(format, elements, body_offset)``. Header lines are ASCII."""
    end = data.find(b"end_header")
    if not data.startswith(b"ply") or end < 0 or end > 64 * 1024:
        _fail("IMPORT_FORMAT", "this is not a PLY file (no ply magic or end_header)")
    newline = data.find(b"\n", end)
    if newline < 0:
        _fail("IMPORT_FORMAT", "the PLY header is not terminated")
    body = newline + 1
    header = data[:end].decode("ascii", errors="replace").replace("\r", "").split("\n")
    if header[0].strip() != "ply":
        _fail("IMPORT_FORMAT", "this is not a PLY file (the first line is not 'ply')")
    fmt: Optional[str] = None
    elements: list = []
    for line in header[1:]:
        parts = line.split()
        if not parts or parts[0] in ("comment", "obj_info"):
            continue
        if parts[0] == "format":
            if len(parts) != 3 or parts[2] != "1.0":
                _fail("IMPORT_FORMAT", "only PLY version 1.0 is read")
            fmt = parts[1]
            if fmt not in ("ascii", "binary_little_endian", "binary_big_endian"):
                _fail("IMPORT_FORMAT", "unknown PLY format %r" % fmt)
        elif parts[0] == "element":
            if len(parts) != 3 or not parts[2].isdigit():
                _fail("IMPORT_FORMAT", "the PLY header has a malformed element line")
            elements.append(_PlyElement(parts[1], int(parts[2])))
        elif parts[0] == "property":
            if not elements:
                _fail("IMPORT_FORMAT", "the PLY header has a property before any element")
            if len(parts) == 5 and parts[1] == "list":
                if parts[2] not in _PLY_TYPES or parts[3] not in _PLY_TYPES:
                    _fail("IMPORT_FORMAT", "the PLY header has a list with an unknown type")
                if _PLY_TYPES[parts[2]][0] in ("f", "d"):
                    _fail("IMPORT_FORMAT", "a PLY list count must be an integer type")
                elements[-1].props.append((parts[4], ("list", parts[2], parts[3])))
            elif len(parts) == 3 and parts[1] in _PLY_TYPES:
                elements[-1].props.append((parts[2], parts[1]))
            else:
                _fail("IMPORT_FORMAT", "the PLY header has an unknown property type")
        elif parts[0] != "ply":
            _fail("IMPORT_FORMAT", "the PLY header has an unknown line %r" % parts[0])
    if fmt is None:
        _fail("IMPORT_FORMAT", "the PLY header has no format line")
    return fmt, elements, body


def _read_ply(data: bytes, deadline: float) -> tuple:
    fmt, elements, body = _ply_header(data)
    ignored: list = []
    vertex = next((e for e in elements if e.name == "vertex"), None)
    face = next((e for e in elements if e.name == "face"), None)
    if vertex is None or vertex.count < 1:
        _fail("IMPORT_FORMAT", "the PLY file has no vertex element")
    if face is None or face.count < 1:
        _fail("IMPORT_FORMAT", "the PLY file has no faces (point clouds are not imported)")
    if vertex.count > MAX_VERTICES:
        _too_complex("vertex", vertex.count, MAX_VERTICES)
    if face.count > MAX_TRIANGLES:
        _too_complex("face", face.count, MAX_TRIANGLES)
    vnames = [n for n, _k in vertex.props]
    for axis in ("x", "y", "z"):
        if axis not in vnames:
            _fail("IMPORT_FORMAT", "the PLY vertex element has no %r property" % axis)
    for _n, kind in vertex.props:
        if isinstance(kind, tuple):
            _fail("IMPORT_FORMAT", "the PLY vertex element has a list property, which is not read")
    face_prop = next(
        (n for n, k in face.props if isinstance(k, tuple) and n in ("vertex_indices", "vertex_index")),
        None,
    )
    if face_prop is None:
        _fail("IMPORT_FORMAT", "the PLY face element has no vertex_indices list")
    skipped = [e.name for e in elements if e.name not in ("vertex", "face")]
    if skipped:
        ignored.append("PLY element%s skipped: %s" % ("" if len(skipped) == 1 else "s", ", ".join(skipped)))
    extra_vertex = [n for n in vnames if n not in ("x", "y", "z", "nx", "ny", "nz", "red", "green", "blue", "alpha")]
    if extra_vertex:
        ignored.append("PLY vertex propert%s ignored: %s" % ("y" if len(extra_vertex) == 1 else "ies", ", ".join(extra_vertex[:8])))

    endian = ">" if fmt == "binary_big_endian" else "<"
    positions = array("f")
    normals_present = all(n in vnames for n in ("nx", "ny", "nz"))
    colors_present = all(n in vnames for n in ("red", "green", "blue"))
    alpha_present = "alpha" in vnames
    normals = array("f") if normals_present else None
    colors = bytearray() if colors_present else None
    color_kind = {n: k for n, k in vertex.props}
    tri = array("I")

    def to_byte(value: float, kind: str) -> int:
        if kind in ("float", "float32", "double", "float64"):
            return max(0, min(255, int(round(value * 255.0))))
        if kind in ("ushort", "uint16"):
            return max(0, min(255, int(round(value / 257.0))))
        return max(0, min(255, int(value)))

    def add_vertex(row: dict) -> None:
        positions.extend((row["x"], row["y"], row["z"]))
        if normals is not None:
            normals.extend((row["nx"], row["ny"], row["nz"]))
        if colors is not None:
            colors.extend(
                (
                    to_byte(row["red"], color_kind["red"]),
                    to_byte(row["green"], color_kind["green"]),
                    to_byte(row["blue"], color_kind["blue"]),
                    to_byte(row["alpha"], color_kind["alpha"]) if alpha_present else 255,
                )
            )

    def add_face(corners: list) -> None:
        if len(corners) < 3:
            return
        for c in corners:
            if not 0 <= c < vertex.count:
                _fail("IMPORT_FORMAT", "the PLY file has a face index %d outside 0..%d" % (c, vertex.count - 1))
        if (len(tri) // 3) + len(corners) - 2 > MAX_TRIANGLES:
            _too_complex("triangle", (len(tri) // 3) + len(corners) - 2, MAX_TRIANGLES)
        first = corners[0]
        for i in range(1, len(corners) - 1):
            tri.extend((first, corners[i], corners[i + 1]))

    if fmt == "ascii":
        text = data[body:].decode("ascii", errors="replace").split("\n")
        cursor = 0

        def next_tokens() -> list:
            nonlocal cursor
            while cursor < len(text):
                parts = text[cursor].split()
                cursor += 1
                if parts:
                    return parts
            _fail("IMPORT_FORMAT", "the PLY file ends before all declared elements are read")
            raise AssertionError("unreachable")

        for element in elements:
            for i in range(element.count):
                if i % _CHECK_EVERY == 0:
                    _check_deadline(deadline)
                tokens = next_tokens()
                pos = 0
                row: dict = {}
                faces_here: list = []
                try:
                    for name, kind in element.props:
                        if isinstance(kind, tuple):
                            n = int(tokens[pos])
                            items = [int(t) for t in tokens[pos + 1 : pos + 1 + n]]
                            if len(items) != n:
                                raise IndexError
                            pos += 1 + n
                            if element is face and name == face_prop:
                                faces_here = items
                        else:
                            token = tokens[pos]
                            pos += 1
                            if element is vertex:
                                row[name] = float(token)
                except (ValueError, IndexError):
                    _fail("IMPORT_FORMAT", "the PLY file has a malformed %s row" % element.name)
                if element is vertex:
                    if not all(math.isfinite(row[k]) for k in ("x", "y", "z")):
                        _fail("IMPORT_FORMAT", "the PLY file has a vertex that is not finite")
                    add_vertex(row)
                elif element is face:
                    add_face(faces_here)
    else:
        view = memoryview(data)
        offset = body
        total = len(data)
        for element in elements:
            if element.fixed:
                fmt_str = endian + "".join(_PLY_TYPES[k][0] for _n, k in element.props)
                size = struct.calcsize(fmt_str)
                if size * element.count > total - offset:
                    _fail("IMPORT_FORMAT", "the PLY file is truncated inside its %s element" % element.name)
                if element is vertex:
                    names = [n for n, _k in element.props]
                    unpack = struct.Struct(fmt_str)
                    for i, fields in enumerate(unpack.iter_unpack(view[offset : offset + size * element.count])):
                        if i % _CHECK_EVERY == 0:
                            _check_deadline(deadline)
                        row = dict(zip(names, fields))
                        if not all(math.isfinite(row[k]) for k in ("x", "y", "z")):
                            _fail("IMPORT_FORMAT", "the PLY file has a vertex that is not finite")
                        add_vertex(row)
                offset += size * element.count
                continue
            # Variable-size element (lists): walk row by row.
            for i in range(element.count):
                if i % _CHECK_EVERY == 0:
                    _check_deadline(deadline)
                faces_here = []
                for name, kind in element.props:
                    if isinstance(kind, tuple):
                        _tag, ctype, itype = kind
                        cfmt, csize = _PLY_TYPES[ctype]
                        ifmt, isize = _PLY_TYPES[itype]
                        if offset + csize > total:
                            _fail("IMPORT_FORMAT", "the PLY file is truncated inside its %s element" % element.name)
                        (n,) = struct.unpack_from(endian + cfmt, view, offset)
                        offset += csize
                        if n < 0 or offset + n * isize > total:
                            _fail("IMPORT_FORMAT", "the PLY file is truncated inside its %s element" % element.name)
                        if element is face and name == face_prop:
                            faces_here = list(struct.unpack_from(endian + ("%d%s" % (n, ifmt)), view, offset))
                        offset += n * isize
                    else:
                        sfmt, ssize = _PLY_TYPES[kind]
                        if offset + ssize > total:
                            _fail("IMPORT_FORMAT", "the PLY file is truncated inside its %s element" % element.name)
                        offset += ssize
                if element is face:
                    add_face(faces_here)
            if element is vertex:  # pragma: no cover - vertex lists are refused above
                _fail("IMPORT_FORMAT", "the PLY vertex element has a list property")

    if len(positions) // 3 != vertex.count:
        _fail("IMPORT_FORMAT", "the PLY vertex element was not fully read")
    if not tri:
        _fail("IMPORT_FORMAT", "the PLY file has no triangles")
    _check_finite(positions, "the PLY file")
    if normals is not None:
        _check_finite(normals, "the PLY normals")
    return (positions, tri, normals, None, bytes(colors) if colors is not None else None), ignored


# --- Entry point -----------------------------------------------------------------


def convert(
    data: bytes,
    source_format: str,
    *,
    name: str,
    deadline: float,
    mtl_loader: Optional[MtlLoader] = None,
) -> tuple:
    """Convert one OBJ / STL / PLY file to GLB bytes.

    Returns ``(glb_bytes, ignored)``; ``ignored`` is a list of short
    sentences for ``stats.ignored``. Raises :class:`PlastisError` with
    a stable import code on any refusal, having written nothing.
    """
    _check_deadline(deadline)
    if source_format == "stl":
        positions, ignored = _read_stl(data, deadline)
        glb_bytes = _build_glb(
            name=name,
            positions=positions,
            indices=None,
            normals=None,
            uvs=None,
            colors=None,
            material=_material(),
        )
    elif source_format == "obj":
        (positions, indices, normals, uvs, color, material_name), ignored = _read_obj(
            data, deadline, mtl_loader
        )
        glb_bytes = _build_glb(
            name=name,
            positions=positions,
            indices=indices,
            normals=normals,
            uvs=uvs,
            colors=None,
            material=_material(material_name, color),
        )
    elif source_format == "ply":
        (positions, indices, normals, uvs, colors), ignored = _read_ply(data, deadline)
        glb_bytes = _build_glb(
            name=name,
            positions=positions,
            indices=indices,
            normals=normals,
            uvs=uvs,
            colors=colors,
            material=_material(),
        )
    else:
        _fail("IMPORT_FORMAT", "unknown mesh format %r" % source_format)
        raise AssertionError("unreachable")
    _check_deadline(deadline)
    return glb_bytes, ignored
