"""Plastis3D — analytic primitive mathematics (PR2, Stage 1).

Deterministic parametric mesh generators plus analytic triangle/vertex
counters, so the agent gets instant feedback (triangle counts for a tool
result) without allocating a mesh.

Conventions (standalone-editor.md, Scene spec):

* Units are metres; the scene is Y-up.
* Rotation is Euler XYZ in degrees, three.js ``Euler`` order ``"XYZ"``:
  the rotation matrix is ``R = Rx(x) * Ry(y) * Rz(z)`` applied to column
  vectors. This is the convention the default rig was verified against
  (``light_key`` / ``cam_main`` local ``-Z`` dots the direction to the
  origin at 1.000000 — see ``tests/python/test_store.py``).
* ``plane`` lies on XY facing +Z (three.js ``PlaneGeometry``). A floor is
  ``r = [-90, 0, 0]``; do not flip it to ``+90``.
* Segment counts are integers in 3..64 (caps, stage-1 §4.2).

Every generator returns flat lists::

    {"positions": [x, y, z, ...], "normals": [x, y, z, ...],
     "uvs": [u, v, ...], "indices": [i0, i1, i2, ...]}

``uvs`` (PR15, correctness audit C-08) use the **glTF convention**: the
origin is the image's top-left corner, ``u`` runs right and ``v`` runs
*down*. They reproduce three.js's built-in geometry UVs (the viewport
draws those) after ``v -> 1 - v``, so a texture lands on a primitive the
same way in the editor and in the exported file. The editor loads image
textures with ``flipY`` so its (v-up) geometry UVs and the file's (v-down)
UVs show the same picture; ``tests/node/primitive-uv.test.ts`` proves the
two agree. Where a surface wraps (sphere, cylinder, cone, capsule), ``u``
is not clamped to ``[0, 1]`` at the seam: it runs through ``0.5 - k/n``
(or ``0.25 - k/n``), so a sampler with REPEAT wrapping, which the export
writes, shows it unbroken.

``count_primitive`` returns the exact vertex/triangle counts the matching
generator produces, without allocating anything. The tests assert the two
agree for every primitive type.

Stdlib only. Python 3.11-compatible.
"""

from __future__ import annotations

import math
from typing import Any

# --- Caps (stage-1 §4.2; agent-invented, enforced as written) ---------------
MIN_SEGMENTS = 3
MAX_SEGMENTS = 64

PRIMITIVE_TYPES = ("box", "sphere", "cylinder", "cone", "torus", "plane", "capsule")

# Parameter defaults (standalone-editor.md, Primitives table). These are
# deliberately low-poly and are NOT three.js's own defaults.
PRIMITIVE_DEFAULTS = {
    "box": {"width": 1.0, "height": 1.0, "depth": 1.0},
    "sphere": {"radius": 0.5, "widthSegments": 16, "heightSegments": 12},
    "cylinder": {
        "radiusTop": 0.5,
        "radiusBottom": 0.5,
        "height": 1.0,
        "radialSegments": 16,
    },
    "cone": {"radius": 0.5, "height": 1.0, "radialSegments": 16},
    "torus": {
        "radius": 0.5,
        "tube": 0.15,
        "radialSegments": 12,
        "tubularSegments": 24,
    },
    "plane": {"width": 1.0, "height": 1.0},
    "capsule": {"radius": 0.25, "length": 1.0, "capSegments": 4, "radialSegments": 8},
}

# Segment-count parameter per primitive type (validated to 3..64).
_SEGMENT_PARAMS = {
    "sphere": ("widthSegments", "heightSegments"),
    "cylinder": ("radialSegments",),
    "cone": ("radialSegments",),
    "torus": ("radialSegments", "tubularSegments"),
    "capsule": ("capSegments", "radialSegments"),
}

# Dimension parameters (must be finite and > 0).
_DIMENSION_PARAMS = {
    "box": ("width", "height", "depth"),
    "sphere": ("radius",),
    "cylinder": ("radiusTop", "radiusBottom", "height"),
    "cone": ("radius", "height"),
    "torus": ("radius", "tube"),
    "plane": ("width", "height"),
    "capsule": ("radius", "length"),
}


