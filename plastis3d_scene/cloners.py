"""Plastis3D — cloners: copies of a node laid out in a grid, a line or a ring (PR28).

A cloner writes REAL child nodes under a new group "Clones of <name>", in one history entry. The copies share the
source's asset and material (they are ordinary nodes that point at the same ids), so they cost no new asset.
At most 256 clones, and the scene's node cap is checked first (``LIMIT_NODES``) so nothing is written when the
result would not fit. GPU instancing is not used. Stdlib only.
"""

from __future__ import annotations

import math
from typing import Any

from .spec import PlastisError

MAX_CLONES = 256
MODES = ("grid", "line", "radial")


def _fail(message: str, path: str = "") -> None:
    raise PlastisError("SPEC_INVALID", "SPEC_INVALID: %s" % message, path=path)


def _vec(value: Any, name: str, low: float = -10000, high: float = 10000) -> list:
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        _fail("%s must be [x, y, z]" % name, "/%s" % name)
    out = []
    for c in value:
        if isinstance(c, bool) or not isinstance(c, (int, float)) or not math.isfinite(c) or not low <= c <= high:
            _fail("%s must hold numbers from %s to %s" % (name, low, high), "/%s" % name)
        out.append(float(c))
    return out


def validate(mode: Any, params: Any) -> dict:
    """The closed clone settings (a copy), or ``SPEC_INVALID``."""
    if mode not in MODES:
        _fail("mode must be grid, line or radial", "/mode")
    if not isinstance(params, dict):
        _fail("params must be an object", "/params")
    allowed = {"grid": {"counts", "spacing"}, "line": {"count", "offset"}, "radial": {"count", "radius", "axis", "angle"}}[mode]
    for key in params:
        if key not in allowed:
            _fail("%s is not a %s setting" % (key, mode), "/params/%s" % key)
    if mode == "grid":
        counts = params.get("counts")
        if not isinstance(counts, (list, tuple)) or len(counts) != 3 or any(isinstance(c, bool) or not isinstance(c, int) or not 1 <= c <= 64 for c in counts):
            _fail("counts must be three whole numbers from 1 to 64", "/params/counts")
        total = counts[0] * counts[1] * counts[2] - 1
        if total < 1 or total > MAX_CLONES:
            _fail("a grid makes 1 to %d clones (counts multiplied, minus the source)" % MAX_CLONES, "/params/counts")
        return {"counts": list(counts), "spacing": _vec(params.get("spacing"), "params/spacing")}
    count = params.get("count")
    if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= MAX_CLONES:
        _fail("count must be a whole number from 1 to %d" % MAX_CLONES, "/params/count")
    if mode == "line":
        return {"count": count, "offset": _vec(params.get("offset"), "params/offset")}
    radius = params.get("radius")
    if isinstance(radius, bool) or not isinstance(radius, (int, float)) or not math.isfinite(radius) or not 0.001 <= radius <= 10000:
        _fail("radius must be a number from 0.001 to 10000", "/params/radius")
    axis = params.get("axis", "y")
    if axis not in ("x", "y", "z"):
        _fail("axis must be x, y or z", "/params/axis")
    angle = params.get("angle", 360)
    if isinstance(angle, bool) or not isinstance(angle, (int, float)) or not math.isfinite(angle) or not 1 <= angle <= 360:
        _fail("angle must be a number from 1 to 360", "/params/angle")
    return {"count": count, "radius": float(radius), "axis": axis, "angle": float(angle)}


def layout(settings: dict, mode: str, base_t: list, base_r: list) -> list:
    """``[(translation, rotation_degrees)]`` for each clone, in the source's parent space."""
    out = []
    if mode == "grid":
        nx, ny, nz = settings["counts"]
        sx, sy, sz = settings["spacing"]
        for k in range(nz):
            for j in range(ny):
                for i in range(nx):
                    if i == j == k == 0:
                        continue
                    out.append(([base_t[0] + i * sx, base_t[1] + j * sy, base_t[2] + k * sz], list(base_r)))
    elif mode == "line":
        ox, oy, oz = settings["offset"]
        for i in range(1, settings["count"] + 1):
            out.append(([base_t[0] + i * ox, base_t[1] + i * oy, base_t[2] + i * oz], list(base_r)))
    else:
        n, radius, axis, span = settings["count"], settings["radius"], settings["axis"], settings["angle"]
        full = span >= 360
        for i in range(n):
            theta = math.radians(span * i / (n if full else max(n - 1, 1)))
            c, s = math.cos(theta) * radius, math.sin(theta) * radius
            offset = {"y": [c, 0.0, s], "x": [0.0, c, s], "z": [c, s, 0.0]}[axis]
            turn = {"y": [0.0, -math.degrees(theta), 0.0], "x": [math.degrees(theta), 0.0, 0.0], "z": [0.0, 0.0, math.degrees(theta)]}[axis]
            out.append(([base_t[0] + offset[0], base_t[1] + offset[1], base_t[2] + offset[2]], [base_r[0] + turn[0], base_r[1] + turn[1], base_r[2] + turn[2]]))
    return [([round(v, 6) for v in t], [round(v, 6) for v in r]) for t, r in out]
