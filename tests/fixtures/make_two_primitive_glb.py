#!/usr/bin/env python3
"""Generate tests/fixtures/two-primitive.glb + two-primitive.expected.json.

Deterministic, stdlib-only (struct/json): no timestamps, no randomness,
fixed key order. The GLB has:

  mesh 0: two primitives (two boxes) — part (0, 0) and part (0, 1)
  mesh 1: one primitive (one box)   — part (1, 0)

Positions are the only attribute (non-indexed TRIANGLES, 36 vertices
per box; `mode` omitted, which reads as 4). No materials, no normals,
no textures — the part-mapping test only needs geometry + bounds.

The expected-bounds JSON carries the `stats.parts` entries the test
fabricates: PR7's exploder does not exist yet, so the view only
consumes stats.parts — fabricating them here (from the known box
geometry, computed by this script, not hand-typed) is valid. Regenerate
both files with:  python3 tests/fixtures/make_two_primitive_glb.py
"""

import json
import struct
from pathlib import Path

HERE = Path(__file__).resolve().parent
GLB_PATH = HERE / "two-primitive.glb"
EXPECTED_PATH = HERE / "two-primitive.expected.json"

# Quad faces of a unit cube centred on the origin (each quad -> 2 tris).
# Winding is outward; it does not matter for the bounds test.
_FACES = [
    [(1, -1, 1), (1, -1, -1), (1, 1, -1), (1, 1, 1)],      # +X
    [(-1, -1, -1), (-1, -1, 1), (-1, 1, 1), (-1, 1, -1)],  # -X
    [(-1, 1, 1), (1, 1, 1), (1, 1, -1), (-1, 1, -1)],      # +Y
    [(-1, -1, -1), (1, -1, -1), (1, -1, 1), (-1, -1, 1)],  # -Y
    [(-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)],      # +Z
    [(1, -1, -1), (-1, -1, -1), (-1, 1, -1), (1, 1, -1)],   # -Z
]


def box_positions(center, size):
    """36 non-indexed vertices for a box centred at `center`."""
    half = size / 2.0
    cx, cy, cz = center
    verts = []
    for quad in _FACES:
        for i in (0, 1, 2, 0, 2, 3):
            x, y, z = quad[i]
            verts.append((cx + x * half, cy + y * half, cz + z * half))
    return verts


def bounds_of(verts):
    mins = [min(v[a] for v in verts) for a in range(3)]
    maxs = [max(v[a] for v in verts) for a in range(3)]
    return {"min": mins, "max": maxs}


# (mesh_index, primitive_index, center, size)
BOXES = [
    (0, 0, (0.0, 0.0, 0.0), 1.0),   # unit box at the origin
    (0, 1, (2.0, 0.0, 0.0), 1.0),   # unit box offset +X
    (1, 0, (0.0, 3.0, 0.0), 2.0),   # size-2 box offset +Y
]


def build_glb():
    bin_data = bytearray()
    buffer_views = []
    accessors = []
    for mesh_index, prim_index, center, size in BOXES:
        verts = box_positions(center, size)
        flat = [c for v in verts for c in v]
        blob = struct.pack("<%df" % len(flat), *flat)
        buffer_views.append(
            {"buffer": 0, "byteOffset": len(bin_data), "byteLength": len(blob)}
        )
        bounds = bounds_of(verts)
        accessors.append(
            {
                "bufferView": len(buffer_views) - 1,
                "componentType": 5126,  # FLOAT
                "count": len(verts),
                "type": "VEC3",
                "min": bounds["min"],
                "max": bounds["max"],
            }
        )
        bin_data.extend(blob)

    gltf = {
        "asset": {
            "version": "2.0",
            "generator": "plastis3d make_two_primitive_glb.py",
        },
        "scene": 0,
        "scenes": [{"nodes": [0, 1]}],
        "nodes": [
            {"mesh": 0, "name": "mesh0"},
            {"mesh": 1, "name": "mesh1"},
        ],
        "meshes": [
            {
                "name": "mesh0",
                "primitives": [
                    {"attributes": {"POSITION": 0}},
                    {"attributes": {"POSITION": 1}},
                ],
            },
            {
                "name": "mesh1",
                "primitives": [{"attributes": {"POSITION": 2}}],
            },
        ],
        "accessors": accessors,
        "bufferViews": buffer_views,
        "buffers": [{"byteLength": len(bin_data)}],
    }
    json_bytes = json.dumps(gltf, separators=(",", ":"), sort_keys=True).encode("utf-8")
    json_pad = (-len(json_bytes)) % 4
    json_bytes += b" " * json_pad
    bin_pad = (-len(bin_data)) % 4
    bin_data.extend(b"\x00" * bin_pad)

    header = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(json_bytes) + 8 + len(bin_data))
    chunk_json = struct.pack("<II", len(json_bytes), 0x4E4F534A) + json_bytes
    chunk_bin = struct.pack("<II", len(bin_data), 0x004E4942) + bytes(bin_data)
    return header + chunk_json + chunk_bin


def build_expected():
    parts = []
    all_mins = [float("inf")] * 3
    all_maxs = [float("-inf")] * 3
    for mesh_index, prim_index, center, size in BOXES:
        bounds = bounds_of(box_positions(center, size))
        parts.append(
            {
                "meshIndex": mesh_index,
                "primitiveIndex": prim_index,
                "tris": 12,
                "verts": 36,
                "bounds": bounds,
            }
        )
        for a in range(3):
            all_mins[a] = min(all_mins[a], bounds["min"][a])
            all_maxs[a] = max(all_maxs[a], bounds["max"][a])
    return {
        "description": (
            "Expected bounds for two-primitive.glb. The `parts` entries "
            "are the stats.parts the part-mapping test fabricates: PR7's "
            "exploder does not exist yet, so the view only consumes "
            "stats.parts. Values are computed by "
            "make_two_primitive_glb.py from the same box geometry the "
            "GLB embeds, not hand-typed."
        ),
        "parts": parts,
        "assetTris": 36,
        "assetBounds": {"min": all_mins, "max": all_maxs},
    }


def main():
    GLB_PATH.write_bytes(build_glb())
    EXPECTED_PATH.write_text(
        json.dumps(build_expected(), indent=2, sort_keys=False) + "\n",
        encoding="utf-8",
    )
    print(f"wrote {GLB_PATH} ({GLB_PATH.stat().st_size} bytes)")
    print(f"wrote {EXPECTED_PATH}")


if __name__ == "__main__":
    main()
