"""Plastis3D — seeded noise displacement (PR28). Stdlib only.

``generator: {type: "displace", version: 1, params: {baseAssetId, amplitude, frequency, octaves, seed}}``.
Each vertex moves along its normal by ``amplitude`` times fractal value noise sampled at its POSITION (so the
split vertices of a UV seam or a hard edge move together and no crack opens). The noise is a pure integer-hash
lattice with smooth interpolation: the same seed gives the same mesh on every machine, with no use of
Python's randomised ``hash``. The un-displaced mesh is stored as the base asset, so changing a setting
regenerates from it non-destructively. At most 200,000 vertices (``DISPLACE_TOO_LARGE``).
"""

from __future__ import annotations

import math
import struct
from array import array
from typing import Any

from . import glb as _glb
from . import primitives
from .spec import PlastisError

MAX_VERTICES = 200_000
PARAM_KEYS = ("amplitude", "frequency", "octaves", "seed")


def _fail(message: str, path: str = "") -> None:
    raise PlastisError("SPEC_INVALID", "SPEC_INVALID: %s" % message, path=path)


def validate_params(params: Any) -> dict:
    if not isinstance(params, dict):
        _fail("displace must be an object", "/displace")
    for key in params:
        if key not in PARAM_KEYS:
            _fail("%s is not a displace setting" % key, "/displace/%s" % key)

    def number(name: str, low: float, high: float) -> float:
        value = params.get(name)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
            _fail("%s must be a number from %s to %s" % (name, low, high), "/displace/%s" % name)
        return float(value)

    octaves = params.get("octaves", 3)
    if isinstance(octaves, bool) or not isinstance(octaves, int) or not 1 <= octaves <= 6:
        _fail("octaves must be a whole number from 1 to 6", "/displace/octaves")
    seed = params.get("seed", 0)
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 2147483647:
        _fail("seed must be a whole number from 0 to 2147483647", "/displace/seed")
    return {
        "amplitude": number("amplitude", 0, 10) if "amplitude" in params else 0.1,
        "frequency": number("frequency", 0.01, 100) if "frequency" in params else 2.0,
        "octaves": octaves,
        "seed": seed,
    }


def _hash(ix: int, iy: int, iz: int, seed: int) -> float:
    h = (ix * 374761393 + iy * 668265263 + iz * 2147483647 + seed * 1274126177) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    h ^= h >> 16
    return (h & 0xFFFFFF) / 0x7FFFFF - 1.0  # [-1, 1]


def _smooth(t: float) -> float:
    return t * t * (3 - 2 * t)


def value_noise(x: float, y: float, z: float, seed: int) -> float:
    """Smooth value noise in [-1, 1] on an integer lattice."""
    ix, iy, iz = math.floor(x), math.floor(y), math.floor(z)
    fx, fy, fz = _smooth(x - ix), _smooth(y - iy), _smooth(z - iz)

    def corner(dx: int, dy: int, dz: int) -> float:
        return _hash(ix + dx, iy + dy, iz + dz, seed)

    x00 = corner(0, 0, 0) * (1 - fx) + corner(1, 0, 0) * fx
    x10 = corner(0, 1, 0) * (1 - fx) + corner(1, 1, 0) * fx
    x01 = corner(0, 0, 1) * (1 - fx) + corner(1, 0, 1) * fx
    x11 = corner(0, 1, 1) * (1 - fx) + corner(1, 1, 1) * fx
    return (x00 * (1 - fy) + x10 * fy) * (1 - fz) + (x01 * (1 - fy) + x11 * fy) * fz


def fractal(x: float, y: float, z: float, octaves: int, seed: int) -> float:
    total, amp, norm, freq = 0.0, 1.0, 0.0, 1.0
    for o in range(octaves):
        total += amp * value_noise(x * freq, y * freq, z * freq, seed + o * 101)
        norm += amp
        amp *= 0.5
        freq *= 2.0
    return total / norm