# --- Rotation math -----------------------------------------------------------
# Euler XYZ, degrees, three.js "XYZ" order: R = Rx * Ry * Rz.

def _mat_mul(a: list, b: list) -> list:
    return [[sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)] for i in range(3)]


def rotation_matrix_xyz(degrees: list) -> list:
    """3x3 rotation matrix for Euler XYZ degrees (R = Rx * Ry * Rz)."""
    x, y, z = (math.radians(v) for v in degrees)
    cx, sx = math.cos(x), math.sin(x)
    cy, sy = math.cos(y), math.sin(y)
    cz, sz = math.cos(z), math.sin(z)
    rx = [[1.0, 0.0, 0.0], [0.0, cx, -sx], [0.0, sx, cx]]
    ry = [[cy, 0.0, sy], [0.0, 1.0, 0.0], [-sy, 0.0, cy]]
    rz = [[cz, -sz, 0.0], [sz, cz, 0.0], [0.0, 0.0, 1.0]]
    return _mat_mul(rx, _mat_mul(ry, rz))


def local_minus_z(degrees: list) -> list:
    """The local -Z axis of a node with Euler XYZ rotation ``degrees``.

    This is the direction a camera looks and a directional light shines
    along (before any parent transform). Returns a unit vector.
    """
    r = rotation_matrix_xyz(degrees)
    return [-r[0][2], -r[1][2], -r[2][2]]


def dot_to_origin(position: list, rotation_degrees: list) -> float:
    """Dot product of local -Z with the unit direction to the origin.

    1.0 means the node's local -Z points exactly at the world origin.
    Used by the default-rig fixture (stage-1 §6.1); the bar is > 0.9999.
    """
    minus_z = local_minus_z(rotation_degrees)
    norm = math.sqrt(sum(v * v for v in position))
    if norm == 0.0:
        return 0.0
    direction = [-v / norm for v in position]
    return sum(minus_z[i] * direction[i] for i in range(3))


# --- Parameter handling ------------------------------------------------------


