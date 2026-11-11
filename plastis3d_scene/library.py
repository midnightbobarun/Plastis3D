"""Plastis3D — the local library (PR14): scene thumbnails and the asset list.

* **Thumbnails.** A small PNG per scene (at most 512 KB and 512 px a side),
  posted by the editor after an edit settles and stored at
  ``thumbnails/<scene>.png`` with a ``.json`` sidecar holding the revision it
  shows. The scene picker and the Scenes pane draw it instead of a letter tile.
  A thumbnail is a convenience: it is not part of the scene, has no history, and
  is deleted with the scene.
* **The asset list.** Every model and image a scene holds, whether anything in
  the scene uses it, and how much space it takes. **Remove unused** drops the
  rows nothing uses (the ``remove_unused_assets`` op: one revision, one undo
  entry that restores them). Files are never deleted here: the sweep
  (:mod:`plastis3d_scene.sweep`) deletes a file only once no scene, undo entry or
  draft references it, so removing a row can never leave a dangling reference.

Stdlib only. Python 3.11-compatible.
"""

from __future__ import annotations

import base64
import json
import time
from pathlib import Path
from typing import Any

from .capture import png_dimensions
from .spec import MATERIAL_MAP_FIELDS, PlastisError, SCENE_ID_RE
from .store import Store

THUMB_MAX_BYTES = 512 * 1024
THUMB_MAX_EDGE = 512
THUMB_MIN_EDGE = 16


def thumbnails_dir(store: Store) -> Path:
    path = store.data_dir / "thumbnails"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _paths(store: Store, scene_id: str) -> tuple:
    if not isinstance(scene_id, str) or not SCENE_ID_RE.match(scene_id):
        raise PlastisError("SCENE_NOT_FOUND", "no scene with id %r" % (scene_id,))
    base = thumbnails_dir(store)
    return base / ("%s.png" % scene_id), base / ("%s.json" % scene_id)


def put_thumbnail(store: Store, scene_id: str, revision: Any, png: bytes) -> dict:
    """Store a scene's thumbnail. Refuses a PNG over the byte or size caps."""
    store.get_scene(scene_id)  # SCENE_NOT_FOUND
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
        raise PlastisError("SPEC_INVALID", "revision must be a positive integer", path="/revision")
    if len(png) > THUMB_MAX_BYTES:
        raise PlastisError("THUMBNAIL_INVALID", "a thumbnail is at most %d bytes" % THUMB_MAX_BYTES)
    width, height = png_dimensions(png)  # CAPTURE_INVALID on a bad PNG
    if max(width, height) > THUMB_MAX_EDGE or min(width, height) < THUMB_MIN_EDGE:
        raise PlastisError("THUMBNAIL_INVALID", "a thumbnail is %d to %d pixels a side" % (THUMB_MIN_EDGE, THUMB_MAX_EDGE))
    png_path, meta_path = _paths(store, scene_id)
    Store._atomic_write(png_path, png)
    Store._atomic_write(meta_path, json.dumps({"revision": revision, "savedAt": time.time(), "width": width, "height": height}).encode())
    return {"ok": True, "revision": revision, "bytes": len(png)}


def thumbnail_revision(store: Store, scene_id: str) -> Any:
    """The revision the stored thumbnail shows, or None."""
    try:
        _, meta_path = _paths(store, scene_id)
        return json.loads(meta_path.read_text(encoding="utf-8")).get("revision")
    except (OSError, ValueError, PlastisError):
        return None


def get_thumbnail(store: Store, scene_id: str) -> dict:
    png_path, meta_path = _paths(store, scene_id)
    try:
        data = png_path.read_bytes()
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise PlastisError("THUMBNAIL_NOT_FOUND", "this scene has no thumbnail yet") from None
    return {"ok": True, "revision": meta.get("revision"), "png": base64.b64encode(data).decode("ascii")}


def delete_thumbnail(store: Store, scene_id: str) -> None:
    try:
        for path in _paths(store, scene_id):
            try:
                path.unlink()
            except OSError:
                pass
    except PlastisError:
        pass


# --- the asset list ----------------------------------------------------------------------------------

def used_asset_ids(scene: dict) -> dict:
    """``{asset id: number of nodes and material slots that use it}`` for the live scene."""
    counts: dict = {}

    def bump(asset_id: Any) -> None:
        if isinstance(asset_id, str):
            counts[asset_id] = counts.get(asset_id, 0) + 1

    for node in scene.get("nodes", []):
        bump(node.get("modelAssetId"))
        bump(node.get("splatAssetId"))
        bump((node.get("generator") or {}).get("baseAssetId"))
    for material in scene.get("materials", []):
        for field in MATERIAL_MAP_FIELDS:
            value = material.get(field)
            if isinstance(value, dict):
                value = value.get("assetId")
            bump(value)
    return counts


def list_assets(scene: dict) -> dict:
    """The library view of one scene: every row, whether it is used, and what is unused."""
    used = used_asset_ids(scene)
    rows = []
    unused_bytes = 0
    for asset in scene.get("assets", []):
        count = used.get(asset["id"], 0)
        row = {
            "id": asset["id"],
            "name": asset.get("originalName") or asset["id"][:8],
            "format": asset.get("format"),
            "bytes": asset.get("bytes") or 0,
            "used": count > 0,
            "usedBy": count,
        }
        if count == 0:
            unused_bytes += row["bytes"]
        rows.append(row)
    return {
        "ok": True,
        "revision": scene["revision"],
        "assets": rows,
        "unused": sum(1 for r in rows if not r["used"]),
        "unusedBytes": unused_bytes,
    }


def remove_unused(store: Store, scene_id: str, base_revision: Any, dry_run: bool = False) -> dict:
    """Preview or apply "Remove unused". Returns the library view plus ``removed``/``applied``."""
    from . import mutate
    from .sweep import sweep_files

    scene = store.get_scene(scene_id)
    if not isinstance(base_revision, int) or isinstance(base_revision, bool):
        raise PlastisError("SPEC_INVALID", "baseRevision must be an integer", path="/baseRevision")
    if base_revision != scene["revision"]:
        raise PlastisError(
            "REVISION_CONFLICT",
            "scene is at revision %d, not %d" % (scene["revision"], base_revision),
            current_revision=scene["revision"],
        )
    view = list_assets(scene)
    unused = [row for row in view["assets"] if not row["used"]]
    result = dict(view, removed=[r["id"] for r in unused], applied=False)
    if dry_run or not unused:
        return result
    envelope = mutate.apply(scene_id, base_revision, {"op": "remove_unused_assets"}, store=store)
    sweep_files(store)  # a file goes only once no scene, undo entry or draft still references it
    after = list_assets(store.get_scene(scene_id))
    envelope.update({"library": after, "removed": result["removed"], "applied": True})
    return envelope
