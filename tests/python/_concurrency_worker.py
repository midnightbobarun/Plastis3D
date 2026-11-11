"""Concurrency worker for test_store_concurrency.py.

One process, one mutation: read the scene, append a box node with a
worker-unique id, and write it back with the revision just read. On
``REVISION_CONFLICT`` it re-reads and retries (up to 100 attempts) —
that is the correct client behaviour, and it is what "zero lost updates"
means here: every worker's node must land, each at its own revision.

Usage: python _concurrency_worker.py <repo_root> <data_dir> <scene_id> <index>
"""

import json
import sys
import time

sys.path.insert(0, sys.argv[1])

from plastis3d_scene.spec import PlastisError, now_iso
from plastis3d_scene.store import Store


def main() -> int:
    _repo_root, data_dir, scene_id, index = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
    store = Store(data_dir)
    node_id = "w%d" % index
    for _attempt in range(100):
        scene = store.get_scene(scene_id)
        new_scene = json.loads(json.dumps(scene))
        new_scene["nodes"].append(
            {
                "id": node_id,
                "name": "Worker %d" % index,
                "parent": None,
                "kind": "mesh",
                "transform": {"t": [index, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
                "visible": True,
                "primitive": {"type": "box", "width": 1, "height": 1, "depth": 1},
                "materialId": "m_default",
            }
        )
        entry = {
            "label": "worker %d" % index,
            "at": now_iso(),
            "undo": {"nodes": {node_id: None}},
            "redo": {},
        }
        try:
            store.write_scene(scene_id, new_scene, scene["revision"], entry)
        except PlastisError as error:
            if error.code == "REVISION_CONFLICT":
                time.sleep(0.01)
                continue
            raise
        return 0
    print("worker %d: too many REVISION_CONFLICT retries" % index, file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
