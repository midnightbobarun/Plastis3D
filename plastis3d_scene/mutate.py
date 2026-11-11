"""Plastis3D — mutation core (PR3, Stage 2).

The single writer of scene JSON, shared by the agent tools
(``plastis3d_scene.tools``) and the gateway (``dashboard/plugin_api.py``,
``PATCH /scenes/{id}``).

Every mutation goes through :class:`plastis3d_scene.store.Store.write_scene`
— the revision check, the OS lock, and the atomic replace live there,
never here. This module only computes the post-mutation document and the
one history entry for it, then hands both to the store.

Ops (standalone-editor.md, Mutation core):

* ``create`` — new scene file + default rig, no ``baseRevision``.
* ``build`` — replace nodes/materials, keep asset rows, re-add
  ``light_key``/``cam_main`` when the payload lacks them.
* ``add_node`` / ``update_node`` / ``set_material`` / ``duplicate_node`` /
  ``delete_node`` / ``import_asset`` / ``undo`` / ``redo``.
* ``delete_material`` — extra op (no tool exposes it): deletes a material
  only when nothing references it; a referenced delete is ``SPEC_INVALID``
  at ``/materials/<id>``, per the design's Materials rule. ``build``
  dropping a material the new nodes still reference is caught by the
  validator instead (unknown ``materialId`` on the node).
* A ``PATCH`` batch (``apply_patch``) folds up to 32 ops into one history
  entry and one revision increment.

History maps carry ``null`` for absent ids. ``undo``/``redo`` pop one
stack and push the swapped entry onto the other; the store's
``history_override`` path is what makes that possible — a plain
``write_scene`` call always appends to undo and clears redo, which is
correct for every op except undo/redo.

Broadcast: after a successful commit,
``broadcast_plugin_event("plastis3d", "scene.changed", {"scene": id,
"revision": rev})``. The broadcast is best-effort: in a process with no
gateway (``hermes chat``, cron, plain pytest, ``validate``) the import
or the call logs a warning and the tool still returns.

Part nodes pass through unchanged — they are nodes. ``duplicate_node``
on a part makes a new part node with the same ``modelAssetId`` /
``meshIndex`` / ``primitiveIndex`` and its own transform;
``delete_node`` on a part removes just that part and the asset row
stays. ``duplicate_node`` on a model keeps ``kind=model`` and the same
``modelAssetId`` (same sha256 bytes) with its own transform.

Stdlib only. Python 3.11-compatible.
"""

from __future__ import annotations

from contextvars import ContextVar
import copy
import logging
from typing import Any, Optional

from .spec import (
    MATERIAL_MAP_FIELDS,
    MAX_NODES,
    MAX_OPS_PER_PATCH,
    PlastisError,
    new_material_id,
    new_node_id,
    now_iso,
)
from .store import Store
from .validate import validate_scene

EVENT_ORIGIN = ContextVar("plastis3d_event_origin", default="ui")
logger = logging.getLogger(__name__)

# Ops a PATCH batch may contain. ``create`` has no scene yet, and
# ``undo``/``redo`` inside a batch would be incoherent (a batch is one
# history entry); both are rejected with SPEC_INVALID. ``import_asset``
# is not patchable either: it attaches an asset row that only the
# import engine's scan may produce (``import_model.import_bytes`` calls
# ``apply`` directly). A PATCH could otherwise attach an unscanned row
# with made-up stats (pre-PR9 completion plan, audit A-2).
_PATCHABLE_OPS = {
    "set_scene_name",
    "build",
    "add_node",
    "update_node",
    "set_material",
    "duplicate_node",
    "delete_node",
    "delete_material",
}


# --- Broadcast ---------------------------------------------------------------

def broadcast(event: str, payload: dict) -> None:
    """Fire-and-forget plugin event; a missing gateway is a logged no-op.

    The sanctioned door is ``hermes_cli.plugin_events`` (PR1 spike §4.4:
    delivered gateway-hosted; without a gateway a logged no-op, no
    crash). The import is lazy so this module stays importable in a
    plain-Python process that has no Hermes install.
    """
    try:
        from hermes_cli.plugin_events import broadcast_plugin_event
    except Exception:
        logger.warning(
            "plastis3d: broadcast %s not delivered (no hermes_cli in this process)",
            event,
        )
        return
    try:
        broadcast_plugin_event("plastis3d", event, dict(payload))
    except Exception:
        logger.warning("plastis3d: broadcast %s failed", event, exc_info=True)


def _broadcast_scene_changed(scene_id: str, revision: int, origin: str = "ui") -> None:
    broadcast("scene.changed", {"scene": scene_id, "revision": revision, "origin": "tool" if EVENT_ORIGIN.get() == "tool" else origin})


# --- Small helpers -----------------------------------------------------------

def _require_base_revision(base_revision: Any) -> int:
    if not isinstance(base_revision, int) or isinstance(base_revision, bool):
        raise PlastisError(
            "SPEC_INVALID", "baseRevision must be an integer", path="/baseRevision"
        )
    return base_revision


def _node_by_id(scene: dict, node_id: str) -> Optional[dict]:
    for node in scene.get("nodes", []):
        if node.get("id") == node_id:
            return node
    return None


def _material_by_id(scene: dict, material_id: str) -> Optional[dict]:
    for material in scene.get("materials", []):
        if material.get("id") == material_id:
            return material
    return None


def _subtree_ids(scene: dict, root_id: str) -> list:
    """``root_id`` plus every descendant (transitive parent chain)."""
    children: dict = {}
    for node in scene.get("nodes", []):
        children.setdefault(node.get("parent"), []).append(node.get("id"))
    result = [root_id]
    stack = [root_id]
    while stack:
        current = stack.pop()
        for child in children.get(current, []):
            result.append(child)
            stack.append(child)
    return result


def _history_entry(label: str, undo: dict, redo: dict) -> dict:
    entry: dict = {"label": label, "at": now_iso()}
    if undo:
        entry["undo"] = undo
    if redo:
        entry["redo"] = redo
    return entry


def _apply_history_maps(scene: dict, maps: dict) -> dict:
    """Apply one history side's maps to a scene dict (in place, returned).

    A value of ``None`` removes the id; an object upserts it (replace in
    place when present, else append). Missing map kinds are empty.
    """
    for kind, id_map in (maps or {}).items():
        if kind == "scene":
            scene["name"] = id_map["name"]
            continue
        if kind not in ("nodes", "materials", "assets"):
            continue
        rows = scene.get(kind, [])
        by_id = {row.get("id"): row for row in rows}
        for row_id, value in (id_map or {}).items():
            if value is None:
                if row_id in by_id:
                    rows = [r for r in rows if r.get("id") != row_id]
                    by_id.pop(row_id, None)
            else:
                replacement = copy.deepcopy(value)
                if row_id in by_id:
                    rows = [
                        replacement if r.get("id") == row_id else r for r in rows
                    ]
                else:
                    rows.append(replacement)
                by_id[row_id] = replacement
        scene[kind] = rows
    return scene


