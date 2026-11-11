"""Plastis3D — the agent-drivable generators: curves, cloners and displacement (PR28).

Each function is one revision and one history entry. The mesh generators write their result with
:func:`plastis3d_scene.bake.commit_mesh` (the same checked, atomic path as every bake), so a failure writes
nothing. The tools, and the REST routes the editor uses, call these.
"""

from __future__ import annotations

import copy
from typing import Any, Optional

from .asset_transactions import pin_scene
from . import bake, cloners, curves, displace, mutate
from .spec import PlastisError
from .store import Store


def _need_revision(base_revision: Any) -> int:
    if not isinstance(base_revision, int) or isinstance(base_revision, bool):
        raise PlastisError("SPEC_INVALID", "SPEC_INVALID: baseRevision must be an integer", path="/baseRevision")
    return base_revision


def make_curve(
    store: Store,
    scene_id: str,
    base_revision: Any,
    params: Any,
    *,
    node_id: Optional[str] = None,
    name: Optional[str] = None,
    parent: Optional[str] = None,
    transform: Optional[dict] = None,
    origin: str = "ui",
) -> dict:
    """Create a curve part, or regenerate an existing one (``node_id``) when its settings change."""
    base_revision = _need_revision(base_revision)
    clean = curves.validate_params(params)
    decoded = curves.to_decoded(curves.build_mesh(clean))
    generator = {"type": "curve", "version": 1, "params": clean}
    if node_id is None:
        create: dict = {"name": name or ("Tube" if clean["kind"] == "tube" else "Lathe")}
        if parent is not None:
            create["parent"] = parent
        if transform is not None:
            create["transform"] = transform
        return bake.commit_mesh(scene_id, store, base_revision, mutate.new_part_id(), create, decoded, name, generator, origin=origin)
    scene = store.get_scene(scene_id)
    node = next((n for n in scene["nodes"] if n.get("id") == node_id), None)
    if node is None:
        raise PlastisError("NODE_NOT_FOUND", "no node with id %r" % node_id)
    if (node.get("generator") or {}).get("type") != "curve":
        raise PlastisError("SPEC_INVALID", "SPEC_INVALID: %r is not a curve; make a new one by leaving id out" % node_id, path="/id")
    return bake.commit_mesh(scene_id, store, base_revision, node_id, None, decoded, name, generator, origin=origin)


def follow_path(store: Store, scene_id: str, base_revision: Any, curve_id: str, target_id: str, keys: int, duration: float, origin: str = "ui") -> dict:
    """Give ``target_id`` (a built-in shape) a translation clip that walks along the curve (a second revision)."""
    base_revision = _need_revision(base_revision)
    if isinstance(keys, bool) or not isinstance(keys, int) or not 2 <= keys <= 64:
        raise PlastisError("SPEC_INVALID", "SPEC_INVALID: keys must be a whole number from 2 to 64", path="/followPath/keys")
    if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not 0.1 <= duration <= 3600:
        raise PlastisError("SPEC_INVALID", "SPEC_INVALID: duration must be a number from 0.1 to 3600 seconds", path="/followPath/duration")
    scene = store.get_scene(scene_id)
    curve = next((n for n in scene["nodes"] if n.get("id") == curve_id), None)
    target = next((n for n in scene["nodes"] if n.get("id") == target_id), None)
    if curve is None or (curve.get("generator") or {}).get("type") != "curve":
        raise PlastisError("NODE_NOT_FOUND", "no curve with id %r" % curve_id)
    if target is None:
        raise PlastisError("NODE_NOT_FOUND", "no node with id %r" % target_id)
    clip = curves.follow_path(curve["generator"]["params"], keys, float(duration))
    curve_frame = curves.node_frame(scene["nodes"], curve_id)
    parent_frame = curves.node_frame(scene["nodes"], target.get("parent"))
    clip["channels"][0]["values"] = [
        [round(v, 6) for v in curves.in_frame(curves.in_frame(p, curve_frame), parent_frame, inverse=True)]
        for p in curves.sample(curve["generator"]["params"], keys)
    ]
    return mutate.apply(scene_id, base_revision, {"op": "update_node", "id": target_id, "clips": [clip]}, store=store, origin=origin)


