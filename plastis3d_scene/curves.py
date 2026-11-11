"""Plastis3D — curves: a tube along a centripetal Catmull-Rom spline, or a lathe (PR28).

``generator: {type: "curve", version: 1, params}``. Python samples the curve and writes the mesh with the
existing GLB writer (through :func:`plastis3d_scene.bake.commit_mesh`), so the result is a ``part`` with UVs.
Changing the params regenerates the asset in the same revision. Deterministic: the same params give the same
bytes. The spline passes through its control points (centripetal, so no loops or cusps), a closed curve is
seamless (the last ring is the first, with a twist correction so no shading seam appears), and an open tube is
capped at both ends.

Stdlib only. Python 3.11-compatible.
"""

from __future__ import annotations

import math
from array import array
from typing import Any, Optional

from .spec import PlastisError

KINDS = ("tube", "lathe")
MAX_POINTS = 256
_COMMON = {"kind", "points", "closed", "interpolation"}
_TUBE = {"radius", "radialSegments", "tubularSegments"}
_LATHE = {"segments", "angle"}

DEFAULT_TUBE = {
    "kind": "tube",
    "points": [[-1.0, 0.0, 0.0], [-0.4, 0.8, 0.2], [0.4, 0.8, -0.2], [1.0, 0.0, 0.0]],
    "closed": False,
    "interpolation": "centripetal",
    "radius": 0.08,
    "radialSegments": 12,
    "tubularSegments": 64,
}


def _fail(message: str, path: str = "") -> None:
    raise PlastisError("SPEC_INVALID", "SPEC_INVALID: %s" % message, path=path)


def _num(value: Any, low: float, high: float, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        _fail("%s must be a number from %s to %s" % (name, low, high), "/curve/%s" % name)
    return float(value)


def _int(value: Any, low: int, high: int, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        _fail("%s must be a whole number from %d to %d" % (name, low, high), "/curve/%s" % name)
    return value


def validate_params(params: Any) -> dict:
    """The closed, bounded curve params (a copy), or ``SPEC_INVALID``."""
    if not isinstance(params, dict):
        _fail("curve must be an object", "/curve")
    kind = params.get("kind")
    if kind not in KINDS:
        _fail("kind must be tube or lathe", "/curve/kind")
    allowed = _COMMON | (_TUBE if kind == "tube" else _LATHE)
    for key in params:
        if key not in allowed:
            _fail("%s is not a %s setting" % (key, kind), "/curve/%s" % key)
    points = params.get("points")
    if not isinstance(points, list) or not 2 <= len(points) <= MAX_POINTS:
        _fail("points must be a list of 2 to %d [x, y, z] points" % MAX_POINTS, "/curve/points")
    clean = []
    for i, point in enumerate(points):
        if not isinstance(point, (list, tuple)) or len(point) != 3:
            _fail("point %d must be [x, y, z]" % i, "/curve/points/%d" % i)
        clean.append([_num(c, -10000, 10000, "points/%d" % i) for c in point])
    closed = params.get("closed", False)
    if not isinstance(closed, bool):
        _fail("closed must be true or false", "/curve/closed")
    if params.get("interpolation", "centripetal") != "centripetal":
        _fail("interpolation must be centripetal", "/curve/interpolation")
    out = {"kind": kind, "points": clean, "closed": closed, "interpolation": "centripetal"}
    if kind == "tube":
        if closed and len(clean) < 3:
            _fail("a closed tube needs at least 3 points", "/curve/points")
        out["radius"] = _num(params.get("radius", 0.05), 0.001, 10, "radius")
        out["radialSegments"] = _int(params.get("radialSegments", 12), 3, 32, "radialSegments")
        out["tubularSegments"] = _int(params.get("tubularSegments", 64), 4, 512, "tubularSegments")
    else:
        if closed:
            _fail("a lathe profile cannot be closed", "/curve/closed")
        for i, p in enumerate(clean):
            if p[0] < 0:
                _fail("a lathe profile uses x as the radius, so x must not be negative (point %d)" % i, "/curve/points/%d" % i)
        out["segments"] = _int(params.get("segments", 32), 3, 128, "segments")
        out["angle"] = _num(params.get("angle", 360), 1, 360, "angle")
    return out


# --- the spline ----------------------------------------------------------------------------------

def _sub(a: list, b: list) -> list:
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]


def _add(a: list, b: list) -> list:
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]


def _mul(a: list, s: float) -> list:
    return [a[0] * s, a[1] * s, a[2] * s]


def _dot(a: list, b: list) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _cross(a: list, b: list) -> list:
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def _len(a: list) -> float:
    return math.sqrt(_dot(a, a))