def _merge_history(
    combined_undo: dict, combined_redo: dict, entry: dict
) -> None:
    """Fold one op's history entry into a PATCH's combined entry.

    Undo is first-wins per id (the state before the batch); redo is
    last-wins per id (the state after the batch).
    """
    for side, combined in (("undo", combined_undo), ("redo", combined_redo)):
        for kind, id_map in (entry.get(side) or {}).items():
            target = combined.setdefault(kind, {})
            for row_id, value in (id_map or {}).items():
                if side == "undo":
                    target.setdefault(row_id, copy.deepcopy(value))
                else:
                    target[row_id] = copy.deepcopy(value)


def _unique_node_id(scene: dict, taken: Optional[set] = None) -> str:
    taken = set(taken) if taken is not None else {n.get("id") for n in scene.get("nodes", [])}
    while True:
        candidate = new_node_id()
        if candidate not in taken:
            taken.add(candidate)
            return candidate


def _unique_material_id(scene: dict, taken: Optional[set] = None) -> str:
    taken = set(taken) if taken is not None else {m.get("id") for m in scene.get("materials", [])}
    while True:
        candidate = new_material_id()
        if candidate not in taken:
            taken.add(candidate)
            return candidate


def _normalize_node(node: dict, scene: dict, taken: Optional[set] = None) -> dict:
    """Fill server defaults on a node dict (parent null, visible true)."""
    node = copy.deepcopy(node)
    node.setdefault("parent", None)
    node.setdefault("visible", True)
    if not node.get("id"):
        node["id"] = _unique_node_id(scene, taken)
    elif taken is not None:
        taken.add(node["id"])
    return node


def _normalize_material(material: dict, scene: dict, taken: Optional[set] = None) -> dict:
    """Fill server defaults on a material dict (validator requires id+color)."""
    material = copy.deepcopy(material)
    if not material.get("id"):
        material["id"] = _unique_material_id(scene, taken)
    elif taken is not None:
        taken.add(material["id"])
    material.setdefault("emissive", "#000000")
    material.setdefault("metalness", 0.0)
    material.setdefault("roughness", 0.6)
    material.setdefault("opacity", 1.0)
    material.setdefault("doubleSide", False)
    return material


def _check_not_model_or_part(node: dict, index: int) -> None:
    kind = node.get("kind")
    if kind in ("model", "part", "splat"):
        raise PlastisError(
            "SPEC_INVALID",
            "kind=%s nodes enter only through plastis3d_import_model" % kind,
            path="/nodes/%d/kind" % index,
        )


# --- Per-op pure transformations ---------------------------------------------
# Each takes a scene dict (never mutated in place — a deepcopy is made)
# and returns (new_scene, history_entry, defaults_added).


def _op_set_scene_name(scene: dict, mutation: dict) -> tuple:
    name = mutation.get("name")
    if not isinstance(name, str) or not name.strip() or len(name) > 80:
        raise PlastisError("SPEC_INVALID", "scene name must be 1 to 80 characters", path="/name")
    old = scene["name"]
    scene["name"] = name.strip()
    return scene, _history_entry("Rename scene", {"scene": {"name": old}}, {"scene": {"name": scene["name"]}}), []


def _op_build(scene: dict, mutation: dict) -> tuple:
    old_nodes = {n["id"]: n for n in scene.get("nodes", [])}
    old_materials = {m["id"]: m for m in scene.get("materials", [])}
    nodes_in = mutation.get("nodes")
    if not isinstance(nodes_in, list):
        raise PlastisError("SPEC_INVALID", "build requires a nodes array", path="/nodes")
    # "materials?" is optional: omitted keeps the scene's current
    # materials (so a payload that only replaces nodes can still
    # reference m_default). An explicit list — even an empty one —
    # replaces them.
    if "materials" in mutation and mutation.get("materials") is not None:
        materials_in = mutation["materials"]
    else:
        materials_in = copy.deepcopy(scene.get("materials", []))
    if not isinstance(materials_in, list):
        raise PlastisError(
            "SPEC_INVALID", "build materials must be an array", path="/materials"
        )
    nodes = []
    taken_nodes = {n.get("id") for n in scene.get("nodes", [])}
    for index, node in enumerate(nodes_in):
        if not isinstance(node, dict):
            raise PlastisError(
                "SPEC_INVALID", "node must be an object", path="/nodes/%d" % index
            )
        _check_not_model_or_part(node, index)
        nodes.append(_normalize_node(node, scene, taken_nodes))
    taken_materials = {m.get("id") for m in scene.get("materials", [])}
    materials = [
        _normalize_material(m, scene, taken_materials)
        for m in materials_in
        if isinstance(m, dict)
    ]
    if len(materials) != len(materials_in):
        raise PlastisError(
            "SPEC_INVALID", "material must be an object", path="/materials"
        )
    defaults_added = []
    new_scene = copy.deepcopy(scene)
    new_scene["nodes"] = nodes
    new_scene["materials"] = materials
    if mutation.get("name") is not None:
        name = mutation["name"]
        if not isinstance(name, str) or not name.strip():
            raise PlastisError(
                "SPEC_INVALID", "scene name must be a non-empty string", path="/name"
            )
        new_scene["name"] = name
    # Assets stay exactly as they were; build never puts them in the maps.
    new_nodes = {n["id"]: n for n in nodes}
    new_materials = {m["id"]: m for m in materials}
    undo_nodes = {
        nid: copy.deepcopy(old_nodes.get(nid))
        for nid in set(old_nodes) | set(new_nodes)
    }
    redo_nodes = {
        nid: copy.deepcopy(new_nodes.get(nid))
        for nid in set(old_nodes) | set(new_nodes)
    }
    undo_materials = {
        mid: copy.deepcopy(old_materials.get(mid))
        for mid in set(old_materials) | set(new_materials)
    }
    redo_materials = {
        mid: copy.deepcopy(new_materials.get(mid))
        for mid in set(old_materials) | set(new_materials)
    }
    entry = _history_entry(
        "build",
        {"nodes": undo_nodes, "materials": undo_materials},
        {"nodes": redo_nodes, "materials": redo_materials},
    )
    return new_scene, entry, defaults_added