def recompute_normals(positions: list, indices: list) -> list:
    """Area-weighted vertex normals by vertex INDEX (split vertices keep their own), as a flat list."""
    sums = [0.0] * len(positions)
    for t in range(0, len(indices), 3):
        a, b, c = indices[t] * 3, indices[t + 1] * 3, indices[t + 2] * 3
        ux, uy, uz = positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]
        vx, vy, vz = positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]
        n = (uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
        for v in (a, b, c):
            sums[v] += n[0]
            sums[v + 1] += n[1]
            sums[v + 2] += n[2]
    out = []
    for i in range(0, len(sums), 3):
        length = math.sqrt(sums[i] ** 2 + sums[i + 1] ** 2 + sums[i + 2] ** 2)
        out += [sums[i] / length, sums[i + 1] / length, sums[i + 2] / length] if length > 1e-12 else [0.0, 1.0, 0.0]
    return out


def apply_noise(mesh: dict, params: dict) -> dict:
    """The displaced copy of ``mesh`` (``positions``, ``normals``, ``uvs``, ``indices`` lists)."""
    p = mesh["positions"]
    n = mesh["normals"]
    if len(p) // 3 > MAX_VERTICES:
        raise PlastisError("DISPLACE_TOO_LARGE", "DISPLACE_TOO_LARGE: the mesh has %d vertices, over the %d limit" % (len(p) // 3, MAX_VERTICES))
    out = list(p)
    f = params["frequency"]
    for v in range(0, len(p), 3):
        d = params["amplitude"] * fractal(p[v] * f, p[v + 1] * f, p[v + 2] * f, params["octaves"], params["seed"])
        out[v] = p[v] + n[v] * d
        out[v + 1] = p[v + 1] + n[v + 1] * d
        out[v + 2] = p[v + 2] + n[v + 2] * d
    return {"positions": out, "normals": recompute_normals(out, mesh["indices"]), "uvs": mesh["uvs"], "indices": mesh["indices"], "colors": mesh.get("colors")}


_WIDTH = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}
_CODE = {5121: ("B", 1), 5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4)}


def _read(gltf: dict, buffers: list, index: int) -> list:
    accessor = gltf["accessors"][index]
    if "sparse" in accessor or accessor.get("componentType") not in _CODE:
        _fail("this accessor encoding cannot be displaced without losing attributes")
    code, size = _CODE[accessor["componentType"]]
    width = _WIDTH[accessor["type"]]
    view = gltf["bufferViews"][accessor["bufferView"]]
    buffer = buffers[view.get("buffer", 0)]
    stride = view.get("byteStride") or size * width
    start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    out: list = []
    fmt = "<%d%s" % (width, code)
    for i in range(accessor["count"]):
        out.extend(struct.unpack_from(fmt, buffer, start + i * stride))
    if accessor.get("normalized"):
        maximum = {5121: 255, 5123: 65535}.get(accessor["componentType"])
        if maximum is None:
            _fail("unsupported normalized accessor")
        out = [v / maximum for v in out]
    return out


def mesh_from_asset(data: bytes, mesh_index: int, primitive_index: int) -> dict:
    """One triangle primitive of a stored GLB as lists. Sparse or non-triangle data is refused; interleaved and normalized colours are decoded."""
    import time

    scan = _glb.scan(data, source_format="glb", deadline=time.monotonic() + 15)
    if isinstance(mesh_index, bool) or not isinstance(mesh_index, int) or mesh_index < 0 or isinstance(primitive_index, bool) or not isinstance(primitive_index, int) or primitive_index < 0:
        _fail("mesh and primitive indices must be nonnegative integers")
    try:
        primitive = scan.gltf["meshes"][mesh_index]["primitives"][primitive_index]
    except (KeyError, IndexError):
        raise PlastisError("SPEC_INVALID", "SPEC_INVALID: the model has no such mesh") from None
    if primitive.get("mode", 4) != 4 or "POSITION" not in primitive["attributes"]:
        raise PlastisError("SPEC_INVALID", "SPEC_INVALID: only triangle meshes can be displaced")
    buffers = scan.buffers
    positions = _read(scan.gltf, buffers, primitive["attributes"]["POSITION"])
    indices = _read(scan.gltf, buffers, primitive["indices"]) if "indices" in primitive else list(range(len(positions) // 3))
    normals = _read(scan.gltf, buffers, primitive["attributes"]["NORMAL"]) if "NORMAL" in primitive["attributes"] else recompute_normals(positions, indices)
    uv_index = primitive["attributes"].get("TEXCOORD_0")
    uvs = _read(scan.gltf, buffers, uv_index) if uv_index is not None else None
    color_index = primitive["attributes"].get("COLOR_0")
    colors = _read(scan.gltf, buffers, color_index) if color_index is not None else None
    if colors is not None and scan.gltf["accessors"][color_index]["type"] == "VEC3":
        colors = [v for i in range(0, len(colors), 3) for v in colors[i:i + 3] + [1.0]]
    return {"positions": positions, "normals": normals, "uvs": uvs, "indices": indices, "colors": colors}


def mesh_from_primitive(primitive: dict) -> dict:
    return primitives.generate(primitive)


def to_decoded(mesh: dict) -> dict:
    return {
        "positions": array("f", mesh["positions"]),
        "normals": array("f", mesh["normals"]),
        "uvs": array("f", mesh["uvs"]) if mesh.get("uvs") else None,
        "colors": bytes(min(255, max(0, int(round(c * 255)))) for c in mesh["colors"]) if mesh.get("colors") is not None else None,
        "indices": array("I", mesh["indices"]),
    }
