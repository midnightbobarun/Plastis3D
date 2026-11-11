"""Plastis3D — rigging (PR30, D-EXT-01 exception): a bone set, envelope weights and a skinned GLB.

The result of a rig is a locked ``model`` (the mesh, the skin and its clips travel as one GLB, the form PR13's export
splice and PR20's playback already handle). ``generator: {type: "rig", version: 1, params}`` records the bones and
clips so the Rig section can re-open them; the unskinned mesh is kept as ``baseAssetId``.

* **Bones** (at most 64): ``{id, name, parent, head, tail}``, in metres, mesh-local. A bone's parent is another bone or
  ``null``; a parent cycle is refused. The bind pose is the rest pose: every bone node's local rotation is identity.
* **Weights** (v1 ``"envelope"``): for each vertex the 4 nearest bones by distance to the bone *segment* head->tail,
  weighted by ``1 / (distance + falloff)^2`` (the falloff is 2% of the mesh's diagonal, so a vertex ON a bone does not
  take all of it) and normalised to sum to 1. Ties break by bone order, so the result is deterministic.
* **Clips** (at most 16): ``{name, keys: [{t, boneId, rotation}]}`` where ``rotation`` is a unit quaternion ``[x,y,z,w]``
  (the bone's LOCAL rotation, replacing the identity rest rotation). Times strictly increase for each bone; between keys
  the rotation is spherical-linear, which is what glTF ``LINEAR`` means for a rotation channel (C-06).

Stdlib only. Python 3.11-compatible.
"""

from __future__ import annotations

import math
import re
from array import array
from typing import Any

from . import glb as _glb
from . import mesh_import as _mesh
from .spec import PlastisError

MAX_BONES = 64
MAX_CLIPS = 16
MAX_KEYS_PER_CLIP = 512
MAX_RIG_VERTICES = 50_000
MAX_INFLUENCES = 4
MAX_COORD = 1000.0
_ID_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,31}$")
_NAME_MAX = 64


def _fail(message: str, path: str = "", code: str = "RIG_INVALID") -> None:
    raise PlastisError(code, message, path=path or None)


def _vec3(value: Any, name: str, path: str) -> list:
    if not isinstance(value, (list, tuple)) or len(value) != 3 or any(
        isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or abs(v) > MAX_COORD for v in value
    ):
        _fail("%s must be three numbers within %g metres" % (name, MAX_COORD), path)
    return [float(v) for v in value]