def _op_add_node(scene: dict, mutation: dict) -> tuple:
    node_in = mutation.get("node")
    if not isinstance(node_in, dict):
        raise PlastisError("SPEC_INVALID", "add_node requires a node object", path="/node")
    _check_not_model_or_part(node_in, 0)
    node = _normalize_node(node_in, scene)
    if _node_by_id(scene, node["id"]) is not None:
        raise PlastisError(
            "SPEC_INVALID",
            "node id %r already exists" % node["id"],
            path="/nodes",
        )
    new_scene = copy.deepcopy(scene)
    new_scene["nodes"] = list(scene.get("nodes", [])) + [node]
    entry = _history_entry(
        "add_node %s" % node["id"],
        {"nodes": {node["id"]: None}},
        {"nodes": {node["id"]: copy.deepcopy(node)}},
    )
    return new_scene, entry, []


def _op_update_node(scene: dict, mutation: dict) -> tuple:
    node_id = mutation.get("id")
    changes = mutation.get("changes")
    if isinstance(changes, dict):
        fields = dict(changes)
    else:
        fields = {
            key: value
            for key, value in mutation.items()
            if key not in ("op", "id", "changes")
        }
    if not isinstance(node_id, str) or not node_id:
        raise PlastisError("SPEC_INVALID", "update_node requires an id", path="/id")
    old = _node_by_id(scene, node_id)
    if old is None:
        raise PlastisError("NODE_NOT_FOUND", "no node with id %r" % node_id)
    if "kind" in fields and fields["kind"] != old.get("kind"):
        raise PlastisError(
            "SPEC_INVALID",
            "update_node cannot change kind (was %r)" % old.get("kind"),
            path="/nodes/%s/kind" % node_id,
        )
    kind = old.get("kind")
    # A model node is opaque: only name/parent/visible/transform move.
    # Anything structural aimed at it is NODE_LOCKED.
    if kind in ("model", "splat"):
        for key in fields:
            if key not in ("name", "parent", "visible", "transform"):
                raise PlastisError(
                    "NODE_LOCKED",
                    "MODEL_MATERIAL_OPAQUE: model node %r is opaque; "
                    "only name, parent, visible, and transform can change" % node_id,
                )
    elif kind == "part":
        for key in fields:
            if key in ("primitive", "light", "camera"):
                raise PlastisError(
                    "SPEC_INVALID",
                    "part node %r has no %s" % (node_id, key),
                    path="/nodes/%s/%s" % (node_id, key),
                )
    elif kind == "mesh":
        for key in fields:
            if key in ("light", "camera"):
                raise PlastisError(
                    "SPEC_INVALID",
                    "mesh node %r has no %s" % (node_id, key),
                    path="/nodes/%s/%s" % (node_id, key),
                )
    elif kind == "light":
        for key in fields:
            if key in ("primitive", "camera", "materialId"):
                raise PlastisError(
                    "SPEC_INVALID",
                    "light node %r has no %s" % (node_id, key),
                    path="/nodes/%s/%s" % (node_id, key),
                )
    elif kind == "camera":
        for key in fields:
            if key in ("primitive", "light", "materialId"):
                raise PlastisError(
                    "SPEC_INVALID",
                    "camera node %r has no %s" % (node_id, key),
                    path="/nodes/%s/%s" % (node_id, key),
                )
    elif kind == "group":
        for key in fields:
            if key in ("primitive", "light", "camera", "materialId"):
                raise PlastisError(
                    "SPEC_INVALID",
                    "group node %r has no %s" % (node_id, key),
                    path="/nodes/%s/%s" % (node_id, key),
                )
    new_node = copy.deepcopy(old)
    for key, value in fields.items():
        if key == "kind":
            continue
        if key == "primitive" and isinstance(value, dict) and isinstance(
            old.get("primitive"), dict
        ):
            # Merge params over the existing primitive; a new "type"
            # replaces the whole primitive object.
            if value.get("type", old["primitive"].get("type")) == old["primitive"].get("type"):
                merged = dict(old["primitive"])
                merged.update({k: v for k, v in value.items() if k != "type"})
                new_node["primitive"] = merged
            else:
                new_node["primitive"] = copy.deepcopy(value)
        elif key in ("light", "camera") and isinstance(value, dict) and isinstance(
            old.get(key), dict
        ):
            merged = dict(old[key])
            merged.update(value)
            new_node[key] = merged
        else:
            new_node[key] = copy.deepcopy(value)
    new_scene = copy.deepcopy(scene)
    new_scene["nodes"] = [
        new_node if n.get("id") == node_id else n for n in scene.get("nodes", [])
    ]
    entry = _history_entry(
        "update_node %s" % node_id,
        {"nodes": {node_id: copy.deepcopy(old)}},
        {"nodes": {node_id: copy.deepcopy(new_node)}},
    )
    return new_scene, entry, []


def _op_set_material(scene: dict, mutation: dict) -> tuple:
    material_in = mutation.get("material")
    if not isinstance(material_in, dict):
        raise PlastisError(
            "SPEC_INVALID", "set_material requires a material object", path="/material"
        )
    assign_to = mutation.get("assignTo", [])
    if assign_to is None:
        assign_to = []
    if not isinstance(assign_to, list) or not all(
        isinstance(v, str) for v in assign_to
    ):
        raise PlastisError(
            "SPEC_INVALID", "assignTo must be an array of node ids", path="/assignTo"
        )
    material_id = material_in.get("id")
    existing = _material_by_id(scene, material_id) if material_id else None
    if existing is not None:
        material = copy.deepcopy(existing)
        for key, value in material_in.items():
            if key == "id":
                continue
            if key in MATERIAL_MAP_FIELDS and value in (None, []):
                material.pop(key, None)  # clearing a map removes the key
            else:
                material[key] = copy.deepcopy(value)
        _lift_black_emissive(material, material_in)
        old_material = copy.deepcopy(existing)
    else:
        if material_in.get("color") is None:
            raise PlastisError(
                "SPEC_INVALID",
                "a new material requires a color",
                path="/material/color",
            )
        material = _normalize_material(material_in, scene)
        old_material = None
        material_id = material["id"]
    # Resolve assignments before touching anything: a model target or a
    # missing id fails the whole mutation, nothing is written.
    targets = []
    for target_id in assign_to:
        node = _node_by_id(scene, target_id)
        if node is None:
            raise PlastisError(
                "NODE_NOT_FOUND", "no node with id %r" % target_id
            )
        if node.get("kind") == "model":
            raise PlastisError(
                "NODE_LOCKED",
                "MODEL_MATERIAL_OPAQUE: cannot set a material on model node "
                "%r; recolor its part nodes instead" % target_id,
            )
        if node.get("kind") not in ("mesh", "part"):
            raise PlastisError(
                "SPEC_INVALID",
                "cannot assign a material to a %s node %r"
                % (node.get("kind"), target_id),
                path="/nodes/%s" % target_id,
            )
        targets.append(node)
    new_scene = copy.deepcopy(scene)
    if existing is not None:
        new_scene["materials"] = [
            material if m.get("id") == material_id else m
            for m in scene.get("materials", [])
        ]
    else:
        new_scene["materials"] = list(scene.get("materials", [])) + [material]
    undo_nodes: dict = {}
    redo_nodes: dict = {}
    for node in targets:
        old_node = copy.deepcopy(node)
        new_node = copy.deepcopy(node)
        new_node["materialId"] = material_id
        new_scene["nodes"] = [
            new_node if n.get("id") == node["id"] else n
            for n in new_scene["nodes"]
        ]
        undo_nodes[node["id"]] = old_node
        redo_nodes[node["id"]] = new_node
    undo: dict = {"materials": {material_id: old_material}}
    redo: dict = {"materials": {material_id: copy.deepcopy(material)}}
    if undo_nodes:
        undo["nodes"] = undo_nodes
        redo["nodes"] = redo_nodes
    entry = _history_entry("set_material %s" % material_id, undo, redo)
    return new_scene, entry, []


