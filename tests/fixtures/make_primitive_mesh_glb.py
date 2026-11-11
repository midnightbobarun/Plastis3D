#!/usr/bin/env python3
"""Generate tests/fixtures/primitive-mesh.glb + primitive-mesh.json.

The PR6 mesh oracle (stage-3.md §4.1): one node of each of the 7
default primitives, plus ``cam_main`` (from the default rig), a floor
plane with ``r = [-90, 0, 0]``, and a box under a moved group. The GLB
is written by the real PR6 writer
(:func:`plastis3d_scene.export_glb.export_scene`) into a throwaway
store, then copied here; the JSON is computed from the same primitive
generators the writer uses.

Hash method (the Node oracle must reproduce it exactly): for one
primitive, take the generated positions then normals, round each float
to float32 (``struct`` pack/unpack ``'<f'`` first — the Node side sees
float32), format each with ``f"{(0.0 if v == 0 else v):.5f}"`` (so
``-0.0`` formats as ``0.00000``), join all values with ``","``, and
take the SHA-256 hex of that UTF-8 text.

Deterministic, stdlib-only: no timestamps, no randomness, fixed key
order. Regenerate both files with:
``python3 tests/fixtures/make_primitive_mesh_glb.py`` (from the repo
root).
"""

import hashlib
import json
import math
import shutil
import struct
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from plastis3d_scene import primitives  # noqa: E402
from plastis3d_scene.export_glb import export_scene  # noqa: E402
from plastis3d_scene.store import Store  # noqa: E402

GLB_PATH = HERE / "primitive-mesh.glb"
JSON_PATH = HERE / "primitive-mesh.json"

ORACLE_SCENE_ID = "oracle"

HASH_METHOD = (
    "SHA-256 hex of positions then normals; each float rounded to "
    "float32 (struct '<f'), formatted f\"{(0.0 if v == 0 else v):.5f}\", "
    "values joined with ','"
)

_PRIMITIVE_TYPES = ("box", "sphere", "cylinder", "cone", "torus", "plane", "capsule")
_NODE_NAMES = {
    "box": "Box",
    "sphere": "Sphere",
    "cylinder": "Cylinder",
    "cone": "Cone",
    "torus": "Torus",
    "plane": "Plane",
    "capsule": "Capsule",
}


def _mesh_node(node_id, name, ptype, transform=None, parent=None):
    node = {
        "id": node_id,
        "name": name,
        "kind": "mesh",
        "transform": transform or {"t": [0, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
        "primitive": {"type": ptype},
        "materialId": "m_default",
    }
    if parent is not None:
        node["parent"] = parent
    return node


def oracle_nodes():
    """The oracle scene's nodes beyond the default rig (light + camera).

    One node of each default primitive, a floor plane with
    ``r = [-90, 0, 0]``, and a box under a moved group.
    """
    nodes = [
        _mesh_node("n_%s" % ptype, _NODE_NAMES[ptype], ptype)
        for ptype in _PRIMITIVE_TYPES
    ]
    nodes.append(
        _mesh_node(
            "n_floor",
            "Floor",
            "plane",
            transform={"t": [0, 0, 0], "r": [-90, 0, 0], "s": [1, 1, 1]},
        )
    )
    nodes.append(
        {
            "id": "n_group",
            "name": "Moved group",
            "kind": "group",
            "transform": {"t": [2, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
        }
    )
    nodes.append(
        _mesh_node(
            "n_grouped_box",
            "Grouped box",
            "box",
            transform={"t": [0, 1, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
            parent="n_group",
        )
    )
    return nodes


def build_oracle_scene(store):
    """Create the oracle scene in ``store``; returns the scene dict."""
    scene = store.create_scene("Oracle", ORACLE_SCENE_ID)
    scene["nodes"].extend(oracle_nodes())
    written = store.write_scene(ORACLE_SCENE_ID, scene, base_revision=1)
    return written["scene"]


def quantized_hash(positions, normals):
    """SHA-256 hex of the canonical quantized text (see HASH_METHOD)."""
    values = []
    for raw in list(positions) + list(normals):
        rounded = struct.unpack("<f", struct.pack("<f", raw))[0]
        values.append("%s" % ("%.5f" % (0.0 if rounded == 0 else rounded)))
    return hashlib.sha256(",".join(values).encode("utf-8")).hexdigest()


def primitive_entry(ptype):
    """``{type, verts, tris, hash}`` for one default primitive."""
    counts = primitives.count_primitive({"type": ptype})
    mesh = primitives.generate({"type": ptype})
    return {
        "type": ptype,
        "verts": counts["verts"],
        "tris": counts["tris"],
        "hash": quantized_hash(mesh["positions"], mesh["normals"]),
    }


def build_fixture_json():
    """The ``primitive-mesh.json`` document, computed from the generators."""
    return {
        "hashMethod": HASH_METHOD,
        "primitives": [primitive_entry(ptype) for ptype in _PRIMITIVE_TYPES],
        "floor": {
            "rotation": [-90, 0, 0],
            "point": [0, 1, 0],
            "expected": [0, 0, -1],
        },
        "yfov": math.radians(40),
        "groupChild": {"group": "Moved group", "child": "Grouped box"},
    }


def main():
    with tempfile.TemporaryDirectory(prefix="plastis3d-oracle-") as tmp:
        store = Store(Path(tmp))
        scene = build_oracle_scene(store)
        result = export_scene(scene, store)
        shutil.copyfile(result["path"], GLB_PATH)
    JSON_PATH.write_text(
        json.dumps(build_fixture_json(), indent=2) + "\n", encoding="utf-8"
    )
    print("wrote %s (%d bytes)" % (GLB_PATH, GLB_PATH.stat().st_size))
    print("wrote %s" % JSON_PATH)


if __name__ == "__main__":
    main()
