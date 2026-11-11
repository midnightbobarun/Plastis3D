"""Plastis3D — baking a desktop-computed mesh into the scene (PR24, D-EXT-01/03).

``POST /scenes/{id}/bakes`` takes the vertex arrays the editor computed (an
edited mesh; later text, modifiers, sculpt) and turns them into a new
content-addressed GLB asset, then repoints the node at it as a ``part`` in
**one** ``mutate.apply``: one revision, one history entry. Nothing is written
on any refusal, and the asset file is written only after the whole mutation
has been checked against a copy of the scene.

The arrays are base64 little-endian typed arrays (the same 16 MiB JSON body
cap as an import upload): ``positions`` and optional ``normals`` float32 VEC3,
``uvs`` float32 VEC2, ``colors`` float32 RGBA, ``indices`` uint32.

Errors: ``BAKE_INVALID`` (an array that is not finite, an index out of
bounds, lengths that do not match, an unsupported node or a ``skin``),
``BAKE_TOO_LARGE`` (over 1,000,000 vertices), ``NODE_NOT_FOUND``,
``NODE_LOCKED`` (a ``model``), ``REVISION_CONFLICT``, ``LIMIT_ASSETS``.

Lock order (C-03): bounded reservation/publication under the asset lock;
operation pins remain live through ``mutate.apply`` without holding that lock.

Stdlib only. Python 3.11-compatible.
"""

from __future__ import annotations

import base64
import binascii
import copy
import hashlib
import math
import sys
import time
from array import array
from typing import Any, Optional

from .asset_transactions import pin_scene
from . import glb as _glb
from . import mesh_import as _mesh
from . import mutate
from .import_model import MAX_ASSET_QUOTA_BYTES
from .spec import PlastisError
from .store import Store
from .sweep import sweep_after_commit
from .validate import validate_scene

MAX_VERTICES = 1_000_000
MAX_BODY_BYTES = 16 * 1024 * 1024
BAKE_TIMEOUT = 30.0

# The only material properties carried over from the previous asset; a texture
# reference would point into a GLB that no longer holds the image.
_MATERIAL_KEYS = ("name", "emissiveFactor", "alphaMode", "alphaCutoff", "doubleSided")
_PBR_KEYS = ("baseColorFactor", "metallicFactor", "roughnessFactor")


def _fail(code: str, message: str, path: Optional[str] = None) -> None:
    raise PlastisError(code, message, path=path)


def _decode(value: Any, typecode: str, per_vertex: Optional[int], name: str, vertices: Optional[int]) -> array:
    if not isinstance(value, str):
        _fail("BAKE_INVALID", "mesh.%s must be a base64 string" % name, "/mesh/%s" % name)
    try:
        raw = base64.b64decode("".join(value.split()), validate=True)
    except (binascii.Error, ValueError):
        _fail("BAKE_INVALID", "mesh.%s is not valid base64" % name, "/mesh/%s" % name)
    out = array(typecode)
    if len(raw) % out.itemsize:
        _fail("BAKE_INVALID", "mesh.%s is not a whole number of values" % name, "/mesh/%s" % name)
    out.frombytes(raw)
    if sys.byteorder == "big":  # pragma: no cover - the wire is little-endian
        out.byteswap()
    if per_vertex is not None and vertices is not None and len(out) != per_vertex * vertices:
        _fail(
            "BAKE_INVALID",
            "mesh.%s has %d values for %d vertices (expected %d)" % (name, len(out), vertices, per_vertex * vertices),
            "/mesh/%s" % name,
        )
    return out


def _check_finite(values: array, name: str) -> None:
    if not all(map(math.isfinite, values)):
        _fail("BAKE_INVALID", "mesh.%s holds a value that is not finite" % name, "/mesh/%s" % name)


