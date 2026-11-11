"""Plastis3D — scene cleanup: prune and dedupe (PR18).

Three operations, one run, one undoable mutation:

``dedupe_materials``
    Materials that are identical in **every field except ``id``** (colour,
    emissive, metalness, roughness, opacity, double-sided, name, and each map)
    are merged into one: the first in the list, or ``m_default`` when it is one
    of them. Every node that used a duplicate is repointed to the keeper. The
    name is part of "identical" on purpose: two materials the author named
    differently are different materials, even if they look alike.
``prune_materials``
    Materials no mesh or part uses are removed, except ``m_default`` (the
    scene's fallback, which a new mesh and the editor assume exists). The image
    assets an unused material pointed at stay in the scene's asset list and on
    disk; the asset sweep is PR24's.
``prune_groups``
    Groups with nothing in them are removed, repeatedly, so a group that
    holds only empty groups goes too. A group that holds any node, of any kind,
    stays. An empty group is one the author left with nothing inside; a pivot
    the author wants to keep should have something in it.

``weld`` (PR19, explicit only: it is not in the default set)
    Imported mesh data: merges vertices whose complete attribute records are
    equal (so UV seams and hard normal edges survive) and drops degenerate
    triangles, writing a **new** model asset and repointing every node that used
    the old one. See :mod:`plastis3d_scene.weld` for the rules. Analytic
    primitives are skipped and listed (C-19); a model with skins, animations or
    morph targets is skipped and listed (C-11). The old asset's bytes stay on
    disk until the asset sweep (C-03).

Nothing else is touched: no decimation, no imported file in place. Locked ``model`` nodes and ``part`` nodes keep their ids and
transforms; only their ``materialId`` may be repointed by a dedupe.

The pure core, :func:`apply_cleanup`, returns the new scene and what changed;
``mutate`` runs it inside the scene lock as the ``cleanup`` op, and
:func:`run` adds the preview (dry run) and the revision check. Stdlib only.
"""

from __future__ import annotations

import copy
import json
from typing import Any, Optional

from .asset_transactions import pin_scene
from .spec import DEFAULT_MATERIAL_ID, PlastisError

OPERATIONS = ("dedupe_materials", "prune_materials", "prune_groups", "weld")
# Order matters: merging first leaves the pruning with the true picture.
_ORDER = ("dedupe_materials", "prune_materials", "prune_groups", "weld")
# What "all" means when no operations are named. Weld is never implied: it
# rewrites mesh data, so it has to be asked for.
DEFAULT_OPERATIONS = ("dedupe_materials", "prune_materials", "prune_groups")


def normalize_operations(operations: Any) -> list:
    """The operations to run, in the fixed order. ``None`` means the three
    that do not touch mesh data; ``weld`` has to be named."""
    if operations is None:
        return list(DEFAULT_OPERATIONS)
    if not isinstance(operations, list) or not operations:
        raise PlastisError("SPEC_INVALID", "operations must be a non-empty list", path="/operations")
    for name in operations:
        if name not in OPERATIONS:
            raise PlastisError(
                "SPEC_INVALID",
                "unknown cleanup operation %r; use %s" % (name, ", ".join(OPERATIONS)),
                path="/operations",
            )
    return [name for name in _ORDER if name in operations]


def _signature(material: dict) -> str:
    return json.dumps({k: v for k, v in material.items() if k != "id"}, sort_keys=True)


