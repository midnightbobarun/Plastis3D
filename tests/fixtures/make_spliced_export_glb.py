#!/usr/bin/env python3
"""Generate tests/fixtures/spliced-export.glb + spliced-export.expected.json.

Deterministic, stdlib-only: no timestamps, no randomness in the GLB
(the import mints random spec node ids, but ids never reach the file).
The source asset has two meshes with distinct names ("hullMesh",
"wingMesh"), one green material, and one source camera; the oracle
scene imports it twice — once exploded (the hull part moved to
[5, 0, 0]) and once locked ("Ship", moved to [10, 0, 0], with a spec
box child) — plus a moved group parenting a box.

Regenerate both files with:  python3 tests/fixtures/make_spliced_export_glb.py

The Node oracle (tests/node/test_splice_oracle.test.ts) loads the
checked-in GLB with GLTFLoader and asserts the hierarchy and the
moved part's world transform. The Python test
(test_splice.py::test_oracle_fixture_matches_fresh_writer_run) rebuilds
the same scene in a tmp store and requires byte-identical output, so
the fixture cannot drift silently.
"""

import json
import math
import struct
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
GLB_PATH = HERE / "spliced-export.glb"
EXPECTED_PATH = HERE / "spliced-export.expected.json"

REPO_ROOT = HERE.parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from plastis3d_scene import import_model as import_model_mod  # noqa: E402
from plastis3d_scene import mutate as mutate_mod  # noqa: E402
from plastis3d_scene.export_glb import export_scene  # noqa: E402
from plastis3d_scene.store import Store  # noqa: E402

_FACES = [
    [(1, -1, 1), (1, -1, -1), (1, 1, -1), (1, 1, 1)],
    [(-1, -1, -1), (-1, -1, 1), (-1, 1, 1), (-1, 1, -1)],
    [(-1, 1, 1), (1, 1, 1), (1, 1, -1), (-1, 1, -1)],
    [(-1, -1, -1), (1, -1, -1), (1, -1, 1), (-1, -1, 1)],
    [(-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)],
    [(1, -1, -1), (-1, -1, -1), (-1, 1, -1), (1, 1, -1)],
]


def _box_positions(center, size):
    half = size / 2.0
    cx, cy, cz = center
    verts = []
    for quad in _FACES:
        for i in (0, 1, 2, 0, 2, 3):
            x, y, z = quad[i]
            verts.append((cx + x * half, cy + y * half, cz + z * half))
    return verts


def _bounds_of(verts):
    return {
        "min": [min(v[a] for v in verts) for a in range(3)],
        "max": [max(v[a] for v in verts) for a in range(3)],
    }


def build_source_glb():
    """Two named meshes, one material, one camera, three root nodes."""
    bin_data = bytearray()
    views = []
    accessors = []
    for center, size in (((0.0, 0.0, 0.0), 1.0), ((2.0, 0.0, 0.0), 1.0)):
        verts = _box_positions(center, size)
        flat = [c for v in verts for c in v]
        blob = struct.pack("<%df" % len(flat), *flat)
        views.append({"buffer": 0, "byteOffset": len(bin_data), "byteLength": len(blob)})
        bounds = _bounds_of(verts)
        accessors.append(
            {
                "bufferView": len(views) - 1,
                "componentType": 5126,
                "count": len(verts),
                "type": "VEC3",
                "min": bounds["min"],
                "max": bounds["max"],
            }
        )
        bin_data.extend(blob)
    gltf = {
        "asset": {"version": "2.0", "generator": "plastis3d make_spliced_export_glb.py"},
        "scene": 0,
        "scenes": [{"nodes": [0, 1, 2]}],
        "nodes": [
            {"mesh": 0, "name": "Hull"},
            {"mesh": 1, "name": "Wing"},
            {"camera": 0, "name": "SrcCam"},
        ],
        "meshes": [
            {
                "name": "hullMesh",
                "primitives": [{"attributes": {"POSITION": 0}, "material": 0}],
            },
            {
                "name": "wingMesh",
                "primitives": [{"attributes": {"POSITION": 1}, "material": 0}],
            },
        ],
        "materials": [
            {
                "name": "hullMat",
                "pbrMetallicRoughness": {
                    "baseColorFactor": [0.0, 1.0, 0.0, 1.0],
                    "metallicFactor": 0.0,
                    "roughnessFactor": 0.5,
                },
            }
        ],
        "cameras": [
            {
                "type": "perspective",
                "perspective": {"yfov": 0.9, "znear": 0.1, "zfar": 50.0},
            }
        ],
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"byteLength": len(bin_data)}],
    }
    json_bytes = json.dumps(gltf, separators=(",", ":"), sort_keys=True).encode("utf-8")
    json_bytes += b" " * ((-len(json_bytes)) % 4)
    bin_bytes = bytes(bin_data)
    bin_bytes += b"\x00" * ((-len(bin_bytes)) % 4)
    total = 12 + 8 + len(json_bytes) + 8 + len(bin_bytes)
    return (
        struct.pack("<III", 0x46546C67, 2, total)
        + struct.pack("<II", len(json_bytes), 0x4E4F534A)
        + json_bytes
        + struct.pack("<II", len(bin_bytes), 0x004E4942)
        + bin_bytes
    )