def decode_mesh(mesh: Any) -> dict:
    """Validate and decode the body's ``mesh`` object."""
    if not isinstance(mesh, dict):
        _fail("BAKE_INVALID", "mesh must be an object", "/mesh")
    unknown = sorted(set(mesh) - {"positions", "normals", "uvs", "colors", "indices", "skin"})
    if unknown:
        _fail("BAKE_INVALID", "unknown mesh key %r" % unknown[0], "/mesh")
    if mesh.get("skin") is not None:
        _fail("BAKE_INVALID", "a skinned mesh cannot be baked yet", "/mesh/skin")
    positions = _decode(mesh.get("positions"), "f", None, "positions", None)
    if len(positions) % 3 or len(positions) < 9:
        _fail("BAKE_INVALID", "mesh.positions must hold at least three xyz vertices", "/mesh/positions")
    vertices = len(positions) // 3
    if vertices > MAX_VERTICES:
        _fail("BAKE_TOO_LARGE", "the mesh has %d vertices, over the %d cap" % (vertices, MAX_VERTICES))
    indices = _decode(mesh.get("indices"), "I", None, "indices", None)
    if len(indices) < 3 or len(indices) % 3:
        _fail("BAKE_INVALID", "mesh.indices must be a whole number of triangles", "/mesh/indices")
    if max(indices) >= vertices:
        _fail("BAKE_INVALID", "mesh.indices names a vertex that does not exist", "/mesh/indices")
    out = {"positions": positions, "indices": indices, "normals": None, "uvs": None, "colors": None}
    if mesh.get("normals") is not None:
        out["normals"] = _decode(mesh["normals"], "f", 3, "normals", vertices)
    if mesh.get("uvs") is not None:
        out["uvs"] = _decode(mesh["uvs"], "f", 2, "uvs", vertices)
    if mesh.get("colors") is not None:
        colors = _decode(mesh["colors"], "f", 4, "colors", vertices)
        _check_finite(colors, "colors")
        out["colors"] = bytes(min(255, max(0, int(round(c * 255)))) for c in colors)
    for key in ("positions", "normals", "uvs"):
        if out[key] is not None:
            _check_finite(out[key], key)
    return out


def _carried_material(store: Store, scene: dict, node: dict) -> dict:
    """The source material of an existing part (no textures), or the default."""
    material = _mesh._material()
    if node.get("kind") != "part" or node.get("materialId"):
        return material
    asset = next((a for a in scene.get("assets", []) if a.get("id") == node.get("modelAssetId")), None)
    if not asset:
        return material
    try:
        data = (store.assets_dir / ("%s.glb" % asset["sha256"])).read_bytes()
        scan = _glb.scan(data, source_format="glb", deadline=time.monotonic() + 10)
        primitive = scan.gltf["meshes"][node["meshIndex"]]["primitives"][node["primitiveIndex"]]
        source = scan.gltf["materials"][primitive["material"]]
    except Exception:
        return material
    def has_maps(value):
        return isinstance(value, dict) and any(
            (key.endswith("Texture") and isinstance(child, dict) and "index" in child) or has_maps(child)
            for key, child in value.items()
        )
    if has_maps(source):
        _fail("BAKE_INVALID", "the source material has embedded texture maps that this bake cannot carry; assign a material override before baking", "/nodeId")
    carried: dict = {key: source[key] for key in _MATERIAL_KEYS if key in source}
    pbr = {key: source["pbrMetallicRoughness"][key] for key in _PBR_KEYS if key in source.get("pbrMetallicRoughness", {})}
    carried["pbrMetallicRoughness"] = pbr or material["pbrMetallicRoughness"]
    return carried


def bake_mesh(scene_id: str, store: Store, body: Any, origin: str = "ui") -> dict:
    """Bake ``body.mesh`` onto ``body.nodeId``; returns the feedback envelope."""
    if not isinstance(body, dict):
        _fail("SPEC_INVALID", "request body must be a JSON object", "")
    unknown = sorted(set(body) - {"baseRevision", "nodeId", "mesh", "generator", "name", "create"})
    if unknown:
        _fail("SPEC_INVALID", "unknown key %r" % unknown[0], "/%s" % unknown[0])
    base_revision = body.get("baseRevision")
    if not isinstance(base_revision, int) or isinstance(base_revision, bool):
        _fail("SPEC_INVALID", "baseRevision must be an integer", "/baseRevision")
    node_id = body.get("nodeId")
    create = body.get("create")
    if create is not None:
        # PR23: add a NEW part in the same revision (Add > Text). It names no existing node.
        if node_id is not None or not isinstance(create, dict):
            _fail("SPEC_INVALID", "create takes an object and no nodeId", "/create")
        unknown_create = sorted(set(create) - {"name", "parent", "transform"})
        if unknown_create:
            _fail("SPEC_INVALID", "unknown create key %r" % unknown_create[0], "/create/%s" % unknown_create[0])
        node_id = mutate.new_part_id()
    elif not isinstance(node_id, str) or not node_id:
        _fail("SPEC_INVALID", "nodeId must be a node id", "/nodeId")
    name = body.get("name")
    if name is not None and (not isinstance(name, str) or not name or len(name) > 64):
        _fail("SPEC_INVALID", "name must be a string of 1 to 64 characters", "/name")
    decoded = decode_mesh(body.get("mesh"))
    return commit_mesh(scene_id, store, base_revision, node_id, create, decoded, name, body.get("generator"), origin=origin)


