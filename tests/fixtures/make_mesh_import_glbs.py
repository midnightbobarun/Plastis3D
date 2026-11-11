#!/usr/bin/env python3
"""Generate tests/fixtures/mesh-import-{stl,obj,ply}.glb (PR12).

Each file is what ``plastis3d_scene.mesh_import.convert`` produces for a
tiny deterministic source: a 180 x 90 rectangle as two triangles. The Node
loader-acceptance test (tests/node/mesh-import-loader.test.ts) loads them
with GLTFLoader, which proves the converter's output is a GLB that three.js
accepts. Regenerate with:  python3 tests/fixtures/make_mesh_import_glbs.py
Stdlib only; no timestamps or randomness.
"""

import struct
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent.parent))

from plastis3d_scene import mesh_import  # noqa: E402

VERTS = [(0, 0, 0), (180, 0, 0), (180, 90, 0), (0, 90, 0)]
COLORS = [(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0)]


def stl() -> bytes:
    out = bytearray(b"plastis3d fixture".ljust(80, b" ")) + struct.pack("<I", 2)
    for tri in ((0, 1, 2), (0, 2, 3)):
        out += struct.pack("<3f", 0, 0, 1)
        for i in tri:
            out += struct.pack("<3f", *VERTS[i])
        out += b"\x00\x00"
    return bytes(out)


def obj() -> bytes:
    lines = ["v %d %d %d" % v for v in VERTS]
    lines += ["vt 0 0", "vt 1 0", "vt 1 1", "vt 0 1", "vn 0 0 1"]
    lines.append("f 1/1/1 2/2/1 3/3/1 4/4/1")
    return ("\n".join(lines) + "\n").encode()


def ply() -> bytes:
    head = (
        "ply\nformat binary_little_endian 1.0\nelement vertex 4\nproperty float x\n"
        "property float y\nproperty float z\nproperty uchar red\nproperty uchar green\n"
        "property uchar blue\nelement face 1\nproperty list uchar int vertex_indices\n"
        "end_header\n"
    ).encode()
    body = b"".join(struct.pack("<3f3B", *v, *c) for v, c in zip(VERTS, COLORS))
    return head + body + struct.pack("<B4i", 4, 0, 1, 2, 3)


def main() -> None:
    deadline = time.monotonic() + 30
    for fmt, data in (("stl", stl()), ("obj", obj()), ("ply", ply())):
        glb, _ignored = mesh_import.convert(data, fmt, name="rect", deadline=deadline)
        (HERE / ("mesh-import-%s.glb" % fmt)).write_bytes(glb)
        print("wrote mesh-import-%s.glb (%d bytes)" % (fmt, len(glb)))


if __name__ == "__main__":
    main()