def _norm(a: list) -> list:
    n = _len(a)
    return [a[0] / n, a[1] / n, a[2] / n] if n > 1e-12 else [0.0, 0.0, 1.0]


def _catmull_rom(p0: list, p1: list, p2: list, p3: list, t: float) -> list:
    """Barry-Goldman evaluation of a centripetal (alpha 0.5) Catmull-Rom segment p1 -> p2 at t in [0, 1]."""
    def knot(a: list, b: list, ti: float) -> float:
        return ti + max(_len(_sub(b, a)), 1e-9) ** 0.5

    t0 = 0.0
    t1 = knot(p0, p1, t0)
    t2 = knot(p1, p2, t1)
    t3 = knot(p2, p3, t2)
    u = t1 + (t2 - t1) * t

    def lerp(a: list, b: list, ta: float, tb: float) -> list:
        w = (u - ta) / (tb - ta) if tb != ta else 0.0
        return _add(_mul(a, 1 - w), _mul(b, w))

    a1 = lerp(p0, p1, t0, t1)
    a2 = lerp(p1, p2, t1, t2)
    a3 = lerp(p2, p3, t2, t3)
    b1 = _add(_mul(a1, (t2 - u) / (t2 - t0)), _mul(a2, (u - t0) / (t2 - t0)))
    b2 = _add(_mul(a2, (t3 - u) / (t3 - t1)), _mul(a3, (u - t1) / (t3 - t1)))
    return _add(_mul(b1, (t2 - u) / (t2 - t1)), _mul(b2, (u - t1) / (t2 - t1)))


def dense_polyline(points: list, closed: bool, per_segment: int = 24) -> list:
    """The spline as a dense polyline (passes through every control point). Closed curves repeat the first point last."""
    n = len(points)
    if closed:
        ctrl = lambda i: points[i % n]  # noqa: E731
        segments = n
    else:
        first = _sub(_mul(points[0], 2), points[1])
        last = _sub(_mul(points[-1], 2), points[-2])
        ctrl = lambda i: first if i < 0 else (last if i >= n else points[i])  # noqa: E731
        segments = n - 1
    out = []
    for s in range(segments):
        for k in range(per_segment):
            out.append(_catmull_rom(ctrl(s - 1), ctrl(s), ctrl(s + 1), ctrl(s + 2), k / per_segment))
    out.append(list(points[0]) if closed else list(points[-1]))
    return out


def resample(poly: list, count: int, closed: bool) -> list:
    """``count`` points evenly spaced by arc length. Closed: the first point is not repeated at the end."""
    lengths = [0.0]
    for i in range(1, len(poly)):
        lengths.append(lengths[-1] + _len(_sub(poly[i], poly[i - 1])))
    total = lengths[-1] or 1e-9
    steps = count if closed else count - 1
    out = []
    j = 0
    for i in range(count):
        target = total * i / steps
        while j < len(lengths) - 2 and lengths[j + 1] < target:
            j += 1
        span = lengths[j + 1] - lengths[j]
        w = (target - lengths[j]) / span if span > 1e-12 else 0.0
        out.append(_add(_mul(poly[j], 1 - w), _mul(poly[j + 1], w)))
    return out


def sample(params: dict, count: int) -> list:
    """Evenly spaced points along a (validated) curve: the curve's own shape, for tubes and for follow-path."""
    poly = dense_polyline(params["points"], params["closed"])
    return resample(poly, count, params["closed"])


# --- the tube ------------------------------------------------------------------------------------

def _rotate(v: list, axis: list, angle: float) -> list:
    c, s = math.cos(angle), math.sin(angle)
    return _add(_add(_mul(v, c), _mul(_cross(axis, v), s)), _mul(axis, _dot(axis, v) * (1 - c)))