@pin_scene
def commit_mesh(
    scene_id: str,
    store: Store,
    base_revision: int,
    node_id: str,
    create: Optional[dict],
    decoded: dict,
    name: Optional[str],
    generator: Optional[dict],
    origin: str = "ui",
    base_decoded: Optional[dict] = None,
    base_name: str = "Base mesh",
    rig_params: Optional[dict] = None,
) -> dict:
    """The shared tail of every bake: build the GLB from decoded arrays, check the whole mutation on a copy,
    write the file under the asset lock and apply the ``bake`` op (PR28's curves and displacement reuse it).

    ``rig_params`` (PR30) builds a skinned GLB from ``decoded`` and the bones, and makes the node a locked ``model``.

    ``base_decoded`` also stores the un-modified mesh as a second asset in the same revision and sets
    ``generator.params.baseAssetId`` to it (displacement keeps its base for non-destructive re-application)."""
    scene = store.get_scene(scene_id)
    if scene["revision"] != base_revision:
        raise PlastisError(
            "REVISION_CONFLICT",
            "scene is at revision %d, not %d" % (scene["revision"], base_revision),
            current_revision=scene["revision"],
        )
    node = next((n for n in scene["nodes"] if n.get("id") == node_id), None)
    if create is not None:
        node = {"id": node_id, "name": (create.get("name") or name or "Part")[:64], "kind": "part"}
    elif node is None:
        _fail("NODE_NOT_FOUND", "no node with id %r" % node_id)
    elif not (rig_params is not None and mutate.is_rig_model(node)):
        mutate.check_bakeable(node)

    if rig_params is not None:
        from . import rig as _rig

        glb_bytes = _rig.build_skinned_glb(name=(name or node.get("name") or "Rigged mesh"), decoded=decoded, params=rig_params, material=_carried_material(store, scene, node))
    else:
        glb_bytes = _mesh._build_glb(
            name=(name or node.get("name") or "Mesh"),
            positions=decoded["positions"],
            indices=decoded["indices"],
            normals=decoded["normals"],
            uvs=decoded["uvs"],
            colors=decoded["colors"],
            material=_carried_material(store, scene, node),
        )
    scan = _glb.scan(glb_bytes, source_format="glb", deadline=time.monotonic() + BAKE_TIMEOUT)
    sha = hashlib.sha256(glb_bytes).hexdigest()
    stats = copy.deepcopy(scan.stats)
    stats["internals"] = [{"index": 0, "name": ((name or node.get("name") or "Mesh")[:64])}]
    if rig_params is not None:
        gltf_nodes = scan.gltf.get("nodes", [])
        stats["internals"] = [{"index": i, "name": str(n.get("name") or "Node %d" % i)[:64]} for i, n in enumerate(gltf_nodes)]
    asset = {
        "id": sha,
        "sha256": sha,
        "file": "assets/%s.glb" % sha,
        "format": "glb",
        "bytes": len(glb_bytes),
        "originalName": "Edited mesh",
        "sourceFormat": "glb",
        "stats": stats,
    }
    base_asset = None
    base_bytes = None
    if base_decoded is not None:
        base_bytes = _mesh._build_glb(
            name=(base_name or "Base mesh"), positions=base_decoded["positions"], indices=base_decoded["indices"],
            normals=base_decoded["normals"], uvs=base_decoded["uvs"], colors=base_decoded["colors"], material=_carried_material(store, scene, node),
        )
        base_scan = _glb.scan(base_bytes, source_format="glb", deadline=time.monotonic() + BAKE_TIMEOUT)
        base_sha = hashlib.sha256(base_bytes).hexdigest()
        base_stats = copy.deepcopy(base_scan.stats)
        base_stats["internals"] = [{"index": 0, "name": (base_name or "Base mesh")[:64]}]
        base_asset = {"id": base_sha, "sha256": base_sha, "file": "assets/%s.glb" % base_sha, "format": "glb", "bytes": len(base_bytes), "originalName": base_name or "Base mesh", "sourceFormat": "glb", "stats": base_stats}
        generator = copy.deepcopy(generator)
        generator["params"]["baseAssetId"] = base_sha
    mutation = {"op": "bake", "nodeId": node_id, "asset": asset, "generator": generator}
    if base_asset is not None:
        mutation["baseAsset"] = base_asset
    if create is not None:
        mutation["create"] = create
    if rig_params is not None:
        mutation["asModel"] = True
    # Everything is checked on a copy first (including the whole document), so a refusal writes no asset file.
    checked, _, _ = mutate.apply_bake(copy.deepcopy(scene), mutation)
    validate_scene(checked)

    from .asset_transactions import AssetOperation
    files = {sha + ".glb": glb_bytes}
    if base_asset is not None:
        files[base_asset["id"] + ".glb"] = base_bytes
    with AssetOperation(store, assets=scene.get("assets", []), files=files, quota=MAX_ASSET_QUOTA_BYTES):
        envelope = mutate.apply(scene_id, base_revision, mutation, store=store, origin=origin)
    # The edit is committed: the node's unsaved-edit draft is done with, and files
    # nothing references any more can go (after the commit, under the asset lock).
    from .drafts import delete_draft

    delete_draft(store, scene_id, node_id)
    sweep_after_commit(store)
    return envelope