def build_expected():
    return {
        "description": (
            "Expected hierarchy / transforms for spliced-export.glb. "
            "Names are the GLB JSON names (GLTFLoader sanitizes spaces "
            "to underscores, so the Node test asserts on the sanitized "
            "forms). The moved part is the exploded hullMesh part "
            "moved to [5, 0, 0]; the grouped box sits under the moved "
            "group at [2, 0, 0] with local [0, 1, 0]."
        ),
        "movedPartWorld": [5, 0, 0],
        "groupedBoxWorld": [2, 1, 0],
        "shipChildren": ["Hull", "Wing", "SrcCam", "Ship_box"],
        "shipTranslation": [10, 0, 0],
        "cameraYfovs": [0.9, math.radians(40)],
    }


def build_glb(work_dir):
    """Build the oracle scene in ``work_dir`` and return its export bytes."""
    work_dir = Path(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    store = Store(work_dir / "data")
    source = work_dir / "oracle-src.glb"
    source.write_bytes(build_source_glb())

    scene = store.create_scene("Splice oracle", "splice-oracle")
    scene_id = scene["id"]
    revision = scene["revision"]

    # Exploded import: wrapper "Oracle", groups Hull/Wing, parts
    # hullMesh/wingMesh. Move the hull part to [5, 0, 0].
    envelope = import_model_mod.import_bytes(
        scene_id, store, source.read_bytes(),
        original_name="oracle-src.glb", source_format="glb",
        base_revision=revision, name="Oracle",
    )
    revision = envelope["scene"]["revision"]
    hull = next(
        n for n in envelope["nodes"]
        if n["kind"] == "part" and n["name"] == "hullMesh"
    )
    envelope = mutate_mod.apply(
        scene_id, revision,
        {
            "op": "update_node",
            "id": hull["id"],
            "transform": {"t": [5, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
        },
        store=store,
    )
    revision = envelope["scene"]["revision"]

    # Locked import: one model node "Ship", moved to [10, 0, 0].
    envelope = import_model_mod.import_bytes(
        scene_id, store, source.read_bytes(),
        original_name="oracle-src.glb", source_format="glb",
        base_revision=revision, name="Ship", explode=False,
        transform={"t": [10, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
    )
    revision = envelope["scene"]["revision"]
    ship = next(n for n in envelope["nodes"] if n["kind"] == "model")

    # A spec box child under the model node.
    envelope = mutate_mod.apply(
        scene_id, revision,
        {
            "op": "add_node",
            "node": {
                "name": "Ship box",
                "parent": ship["id"],
                "kind": "mesh",
                "transform": {"t": [0, 1, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
                "primitive": {"type": "box"},
                "materialId": "m_default",
            },
        },
        store=store,
    )
    revision = envelope["scene"]["revision"]

    # A moved group parenting a spec box.
    envelope = mutate_mod.apply(
        scene_id, revision,
        {
            "op": "add_node",
            "node": {
                "name": "Moved group",
                "kind": "group",
                "transform": {"t": [2, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
            },
        },
        store=store,
    )
    revision = envelope["scene"]["revision"]
    group = next(n for n in envelope["nodes"] if n["name"] == "Moved group")
    envelope = mutate_mod.apply(
        scene_id, revision,
        {
            "op": "add_node",
            "node": {
                "name": "Grouped box",
                "parent": group["id"],
                "kind": "mesh",
                "transform": {"t": [0, 1, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
                "primitive": {"type": "box"},
                "materialId": "m_default",
            },
        },
        store=store,
    )

    scene = store.get_scene(scene_id)
    result = export_scene(scene, store)
    return Path(result["path"]).read_bytes()


def main():
    with tempfile.TemporaryDirectory(prefix="splice-oracle-") as tmp:
        data = build_glb(Path(tmp) / "work")
    GLB_PATH.write_bytes(data)
    EXPECTED_PATH.write_text(
        json.dumps(build_expected(), indent=2) + "\n", encoding="utf-8"
    )
    print(f"wrote {GLB_PATH} ({GLB_PATH.stat().st_size} bytes)")
    print(f"wrote {EXPECTED_PATH}")


if __name__ == "__main__":
    main()