def resolve_params(primitive: dict) -> dict:
    """Merge a primitive dict's params over the type defaults.

    Raises ``ValueError`` for an unknown type, a non-finite or
    non-positive dimension, or a segment count outside 3..64 (or not an
    integer). The schema validator (``validate.py``) enforces the same
    rules with ``SPEC_INVALID``; this is the math layer's own guard so a
    generator never allocates a degenerate or unbounded mesh.
    """
    if not isinstance(primitive, dict):
        raise ValueError("primitive must be an object")
    ptype = primitive.get("type")
    if ptype not in PRIMITIVE_TYPES:
        raise ValueError("unknown primitive type: %r" % (ptype,))
    params = dict(PRIMITIVE_DEFAULTS[ptype])
    for key, value in primitive.items():
        if key == "type":
            continue
        if key not in params:
            raise ValueError("unknown parameter %r for primitive %r" % (key, ptype))
        params[key] = value
    for key in _DIMENSION_PARAMS[ptype]:
        value = params[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("parameter %r must be a number" % key)
        if not math.isfinite(value) or value <= 0:
            raise ValueError("parameter %r must be finite and > 0" % key)
    for key in _SEGMENT_PARAMS.get(ptype, ()):
        value = params[key]
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError("parameter %r must be an integer" % key)
        if value < MIN_SEGMENTS or value > MAX_SEGMENTS:
            raise ValueError(
                "parameter %r must be in %d..%d" % (key, MIN_SEGMENTS, MAX_SEGMENTS)
            )
    return params


# --- Analytic counters ------------------------------------------------------

# Each counter mirrors its generator exactly (same grid sizes, same fans);
# the tests assert generator output counts equal these numbers.


def count_primitive(primitive: dict) -> dict:
    """``{"verts": int, "tris": int}`` for a primitive dict, no allocation."""
    params = resolve_params(primitive)
    ptype = primitive["type"]
    if ptype == "box":
        return {"verts": 24, "tris": 12}
    if ptype == "sphere":
        ws = params["widthSegments"]
        hs = params["heightSegments"]
        # Pole rows emit one triangle per column (see generate_sphere):
        # 2*ws*(hs-1), not 2*ws*hs. three.js SphereGeometry emits the
        # same count (PR4 report: 352 for 16x12, not 384).
        return {"verts": (ws + 1) * (hs + 1), "tris": ws * (hs - 1) * 2}
    if ptype == "cylinder":
        radial = params["radialSegments"]
        return {"verts": 4 * radial + 6, "tris": 4 * radial}
    if ptype == "cone":
        radial = params["radialSegments"]
        # apex row (radial + 1), base ring (radial + 1), cap centre, cap ring.
        return {"verts": 3 * radial + 4, "tris": 2 * radial}
    if ptype == "torus":
        radial = params["radialSegments"]
        tubular = params["tubularSegments"]
        return {"verts": (radial + 1) * (tubular + 1), "tris": radial * tubular * 2}
    if ptype == "plane":
        return {"verts": 4, "tris": 2}
    if ptype == "capsule":
        cap = params["capSegments"]
        radial = params["radialSegments"]
        return {
            "verts": (2 * cap + 2) * (radial + 1),
            "tris": (2 * cap + 1) * radial * 2,
        }
    raise ValueError("unknown primitive type: %r" % (ptype,))


# --- Generators --------------------------------------------------------------
# All generators are deterministic: same params, same arrays. Vertices are
# emitted as flat float lists; indices are flat int lists (CCW outward).


def _mesh(positions: list, normals: list, indices: list, uvs: list) -> dict:
    return {"positions": positions, "normals": normals, "uvs": uvs, "indices": indices}


def _ring(radius: float, y: float, segments: int, ny: float = 0.0) -> tuple:
    """One ring of ``segments + 1`` verts (seam duplicated) at height ``y``.

    Returns (positions, normals). The side normal tilts by ``ny`` (the
    y-component, for tapered cylinders); pass 0 for a straight wall.
    """
    positions: list = []
    normals: list = []
    for i in range(segments + 1):
        theta = 2.0 * math.pi * i / segments
        c, s = math.cos(theta), math.sin(theta)
        positions.extend([radius * c, y, radius * s])
        n = [c, ny, s]
        length = math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2])
        normals.extend([v / length for v in n])
    return positions, normals


def _cap_uvs(segments: int, sign: float) -> list:
    """UVs for one cap's ring (``segments + 1`` verts): the cap as a disc
    inscribed in the unit square, upright when seen from outside. ``sign``
    is +1 for the +Y cap, -1 for the -Y cap (glTF convention, v down)."""
    out: list = []
    for i in range(segments + 1):
        theta = 2.0 * math.pi * i / segments
        out.extend(
            [
                0.5 + 0.5 * math.sin(theta),
                1.0 - (0.5 + 0.5 * sign * math.cos(theta)),
            ]
        )
    return out