def apply_cleanup(scene: dict, operations: Any = None, welds: Optional[dict] = None) -> tuple:
    """``(new_scene, changes)``: the scene after the operations, and what they did.

    ``changes`` is ``{"materialsMerged": [{"from", "into"}], "materialsRemoved":
    [ids], "groupsRemoved": [{"id", "name"}], "nodesRepointed": [ids],
    "assetsWelded": [report], "weldSkipped": [{"what", "reason"}]}``. The input
    is not modified. ``welds`` is the plan :func:`plan_welds` made (new asset
    rows and reports); it is only read when ``weld`` is among the operations.
    """
    ops = normalize_operations(operations)
    new_scene = copy.deepcopy(scene)
    changes = {
        "materialsMerged": [],
        "materialsRemoved": [],
        "groupsRemoved": [],
        "nodesRepointed": [],
        "assetsWelded": [],
        "weldSkipped": [],
    }
    nodes = new_scene.get("nodes", [])
    materials = new_scene.get("materials", [])

    if "dedupe_materials" in ops:
        groups: dict = {}
        for material in materials:
            groups.setdefault(_signature(material), []).append(material)
        redirect: dict = {}
        for group in groups.values():
            if len(group) < 2:
                continue
            keeper = next((m for m in group if m["id"] == DEFAULT_MATERIAL_ID), group[0])
            for material in group:
                if material is not keeper:
                    redirect[material["id"]] = keeper["id"]
                    changes["materialsMerged"].append({"from": material["id"], "into": keeper["id"]})
        if redirect:
            for node in nodes:
                target = redirect.get(node.get("materialId"))
                if target is not None:
                    node["materialId"] = target
                    changes["nodesRepointed"].append(node["id"])
            new_scene["materials"] = materials = [m for m in materials if m["id"] not in redirect]

    if "prune_materials" in ops:
        used = {n.get("materialId") for n in nodes if n.get("kind") in ("mesh", "part") and n.get("materialId")}
        unused = [m["id"] for m in materials if m["id"] not in used and m["id"] != DEFAULT_MATERIAL_ID]
        if unused:
            drop = set(unused)
            new_scene["materials"] = materials = [m for m in materials if m["id"] not in drop]
            changes["materialsRemoved"] = unused

    if "prune_groups" in ops:
        remaining = list(nodes)
        removed: list = []
        while True:
            parents = {n.get("parent") for n in remaining if n.get("parent") is not None}
            empty = [n for n in remaining if n.get("kind") == "group" and n["id"] not in parents]
            if not empty:
                break
            gone = {n["id"] for n in empty}
            removed.extend(empty)
            remaining = [n for n in remaining if n["id"] not in gone]
        if removed:
            new_scene["nodes"] = remaining
            changes["groupsRemoved"] = [{"id": n["id"], "name": n.get("name")} for n in removed]

    if "weld" in ops and welds:
        changes["weldSkipped"] = list(welds.get("skipped", []))
        for old_id, planned in (welds.get("assets") or {}).items():
            row = planned["row"]
            if not any(a.get("id") == old_id for a in new_scene.get("assets", [])):
                continue
            moved = [n for n in new_scene.get("nodes", []) if n.get("modelAssetId") == old_id]
            for node in moved:
                node["modelAssetId"] = row["id"]
            assets = [a for a in new_scene["assets"] if a.get("id") != old_id]
            if not any(a.get("id") == row["id"] for a in assets):
                assets.append(copy.deepcopy(row))
            new_scene["assets"] = assets
            changes["assetsWelded"].append(dict(planned["report"], nodes=[n["id"] for n in moved]))
    return new_scene, changes


def is_empty(changes: dict) -> bool:
    return not any(
        changes[key] for key in ("materialsMerged", "materialsRemoved", "groupsRemoved", "assetsWelded")
    )


def plan_welds(scene: dict, store: Any, *, asset_id: Optional[str] = None, timeout: float = 25.0) -> dict:
    """Weld the scene's imported models, outside any lock (the work is heavy).

    Returns ``{"assets": {old_id: {"row", "report", "bytes"}}, "skipped": [...]}``.
    Nothing is written: ``bytes`` are the new GLBs for the caller to store. A
    model the weld cannot or need not change is left out and, when it is a
    reason the author should know, listed under ``skipped``.
    """
    import hashlib
    import time

    from . import weld as _weld

    deadline = time.monotonic() + timeout
    assets = {a.get("id"): a for a in scene.get("assets", [])}
    used: list = []
    for node in scene.get("nodes", []):
        if node.get("kind") in ("model", "part") and node.get("modelAssetId") in assets:
            if node["modelAssetId"] not in used:
                used.append(node["modelAssetId"])
    if asset_id is not None:
        if asset_id not in assets or assets[asset_id].get("format") != "glb":
            raise PlastisError("ASSET_NOT_FOUND", "the scene has no model asset %r" % asset_id)
        used = [asset_id] if asset_id in used else []
    plan: dict = {"assets": {}, "skipped": []}
    primitives = sum(1 for n in scene.get("nodes", []) if n.get("kind") == "mesh")
    if primitives and asset_id is None:
        plan["skipped"].append(
            {
                "what": "%d primitive shape%s" % (primitives, "" if primitives == 1 else "s"),
                "reason": "built-in shapes have deliberate seams, so they are left alone",
            }
        )
    for old_id in used:
        asset = assets[old_id]
        label = asset.get("originalName") or old_id
        if asset.get("format") != "glb":
            continue
        path = store.assets_dir / ("%s.glb" % asset.get("sha256"))
        try:
            data = path.read_bytes()
        except OSError:
            plan["skipped"].append({"what": label, "reason": "its stored file is missing"})
            continue
        if hashlib.sha256(data).hexdigest() != asset.get("sha256"):
            plan["skipped"].append({"what": label, "reason": "its stored file changed since import"})
            continue
        result = _weld.weld_asset(data, deadline)
        if result["status"] == "skipped":
            plan["skipped"].append({"what": label, "reason": result["reason"]})
            continue
        if result["status"] == "unchanged":
            if result.get("primitives_skipped"):
                plan["skipped"].append({"what": label, "reason": result["reason"]})
            continue
        new_bytes = result["bytes"]
        sha = hashlib.sha256(new_bytes).hexdigest()
        scan_stats = dict(result["scan"].stats)
        stats = dict(asset.get("stats") or {})
        stats.update(scan_stats)
        for key in ("ignored", "internals"):
            if (asset.get("stats") or {}).get(key) is not None:
                stats[key] = (asset["stats"])[key]
            else:
                stats.pop(key, None) if key not in scan_stats else None
        row = dict(asset, id=sha, sha256=sha, file="assets/%s.glb" % sha, format="glb", bytes=len(new_bytes), stats=stats)
        plan["assets"][old_id] = {
            "row": row,
            "bytes": new_bytes,
            "report": {
                "assetId": old_id,
                "newAssetId": sha,
                "name": label,
                "verticesRemoved": result["vertices_removed"],
                "trianglesRemoved": result["triangles_removed"],
                "primitivesChanged": result["primitives_changed"],
                "bytesBefore": asset.get("bytes"),
                "bytesAfter": len(new_bytes),
                "drawableBefore": result["drawable_before"],
                "drawableAfter": scan_stats.get("drawable") is True,
                "becameDrawable": not result["drawable_before"] and scan_stats.get("drawable") is True,
            },
        }
    return plan


