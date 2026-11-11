#!/usr/bin/env python3
"""Generate the PR13 deformable fixtures.

``skin-clip-morph.glb`` (the *source* asset): one skinned mesh with a
two-bone skin, one animation clip with two channels (a rotation on the
second bone and a morph-weights channel), and one mesh with a single morph
target. ``deformable-export.glb`` is what the exporter writes for a scene
that imports that asset as two locked ``model`` nodes (the second moved),
which the Node oracle (tests/node/deformable-export.test.ts) loads with
GLTFLoader.

Deterministic, stdlib only: no timestamps or randomness reach the files
(the import mints random node ids, but ids never reach the GLB).
Regenerate both with:  python3 tests/fixtures/make_skin_clip_morph_glb.py
Python (test_deformable_splice.py) rebuilds the source in memory and the
export in a tmp store and requires byte-identical output.
"""

import json
import math
import struct
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from plastis3d_scene import glb as glb_mod  # noqa: E402

SOURCE_PATH = HERE / "skin-clip-morph.glb"
EXPORT_PATH = HERE / "deformable-export.glb"

# Node indexes in the source document.
N_ARMATURE, N_BONE0, N_BONE1, N_SKINNED, N_MORPHER = 0, 1, 2, 3, 4


def build_source_gltf():
    """``(gltf dict, BIN bytes)`` for the source asset."""
    blob = bytearray()
    views, accessors = [], []

    def add(data: bytes, component, count, kind, target=None, **extra):
        while len(blob) % 4:
            blob.append(0)
        view = {"buffer": 0, "byteOffset": len(blob), "byteLength": len(data)}
        if target:
            view["target"] = target
        blob.extend(data)
        views.append(view)
        accessor = {"bufferView": len(views) - 1, "componentType": component,
                    "count": count, "type": kind}
        accessor.update(extra)
        accessors.append(accessor)
        return len(accessors) - 1

    # Skinned strip: 3 rows (y = 0, 1, 2) x 2 columns, 4 triangles.
    positions = [(-1, 0, 0), (1, 0, 0), (-1, 1, 0), (1, 1, 0), (-1, 2, 0), (1, 2, 0)]
    flat = [c for p in positions for c in p]
    pos = add(struct.pack("<18f", *flat), 5126, 6, "VEC3", 34962,
              min=[-1.0, 0.0, 0.0], max=[1.0, 2.0, 0.0])
    joints = [(0, 0, 0, 0), (0, 0, 0, 0), (0, 1, 0, 0), (0, 1, 0, 0), (1, 0, 0, 0), (1, 0, 0, 0)]
    jnt = add(b"".join(struct.pack("<4B", *j) for j in joints), 5121, 6, "VEC4", 34962)
    weights = [(1, 0, 0, 0), (1, 0, 0, 0), (.5, .5, 0, 0), (.5, .5, 0, 0), (1, 0, 0, 0), (1, 0, 0, 0)]
    wgt = add(b"".join(struct.pack("<4f", *w) for w in weights), 5126, 6, "VEC4", 34962)
    idx = add(struct.pack("<12H", 0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4), 5123, 12, "SCALAR", 34963)
    identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    down = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1]
    ibm = add(struct.pack("<32f", *(identity + down)), 5126, 2, "MAT4")

    # Morph mesh: one triangle with one POSITION target.
    tri = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    mpos = add(struct.pack("<9f", *[c for p in tri for c in p]), 5126, 3, "VEC3", 34962,
               min=[0.0, 0.0, 0.0], max=[1.0, 1.0, 0.0])
    delta = add(struct.pack("<9f", 0, 0, 1, 0, 0, 1, 0, 0, 1), 5126, 3, "VEC3", 34962,
                min=[0.0, 0.0, 1.0], max=[0.0, 0.0, 1.0])

    # Animation: bone1 bends about Z; the morph weight ramps 0 -> 1.
    times = add(struct.pack("<2f", 0.0, 1.0), 5126, 2, "SCALAR",
                min=[0.0], max=[1.0])
    angle = 0.5
    bend = add(struct.pack("<8f", 0, 0, 0, 1, 0, 0, math.sin(angle / 2), math.cos(angle / 2)),
               5126, 2, "VEC4")
    ramp = add(struct.pack("<2f", 0.0, 1.0), 5126, 2, "SCALAR")

    gltf = {
        "asset": {"version": "2.0", "generator": "plastis3d skin-clip-morph fixture"},
        "scene": 0,
        "scenes": [{"nodes": [N_ARMATURE, N_SKINNED, N_MORPHER]}],
        "nodes": [
            {"name": "Armature", "children": [N_BONE0]},
            {"name": "bone0", "children": [N_BONE1]},
            {"name": "bone1", "translation": [0.0, 1.0, 0.0]},
            {"name": "SkinnedMesh", "mesh": 0, "skin": 0},
            {"name": "Morpher", "mesh": 1, "weights": [0.5]},
        ],
        "meshes": [
            {"name": "strip", "primitives": [{
                "attributes": {"POSITION": pos, "JOINTS_0": jnt, "WEIGHTS_0": wgt},
                "indices": idx, "material": 0}]},
            {"name": "morph", "weights": [0.5], "primitives": [{
                "attributes": {"POSITION": mpos}, "targets": [{"POSITION": delta}],
                "material": 0}]},
        ],
        "materials": [{"name": "skinMat", "pbrMetallicRoughness": {
            "baseColorFactor": [0.2, 0.6, 0.9, 1.0], "metallicFactor": 0.0}}],
        "skins": [{"name": "rig", "joints": [N_BONE0, N_BONE1], "skeleton": N_BONE0,
                   "inverseBindMatrices": ibm}],
        "animations": [{"name": "bend", "samplers": [
            {"input": times, "output": bend, "interpolation": "LINEAR"},
            {"input": times, "output": ramp, "interpolation": "LINEAR"}],
            "channels": [
                {"sampler": 0, "target": {"node": N_BONE1, "path": "rotation"}},
                {"sampler": 1, "target": {"node": N_MORPHER, "path": "weights"}}]}],
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"byteLength": len(blob)}],
    }
    return gltf, bytes(blob)


