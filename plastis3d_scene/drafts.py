"""Plastis3D — unsaved-edit drafts (PR24, D-EXT-07 §2).

A crash-safe copy of a mesh the editor holds in memory, written about every
two minutes and when the window is hidden. One slot per node, overwritten in
place, at ``drafts/<scene>/<node>.json`` in the plugin data folder.

A draft is **not** part of the scene: it has no revision, no history entry, does
not count toward the asset cap, and the agent never sees it. A normal commit
(the bake) or Cancel deletes it, as does deleting the scene. At most 64 MiB of
drafts are kept per scene; above that the oldest other draft is dropped.

Stdlib only. Python 3.11-compatible.
"""

from __future__ import annotations

import json
import shutil
import time
from pathlib import Path
from typing import Any

from .asset_transactions import pin_scene
from .spec import NODE_ID_RE, PlastisError, SCENE_ID_RE
from .store import Store

MAX_DRAFT_BYTES = 16 * 1024 * 1024
MAX_SCENE_DRAFT_BYTES = 64 * 1024 * 1024


def _path(store: Store, scene_id: str, node_id: str) -> Path:
    if not isinstance(scene_id, str) or not SCENE_ID_RE.match(scene_id):
        raise PlastisError("SCENE_NOT_FOUND", "no scene with id %r" % (scene_id,))
    if not isinstance(node_id, str) or not NODE_ID_RE.match(node_id):
        raise PlastisError("SPEC_INVALID", "node id is malformed", path="/nodeId")
    return store.data_dir / "drafts" / scene_id / ("%s.json" % node_id)


@pin_scene
def put_draft(store: Store, scene_id: str, node_id: str, body: Any) -> dict:
    """Write (replace) one node's draft. Returns ``{ok, bytes, savedAt, dropped}``."""
    scene = store.get_scene(scene_id)
    if not any(n.get("id") == node_id for n in scene["nodes"]):
        raise PlastisError("NODE_NOT_FOUND", "no node with id %r" % node_id)
    path = _path(store, scene_id, node_id)
    if not isinstance(body, dict) or not isinstance(body.get("mesh"), dict):
        raise PlastisError("SPEC_INVALID", "a draft needs a mesh object", path="/mesh")
    if not isinstance(body.get("baseRevision"), int) or isinstance(body.get("baseRevision"), bool):
        raise PlastisError("SPEC_INVALID", "a draft needs the baseRevision it started from", path="/baseRevision")
    record = {
        "nodeId": node_id,
        "baseRevision": body["baseRevision"],
        "from": body.get("from") if isinstance(body.get("from"), dict) else None,
        "mesh": body["mesh"],
        "savedAt": time.time(),
    }
    data = json.dumps(record, separators=(",", ":")).encode("utf-8")
    if len(data) > MAX_DRAFT_BYTES:
        raise PlastisError("DRAFT_TOO_LARGE", "the draft is larger than %d bytes" % MAX_DRAFT_BYTES)
    path.parent.mkdir(parents=True, exist_ok=True)
    Store._atomic_write(path, data)
    dropped = 0
    siblings = sorted(
        (p for p in path.parent.glob("*.json") if p != path),
        key=lambda p: p.stat().st_mtime,
    )
    total = len(data) + sum(p.stat().st_size for p in siblings)
    while siblings and total > MAX_SCENE_DRAFT_BYTES:
        oldest = siblings.pop(0)
        total -= oldest.stat().st_size
        oldest.unlink()
        dropped += 1
    return {"ok": True, "bytes": len(data), "savedAt": record["savedAt"], "dropped": dropped}


def get_draft(store: Store, scene_id: str, node_id: str) -> dict:
    scene = store.get_scene(scene_id)
    path = _path(store, scene_id, node_id)
    node = next((n for n in scene["nodes"] if n.get("id") == node_id), None)
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        record = None
    if node is None or record is None:
        raise PlastisError("DRAFT_NOT_FOUND", "no unsaved edit for this object")
    record["currentRevision"] = scene["revision"]
    return {"ok": True, "draft": record}


def delete_draft(store: Store, scene_id: str, node_id: str) -> bool:
    try:
        path = _path(store, scene_id, node_id)
    except PlastisError:
        return False
    try:
        path.unlink()
    except OSError:
        return False
    try:
        path.parent.rmdir()
    except OSError:
        pass
    return True


def delete_scene_drafts(store: Store, scene_id: str) -> None:
    try:
        shutil.rmtree(store.data_dir / "drafts" / scene_id, ignore_errors=True)
    except Exception:
        pass