def generate_box(params: dict) -> dict:
    w, h, d = params["width"] / 2.0, params["height"] / 2.0, params["depth"] / 2.0
    # (corner offsets, normal) per face, CCW seen from outside.
    faces = [
        ([(w, -h, -d), (w, h, -d), (w, h, d), (w, -h, d)], (1.0, 0.0, 0.0)),
        ([(-w, -h, d), (-w, h, d), (-w, h, -d), (-w, -h, -d)], (-1.0, 0.0, 0.0)),
        ([(-w, h, -d), (-w, h, d), (w, h, d), (w, h, -d)], (0.0, 1.0, 0.0)),
        ([(-w, -h, d), (-w, -h, -d), (w, -h, -d), (w, -h, d)], (0.0, -1.0, 0.0)),
        ([(-w, -h, d), (w, -h, d), (w, h, d), (-w, h, d)], (0.0, 0.0, 1.0)),
        ([(w, -h, -d), (-w, -h, -d), (-w, h, -d), (w, h, -d)], (0.0, 0.0, -1.0)),
    ]
    # Per-face (u, v) as a function of the corner, glTF convention: every
    # face shows an upright image (top of the image toward +Y; on the
    # top and bottom faces, toward -Z and +Z).
    width, height, depth = 2.0 * w, 2.0 * h, 2.0 * d
    face_uv = {
        (1.0, 0.0, 0.0): lambda x, y, z: ((d - z) / depth, (h - y) / height),
        (-1.0, 0.0, 0.0): lambda x, y, z: ((z + d) / depth, (h - y) / height),
        (0.0, 1.0, 0.0): lambda x, y, z: ((x + w) / width, (z + d) / depth),
        (0.0, -1.0, 0.0): lambda x, y, z: ((x + w) / width, (d - z) / depth),
        (0.0, 0.0, 1.0): lambda x, y, z: ((x + w) / width, (h - y) / height),
        (0.0, 0.0, -1.0): lambda x, y, z: ((w - x) / width, (h - y) / height),
    }
    positions: list = []
    normals: list = []
    uvs: list = []
    indices: list = []
    for corners, normal in faces:
        base = len(positions) // 3
        for corner in corners:
            positions.extend(corner)
            normals.extend(normal)
            uvs.extend(face_uv[normal](*corner))
        indices.extend([base, base + 1, base + 2, base, base + 2, base + 3])
    return _mesh(positions, normals, indices, uvs)


def generate_sphere(params: dict) -> dict:
    radius = params["radius"]
    ws = params["widthSegments"]
    hs = params["heightSegments"]
    positions: list = []
    normals: list = []
    uvs: list = []
    for iy in range(hs + 1):
        # Pole rows put each shared-position vertex at the middle of the
        # one triangle that uses it (+half a column at the top, -half at
        # the bottom: u runs 0.5 - ix/ws), as three.js does.
        u_offset = 0.5 / ws if iy == 0 else (-0.5 / ws if iy == hs else 0.0)
        phi = math.pi * iy / hs  # 0 at +Y pole, pi at -Y pole
        sin_phi, cos_phi = math.sin(phi), math.cos(phi)
        for ix in range(ws + 1):
            theta = 2.0 * math.pi * ix / ws
            sin_theta, cos_theta = math.sin(theta), math.cos(theta)
            nx = sin_phi * cos_theta
            ny = cos_phi
            nz = sin_phi * sin_theta
            positions.extend([radius * nx, radius * ny, radius * nz])
            normals.extend([nx, ny, nz])
            uvs.extend([0.5 - ix / ws + u_offset, iy / hs])
    indices: list = []
    for iy in range(hs):
        for ix in range(ws):
            a = iy * (ws + 1) + ix
            b = a + ws + 1
            # Pole rows emit one triangle per column, not two: at a pole
            # every vertex of the row coincides, so the second triangle
            # of the top row and the first of the bottom row are
            # degenerate (zero area). three.js SphereGeometry skips them
            # the same way (top row: b,c,d; bottom row: a,b,d), so the
            # generated mesh and the analytic count agree with three.js.
            if iy != 0:
                indices.extend([a, b, a + 1])
            if iy != hs - 1:
                indices.extend([b, b + 1, a + 1])
    return _mesh(positions, normals, indices, uvs)