def _lift_black_emissive(material: dict, requested: dict) -> None:
    """An emissive map is multiplied by the emissive colour, so a map on a
    material whose emissive colour is the default black would show nothing.
    When a map is set and the request did not say what the colour should
    be, make it white so the map shows as it is."""
    if (
        material.get("emissiveMap")
        and "emissive" not in requested
        and str(material.get("emissive", "#000000")).lower() == "#000000"
    ):
        material["emissive"] = "#ffffff"


def _set_material_map(scene: dict, material_id: str, slot: str, asset: dict) -> tuple:
    """Pure form of ``set_material_map``: ``(new_scene, undo, redo)``.

    Attaches the image asset row when it is new (an existing row with the
    same sha256 is reused and is not in the undo map) and points ``slot`` of
    the material at it.
    """
    if slot not in MATERIAL_MAP_FIELDS:
        raise PlastisError(
            "SPEC_INVALID", "slot must be one of %s" % (list(MATERIAL_MAP_FIELDS),), path="/slot"
        )
    existing_material = _material_by_id(scene, material_id)
    if existing_material is None:
        raise PlastisError("MATERIAL_NOT_FOUND", "no material with id %r" % (material_id,))
    if not isinstance(asset, dict) or asset.get("format") not in ("png", "jpeg"):
        raise PlastisError(
            "SPEC_INVALID", "set_material_map requires an image asset row", path="/asset"
        )
    existing_asset = next(
        (a for a in scene.get("assets", []) if a.get("id") == asset.get("id")), None
    )
    if existing_asset is not None and existing_asset.get("sha256") != asset.get("sha256"):
        raise PlastisError(
            "SPEC_INVALID",
            "asset id %r already exists with a different sha256" % asset["id"],
            path="/asset/id",
        )
    if _material_by_id(scene, asset["id"]) is not None:
        raise PlastisError(
            "SPEC_INVALID", "asset id %r collides with a material id" % asset["id"], path="/asset/id"
        )
    material = copy.deepcopy(existing_material)
    material[slot] = asset["id"]
    _lift_black_emissive(material, {})
    new_scene = copy.deepcopy(scene)
    new_scene["materials"] = [
        material if m.get("id") == material_id else m for m in scene.get("materials", [])
    ]
    undo: dict = {"materials": {material_id: copy.deepcopy(existing_material)}}
    redo: dict = {"materials": {material_id: copy.deepcopy(material)}}
    if existing_asset is None:
        new_scene["assets"] = list(scene.get("assets", [])) + [copy.deepcopy(asset)]
        undo["assets"] = {asset["id"]: None}
        redo["assets"] = {asset["id"]: copy.deepcopy(asset)}
    return new_scene, undo, redo


def apply_set_material_map(scene: dict, material_id: str, slot: str, asset: dict) -> dict:
    """The scene as it would be after ``set_material_map``, nothing written.

    The image import uses it to validate the whole result (the part-UV rule,
    the decoded-texture budget) before it writes the image file.
    """
    return _set_material_map(scene, material_id, slot, asset)[0]


def _op_set_material_map(scene: dict, mutation: dict) -> tuple:
    """Attach an already-validated image asset to one slot of a material.

    Reachable through :func:`apply` only (the image import validated and
    stored the bytes), never through ``apply_patch``. One revision and one
    history entry cover the asset row (when new), the slot and the emissive
    colour lift. Clearing a slot, or pointing it at an image already in the
    scene, is an ordinary ``set_material``.
    """
    new_scene, undo, redo = _set_material_map(
        scene,
        mutation.get("materialId"),
        mutation.get("slot"),
        mutation.get("asset"),
    )
    entry = _history_entry(
        "set_material_map %s.%s" % (mutation.get("materialId"), mutation.get("slot")), undo, redo
    )
    return new_scene, entry, []


def _op_cleanup(scene: dict, mutation: dict) -> tuple:
    """Prune and dedupe (PR18): one revision, one history entry.

    The work is :func:`plastis3d_scene.cleanup.apply_cleanup`, run here inside
    the scene lock so what is applied is what the lock saw. Reachable through
    ``apply`` (the tool and the cleanup route), not through a patch. A scene
    with nothing to tidy is refused rather than written as an empty revision.
    """
    from .cleanup import apply_cleanup, is_empty

    new_scene, changes = apply_cleanup(scene, mutation.get("operations"), mutation.get("welds"))
    if is_empty(changes):
        raise PlastisError("SPEC_INVALID", "there is nothing to tidy up", path="/operations")
    old_nodes = {n["id"]: n for n in scene.get("nodes", [])}
    new_nodes = {n["id"]: n for n in new_scene.get("nodes", [])}
    old_materials = {m["id"]: m for m in scene.get("materials", [])}
    new_materials = {m["id"]: m for m in new_scene.get("materials", [])}
    undo: dict = {"nodes": {}, "materials": {}}
    redo: dict = {"nodes": {}, "materials": {}}
    for node_id, node in old_nodes.items():
        replacement = new_nodes.get(node_id)
        if replacement != node:
            undo["nodes"][node_id] = copy.deepcopy(node)
            redo["nodes"][node_id] = copy.deepcopy(replacement) if replacement is not None else None
    for material_id, material in old_materials.items():
        if new_materials.get(material_id) != material:
            undo["materials"][material_id] = copy.deepcopy(material)
            redo["materials"][material_id] = None
    old_assets = {a["id"]: a for a in scene.get("assets", [])}
    new_assets = {a["id"]: a for a in new_scene.get("assets", [])}
    undo["assets"] = {}
    redo["assets"] = {}
    for asset_id, asset in old_assets.items():
        if asset_id not in new_assets:  # a welded model's old row
            undo["assets"][asset_id] = copy.deepcopy(asset)
            redo["assets"][asset_id] = None
    for asset_id, asset in new_assets.items():
        if asset_id not in old_assets:  # its replacement
            undo["assets"][asset_id] = None
            redo["assets"][asset_id] = copy.deepcopy(asset)
    undo = {k: v for k, v in undo.items() if v}
    redo = {k: v for k, v in redo.items() if v}
    entry = _history_entry("cleanup", undo, redo)
    return new_scene, entry, []