def validate_params(params: Any) -> dict:
    """Check and normalise the rig settings; returns a clean copy (quaternions normalised)."""
    if not isinstance(params, dict):
        _fail("rig settings must be an object", "")
    extra = sorted(set(params) - {"bones", "weights", "clips", "baseAssetId"})
    if extra:
        _fail("unknown rig setting %r" % extra[0], "/%s" % extra[0])
    bones = params.get("bones")
    if not isinstance(bones, list) or not 1 <= len(bones) <= MAX_BONES:
        _fail("a rig takes 1 to %d bones" % MAX_BONES, "/bones")
    if params.get("weights", "envelope") != "envelope":
        _fail('weights must be "envelope"', "/weights")
    clean_bones: list = []
    ids: dict = {}
    for i, bone in enumerate(bones):
        path = "/bones/%d" % i
        if not isinstance(bone, dict) or set(bone) - {"id", "name", "parent", "head", "tail"}:
            _fail("a bone is {id, name, parent, head, tail}", path)
        bone_id = bone.get("id")
        if not isinstance(bone_id, str) or not _ID_RE.match(bone_id) or bone_id in ids:
            _fail("bone ids are unique, start with a letter and use letters, digits, - and _ (up to 32)", path + "/id")
        name = bone.get("name", bone_id)
        if not isinstance(name, str) or not 1 <= len(name) <= _NAME_MAX:
            _fail("a bone name is 1 to %d characters" % _NAME_MAX, path + "/name")
        head = _vec3(bone.get("head"), "head", path + "/head")
        tail = _vec3(bone.get("tail"), "tail", path + "/tail")
        if math.dist(head, tail) < 1e-6:
            _fail("a bone needs a length (head and tail differ)", path + "/tail")
        ids[bone_id] = i
        clean_bones.append({"id": bone_id, "name": name, "parent": bone.get("parent"), "head": head, "tail": tail})
    for i, bone in enumerate(clean_bones):
        parent = bone["parent"]
        if parent is not None and (not isinstance(parent, str) or parent not in ids):
            _fail("a bone's parent must be another bone or null", "/bones/%d/parent" % i)
        seen = {bone["id"]}
        while parent is not None:
            if parent in seen:
                _fail("bone parents form a loop", "/bones/%d/parent" % i)
            seen.add(parent)
            parent = clean_bones[ids[parent]]["parent"]
    clips = params.get("clips", [])
    if not isinstance(clips, list) or len(clips) > MAX_CLIPS:
        _fail("a rig takes at most %d clips" % MAX_CLIPS, "/clips")
    clean_clips: list = []
    for c, clip in enumerate(clips):
        path = "/clips/%d" % c
        if not isinstance(clip, dict) or set(clip) - {"name", "keys"}:
            _fail("a clip is {name, keys}", path)
        name = clip.get("name")
        if not isinstance(name, str) or not 1 <= len(name) <= _NAME_MAX:
            _fail("a clip name is 1 to %d characters" % _NAME_MAX, path + "/name")
        keys = clip.get("keys")
        if not isinstance(keys, list) or not 1 <= len(keys) <= MAX_KEYS_PER_CLIP:
            _fail("a clip takes 1 to %d keys" % MAX_KEYS_PER_CLIP, path + "/keys")
        last: dict = {}
        clean_keys: list = []
        for k, key in enumerate(keys):
            kpath = "%s/keys/%d" % (path, k)
            if not isinstance(key, dict) or set(key) - {"t", "boneId", "rotation"}:
                _fail("a key is {t, boneId, rotation}", kpath)
            t = key.get("t")
            if isinstance(t, bool) or not isinstance(t, (int, float)) or not math.isfinite(t) or not 0 <= t <= 3600:
                _fail("a key time is 0 to 3600 seconds", kpath + "/t")
            bone_id = key.get("boneId")
            if bone_id not in ids:
                _fail("a key names a bone that does not exist", kpath + "/boneId")
            q = key.get("rotation")
            if not isinstance(q, (list, tuple)) or len(q) != 4 or any(
                isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in q
            ):
                _fail("a rotation is a quaternion [x, y, z, w]", kpath + "/rotation")
            norm = math.sqrt(sum(float(v) ** 2 for v in q))
            if not 0.99 <= norm <= 1.01:
                _fail("a rotation must be a unit quaternion", kpath + "/rotation")
            q = [float(v) / norm for v in q]
            previous = last.get(bone_id)
            if previous is not None:
                if t <= previous[0]:
                    _fail("key times must increase for each bone", kpath + "/t")
                if abs(sum(a * b for a, b in zip(previous[1], q))) <= 5e-7:
                    _fail("two keys of one bone are a half turn apart; add a key between them", kpath + "/rotation")
            last[bone_id] = (float(t), q)
            clean_keys.append({"t": float(t), "boneId": bone_id, "rotation": q})
        clean_clips.append({"name": name, "keys": clean_keys})
    return {"bones": clean_bones, "weights": "envelope", "clips": clean_clips}


def _segment_distance(p: tuple, a: list, b: list) -> float:
    ab = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
    ap = (p[0] - a[0], p[1] - a[1], p[2] - a[2])
    length2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2]
    t = 0.0 if length2 == 0 else max(0.0, min(1.0, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / length2))
    return math.dist(p, (a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t))


def envelope_weights(positions: array, bones: list) -> tuple:
    """Per vertex: up to 4 (bone index, weight) pairs, weights summing to 1. Deterministic.

    Returns ``(joints, weights)`` as flat lists of ``4 * vertex_count`` entries."""
    count = len(positions) // 3
    lo, hi = _mesh._bounds(positions)
    falloff = max(0.02 * math.dist(lo, hi), 1e-4)
    joints: list = []
    weights: list = []
    for v in range(count):
        p = (positions[3 * v], positions[3 * v + 1], positions[3 * v + 2])
        near = sorted(((_segment_distance(p, b["head"], b["tail"]), i) for i, b in enumerate(bones)))[:MAX_INFLUENCES]
        raw = [1.0 / (d + falloff) ** 2 for d, _ in near]
        total = sum(raw)
        row = [(i, w / total) for (_, i), w in zip(near, raw)]
        while len(row) < MAX_INFLUENCES:
            row.append((0, 0.0))
        joints.extend(i for i, _ in row)
        weights.extend(w for _, w in row)
    return joints, weights


