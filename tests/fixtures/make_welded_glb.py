#!/usr/bin/env python3
"""Generate tests/fixtures/weld-source.glb and weld-result.glb (PR19).

The source is two quads side by side as non-indexed triangles, with a UV seam
on the edge they share (the same positions, different UVs), plus one degenerate
triangle. ``weld-result.glb`` is what ``plastis3d_scene.weld.weld_asset`` makes of
it: the duplicate vertices inside each quad merge, the seam stays, the degenerate
triangle is gone. tests/node/weld-loader.test.ts loads both with GLTFLoader.
Deterministic, stdlib only. Regenerate with:  python3 tests/fixtures/make_welded_glb.py
tests/python/test_weld.py requires the checked-in files to match a fresh run.
"""

import struct
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent.parent))

from plastis3d_scene import glb, weld  # noqa: E402

SOURCE = HERE / "weld-source.glb"
RESULT = HERE / "weld-result.glb"


def build_source() -> bytes:
    def quad(x0):
        pts = [(x0, 0, 0), (x0 + 1, 0, 0), (x0, 1, 0), (x0 + 1, 0, 0), (x0 + 1, 1, 0), (x0, 1, 0)]
        uvs = [(0, 0), (1, 0), (0, 1), (1, 0), (1, 1), (0, 1)]
        return pts, uvs

    a_pts, a_uv = quad(0)
    b_pts, b_uv = quad(1)
    pts = a_pts + b_pts + [(5, 5, 5)] * 3  # the last triangle is degenerate
    uvs = a_uv + b_uv + [(0, 0)] * 3
    normals = [(0, 0, 1)] * len(pts)
    blob = bytearray()
    views, accessors = [], []

    def add(rows, letter, kind, **extra):
        data = b"".join(struct.pack("<%d%s" % (len(r), letter), *r) for r in rows)
        views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(data), "target": 34962})
        blob.extend(data)
        accessors.append({"bufferView": len(views) - 1, "componentType": 5126, "count": len(rows), "type": kind, **extra})
        return len(accessors) - 1

    attributes = {
        "POSITION": add(pts, "f", "VEC3", min=[0, 0, 0], max=[5, 5, 5]),
        "NORMAL": add(normals, "f", "VEC3"),
        "TEXCOORD_0": add(uvs, "f", "VEC2"),
    }
    gltf = {
        "asset": {"version": "2.0", "generator": "plastis3d weld fixture"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"name": "strip", "mesh": 0}],
        "meshes": [{"name": "strip", "primitives": [{"attributes": attributes, "material": 0}]}],
        "materials": [{"name": "plain", "pbrMetallicRoughness": {"baseColorFactor": [0.8, 0.8, 0.8, 1]}}],
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"byteLength": len(blob)}],
    }
    return glb.build_glb(gltf, [bytes(blob)])


def build_result(source: bytes) -> bytes:
    return weld.weld_asset(source, time.monotonic() + 30)["bytes"]


def main() -> None:
    source = build_source()
    SOURCE.write_bytes(source)
    RESULT.write_bytes(build_result(source))
    print("wrote %s (%d bytes) and %s (%d bytes)" % (SOURCE.name, len(source), RESULT.name, RESULT.stat().st_size))


if __name__ == "__main__":
    main()