MODEL_LOCKED_SENTENCE = "This model is locked. Re-import it as editable parts to edit its mesh."


def check_bakeable(node: dict) -> None:
    """Refuse a node a baked mesh cannot replace (PR24)."""
    kind = node.get("kind")
    if kind == "model":
        raise PlastisError("NODE_LOCKED", MODEL_LOCKED_SENTENCE)
    if kind not in ("mesh", "part"):
        raise PlastisError("BAKE_INVALID", "only a shape or a part has a mesh to edit", path="/nodeId")
    if node.get("clips"):
        raise PlastisError(
            "BAKE_INVALID",
            "this shape has animation clips, which a part cannot keep; delete its clips first",
            path="/nodeId",
        )


def is_rig_model(node: dict) -> bool:
    """A ``model`` made by the rig generator (PR30): the Rig section may regenerate it."""
    return node.get("kind") == "model" and (node.get("generator") or {}).get("type") == "rig"


def new_part_id() -> str:
    """A fresh node id for a part created by a bake."""
    return new_node_id()


def apply_bake(scene: dict, mutation: dict) -> tuple:
    """Public wrapper so the bake route can dry-run the op on a copy."""
    return _op_bake(scene, mutation)


def _op_bake(scene: dict, mutation: dict) -> tuple:
    """Point a node at a baked mesh asset (PR24, D-EXT-01/03): one revision, one entry.

    A ``mesh`` primitive becomes a ``part`` in the same entry, and undo restores
    the primitive. The new asset's row is added; rows nothing can reach any more
    (nodes, generators, materials, and every undo and redo entry, including this
    one) are swept in the same revision (C-03). Reachable only through ``apply``
    (the bakes route), never through a patch: the asset row must come from the
    server's own scan.
    """
    from .spec import MAX_ASSETS
    from .sweep import sweep_rows

    node_id = mutation.get("nodeId")
    asset = mutation.get("asset")
    if not isinstance(node_id, str) or not isinstance(asset, dict) or not asset.get("id"):
        raise PlastisError("SPEC_INVALID", "bake requires nodeId and asset", path="/op")
    create = mutation.get("create")
    old = _node_by_id(scene, node_id)
    if create is not None:
        # A new part (PR23): the node does not exist yet, so undo removes it again.
        if old is not None:
            raise PlastisError("SPEC_INVALID", "create names a node that already exists", path="/create")
        parent = create.get("parent")
        if parent is not None and _node_by_id(scene, parent) is None:
            raise PlastisError("NODE_NOT_FOUND", "no node with id %r" % parent)
        if len(scene.get("nodes", [])) >= MAX_NODES:
            raise PlastisError("LIMIT_NODES", "the scene already has %d nodes" % MAX_NODES)
        transform = copy.deepcopy(create.get("transform")) or {"t": [0, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]}
        old = {"id": node_id, "name": (create.get("name") or "Part")[:64], "kind": "part", "parent": parent, "visible": True, "transform": transform, "modelAssetId": asset["id"], "meshIndex": 0, "primitiveIndex": 0}
    elif old is None:
        raise PlastisError("NODE_NOT_FOUND", "no node with id %r" % node_id)
    elif not (mutation.get("asModel") and is_rig_model(old)):
        check_bakeable(old)
    generator = mutation.get("generator")
    new_node = copy.deepcopy(old)
    new_node.pop("primitive", None)
    if mutation.get("asModel"):
        # PR30: a rig is a locked model (the skin and clips travel in the GLB), and a model has no material override.
        for key in ("meshIndex", "primitiveIndex", "materialId"):
            new_node.pop(key, None)
        new_node.update({"kind": "model", "modelAssetId": asset["id"]})
    else:
        new_node.update({"kind": "part", "modelAssetId": asset["id"], "meshIndex": 0, "primitiveIndex": 0})
    if generator is None:
        new_node.pop("generator", None)  # editing the mesh ends any generator's settings
    else:
        new_node["generator"] = copy.deepcopy(generator)
    new_scene = copy.deepcopy(scene)
    new_scene["nodes"] = [new_node if n["id"] == node_id else n for n in scene["nodes"]]
    had_row = any(a.get("id") == asset["id"] for a in scene.get("assets", []))
    base_asset = mutation.get("baseAsset")
    had_base = base_asset is None or any(a.get("id") == base_asset["id"] for a in scene.get("assets", []))
    if not had_row:
        new_scene["assets"] = list(scene.get("assets", [])) + [copy.deepcopy(asset)]
    if not had_base:
        new_scene["assets"] = list(new_scene["assets"]) + [copy.deepcopy(base_asset)]
    if create is not None:
        new_scene["nodes"] = list(scene["nodes"]) + [new_node]
    undo: dict = {"nodes": {node_id: None if create is not None else copy.deepcopy(old)}}
    redo: dict = {"nodes": {node_id: copy.deepcopy(new_node)}}
    if not had_row:
        undo["assets"] = {asset["id"]: None}
        redo["assets"] = {asset["id"]: copy.deepcopy(asset)}
    if not had_base:
        undo.setdefault("assets", {})[base_asset["id"]] = None
        redo.setdefault("assets", {})[base_asset["id"]] = copy.deepcopy(base_asset)
    kind = (generator or {}).get("type")
    if kind == "text":
        label = "Add text" if create is not None else "Edit text"
    elif kind == "curve":
        label = "Curve"
    elif kind == "displace":
        label = "Displace"
    elif kind == "rig":
        label = "Rig"
    else:
        label = "Add part" if create is not None else "Edit mesh"
    entry = _history_entry(label, undo, redo)
    from .sweep import sweep_rows as _sweep

    _sweep(new_scene, extra_history=[entry])
    if len(new_scene["assets"]) > MAX_ASSETS:
        raise PlastisError(
            "LIMIT_ASSETS",
            "the scene already has %d models, the %d-model cap; remove unused models first"
            % (len(scene.get("assets", [])), MAX_ASSETS),
        )
    return new_scene, entry, []


