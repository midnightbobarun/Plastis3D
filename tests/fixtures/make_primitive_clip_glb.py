#!/usr/bin/env python3
"""Generate the PR21 primitive animation GLB loader oracle fixture."""
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from plastis3d_scene import mutate
from plastis3d_scene.export_glb import export_scene
from plastis3d_scene.store import Store

with tempfile.TemporaryDirectory() as directory:
    store = Store(directory)
    scene = store.create_scene("primitive clip", scene_id="primitive-clip")
    node = {
        "id": "n_box", "name": "AnimatedBox", "kind": "mesh", "parent": None,
        "transform": {"t": [0, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
        "primitive": {"type": "box"}, "materialId": "m_default",
        "clips": [{"name": "Move and turn", "duration": 2, "channels": [
            {"target": "translation", "times": [0, 1], "values": [[0, 0, 0], [2, 0, 0]]},
            {"target": "rotation", "times": [0, 1], "values": [[0, 0, 0], [0, 90, 0]]},
        ]}],
    }
    mutate.apply(scene["id"], scene["revision"], {"op": "add_node", "node": node}, store=store)
    result = export_scene(store.get_scene(scene["id"]), store)
    (ROOT / "tests/fixtures/primitive-clip.glb").write_bytes(Path(result["path"]).read_bytes())