def build_source_glb() -> bytes:
    gltf, blob = build_source_gltf()
    return glb_mod.build_glb(gltf, [blob])


def export_fixture(data_dir: Path) -> bytes:
    """The exporter's output for two locked instances of the source (the
    second moved to x = 5), as bytes."""
    from plastis3d_scene import import_model as import_model_mod
    from plastis3d_scene import mutate as mutate_mod
    from plastis3d_scene.export_glb import export_scene
    from plastis3d_scene.store import Store

    store = Store(data_dir)
    scene = store.create_scene("Deformable", "deformable")
    source = data_dir / "source" / "skin-clip-morph.glb"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(build_source_glb())
    revision = scene["revision"]
    for name, x in (("Rig A", 0.0), ("Rig B", 5.0)):
        envelope = import_model_mod.import_path(
            "deformable", store, str(source), base_revision=revision, name=name,
            transform={"t": [x, 0.0, 0.0], "r": [0.0, 0.0, 0.0], "s": [1.0, 1.0, 1.0]},
            explode=False, timeout=60.0)
        revision = envelope["scene"]["revision"]
    result = export_scene(store.get_scene("deformable"), store)
    return Path(result["path"]).read_bytes()


def main() -> None:
    SOURCE_PATH.write_bytes(build_source_glb())
    print("wrote %s (%d bytes)" % (SOURCE_PATH.name, SOURCE_PATH.stat().st_size))
    with tempfile.TemporaryDirectory() as tmp:
        EXPORT_PATH.write_bytes(export_fixture(Path(tmp) / "data"))
    print("wrote %s (%d bytes)" % (EXPORT_PATH.name, EXPORT_PATH.stat().st_size))


if __name__ == "__main__":
    main()