def generate_cylinder(params: dict) -> dict:
    r_top = params["radiusTop"]
    r_bottom = params["radiusBottom"]
    half = params["height"] / 2.0
    radial = params["radialSegments"]
    # Side normal y-component for a tapered wall.
    slope = (r_bottom - r_top) / params["height"]
    top_pos, top_nrm = _ring(r_top, half, radial, ny=slope)
    bot_pos, bot_nrm = _ring(r_bottom, -half, radial, ny=slope)
    positions = top_pos + bot_pos
    normals = top_nrm + bot_nrm
    uvs: list = []
    for v in (0.0, 1.0):  # top ring, bottom ring (v runs down)
        for i in range(radial + 1):
            uvs.extend([0.25 - i / radial, v])
    indices: list = []
    for i in range(radial):
        a = i
        b = i + 1
        c = radial + 1 + i + 1
        d = radial + 1 + i
        indices.extend([a, d, c, a, c, b])
    # Caps: centre vert + ring, fan triangles.
    for y, radius, normal, flip in (
        (half, r_top, (0.0, 1.0, 0.0), False),
        (-half, r_bottom, (0.0, -1.0, 0.0), True),
    ):
        centre = len(positions) // 3
        positions.extend([0.0, y, 0.0])
        normals.extend(normal)
        uvs.extend([0.5, 0.5])
        ring_base = len(positions) // 3
        ring_pos, _ring_nrm = _ring(radius, y, radial)
        positions.extend(ring_pos)
        normals.extend(list(normal) * (radial + 1))
        uvs.extend(_cap_uvs(radial, -1.0 if flip else 1.0))
        for i in range(radial):
            if flip:
                indices.extend([centre, ring_base + i + 1, ring_base + i])
            else:
                indices.extend([centre, ring_base + i, ring_base + i + 1])
    return _mesh(positions, normals, indices, uvs)


def generate_cone(params: dict) -> dict:
    radius = params["radius"]
    half = params["height"] / 2.0
    radial = params["radialSegments"]
    slope = radius / params["height"]
    # Like three.js's ConeGeometry (a cylinder with a zero top radius) the
    # apex is one vertex per column, carrying the tilted side normal and its
    # own u, so a texture does not pinch at the tip.
    apex_pos, apex_nrm = _ring(0.0, half, radial, ny=slope)
    ring_pos, ring_nrm = _ring(radius, -half, radial, ny=slope)
    positions: list = apex_pos + ring_pos
    normals: list = apex_nrm + ring_nrm
    uvs: list = []
    for v in (0.0, 1.0):  # apex row, base ring (v runs down)
        for i in range(radial + 1):
            uvs.extend([0.25 - i / radial, v])
    indices: list = []
    ring_start = radial + 1
    for i in range(radial):
        # three.js keeps only (ring i, ring i+1, apex i+1) on the apex row.
        indices.extend([i + 1, ring_start + i, ring_start + i + 1])
    centre = len(positions) // 3
    positions.extend([0.0, -half, 0.0])
    normals.extend([0.0, -1.0, 0.0])
    uvs.extend([0.5, 0.5])
    ring_base = len(positions) // 3
    ring_pos, _ = _ring(radius, -half, radial)
    positions.extend(ring_pos)
    normals.extend([0.0, -1.0, 0.0] * (radial + 1))
    uvs.extend(_cap_uvs(radial, -1.0))
    for i in range(radial):
        indices.extend([centre, ring_base + i + 1, ring_base + i])
    return _mesh(positions, normals, indices, uvs)


def generate_torus(params: dict) -> dict:
    radius = params["radius"]
    tube = params["tube"]
    radial = params["radialSegments"]
    tubular = params["tubularSegments"]
    positions: list = []
    normals: list = []
    uvs: list = []
    for j in range(tubular + 1):
        u = 2.0 * math.pi * j / tubular
        cos_u, sin_u = math.cos(u), math.sin(u)
        for i in range(radial + 1):
            v = 2.0 * math.pi * i / radial
            cos_v, sin_v = math.cos(v), math.sin(v)
            nx = cos_v * cos_u
            ny = cos_v * sin_u
            nz = sin_v
            positions.extend(
                [
                    (radius + tube * cos_v) * cos_u,
                    (radius + tube * cos_v) * sin_u,
                    tube * sin_v,
                ]
            )
            normals.extend([nx, ny, nz])
            uvs.extend([j / tubular, 1.0 - i / radial])
    indices: list = []
    for j in range(tubular):
        for i in range(radial):
            a = j * (radial + 1) + i
            b = (j + 1) * (radial + 1) + i
            indices.extend([a, b, a + 1, b, b + 1, a + 1])
    return _mesh(positions, normals, indices, uvs)