def _op_clone_node(scene: dict, mutation: dict) -> tuple:
    """Clone a node under a new group "Clones of <name>" (PR28): real nodes, one revision, one entry.

    The copies share the source's asset and material. ``LIMIT_NODES`` is checked before anything is built.
    Reachable through ``apply`` (the tool and the clones route), not through a patch."""
    from . import cloners

    source_id = mutation.get("source")
    source = _node_by_id(scene, source_id) if isinstance(source_id, str) else None
    if source is None:
        raise PlastisError("NODE_NOT_FOUND", "no node with id %r" % (source_id,))
    if source.get("kind") in ("light", "camera"):
        raise PlastisError("SPEC_INVALID", "SPEC_INVALID: lights and cameras are not cloned", path="/source")
    mode = mutation.get("mode")
    settings = cloners.validate(mode, mutation.get("params"))
    t = source["transform"]
    placements = cloners.layout(settings, mode, list(t["t"]), list(t["r"]))
    subtree = _subtree_ids(scene, source["id"])
    needed = 1 + len(placements) * len(subtree)
    if len(scene.get("nodes", [])) + needed > MAX_NODES:
        raise PlastisError(
            "LIMIT_NODES",
            "LIMIT_NODES: %d clones of %d node(s) need %d more nodes, over the %d-node cap" % (len(placements), len(subtree), needed, MAX_NODES),
        )
    working = copy.deepcopy(scene)
    before = {n["id"] for n in working["nodes"]}
    group_id = _unique_node_id(working)
    group = {"id": group_id, "name": ("Clones of " + source.get("name", "node"))[:64], "kind": "group", "parent": source.get("parent"), "visible": True,
             "transform": {"t": [0.0, 0.0, 0.0], "r": [0.0, 0.0, 0.0], "s": [1.0, 1.0, 1.0]}}
    working["nodes"] = list(working["nodes"]) + [group]
    for index, (translation, rotation) in enumerate(placements, start=1):
        working, _, _ = _op_duplicate_node(working, {"id": source["id"]})
        fresh = [n for n in working["nodes"] if n["id"] not in before and n["id"] != group_id and n.get("name") == (source.get("name", "") + " copy")[:64] and n.get("parent") == source.get("parent")]
        root = fresh[-1]
        root["parent"] = group_id
        root["name"] = ("%s %d" % (source.get("name", "node"), index))[:64]
        root["transform"] = {"t": translation, "r": rotation, "s": list(t["s"])}
        before |= {n["id"] for n in working["nodes"]}
    created = [n for n in working["nodes"] if n["id"] not in {x["id"] for x in scene["nodes"]}]
    undo = {"nodes": {n["id"]: None for n in created}}
    redo = {"nodes": {n["id"]: copy.deepcopy(n) for n in created}}
    return working, _history_entry("Clone %s" % mode, undo, redo), []


def _op_remove_unused_assets(scene: dict, mutation: dict) -> tuple:
    """Drop the asset rows nothing in the live scene uses (PR14): one revision, undoable.

    The undo entry restores the rows, so the files they name stay referenced by
    history until the entry rolls off; the sweep deletes a file only after that.
    Reachable through ``apply`` (the library route), not through a patch.
    """
    from .library import used_asset_ids

    used = used_asset_ids(scene)
    gone = [a for a in scene.get("assets", []) if a["id"] not in used]
    if not gone:
        raise PlastisError("SPEC_INVALID", "there are no unused models or images to remove", path="/op")
    new_scene = copy.deepcopy(scene)
    keep = {a["id"] for a in gone}
    new_scene["assets"] = [a for a in scene.get("assets", []) if a["id"] not in keep]
    undo = {"assets": {a["id"]: copy.deepcopy(a) for a in gone}}
    redo = {"assets": {a["id"]: None for a in gone}}
    return new_scene, _history_entry("Remove unused files", undo, redo), []


def _op_duplicate_node(scene: dict, mutation: dict) -> tuple:
    node_id = mutation.get("id")
    if not isinstance(node_id, str) or not node_id:
        raise PlastisError("SPEC_INVALID", "duplicate_node requires an id", path="/id")
    root = _node_by_id(scene, node_id)
    if root is None:
        raise PlastisError("NODE_NOT_FOUND", "no node with id %r" % node_id)
    subtree = _subtree_ids(scene, node_id)
    by_id = {n["id"]: n for n in scene.get("nodes", [])}
    id_map: dict = {}
    copies: list = []
    for old_id in subtree:
        new_id = _unique_node_id(scene)
        # _unique_node_id only avoids ids already in the scene, not ids
        # minted earlier in this same duplicate; guard against that too.
        while new_id in id_map.values():
            new_id = _unique_node_id(scene)
        id_map[old_id] = new_id
    for old_id in subtree:
        old_node = by_id[old_id]
        new_node = copy.deepcopy(old_node)
        new_node["id"] = id_map[old_id]
        if old_id == node_id:
            name = old_node.get("name", "")
            new_node["name"] = (name + " copy")[:64] or "Copy"
            # The copy is a sibling: same parent as the original.
        else:
            parent = old_node.get("parent")
            new_node["parent"] = id_map.get(parent, parent)
        # The copy gets its own transform object (same values, independent).
        new_node["transform"] = copy.deepcopy(old_node.get("transform"))
        copies.append(new_node)
    new_scene = copy.deepcopy(scene)
    new_scene["nodes"] = list(scene.get("nodes", [])) + copies
    entry = _history_entry(
        "duplicate_node %s" % node_id,
        {"nodes": {c["id"]: None for c in copies}},
        {"nodes": {c["id"]: copy.deepcopy(c) for c in copies}},
    )
    return new_scene, entry, []


def _op_delete_node(scene: dict, mutation: dict) -> tuple:
    node_id = mutation.get("id")
    if not isinstance(node_id, str) or not node_id:
        raise PlastisError("SPEC_INVALID", "delete_node requires an id", path="/id")
    root = _node_by_id(scene, node_id)
    if root is None:
        raise PlastisError("NODE_NOT_FOUND", "no node with id %r" % node_id)
    removed_ids = _subtree_ids(scene, node_id)
    removed = {
        n["id"]: copy.deepcopy(n)
        for n in scene.get("nodes", [])
        if n["id"] in set(removed_ids)
    }
    remaining = [
        n for n in scene.get("nodes", []) if n["id"] not in set(removed_ids)
    ]
    defaults_added = []
    new_scene = copy.deepcopy(scene)
    new_scene["nodes"] = remaining
    undo_nodes = dict(removed)
    redo_nodes = {nid: None for nid in removed}
    entry = _history_entry(
        "delete_node %s" % node_id,
        {"nodes": undo_nodes},
        {"nodes": redo_nodes},
    )
    return new_scene, entry, defaults_added