def make_clones(store: Store, scene_id: str, base_revision: Any, source: str, mode: Any, params: Any, origin: str = "ui") -> dict:
    return mutate.apply(scene_id, _need_revision(base_revision), {"op": "clone_node", "source": source, "mode": mode, "params": params}, store=store, origin=origin)


@pin_scene
def make_displace(store: Store, scene_id: str, base_revision: Any, node_id: str, params: Any, origin: str = "ui") -> dict:
    """Displace a built-in shape or a part by seeded noise, keeping the un-displaced mesh as the base asset."""
    base_revision = _need_revision(base_revision)
    clean = displace.validate_params(params)
    scene = store.get_scene(scene_id)
    node = next((n for n in scene["nodes"] if n.get("id") == node_id), None)
    if node is None:
        raise PlastisError("NODE_NOT_FOUND", "no node with id %r" % node_id)
    mutate.check_bakeable(node)
    assets = {a["id"]: a for a in scene.get("assets", [])}
    base_decoded = None
    generator_params = dict(clean)
    existing = node.get("generator") or {}
    if existing.get("type") == "displace":
        base_id = existing["params"]["baseAssetId"]
        data = (store.assets_dir / ("%s.glb" % assets[base_id]["sha256"])).read_bytes()
        mesh = displace.mesh_from_asset(data, 0, 0)
        generator_params["baseAssetId"] = base_id
    elif existing:
        raise PlastisError("SPEC_INVALID", "SPEC_INVALID: this object has other settings (%s); displacing it would end them" % existing.get("type"), path="/id")
    elif node["kind"] == "mesh":
        mesh = displace.mesh_from_primitive(node["primitive"])
        base_decoded = displace.to_decoded(mesh)
    else:
        asset = assets.get(node.get("modelAssetId"))
        if asset is None:
            raise PlastisError("ASSET_NOT_FOUND", "the part's model is missing")
        data = (store.assets_dir / ("%s.glb" % asset["sha256"])).read_bytes()
        mesh = displace.mesh_from_asset(data, node.get("meshIndex", 0), node.get("primitiveIndex", 0))
        base_decoded = displace.to_decoded(mesh)
    result = displace.apply_noise(mesh, clean)
    generator = {"type": "displace", "version": 1, "params": generator_params}
    return bake.commit_mesh(
        scene_id, store, base_revision, node_id, None, displace.to_decoded(result), None, generator, origin=origin,
        base_decoded=base_decoded, base_name="Before displacement",
    )


@pin_scene
def make_rig(store: Store, scene_id: str, base_revision: Any, node_id: Any, mesh: Any, params: Any, origin: str = "ui") -> dict:
    """Rig a shape or part (or regenerate a rig): the node becomes a locked model with a skin and clips, in one revision.

    ``mesh`` is the unskinned geometry (the editor sends it; for a regenerate it is the kept base mesh)."""
    from . import rig

    base_revision = _need_revision(base_revision)
    if not isinstance(node_id, str) or not node_id:
        raise PlastisError("SPEC_INVALID", "SPEC_INVALID: id must be a node id", path="/id")
    clean = rig.validate_params(params)
    decoded = bake.decode_mesh(mesh)
    if len(decoded["positions"]) // 3 > rig.MAX_RIG_VERTICES:
        raise PlastisError("RIG_TOO_LARGE", "the mesh has %d vertices, over the %d a rig can weight" % (len(decoded["positions"]) // 3, rig.MAX_RIG_VERTICES))
    generator = {"type": "rig", "version": 1, "params": clean}
    return bake.commit_mesh(scene_id, store, base_revision, node_id, None, decoded, None, generator, origin=origin, base_decoded=decoded, base_name="Unrigged mesh", rig_params=clean)
