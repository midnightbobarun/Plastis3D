#!/usr/bin/env python3
"""Regenerate the W03 ancestor-aware follow-path GLTFLoader oracle (disposable store)."""
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from plastis3d_scene import bake, curves, generators, mutate
from plastis3d_scene.export_glb import export_scene
from plastis3d_scene.store import Store


def build():
    with tempfile.TemporaryDirectory() as directory:
        store = Store(directory)
        scene = store.create_scene("Follow path", scene_id="follow-path")
        nodes = [
            {"id": "n_railparent", "name": "RailParent", "kind": "group", "parent": None, "transform": {"t": [5, 3, -2], "r": [10, 20, 35], "s": [2, 3, 1]}},
            {"id": "n_riderparent", "name": "RiderParent", "kind": "group", "parent": None, "transform": {"t": [-4, 2, 7], "r": [30, -15, 10], "s": [0.5, 2, 1]}},
            {"id": "n_rider", "name": "Rider", "kind": "mesh", "parent": "n_riderparent", "primitive": {"type": "box"}, "materialId": "m_default", "transform": {"t": [0, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]}},
        ]
        env = mutate.apply(scene["id"], 1, {"op": "build", "nodes": nodes}, store=store)
        params = curves.validate_params({"kind": "tube", "points": [[-1, 0, 0], [1, 0, 0]], "radius": 0.05, "radialSegments": 4, "tubularSegments": 4})
        env = bake.commit_mesh(scene["id"], store, env["scene"]["revision"], "n_rail", {"name": "Rail", "parent": "n_railparent", "transform": {"t": [1, 2, 3], "r": [40, 0, 25], "s": [1, 2, 1]}}, curves.to_decoded(curves.build_mesh(params)), None, {"type": "curve", "version": 1, "params": params})
        generators.follow_path(store, scene["id"], env["scene"]["revision"], "n_rail", "n_rider", 5, 2)
        result = export_scene(store.get_scene(scene["id"]), store)
        return Path(result["path"]).read_bytes()


if __name__ == "__main__":
    (ROOT / "tests/fixtures/follow-path.glb").write_bytes(build())