def _op_delete_material(scene: dict, mutation: dict) -> tuple:
    material_id = mutation.get("id")
    if not isinstance(material_id, str) or not material_id:
        raise PlastisError(
            "SPEC_INVALID", "delete_material requires an id", path="/id"
        )
    material = _material_by_id(scene, material_id)
    if material is None:
        raise PlastisError(
            "MATERIAL_NOT_FOUND", "no material with id %r" % material_id
        )
    referrers = [
        n["id"]
        for n in scene.get("nodes", [])
        if n.get("materialId") == material_id
    ]
    if referrers:
        raise PlastisError(
            "SPEC_INVALID",
            "material %r is still referenced by node %r"
            % (material_id, referrers[0]),
            path="/materials/%s" % material_id,
        )
    new_scene = copy.deepcopy(scene)
    new_scene["materials"] = [
        m for m in scene.get("materials", []) if m.get("id") != material_id
    ]
    entry = _history_entry(
        "delete_material %s" % material_id,
        {"materials": {material_id: copy.deepcopy(material)}},
        {"materials": {material_id: None}},
    )
    return new_scene, entry, []


def _op_import_asset(scene: dict, mutation: dict) -> tuple:
    """Attach an already-validated GLB: asset row + nodes.

    The scan lands in PR7 (``plastis3d_scene.import_model``); this op
    only attaches what the scan already validated, so it is reachable
    through ``apply`` only, never through ``apply_patch``. ``mutation``
    carries ``"asset"`` plus ``"nodes"``: the exploder's wrapper group +
    per-node groups + per-primitive parts, or one locked ``model`` node
    when ``explode`` is false. (The PR3 single-``"node"`` shape was
    removed before PR9, R-20.) Groups carry no asset reference;
    ``model`` / ``part`` nodes must name the attached asset.

    Re-importing the same bytes is idempotent: an asset row whose id
    and sha256 already match the scene's row is reused — it is not
    appended again and it is not in the undo map (it predates the
    import). An id that names a *different* sha256 is still
    ``SPEC_INVALID``.
    """
    asset_in = mutation.get("asset")
    if not isinstance(asset_in, dict):
        raise PlastisError(
            "SPEC_INVALID", "import_asset requires an asset object", path="/asset"
        )
    asset = copy.deepcopy(asset_in)
    nodes_in = mutation.get("nodes")
    if not isinstance(nodes_in, list) or not nodes_in:
        raise PlastisError(
            "SPEC_INVALID", "import_asset requires a non-empty nodes array", path="/nodes"
        )
    nodes = []
    taken = {n.get("id") for n in scene.get("nodes", [])}
    for node_in in nodes_in:
        if not isinstance(node_in, dict):
            raise PlastisError(
                "SPEC_INVALID", "import_asset requires node objects", path="/nodes"
            )
        nodes.append(_normalize_node(node_in, scene, taken))
    for node in nodes:
        if node.get("kind") not in ("model", "part", "group", "splat"):
            raise PlastisError(
                "SPEC_INVALID",
                "import_asset attaches model, part, or group nodes, not %r"
                % (node.get("kind"),),
                path="/nodes/kind",
            )
        if node.get("kind") == "splat" and node.get("splatAssetId") != asset.get("id"):
            raise PlastisError("SPEC_INVALID", "splatAssetId must name attached asset")
        if node.get("kind") in ("model", "part") and node.get("modelAssetId") != asset.get("id"):
            raise PlastisError(
                "SPEC_INVALID",
                "node modelAssetId must name the attached asset",
                path="/nodes/modelAssetId",
            )
    existing_asset = next(
        (a for a in scene.get("assets", []) if a.get("id") == asset.get("id")),
        None,
    )
    if existing_asset is not None and existing_asset.get("sha256") != asset.get("sha256"):
        raise PlastisError(
            "SPEC_INVALID",
            "asset id %r already exists with a different sha256" % asset["id"],
            path="/asset/id",
        )
    if _material_by_id(scene, asset["id"]) is not None:
        raise PlastisError(
            "SPEC_INVALID",
            "asset id %r collides with a material id" % asset["id"],
            path="/asset/id",
        )
    asset_is_new = existing_asset is None
    new_scene = copy.deepcopy(scene)
    if asset_is_new:
        new_scene["assets"] = list(scene.get("assets", [])) + [asset]
    new_scene["nodes"] = list(scene.get("nodes", [])) + nodes
    undo_maps: dict = {"nodes": {node["id"]: None for node in nodes}}
    redo_maps: dict = {"nodes": {node["id"]: copy.deepcopy(node) for node in nodes}}
    if asset_is_new:
        undo_maps["assets"] = {asset["id"]: None}
        redo_maps["assets"] = {asset["id"]: copy.deepcopy(asset)}
    entry = _history_entry(
        "import_asset %s" % asset["id"],
        undo_maps,
        redo_maps,
    )
    return new_scene, entry, []


def _op_undo_redo(scene: dict, mutation: dict) -> tuple:
    """Pop one history stack; the swapped entry goes on the other stack.

    Returns (new_scene, None, []) — the caller writes with a full
    ``history_override`` instead of appending an entry, because a plain
    ``write_scene`` appends to undo and clears redo, which is wrong for
    undo/redo.
    """
    op = mutation["op"]
    history = scene.get("history") or {}
    if op == "undo":
        source, target = "undo", "redo"
    else:
        source, target = "redo", "undo"
    stack = list(history.get(source) or [])
    if not stack:
        raise PlastisError(
            "HISTORY_EMPTY",
            "nothing to %s" % op,
        )
    entry = stack.pop()
    new_scene = copy.deepcopy(scene)
    _apply_history_maps(new_scene, entry.get("undo") or {})
    swapped = {
        "label": entry.get("label", op),
        "at": now_iso(),
        "undo": copy.deepcopy(entry.get("redo") or {}),
        "redo": copy.deepcopy(entry.get("undo") or {}),
    }
    new_history = {
        "undo": list(history.get("undo") or []),
        "redo": list(history.get("redo") or []),
        "limit": history.get("limit", 50),
    }
    new_history[source] = stack
    new_history[target] = list(history.get(target) or []) + [swapped]
    new_scene["history"] = new_history
    return new_scene, None, []


_OP_HANDLERS = {
    "set_scene_name": _op_set_scene_name,
    "build": _op_build,
    "add_node": _op_add_node,
    "update_node": _op_update_node,
    "set_material": _op_set_material,
    "duplicate_node": _op_duplicate_node,
    "delete_node": _op_delete_node,
    "delete_material": _op_delete_material,
    "import_asset": _op_import_asset,
    "set_material_map": _op_set_material_map,
    "cleanup": _op_cleanup,
    "bake": _op_bake,
    "clone_node": _op_clone_node,
    "remove_unused_assets": _op_remove_unused_assets,
    "undo": _op_undo_redo,
    "redo": _op_undo_redo,
}