def summarize(changes: dict) -> list:
    """Plain sentences for what the changes are (the preview and the agent)."""
    out = []
    merged = len(changes["materialsMerged"])
    if merged:
        out.append("Merge %d identical material%s into the first of each." % (merged, "" if merged == 1 else "s"))
    removed = len(changes["materialsRemoved"])
    if removed:
        out.append("Remove %d unused material%s." % (removed, "" if removed == 1 else "s"))
    groups = len(changes["groupsRemoved"])
    if groups:
        out.append("Remove %d empty group%s." % (groups, "" if groups == 1 else "s"))
    for welded in changes["assetsWelded"]:
        parts = []
        if welded["verticesRemoved"]:
            parts.append("%d duplicate vertices" % welded["verticesRemoved"])
        if welded["trianglesRemoved"]:
            parts.append("%d empty triangles" % welded["trianglesRemoved"])
        out.append("Weld %s: remove %s." % (welded["name"], " and ".join(parts) or "nothing"))
    return out or ["Nothing to tidy up."]


@pin_scene
def run(
    scene_id: str,
    store: Any,
    base_revision: int,
    operations: Any = None,
    *,
    dry_run: bool = False,
    origin: str = "ui",
    asset_id: Optional[str] = None,
) -> dict:
    """Preview or apply a cleanup; returns the feedback envelope plus ``cleanup``.

    ``dry_run`` and a scene with nothing to tidy write nothing and keep the
    revision. Otherwise one ``cleanup`` mutation runs through
    :func:`mutate.apply`: one revision, one history entry. A stale
    ``base_revision`` is ``REVISION_CONFLICT`` either way.
    """
    from . import mutate  # local: mutate imports this module

    ops = normalize_operations(operations)
    scene = store.get_scene(scene_id)
    if not isinstance(base_revision, int) or isinstance(base_revision, bool):
        raise PlastisError("SPEC_INVALID", "baseRevision must be an integer", path="/baseRevision")
    if base_revision != scene["revision"]:
        raise PlastisError(
            "REVISION_CONFLICT",
            "scene is at revision %d, not %d" % (scene["revision"], base_revision),
            current_revision=scene["revision"],
        )
    welds = plan_welds(scene, store, asset_id=asset_id) if "weld" in ops else None
    _, changes = apply_cleanup(scene, ops, welds)
    info = {"operations": ops, "dryRun": dry_run, "changes": changes, "summary": summarize(changes)}
    if dry_run or is_empty(changes):
        info["applied"] = False
        envelope = store.envelope(scene)
    else:
        carried = None
        if welds and welds["assets"]:
            # The new files go on disk before the scene points at them; a refusal
            # later leaves an unreferenced file for the sweep, never a dangling row.
            carried = {
                "skipped": welds["skipped"],
                "assets": {k: {"row": v["row"], "report": v["report"]} for k, v in welds["assets"].items()},
            }
        mutation = {"op": "cleanup", "operations": ops}
        if carried is not None:
            mutation["welds"] = carried
        from .asset_transactions import AssetOperation
        from .import_model import MAX_ASSET_QUOTA_BYTES
        files = {planned["row"]["id"] + ".glb": planned["bytes"] for planned in (welds or {}).get("assets", {}).values()}
        with AssetOperation(store, assets=scene.get("assets", []), files=files, quota=MAX_ASSET_QUOTA_BYTES):
            envelope = mutate.apply(scene_id, base_revision, mutation, store=store, origin=origin)
        info["applied"] = True
    envelope["cleanup"] = info
    return envelope