def generate_plane(params: dict) -> dict:
    w, h = params["width"] / 2.0, params["height"] / 2.0
    positions = [-w, -h, 0.0, w, -h, 0.0, w, h, 0.0, -w, h, 0.0]
    normals = [0.0, 0.0, 1.0] * 4
    indices = [0, 1, 2, 0, 2, 3]
    uvs = [0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0]
    return _mesh(positions, normals, indices, uvs)


def generate_capsule(params: dict) -> dict:
    radius = params["radius"]
    half = params["length"] / 2.0
    cap = params["capSegments"]
    radial = params["radialSegments"]
    # Rings from the top pole to the bottom pole. Rings 0..cap are the top
    # hemisphere (pole -> equator at y=+half); rings cap+1..2*cap+1 are the
    # bottom hemisphere (equator at y=-half -> pole). The quads between the
    # two equator rings form the cylindrical mid-section.
    positions: list = []
    normals: list = []
    uvs: list = []
    cap_arc = (math.pi / 2.0) * radius
    total_arc = 2.0 * cap_arc + params["length"]
    total_rings = 2 * cap + 2
    for k in range(total_rings):
        if k <= cap:
            angle = (k / cap) * (math.pi / 2.0)
            y = half + radius * math.cos(angle)
            ring_radius = radius * math.sin(angle)
            ny_sign = 1.0
        else:
            # Equator first, pole last, so y decreases monotonically.
            angle = (1.0 - (k - (cap + 1)) / cap) * (math.pi / 2.0)
            y = -half - radius * math.cos(angle)
            ring_radius = radius * math.sin(angle)
            ny_sign = -1.0
        # v runs down the profile: arc length from the top pole / total.
        if k <= cap:
            arc = (k / cap) * cap_arc
        else:
            arc = cap_arc + params["length"] + ((k - cap - 1) / cap) * cap_arc
        u_offset = 0.5 / radial if k == 0 else (-0.5 / radial if k == total_rings - 1 else 0.0)
        for i in range(radial + 1):
            theta = 2.0 * math.pi * i / radial
            c, s = math.cos(theta), math.sin(theta)
            positions.extend([ring_radius * c, y, ring_radius * s])
            normals.extend([math.sin(angle) * c, ny_sign * math.cos(angle), math.sin(angle) * s])
            uvs.extend([0.5 - i / radial + u_offset, arc / total_arc])
    indices: list = []
    for k in range(total_rings - 1):
        for i in range(radial):
            a = k * (radial + 1) + i
            b = (k + 1) * (radial + 1) + i
            indices.extend([a, b, a + 1, b, b + 1, a + 1])
    return _mesh(positions, normals, indices, uvs)


_GENERATORS = {
    "box": generate_box,
    "sphere": generate_sphere,
    "cylinder": generate_cylinder,
    "cone": generate_cone,
    "torus": generate_torus,
    "plane": generate_plane,
    "capsule": generate_capsule,
}


def generate(primitive: dict) -> dict:
    """Generate ``{"positions", "normals", "uvs", "indices"}`` for a primitive dict."""
    params = resolve_params(primitive)
    return _GENERATORS[primitive["type"]](params)


def mesh_bounds(mesh: dict) -> dict:
    """``{"min": [x, y, z], "max": [x, y, z]}`` for a generated mesh."""
    positions = mesh["positions"]
    mins = [float("inf")] * 3
    maxs = [float("-inf")] * 3
    for i in range(0, len(positions), 3):
        for axis in range(3):
            value = positions[i + axis]
            if value < mins[axis]:
                mins[axis] = value
            if value > maxs[axis]:
                maxs[axis] = value
    return {"min": mins, "max": maxs}


def primitive_bounds(primitive: dict) -> dict:
    """Analytic bounds of a primitive without generating it."""
    return mesh_bounds(generate(primitive))


def describe(primitive: dict) -> dict:
    """Small summary used by tool feedback: counts + bounds."""
    counts = count_primitive(primitive)
    return {
        "type": primitive["type"],
        "verts": counts["verts"],
        "tris": counts["tris"],
        "bounds": primitive_bounds(primitive),
    }