def _frames(points: list, closed: bool) -> tuple:
    m = len(points)
    tangents = []
    for i in range(m):
        a = points[(i - 1) % m] if closed or i > 0 else points[i]
        b = points[(i + 1) % m] if closed or i < m - 1 else points[i]
        tangents.append(_norm(_sub(b, a)))
    t0 = tangents[0]
    axis = [1.0, 0.0, 0.0] if abs(t0[0]) < 0.9 else [0.0, 1.0, 0.0]
    normal = _norm(_cross(t0, axis))
    normals = [normal]
    for i in range(1, m):
        rot_axis = _cross(tangents[i - 1], tangents[i])
        sin = _len(rot_axis)
        if sin > 1e-9:
            angle = math.atan2(sin, _dot(tangents[i - 1], tangents[i]))
            normal = _norm(_rotate(normal, _mul(rot_axis, 1 / sin), angle))
        normal = _norm(_sub(normal, _mul(tangents[i], _dot(normal, tangents[i]))))
        normals.append(normal)
    if closed:
        # Carry the last frame on to the first tangent, then spread the leftover twist along the curve.
        last = normals[-1]
        rot_axis = _cross(tangents[-1], tangents[0])
        sin = _len(rot_axis)
        if sin > 1e-9:
            last = _norm(_rotate(last, _mul(rot_axis, 1 / sin), math.atan2(sin, _dot(tangents[-1], tangents[0]))))
        last = _norm(_sub(last, _mul(tangents[0], _dot(last, tangents[0]))))
        theta = math.atan2(_dot(_cross(last, normals[0]), tangents[0]), _dot(last, normals[0]))
        normals = [_norm(_rotate(n, tangents[i], theta * i / m)) for i, n in enumerate(normals)]
    return tangents, normals


def build_tube(params: dict) -> dict:
    closed = params["closed"]
    rings = params["tubularSegments"]
    radial = params["radialSegments"]
    radius = params["radius"]
    points = sample(params, rings if closed else rings + 1)
    tangents, normals = _frames(points, closed)
    positions: list = []
    nrm: list = []
    uvs: list = []
    indices: list = []
    count = len(points)
    ring_count = count + 1 if closed else count  # a closed tube repeats ring 0 at the end so UVs run 0 to 1
    for i in range(ring_count):
        k = i % count
        n = normals[k]
        b = _cross(tangents[k], n)
        for j in range(radial + 1):
            a = 2 * math.pi * (j % radial) / radial
            d = _add(_mul(n, math.cos(a)), _mul(b, math.sin(a)))
            p = _add(points[k], _mul(d, radius))
            positions += p
            nrm += d
            uvs += [i / (ring_count - 1), j / radial]
    stride = radial + 1
    for i in range(ring_count - 1):
        for j in range(radial):
            a = i * stride + j
            b = a + 1
            c = a + stride
            d = c + 1
            indices += [a, b, c, b, d, c]
    if not closed:
        for end, sign in ((0, -1.0), (count - 1, 1.0)):
            center = len(positions) // 3
            positions += points[end]
            nrm += _mul(tangents[end], sign)
            uvs += [0.5, 0.5]
            ring_start = center + 1
            n = normals[end]
            b = _cross(tangents[end], n)
            for j in range(radial + 1):
                a = 2 * math.pi * (j % radial) / radial
                d = _add(_mul(n, math.cos(a)), _mul(b, math.sin(a)))
                positions += _add(points[end], _mul(d, radius))
                nrm += _mul(tangents[end], sign)
                uvs += [0.5 + 0.5 * math.cos(a), 0.5 + 0.5 * math.sin(a)]
            for j in range(radial):
                if sign > 0:
                    indices += [center, ring_start + j, ring_start + j + 1]
                else:
                    indices += [center, ring_start + j + 1, ring_start + j]
    return {"positions": positions, "normals": nrm, "uvs": uvs, "indices": indices}


# --- the lathe -----------------------------------------------------------------------------------

def build_lathe(params: dict) -> dict:
    profile = [(p[0], p[1]) for p in params["points"]]
    segments = params["segments"]
    angle = math.radians(params["angle"])
    # Profile normals (in the radius-height plane), averaged at the joints.
    flat = []
    for i in range(len(profile) - 1):
        dx, dy = profile[i + 1][0] - profile[i][0], profile[i + 1][1] - profile[i][1]
        length = math.hypot(dx, dy) or 1e-9
        flat.append((dy / length, -dx / length))
    vertex_normals = []
    for i in range(len(profile)):
        a = flat[i - 1] if i > 0 else flat[0]
        b = flat[i] if i < len(flat) else flat[-1]
        nx, ny = a[0] + b[0], a[1] + b[1]
        length = math.hypot(nx, ny) or 1.0
        vertex_normals.append((nx / length, ny / length))
    lengths = [0.0]
    for i in range(1, len(profile)):
        lengths.append(lengths[-1] + math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]))
    total = lengths[-1] or 1e-9
    positions: list = []
    normals: list = []
    uvs: list = []
    indices: list = []
    for k in range(segments + 1):
        phi = angle * k / segments
        c, s = math.cos(phi), math.sin(phi)
        for i, (r, y) in enumerate(profile):
            positions += [r * c, y, r * s]
            nx, ny = vertex_normals[i]
            normals += [nx * c, ny, nx * s]
            uvs += [k / segments, lengths[i] / total]
    rows = len(profile)
    for k in range(segments):
        for i in range(rows - 1):
            a = k * rows + i
            b = a + 1
            c = a + rows
            d = c + 1
            indices += [a, b, c, b, d, c]
    return {"positions": positions, "normals": normals, "uvs": uvs, "indices": indices}


