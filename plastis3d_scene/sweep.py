"""Plastis3D — the asset sweep core (PR24, C-03 / D-EXT-07 §3).

Assets are content-addressed and shared across scenes, and nothing used to
remove them. Two things are swept, in two places:

* **Rows** — a scene's ``assets`` rows that nothing in the scene can reach.
  This runs *inside* the transaction of a bake and whenever history entries
  are dropped, so the scene stays consistent in one revision and the 64-asset
  cap counts only geometry the scene or its undo history can still reach.
* **Files** — ``assets/<sha>.*`` files that **no scene** references. This runs
  *after* the commit, under the asset lock, and deletes only files older than
  a grace period, so an import that has written its file but not yet
  committed its row (an in-flight import) is never collected.

Reachability is deliberately an over-approximation: an asset id is a 64-hex
sha256, so a row is reachable when that id appears anywhere in the scene's
nodes (``modelAssetId``, ``generator.baseAssetId``), materials (texture maps),
or history (undo and redo entries, node snapshots and asset patches). A false
"reachable" keeps a file a little longer; a false "unreachable" would delete
user data, so the scan never trusts a narrower rule.

Lock order (C-03): the asset lock is taken before any scene lock.

Stdlib only. Python 3.11-compatible.
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any, Iterable, Optional

_HEX64 = re.compile(r"[0-9a-f]{64}")

# A file this young may belong to an import that has not committed yet.
FILE_GRACE_SECONDS = 600.0


def _tokens(*parts: Any) -> set:
    found: set = set()
    for part in parts:
        if part is None:
            continue
        found.update(_HEX64.findall(json.dumps(part, separators=(",", ":"))))
    return found


def reachable_asset_ids(scene: dict, extra_history: Iterable[dict] = ()) -> set:
    """Asset ids the scene can reach (nodes, materials, history, ``extra_history``)."""
    history = scene.get("history") or {}
    return _tokens(
        scene.get("nodes"),
        scene.get("materials"),
        history.get("undo"),
        history.get("redo"),
        list(extra_history),
    )


def sweep_rows(scene: dict, extra_history: Iterable[dict] = ()) -> list:
    """Remove unreachable asset rows from ``scene`` in place; return their ids."""
    keep = reachable_asset_ids(scene, extra_history)
    removed = [row["id"] for row in scene.get("assets", []) if row.get("id") not in keep]
    if removed:
        gone = set(removed)
        scene["assets"] = [row for row in scene.get("assets", []) if row.get("id") not in gone]
    return removed


def _asset_file_sha(path: Path) -> Optional[str]:
    stem = path.name.split(".", 1)[0]
    return stem if _HEX64.fullmatch(stem) else None


def referenced_everywhere(store: Any) -> set:
    """Every asset id any scene still references: rows, nodes, materials, history, drafts."""
    found: set = set()
    for path in store.scenes_dir.glob("*.json"):
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        found.update(_HEX64.findall(text))
    drafts = store.data_dir / "drafts"
    if drafts.is_dir():
        for path in drafts.rglob("*.json"):
            try:
                found.update(_HEX64.findall(path.read_text(encoding="utf-8")))
            except OSError:
                continue
    return found


def sweep_files(store: Any, now: Optional[float] = None, grace: float = FILE_GRACE_SECONDS) -> list:
    """Delete asset files that no scene references. Returns the names deleted.

    Takes the asset lock. A scene's own ``assets`` rows count as references, so
    a file goes only after every scene has dropped its row (by a sweep, or by
    deleting the scene). Files younger than ``grace`` are never touched.
    """
    now = time.time() if now is None else now
    deleted: list = []
    with store.asset_lock():
        from .asset_transactions import active_asset_ids_locked
        keep = referenced_everywhere(store) | active_asset_ids_locked(store)
        for path in store.assets_dir.iterdir():
            sha = _asset_file_sha(path)
            if sha is None or not path.is_file() or sha in keep:
                continue
            try:
                if now - path.stat().st_mtime < grace:
                    continue
                path.unlink()
            except OSError:
                continue
            deleted.append(path.name)
    return deleted


def sweep_after_commit(store):
    """Best-effort maintenance cannot turn an already committed write into failure."""
    from .spec import PlastisError
    try:
        return sweep_files(store)
    except PlastisError as error:
        if error.code != 'STORE_BUSY':
            raise
        return []  # Conservative retention; a later sweep retries.