# --- Public entry points -----------------------------------------------------

def _reject_reserved(value: Any) -> None:
    from .validate import MAPS_SUPPORTED, CLIPS_SUPPORTED
    if isinstance(value, dict):
        for key, item in value.items():
            if not MAPS_SUPPORTED and key in ("baseColorMap", "normalMap", "metallicRoughnessMap", "emissiveMap") and item not in (None, []):
                raise PlastisError("SPEC_INVALID", "%s cannot be used in this version yet" % key, path="/" + key)
            if not CLIPS_SUPPORTED and key == "clips" and item not in (None, []):
                raise PlastisError("SPEC_INVALID", "clips cannot be used in this version yet", path="/clips")
            _reject_reserved(item)
    elif isinstance(value, list):
        for item in value:
            _reject_reserved(item)


def apply(
    scene_id: Optional[str],
    base_revision: Optional[int],
    mutation: dict,
    store: Optional[Store] = None,
    origin: str = "ui",
) -> dict:
    """Apply one mutation and return the feedback envelope.

    ``base_revision`` is required unless ``mutation["op"] == "create"``.
    Every successful mutation increments the revision by 1 (via
    ``Store.write_scene``) and broadcasts ``scene.changed`` after the
    commit. ``REVISION_CONFLICT`` on mismatch; the tool does not retry.
    """
    if not isinstance(mutation, dict) or not mutation.get("op"):
        raise PlastisError("SPEC_INVALID", "mutation requires an op", path="/op")
    op = mutation["op"]
    if op in ("build", "add_node", "update_node", "set_material"):
        _reject_reserved(mutation)
    store = store or Store()

    if op == "create":
        name = mutation.get("name")
        scene = store.create_scene(name, scene_id=mutation.get("id"))
        _broadcast_scene_changed(scene["id"], scene["revision"], origin)
        return store.envelope(scene, defaults_added=["light_key", "cam_main"])

    if not isinstance(scene_id, str) or not scene_id:
        raise PlastisError("SPEC_INVALID", "scene id is required", path="/scene")
    base_revision = _require_base_revision(base_revision)
    if op not in _OP_HANDLERS:
        raise PlastisError(
            "SPEC_INVALID", "unknown op %r" % (op,), path="/op"
        )
    from .asset_facts import enrich_legacy_uvs
    current = enrich_legacy_uvs(store.get_scene(scene_id), store)
    if op in ("undo", "redo"):
        new_scene, _, _ = _OP_HANDLERS[op](current, mutation)
        # Validate the post-undo document before the locked write.
        new_scene = enrich_legacy_uvs(new_scene, store)
        validate_scene(new_scene)
        result = store.write_scene(
            scene_id,
            new_scene,
            base_revision,
            history_override=new_scene["history"],
        )
    else:
        new_scene, entry, defaults_added = _OP_HANDLERS[op](current, mutation)
        result = store.write_scene(scene_id, new_scene, base_revision, entry)
        written = result["scene"]
        _broadcast_scene_changed(written["id"], written["revision"], origin)
        return store.envelope(
            written,
            defaults_added=defaults_added,
            history_truncated=result["historyTruncated"],
        )
    written = result["scene"]
    _broadcast_scene_changed(written["id"], written["revision"], origin)
    return store.envelope(
        written,
        defaults_added=[],
        history_truncated=result["historyTruncated"],
    )


def apply_patch(
    scene_id: str,
    base_revision: int,
    ops: list,
    store: Optional[Store] = None,
) -> dict:
    """Apply a batch of ops as ONE history entry and ONE revision bump.

    ``PATCH /scenes/{id}`` body: ``{"baseRevision": N, "ops": [...]}``.
    Maximum 32 ops. ``create`` and ``import_asset`` are not patchable.
    ``undo`` / ``redo`` are accepted only as the patch's **single** op:
    that is how the desktop's undo/redo buttons and Mod+Z send them
    (``api.undoScene`` / ``redoScene``), and the ops table lists them as
    shared by tools and PATCH. A single undo/redo is delegated to
    :func:`apply`, which pops the history instead of appending an entry.
    Mixed into a batch they stay ``SPEC_INVALID`` (a batch is one history
    entry, so an undo inside it is incoherent). Before this, every
    desktop undo/redo against the real gateway failed with SPEC_INVALID;
    the mock accepted it, so no harness test noticed (pre-PR9 completion
    plan, audit A-4).
    """
    if not isinstance(scene_id, str) or not scene_id:
        raise PlastisError("SPEC_INVALID", "scene id is required", path="/scene")
    base_revision = _require_base_revision(base_revision)
    if not isinstance(ops, list) or not ops:
        raise PlastisError("SPEC_INVALID", "ops must be a non-empty array", path="/ops")
    if (
        len(ops) == 1
        and isinstance(ops[0], dict)
        and ops[0].get("op") in ("undo", "redo")
    ):
        return apply(scene_id, base_revision, {"op": ops[0]["op"]}, store=store)
    if len(ops) > MAX_OPS_PER_PATCH:
        raise PlastisError(
            "SPEC_INVALID",
            "at most %d ops per patch, got %d" % (MAX_OPS_PER_PATCH, len(ops)),
            path="/ops",
        )
    store = store or Store()
    from .asset_facts import enrich_legacy_uvs
    current = enrich_legacy_uvs(store.get_scene(scene_id), store)
    scene = copy.deepcopy(current)
    combined_undo: dict = {}
    combined_redo: dict = {}
    defaults_added: list = []
    for index, op_mutation in enumerate(ops):
        if not isinstance(op_mutation, dict) or not op_mutation.get("op"):
            raise PlastisError(
                "SPEC_INVALID",
                "op %d requires an op" % index,
                path="/ops/%d/op" % index,
            )
        op = op_mutation["op"]
        if op in ("build", "add_node", "update_node", "set_material"):
            _reject_reserved(op_mutation)
        if op not in _PATCHABLE_OPS:
            raise PlastisError(
                "SPEC_INVALID",
                "op %r is not allowed in a patch" % (op,),
                path="/ops/%d/op" % index,
            )
        scene, entry, added = _OP_HANDLERS[op](scene, op_mutation)
        _merge_history(combined_undo, combined_redo, entry)
        for item in added:
            if item not in defaults_added:
                defaults_added.append(item)
    entry = _history_entry(
        "patch (%d ops)" % len(ops), combined_undo, combined_redo
    )
    result = store.write_scene(scene_id, scene, base_revision, entry)
    written = result["scene"]
    _broadcast_scene_changed(written["id"], written["revision"])
    return store.envelope(
        written,
        defaults_added=defaults_added,
        history_truncated=result["historyTruncated"],
    )