def build_mesh(params: dict) -> dict:
    """Arrays ``{positions, normals, uvs, indices}`` (plain lists) for validated params."""
    return build_tube(params) if params["kind"] == "tube" else build_lathe(params)


def to_decoded(mesh: dict) -> dict:
    """Typed arrays in the shape :func:`plastis3d_scene.bake.commit_mesh` takes."""
    return {
        "positions": array("f", mesh["positions"]),
        "normals": array("f", mesh["normals"]),
        "uvs": array("f", mesh["uvs"]),
        "colors": None,
        "indices": array("I", mesh["indices"]),
    }


def follow_path(params: dict, keys: int, duration: float, transform: Optional[dict] = None) -> dict:
    """A translation clip that walks a target along the curve in ``keys`` evenly spaced keys (follow-path, PR28).

    The curve node's own translation, rotation and scale place the points in the scene (Euler XYZ degrees)."""
    from .primitives import rotation_matrix_xyz

    points = sample(params, keys)
    transform = transform or {"t": [0, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]}
    matrix = rotation_matrix_xyz(transform.get("r", [0, 0, 0]))
    s = transform.get("s", [1, 1, 1])
    t = transform.get("t", [0, 0, 0])
    values = []
    for p in points:
        q = [p[0] * s[0], p[1] * s[1], p[2] * s[2]]
        r = [sum(matrix[row][col] * q[col] for col in range(3)) for row in range(3)]
        values.append([round(r[0] + t[0], 6), round(r[1] + t[1], 6), round(r[2] + t[2], 6)])
    times = [round(duration * i / (keys - 1), 6) for i in range(keys)]
    return {"name": "Follow path", "duration": float(duration), "channels": [{"target": "translation", "times": times, "values": values}]}


def node_frame(nodes: list, node_id: Optional[str]) -> tuple:
    """Static ancestor-composed affine frame; no TRS decomposition or shear loss."""
    from .primitives import rotation_matrix_xyz

    by_id = {node["id"]: node for node in nodes}
    chain, seen = [], set()
    while node_id is not None:
        if node_id in seen or node_id not in by_id:
            raise PlastisError("SPEC_INVALID", "SPEC_INVALID: invalid transform ancestry")
        seen.add(node_id)
        node = by_id[node_id]
        chain.append(node.get("transform") or {})
        node_id = node.get("parent")
    a, t = [[float(i == j) for j in range(3)] for i in range(3)], [0., 0., 0.]
    for tr in reversed(chain):
        rotation = rotation_matrix_xyz(tr.get("r", [0, 0, 0]))
        scale = tr.get("s", [1, 1, 1])
        b = [[rotation[i][j] * scale[j] for j in range(3)] for i in range(3)]
        shift = tr.get("t", [0, 0, 0])
        t = [t[i] + sum(a[i][j] * shift[j] for j in range(3)) for i in range(3)]
        a = [[sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)] for i in range(3)]
    return a, t


def in_frame(point: list, frame: tuple, *, inverse: bool = False) -> list:
    """Apply/invert a full affine frame to a position (translation clips permit shear)."""
    a, t = frame
    if not inverse:
        return [t[i] + sum(a[i][j] * point[j] for j in range(3)) for i in range(3)]
    # Pivoted elimination avoids assuming orthogonal axes after nonuniform ancestors.
    rows = [list(a[i]) + [point[i] - t[i]] for i in range(3)]
    for col in range(3):
        pivot = max(range(col, 3), key=lambda i: abs(rows[i][col]))
        if rows[pivot][col] == 0:
            raise PlastisError("SPEC_INVALID", "SPEC_INVALID: follow-path target parent has a singular transform")
        rows[col], rows[pivot] = rows[pivot], rows[col]
        divisor = rows[col][col]
        rows[col] = [v / divisor for v in rows[col]]
        for i in range(3):
            if i != col:
                factor = rows[i][col]
                rows[i] = [rows[i][j] - factor * rows[col][j] for j in range(4)]
    result = [rows[i][3] for i in range(3)]
    if not all(math.isfinite(v) for v in result):
        raise PlastisError("SPEC_INVALID", "SPEC_INVALID: follow-path target frame cannot represent finite positions")
    return result