def build_skinned_glb(*, name: str, decoded: dict, params: dict, material: dict) -> bytes:
    """One skinned mesh node, one joint node per bone, one animation per clip, as GLB bytes."""
    positions = decoded["positions"]
    indices = decoded["indices"]
    vertex_count = len(positions) // 3
    if vertex_count > MAX_RIG_VERTICES:
        raise PlastisError("RIG_TOO_LARGE", "the mesh has %d vertices, over the %d a rig can weight" % (vertex_count, MAX_RIG_VERTICES))
    bones = params["bones"]
    joints, weights = envelope_weights(positions, bones)

    blob = bytearray()
    views: list = []
    accessors: list = []

    def add_view(data: bytes, target: Any = None) -> int:
        _mesh._pad4(blob)
        view = {"buffer": 0, "byteOffset": len(blob), "byteLength": len(data)}
        if target is not None:
            view["target"] = target
        views.append(view)
        blob.extend(data)
        return len(views) - 1

    def add_accessor(view: int, component: int, count: int, kind: str, **extra: Any) -> int:
        accessor = {"bufferView": view, "componentType": component, "count": count, "type": kind}
        accessor.update(extra)
        accessors.append(accessor)
        return len(accessors) - 1

    lo, hi = _mesh._bounds(positions)
    attributes = {"POSITION": add_accessor(add_view(_mesh._le_bytes(positions), 34962), 5126, vertex_count, "VEC3", min=lo, max=hi)}
    if decoded.get("normals") is not None:
        attributes["NORMAL"] = add_accessor(add_view(_mesh._le_bytes(decoded["normals"]), 34962), 5126, vertex_count, "VEC3")
    if decoded.get("uvs") is not None:
        attributes["TEXCOORD_0"] = add_accessor(add_view(_mesh._le_bytes(decoded["uvs"]), 34962), 5126, vertex_count, "VEC2")
    if decoded.get("colors") is not None:
        attributes["COLOR_0"] = add_accessor(add_view(decoded["colors"], 34962), 5121, vertex_count, "VEC4", normalized=True)
    attributes["JOINTS_0"] = add_accessor(add_view(bytes(joints), 34962), 5121, vertex_count, "VEC4")
    attributes["WEIGHTS_0"] = add_accessor(add_view(_mesh._le_bytes(array("f", weights)), 34962), 5126, vertex_count, "VEC4")
    index_type = 5123 if vertex_count <= 65535 else 5125
    packed = array("H" if index_type == 5123 else "I", indices)
    primitive = {
        "attributes": attributes,
        "mode": 4,
        "material": 0,
        "indices": add_accessor(add_view(_mesh._le_bytes(packed), 34963), index_type, len(indices), "SCALAR"),
    }

    # Joint nodes follow the mesh node (index 0). The bind pose is the rest pose, so a joint's local rotation is
    # identity and its translation is its head relative to its parent's head.
    index_of = {b["id"]: i for i, b in enumerate(bones)}
    bone_nodes: list = []
    for b in bones:
        parent = b["parent"]
        base = bones[index_of[parent]]["head"] if parent is not None else [0.0, 0.0, 0.0]
        node: dict = {"name": b["name"], "translation": [b["head"][k] - base[k] for k in range(3)]}
        bone_nodes.append(node)
    for i, b in enumerate(bones):
        if b["parent"] is not None:
            bone_nodes[index_of[b["parent"]]].setdefault("children", []).append(i + 1)
    ibm = array("f")
    for b in bones:  # column-major translate(-head)
        ibm.extend([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -b["head"][0], -b["head"][1], -b["head"][2], 1])
    ibm_accessor = add_accessor(add_view(_mesh._le_bytes(ibm)), 5126, len(bones), "MAT4")
    roots = [i + 1 for i, b in enumerate(bones) if b["parent"] is None]
    skin: dict = {"joints": [i + 1 for i in range(len(bones))], "inverseBindMatrices": ibm_accessor}
    if len(roots) == 1:
        skin["skeleton"] = roots[0]

    animations: list = []
    for clip in params["clips"]:
        per_bone: dict = {}
        for key in clip["keys"]:
            per_bone.setdefault(key["boneId"], []).append(key)
        samplers: list = []
        channels: list = []
        for bone_id in sorted(per_bone, key=lambda b: index_of[b]):
            keys = per_bone[bone_id]
            times = array("f", [k["t"] for k in keys])
            values = array("f", [c for k in keys for c in k["rotation"]])
            t_acc = add_accessor(add_view(_mesh._le_bytes(times)), 5126, len(keys), "SCALAR", min=[float(min(times))], max=[float(max(times))])
            v_acc = add_accessor(add_view(_mesh._le_bytes(values)), 5126, len(keys), "VEC4")
            samplers.append({"input": t_acc, "output": v_acc, "interpolation": "LINEAR"})
            channels.append({"sampler": len(samplers) - 1, "target": {"node": index_of[bone_id] + 1, "path": "rotation"}})
        animations.append({"name": clip["name"], "samplers": samplers, "channels": channels})
    _mesh._pad4(blob)
    mesh_name = (name or "Rigged mesh")[:64]
    gltf: dict = {
        "asset": {"version": "2.0", "generator": "Plastis3D rig"},
        "scene": 0,
        "scenes": [{"nodes": [0] + roots}],
        "nodes": [{"name": mesh_name, "mesh": 0, "skin": 0}] + bone_nodes,
        "meshes": [{"name": mesh_name, "primitives": [primitive]}],
        "skins": [skin],
        "materials": [material],
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"byteLength": len(blob)}],
    }
    if animations:
        gltf["animations"] = animations
    return _glb.build_glb(gltf, [bytes(blob)])
