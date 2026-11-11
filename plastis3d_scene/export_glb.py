"""Plastis3D — pure-Python GLB exporter (PR6 writer + PR8 tiny splice, Stage 3).

Writes a glTF 2.0 binary (GLB) for a scene of primitive meshes, lights,
cameras, and imported models/parts. Stdlib only. Python 3.11-compatible.

Scope (stage-3.md §4.1/§4.4, standalone-editor.md "Export algorithm"
and "0.1.0 tiny splice"): one glTF node per spec node with local TRS
(Euler XYZ degrees → quaternion), parented by the spec ``parent`` link;
primitive meshes from :mod:`plastis3d_scene.primitives` (POSITION +
NORMAL, float32; indices uint16 when the max index fits, else uint32);
one material per spec material; punctual lights via
``KHR_lights_punctual`` in ``extensionsUsed`` only; perspective cameras
with ``yfov`` in radians.

The tiny splice (PR8): once per ``kind=model`` / ``kind=part`` node,
not once per asset. Per asset sha256 the source buffers (whole BIN,
base-offset remap), bufferViews, accessors, meshes, materials,
textures, images, samplers, and the cameras referenced by copied nodes
are copied ONCE; mesh/buffer/accessor/material indexes are shared
across spec nodes referencing the same asset. Node indexes are NOT
shared — a glTF node cannot have two parents, so each ``model`` node
gets fresh glTF nodes for the imported default-scene subtree (same
shared mesh indexes), and each ``part`` node gets its own glTF node
referencing a shared single-primitive mesh (cached by asset sha256 +
meshIndex + primitiveIndex + override material id or None). A
``part`` with a ``materialId`` override re-points its spliced
primitive at that spec material (already in the output materials
array); otherwise it uses the source primitive's copied material, or
no material when the source primitive has none. Splice-copied cameras
precede spec cameras in the output ``cameras`` array. The splice code
lives here, not in :mod:`plastis3d_scene.glb` — that module stays
scan-only, and the splice needs this writer's builder, material
indexes, and node-emission order (see
``docs/planning/stages/pr8-decisions-and-follow-ups-2026-11-07.md``
D7). W05 then compacts core resource references and live BIN ranges,
retaining tables/bytes when extension semantics are opaque. Plain skins and
clips proven unused outside the copied subtree are omitted before validation;
used or uncertain references remain fail-closed. Clip labels are qualified by
stable output instance and clip indices; channel bindings remain node-based.

Fail-closed cuts (no file is written on any of them):

* primitive animation key times or values that cannot be represented in
  float32, or whose strict ordering collapses in float32 → ``EXPORT_FAILED``.
* no mesh nodes and no model/part nodes → ``EXPORT_EMPTY``.
* splice refusals (``EXPORT_FAILED``; the reason word — ``sparse``,
  ``mode``, ``morph``, ``skin``, ``animation``, ``extension``,
  ``index``, ``scene`` — is named in the message): a sparse accessor
  on any copied accessor; an effective primitive mode other than 4 on
  any copied primitive (a missing ``mode`` reads as 4); a skin, an
  animation channel or a skeleton that names a node outside the copied
  default-scene subtree, or any skin/animation/channel/sampler index
  outside the copied set (PR13: skins, animations and morph targets are
  now *rebased*, not refused, but only when every reference stays inside
  the copy); a ``part`` whose primitive is skinned or has morph targets
  (C-05: deformation reaches export only through a locked ``model``); a
  non-empty ``extensionsRequired``; unsupported node or document
  extensions (``KHR_lights_punctual`` is copied with rebased light indexes);
  any ``extensions`` object on a mesh, primitive, camera, or selected scene;
  an ``extensionsUsed`` name outside punctual lights or copied material/texture JSON
  (material/texture extensions, including clearcoat, ride along); any
  index (mesh/material/accessor/node/camera/texture/image/sampler)
  outside the copied set; a missing asset file on disk, or an asset
  file whose sha256 does not match its row; an empty ``scenes``
  array, an out-of-range ``scene`` index, or a selected scene with no
  nodes to copy. An absent ``scenes`` array copies every unparented
  node as roots (mirroring the import exploder's rule).
* the 30-second budget (``EXPORT_TIMEOUT``) — a default, not a host
  limit (standalone-editor.md, Caps table).

``EXPORT_IMPORT_UNMERGED`` is no longer raised by export (PR8): the
splice accepts the files it used to refuse, and every splice refusal
is ``EXPORT_FAILED``. The code stays defined in
``spec.ERROR_HTTP_STATUS`` (409) for compatibility; nothing raises it.

Invisible nodes ARE emitted: visibility is editor-only in 0.1.0; there
is no culling. No ``TEXCOORD_0`` is written in PR6: the generators
produce no UVs; the design's §4.2 "UVs" line describes the packer for
future UV-carrying meshes.

The output is written via a temp file + ``os.replace`` into
``exports/<id>-r<revision>.glb``; the temp is removed on any failure,
so a refused or timed-out export never leaves a partial file. Export
does not mutate the scene (no revision bump).
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
import os
import re
import unicodedata
import struct
import tempfile
import time
from typing import Any, Optional

from . import glb as _glb
from . import primitives
from .spec import (
    ASSET_FILE_EXTENSIONS,
    IMAGE_ASSET_FORMATS,
    MATERIAL_MAP_FIELDS,
    PlastisError,
    compute_stats,
)
from .validate import validate_scene

# The export budget (standalone-editor.md, Caps table): 30 s is a
# default, not a host limit.
EXPORT_TIMEOUT = 30.0

_GLB_MAGIC = 0x46546C67
_GLB_VERSION = 2
_CHUNK_JSON = 0x4E4F534A  # "JSON"
_CHUNK_BIN = 0x004E4942  # "BIN\0"

# A spot light with no stored cone angle exports with three.js's
# SpotLight default (60 degrees); penumbra defaults to 0.
_SPOT_DEFAULT_ANGLE_DEGREES = 60.0

# Core PBR texture slots on a material. `baseColorTexture` and
# `metallicRoughnessTexture` live inside `pbrMetallicRoughness`;
# the other three are top-level material keys. Each holds
# `{"index": <texture>}`.
_PBR_TEXTURE_SLOTS = ("baseColorTexture", "metallicRoughnessTexture")
_TOP_TEXTURE_SLOTS = ("normalTexture", "occlusionTexture", "emissiveTexture")



def export_filename(scene: dict) -> str:
    """The saved file's name: the scene's name as a plain file name, ``<name>.glb``.

    Letters and digits of any script are kept, accents are dropped, every other run of characters becomes one
    hyphen, and the name is cut at 60 characters. A name with nothing usable falls back to the scene id.
    Hermes Desktop's Save dialog shows the name the gateway serves the file under, so this is what people see.
    """
    name = unicodedata.normalize("NFKD", str(scene.get("name") or ""))
    name = "".join(ch for ch in name if not unicodedata.combining(ch))
    base = re.sub(r"[\W_]+", "-", name).strip("-")[:60].strip("-")
    return "%s.glb" % (base or scene["id"])

def _material_texture_refs(material: dict):
    """Yield ``(where, ref)`` for every core texture ref on a material.

    ``where`` names the slot for error messages; ``ref`` is the
    ``{"index": ...}`` dict itself (mutating it remaps the material).
    """
    pbr = material.get("pbrMetallicRoughness")
    if isinstance(pbr, dict):
        for slot in _PBR_TEXTURE_SLOTS:
            ref = pbr.get(slot)
            if isinstance(ref, dict):
                yield "pbrMetallicRoughness.%s" % slot, ref
    for slot in _TOP_TEXTURE_SLOTS:
        ref = material.get(slot)
        if isinstance(ref, dict):
            yield slot, ref


def _fail(code: str, message: str, path: Optional[str] = None) -> None:
    raise PlastisError(code, "%s: %s" % (code, message), path=path)


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _hex_rgb(color: str) -> list:
    """``#rrggbb`` → ``[r, g, b]`` in 0..1."""
    value = int(color[1:], 16)
    return [((value >> 16) & 0xFF) / 255.0, ((value >> 8) & 0xFF) / 255.0, (value & 0xFF) / 255.0]


def _matrix_to_quaternion(matrix: list) -> list:
    """Row-major 3x3 rotation matrix → glTF quaternion ``[x, y, z, w]``."""
    trace = matrix[0][0] + matrix[1][1] + matrix[2][2]
    if trace > 0.0:
        s = math.sqrt(trace + 1.0) * 2.0
        w = 0.25 * s
        x = (matrix[2][1] - matrix[1][2]) / s
        y = (matrix[0][2] - matrix[2][0]) / s
        z = (matrix[1][0] - matrix[0][1]) / s
    elif matrix[0][0] > matrix[1][1] and matrix[0][0] > matrix[2][2]:
        s = math.sqrt(1.0 + matrix[0][0] - matrix[1][1] - matrix[2][2]) * 2.0
        w = (matrix[2][1] - matrix[1][2]) / s
        x = 0.25 * s
        y = (matrix[0][1] + matrix[1][0]) / s
        z = (matrix[0][2] + matrix[2][0]) / s
    elif matrix[1][1] > matrix[2][2]:
        s = math.sqrt(1.0 + matrix[1][1] - matrix[0][0] - matrix[2][2]) * 2.0
        w = (matrix[0][2] - matrix[2][0]) / s
        x = (matrix[0][1] + matrix[1][0]) / s
        y = 0.25 * s
        z = (matrix[1][2] + matrix[2][1]) / s
    else:
        s = math.sqrt(1.0 + matrix[2][2] - matrix[0][0] - matrix[1][1]) * 2.0
        w = (matrix[1][0] - matrix[0][1]) / s
        x = (matrix[0][2] + matrix[2][0]) / s
        y = (matrix[1][2] + matrix[2][1]) / s
        z = 0.25 * s
    return [x, y, z, w]


def _float32(values: list) -> list:
    """Round floats to float32, the precision the GLB actually stores."""
    packed = struct.pack("<%df" % len(values), *values)
    return list(struct.unpack("<%df" % len(values), packed))


# Health uses a bounded working set; this is not a product export/file-size cap.
DEFAULT_INSPECTION_BYTES = 32 * 1024 * 1024


class ExportInspectionLimit(PlastisError):
    def __init__(self):
        super().__init__("EXPORT_FAILED", "prospective export exceeds the bounded inspection working set")


class _BinBuilder:
    """Appends attribute/index blobs to one buffer, 4-byte aligned.

    Each ``add`` returns ``(byteOffset, byteLength)``; the length is
    the data's own length (alignment padding between blobs belongs to
    the buffer, not to any view).
    """

    def __init__(self, inspection_limit=None) -> None:
        self.data = bytearray()
        self.inspection_limit, self.metadata_bytes = inspection_limit, 0

    def reserve_metadata_size(self, size):
        if self.inspection_limit is not None:
            if len(self.data) + self.metadata_bytes + size > self.inspection_limit:
                raise ExportInspectionLimit()
            self.metadata_bytes += size

    def reserve_metadata(self, value):
        if self.inspection_limit is not None:
            # Account for index/name growth before copying source/instance tables.
            self.reserve_metadata_size(len(json.dumps(value, separators=(",", ":"))) * 2 + 512)

    def add(self, blob: bytes) -> tuple:
        pad = (-len(self.data)) % 4
        if self.inspection_limit is not None and len(self.data) + self.metadata_bytes + pad + len(blob) > self.inspection_limit:
            raise ExportInspectionLimit()
        if pad:
            self.data.extend(b"\x00" * pad)
        offset = len(self.data)
        self.data.extend(blob)
        return offset, len(blob)


def _check_deadline(deadline: float) -> None:
    if time.monotonic() >= deadline:
        _fail(
            "EXPORT_TIMEOUT",
            "export exceeded the %.0f-second budget; nothing was written" % EXPORT_TIMEOUT,
        )


# --- Tiny splice (PR8) ---------------------------------------------------------
# The per-asset copy. `out` holds the output arrays the splice appends
# to (shared with the PR6 writer's spec meshes/materials, which are
# emitted first): bufferViews, accessors, images, samplers, textures,
# materials, meshes, cameras (spliced cameras only — spec cameras are
# appended after them by the caller).


def _check_extension_indexes(
    value: Any, texture_count: int, image_count: int, *, check_source: bool, where: str
) -> None:
    """Validate every ``index`` / ``source`` inside an extensions object.

    An integer ``index`` is a texture index (the design shifts it by
    the texture base on copy); an integer ``source`` inside a *texture*
    extension is an image index (``EXT_texture_webp``). Anything
    outside the copied set, or a non-integer in either slot, is
    ``EXPORT_FAILED`` with reason ``index``. ``texCoord`` is not an
    index and is never touched.
    """
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "index":
                if not _is_int(child) or child < 0 or child >= texture_count:
                    _fail(
                        "EXPORT_FAILED",
                        "index: %s extension index %r is outside the copied texture set"
                        % (where, child),
                        path="/assets",
                    )
            elif key == "source" and check_source:
                if not _is_int(child) or child < 0 or child >= image_count:
                    _fail(
                        "EXPORT_FAILED",
                        "index: %s extension source %r is outside the copied image set"
                        % (where, child),
                        path="/assets",
                    )
            else:
                _check_extension_indexes(
                    child, texture_count, image_count, check_source=check_source, where=where
                )
    elif isinstance(value, list):
        for child in value:
            _check_extension_indexes(
                child, texture_count, image_count, check_source=check_source, where=where
            )


def _remap_extension_indexes(
    value: Any, texture_base: int, image_base: int, *, remap_source: bool
) -> None:
    """Shift ``index`` (texture base) / ``source`` (image base, texture
    extensions only) inside an extensions object, in place."""
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "index" and _is_int(child):
                value[key] = texture_base + child
            elif key == "source" and remap_source and _is_int(child):
                value[key] = image_base + child
            else:
                _remap_extension_indexes(child, texture_base, image_base, remap_source=remap_source)
    elif isinstance(value, list):
        for child in value:
            _remap_extension_indexes(child, texture_base, image_base, remap_source=remap_source)


class _SplicedAsset:
    """One asset's copied data: base indexes into the output arrays,
    the copied default-scene roots, and the extension names the copy
    carries (for the output ``extensionsUsed``)."""

    def __init__(
        self,
        sha: str,
        gltf: dict,
        *,
        roots: list,
        other_scene_count: int,
        buffer_base: list,
        buffer_view_base: list,
        accessor_base: int,
        image_base: int,
        sampler_base: int,
        texture_base: int,
        material_base: int,
        mesh_base: int,
        camera_map: dict,
        extension_names: set,
        reachable: Optional[list] = None,
    ) -> None:
        self.sha = sha
        self.gltf = gltf
        self.roots = roots
        self.other_scene_count = other_scene_count
        self.buffer_base = buffer_base
        self.buffer_view_base = buffer_view_base
        self.accessor_base = accessor_base
        self.image_base = image_base
        self.sampler_base = sampler_base
        self.texture_base = texture_base
        self.material_base = material_base
        self.mesh_base = mesh_base
        self.camera_map = camera_map
        self.extension_names = extension_names
        self.reachable = reachable or []


_ANIMATION_PATHS = ("translation", "rotation", "scale", "weights")
_INTERPOLATIONS = ("LINEAR", "STEP", "CUBICSPLINE")


def _prune_unused_deformation(gltf: dict, reachable: list) -> tuple:
    """Omit proven unused records; used/mixed/extension references stay fail-closed."""
    inside = set(reachable)
    skins = gltf.get("skins") or []
    used = set()
    for index in reachable:
        value = gltf["nodes"][index].get("skin")
        if value is not None:
            if not _is_int(value) or not 0 <= value < len(skins):
                _fail("EXPORT_FAILED", "index: node %d skin is outside the source skin set" % index, path="/assets")
            used.add(value)
    # Unknown extension semantics cannot prove an unused record harmless.
    keep_skins = [i for i, row in enumerate(skins) if i in used or not isinstance(row, dict) or row.get("extensions")]
    mapping = {old: new for new, old in enumerate(keep_skins)}
    animations = gltf.get("animations") or []
    keep_animations = []
    for animation in animations:
        channels = animation.get("channels") if isinstance(animation, dict) else None
        proven_targets = isinstance(channels, list) and not animation.get("extensions") and all(
            isinstance(c, dict) and not c.get("extensions") and isinstance(c.get("target"), dict)
            and not c["target"].get("extensions") and _is_int(c["target"].get("node"))
            for c in channels)
        if not proven_targets or any(c["target"]["node"] in inside for c in channels):
            keep_animations.append(animation)
    new = dict(gltf)
    new["nodes"] = list(gltf.get("nodes", []))
    for index in reachable:
        node = new["nodes"][index]
        if "skin" in node:
            new["nodes"][index] = dict(node, skin=mapping[node["skin"]])
    if "skins" in gltf:
        new["skins"] = [skins[i] for i in keep_skins]
    if "animations" in gltf:
        new["animations"] = keep_animations
    return new, {"skins": len(skins) - len(keep_skins), "clips": len(animations) - len(keep_animations)}


def _clip_name(owner: str, index: int, ordinal: int, name) -> str:
    # Stable output instance/clip indices distinguish even identical display names.
    return "[%d:%d] %s / %s" % (index, ordinal, owner, name or "Animation")


def _check_deformation(gltf: dict, label: str, reachable: list, accessor_count: int) -> None:
    """Prove every skin, animation and morph reference stays inside the copy.

    The splice copies skins and animations once per ``model`` node, with
    their node references pointed at that instance's fresh nodes, so a
    reference to a node the copy does not contain cannot be rebased. Each
    such reference is ``EXPORT_FAILED`` (reason ``index``); so are
    extension objects on these records, which the splice does not
    rewrite, and a malformed record. Called once per asset, before any
    byte is copied.
    """
    inside = set(reachable)
    nodes_src = gltf.get("nodes", []) or []
    skins = gltf.get("skins", []) or []
    animations = gltf.get("animations", []) or []
    meshes = gltf.get("meshes", []) or []

    def bad(reason: str, text: str) -> None:
        _fail("EXPORT_FAILED", "%s: %s %s" % (reason, label, text), path="/assets")

    def accessor_ok(value: Any) -> bool:
        return _is_int(value) and 0 <= value < accessor_count

    for index, skin in enumerate(skins):
        what = "skin %d" % index
        if not isinstance(skin, dict):
            bad("skin", "%s must be an object" % what)
        if skin.get("extensions"):
            bad("extension", "%s has an extensions object" % what)
        joints = skin.get("joints")
        if not isinstance(joints, list) or not joints:
            bad("skin", "%s needs a non-empty joints list" % what)
        if len(set(joints)) != len(joints):
            bad("skin", "%s lists a joint twice" % what)
        for joint in joints:
            if not _is_int(joint) or joint not in inside:
                bad(
                    "index",
                    "%s joint %r is outside the copied default-scene subtree" % (what, joint),
                )
        skeleton = skin.get("skeleton")
        if skeleton is not None and (not _is_int(skeleton) or skeleton not in inside):
            bad(
                "index",
                "%s skeleton %r is outside the copied default-scene subtree" % (what, skeleton),
            )
        matrices = skin.get("inverseBindMatrices")
        if matrices is not None:
            if not accessor_ok(matrices):
                bad("index", "%s inverseBindMatrices %r is outside the copied accessor set" % (what, matrices))
            accessor = gltf["accessors"][matrices]
            if accessor.get("type") != "MAT4" or accessor.get("count", 0) < len(joints):
                bad("skin", "%s inverseBindMatrices must be a MAT4 accessor with one entry per joint" % what)

    for index, animation in enumerate(animations):
        what = "animation %d" % index
        if not isinstance(animation, dict):
            bad("animation", "%s must be an object" % what)
        if animation.get("extensions"):
            bad("extension", "%s has an extensions object" % what)
        samplers = animation.get("samplers")
        channels = animation.get("channels")
        if not isinstance(samplers, list) or not isinstance(channels, list):
            bad("animation", "%s needs samplers and channels lists" % what)
        for s_index, sampler in enumerate(samplers):
            if not isinstance(sampler, dict) or sampler.get("extensions"):
                bad("extension", "%s sampler %d is malformed or has an extensions object" % (what, s_index))
            if not accessor_ok(sampler.get("input")) or not accessor_ok(sampler.get("output")):
                bad("index", "%s sampler %d names an accessor outside the copied set" % (what, s_index))
            interpolation = sampler.get("interpolation", "LINEAR")
            if interpolation not in _INTERPOLATIONS:
                bad("animation", "%s sampler %d interpolation %r is not a glTF value" % (what, s_index, interpolation))
        for c_index, channel in enumerate(channels):
            if not isinstance(channel, dict) or channel.get("extensions"):
                bad("extension", "%s channel %d is malformed or has an extensions object" % (what, c_index))
            sampler = channel.get("sampler")
            if not _is_int(sampler) or not 0 <= sampler < len(samplers):
                bad("index", "%s channel %d sampler %r is outside the copied sampler set" % (what, c_index, sampler))
            target = channel.get("target")
            if not isinstance(target, dict) or target.get("extensions"):
                bad("extension", "%s channel %d has a malformed target or a target extensions object" % (what, c_index))
            if target.get("path") not in _ANIMATION_PATHS:
                bad("animation", "%s channel %d targets path %r, which is not translation, rotation, scale or weights" % (what, c_index, target.get("path")))
            node = target.get("node")
            if not _is_int(node) or node not in inside:
                bad(
                    "index",
                    "%s channel %d targets node %r, which is outside the copied default-scene subtree"
                    % (what, c_index, node),
                )

    for index in reachable:
        node = nodes_src[index]
        skin = node.get("skin")
        if skin is not None and (not _is_int(skin) or not 0 <= skin < len(skins)):
            bad("index", "node %d skin %r is outside the copied skin set" % (index, skin))

    target_counts: dict = {}
    for mesh_index, mesh in enumerate(meshes):
        counts = set()
        for prim_index, primitive in enumerate(mesh.get("primitives", []) or []):
            targets = primitive.get("targets")
            if targets is None:
                counts.add(0)
                continue
            if not isinstance(targets, list):
                bad("morph", "mesh %d primitive %d targets must be a list" % (mesh_index, prim_index))
            for target in targets:
                if not isinstance(target, dict) or not all(accessor_ok(v) for v in target.values()):
                    bad("index", "mesh %d primitive %d has a morph target accessor outside the copied set" % (mesh_index, prim_index))
            counts.add(len(targets))
        if len(counts) > 1:
            bad("morph", "mesh %d has primitives with different morph target counts" % mesh_index)
        target_counts[mesh_index] = next(iter(counts), 0)
        weights = mesh.get("weights")
        if weights is not None and (not isinstance(weights, list) or len(weights) != target_counts[mesh_index]):
            bad("morph", "mesh %d weights do not match its morph target count" % mesh_index)
    for index in reachable:
        node = nodes_src[index]
        weights = node.get("weights")
        if weights is not None:
            mesh_index = node.get("mesh")
            expected = target_counts.get(mesh_index, 0) if mesh_index is not None else 0
            if not isinstance(weights, list) or len(weights) != expected:
                bad("morph", "node %d weights do not match its mesh's morph target count" % index)


def _splice_asset(asset: dict, store: Any, builder: _BinBuilder, out: dict, deadline: float) -> _SplicedAsset:
    """Copy one asset's data arrays into the output document.

    Re-reads the asset file, verifies its sha256, re-scans it
    (``glb.scan`` — accessor ranges are re-proven before any byte is
    copied), applies every §8 refusal cut, then appends the copied
    arrays to ``out`` and returns the base indexes. Raises
    :class:`PlastisError` ``EXPORT_FAILED`` (or ``EXPORT_TIMEOUT``)
    and writes nothing on any refusal.
    """
    sha = asset.get("sha256")
    asset_id = asset.get("id")
    asset_path = store.assets_dir / ("%s.glb" % sha)
    if not asset_path.is_file():
        _fail(
            "EXPORT_FAILED",
            "asset %r file is missing on disk (assets/%s.glb); export refuses "
            "rather than dropping the import" % (asset_id, sha),
            path="/assets",
        )
    try:
        data = asset_path.read_bytes()
    except OSError as exc:
        _fail(
            "EXPORT_FAILED",
            "cannot read asset %r: %s" % (asset_id, exc),
            path="/assets",
        )
    if hashlib.sha256(data).hexdigest() != sha:
        _fail(
            "EXPORT_FAILED",
            "asset %r file does not match its sha256; the stored bytes changed "
            "since import" % asset_id,
            path="/assets",
        )
    try:
        scan = _glb.scan(data, source_format="glb", deadline=deadline)
    except PlastisError as exc:
        if exc.code == "IMPORT_TIMEOUT":
            _fail(
                "EXPORT_TIMEOUT",
                "export exceeded the %.0f-second budget while scanning asset %r; "
                "nothing was written" % (EXPORT_TIMEOUT, asset_id),
            )
        _fail(
            "EXPORT_FAILED",
            "asset %r cannot be spliced: %s" % (asset_id, exc.message),
            path="/assets",
        )
        raise AssertionError("unreachable")
    gltf = scan.gltf
    buffers = scan.buffers
    label = "asset %r" % asset_id

    # --- Categorical refusals (whole document) ------------------------------
    # Skins, animations and morph targets are no longer refused (PR13):
    # they are validated against the copied subtree below and rebased
    # per model instance. Only references that leave the copy refuse.
    if gltf.get("extensionsRequired"):
        _fail(
            "EXPORT_FAILED",
            "extension: %s has a non-empty extensionsRequired (%s)"
            % (label, list(gltf["extensionsRequired"])),
            path="/assets",
        )
    nodes_src = gltf.get("nodes", []) or []
    meshes_src = gltf.get("meshes", []) or []
    materials_src = gltf.get("materials", []) or []
    textures_src = gltf.get("textures", []) or []
    images_src = gltf.get("images", []) or []
    samplers_src = gltf.get("samplers", []) or []
    cameras_src = gltf.get("cameras", []) or []

    # --- Scene selection ------------------------------------------------------
    # Omitted `scene` → index 0. Empty `scenes` → fail. Absent `scenes`
    # → every unparented node is a root (the import exploder's rule).
    scenes = gltf.get("scenes")
    if scenes is None:
        parented: set = set()
        for node in nodes_src:
            parented.update(node.get("children", []) or [])
        roots = [i for i in range(len(nodes_src)) if i not in parented]
        other_scene_count = 0
    elif not scenes:
        _fail(
            "EXPORT_FAILED",
            "scene: %s has an empty scenes array; no scene to copy" % label,
            path="/assets",
        )
    else:
        scene_index = gltf.get("scene", 0)
        if not _is_int(scene_index) or scene_index < 0 or scene_index >= len(scenes):
            _fail(
                "EXPORT_FAILED",
                "scene: %s scene index %r is out of range" % (label, scene_index),
                path="/assets",
            )
        scene_obj = scenes[scene_index]
        if isinstance(scene_obj, dict) and scene_obj.get("extensions"):
            _fail(
                "EXPORT_FAILED",
                "extension: %s selected scene has an extensions object" % label,
                path="/assets",
            )
        roots = list(scene_obj.get("nodes", []) or [])
        other_scene_count = len(scenes) - 1
    if not roots:
        _fail(
            "EXPORT_FAILED",
            "scene: %s selected scene has no nodes to copy" % label,
            path="/assets",
        )

    # Punctual lights are also emitted by our own writer. Other node and
    # document extensions still need an explicit copying implementation.
    document_extensions = gltf.get("extensions", {}) or {}
    if not isinstance(document_extensions, dict) or set(document_extensions) - {"KHR_lights_punctual"}:
        _fail("EXPORT_FAILED", "extension: %s has unsupported top-level extensions" % label, path="/assets")
    punctual = document_extensions.get("KHR_lights_punctual", {})
    if not isinstance(punctual, dict) or punctual.get("extensions"):
        _fail("EXPORT_FAILED", "extension: %s has unsupported punctual-light metadata" % label, path="/assets")
    for light in punctual.get("lights", []):
        if not isinstance(light, dict) or light.get("extensions") or (isinstance(light.get("spot"), dict) and light["spot"].get("extensions")):
            _fail("EXPORT_FAILED", "extension: %s has unsupported light extensions" % label, path="/assets")
    # --- Copied nodes: reachable from the roots ----------------------------
    reachable: list = []
    seen: set = set()
    stack = list(reversed(roots))
    while stack:
        index = stack.pop()
        if index in seen:
            _fail(
                "EXPORT_FAILED",
                "index: %s node %d is listed twice; a glTF node cannot have two parents"
                % (label, index),
                path="/assets",
            )
        seen.add(index)
        reachable.append(index)
        node = nodes_src[index]
        node_extensions = node.get("extensions", {}) or {}
        if not isinstance(node_extensions, dict):
            _fail("EXPORT_FAILED", "extension: %s node %d extensions must be an object" % (label, index), path="/assets")
        light_ref = node_extensions.get("KHR_lights_punctual", {})
        if light_ref.get("extensions"):
            _fail("EXPORT_FAILED", "extension: %s has unsupported light-reference extensions" % label, path="/assets")
        if set(node_extensions) - {"KHR_lights_punctual"}:
            _fail(
                "EXPORT_FAILED",
                "extension: %s node %d has an extensions object (%s); node-level "
                "extensions are not spliced" % (label, index, sorted(node["extensions"])),
                path="/assets",
            )
        for child in reversed(node.get("children", []) or []):
            stack.append(child)

    gltf, pruned_deformation = _prune_unused_deformation(gltf, reachable)
    nodes_src = gltf.get("nodes", [])
    _check_deformation(
        gltf, label, reachable, len(gltf.get("accessors", []) or [])
    )

    # --- Copied meshes / primitives ------------------------------------------
    for mesh_index, mesh in enumerate(meshes_src):
        if mesh.get("extensions"):
            _fail(
                "EXPORT_FAILED",
                "extension: %s mesh %d has an extensions object" % (label, mesh_index),
                path="/assets",
            )
        for prim_index, primitive in enumerate(mesh.get("primitives", []) or []):
            what = "%s mesh %d primitive %d" % (label, mesh_index, prim_index)
            if primitive.get("extensions"):
                _fail(
                    "EXPORT_FAILED",
                    "extension: %s has an extensions object" % what,
                    path="/assets",
                )
            if primitive.get("mode", 4) != 4:
                _fail(
                    "EXPORT_FAILED",
                    "mode: %s has effective mode %r, not TRIANGLES (4); a missing "
                    "mode reads as 4" % (what, primitive.get("mode")),
                    path="/assets",
                )
            material = primitive.get("material")
            if material is not None and (
                not _is_int(material) or material < 0 or material >= len(materials_src)
            ):
                _fail(
                    "EXPORT_FAILED",
                    "index: %s material %r is outside the copied material set"
                    % (what, material),
                    path="/assets",
                )

    # --- Copied accessors: sparse refused ------------------------------------
    for acc_index, accessor in enumerate(gltf.get("accessors", []) or []):
        if "sparse" in accessor:
            _fail(
                "EXPORT_FAILED",
                "sparse: %s accessor %d is sparse" % (label, acc_index),
                path="/assets",
            )

    # --- Copied bufferViews: buffer + range ----------------------------------
    for view_index, view in enumerate(gltf.get("bufferViews", []) or []):
        buffer_index = view.get("buffer")
        if not _is_int(buffer_index) or buffer_index < 0 or buffer_index >= len(buffers):
            _fail(
                "EXPORT_FAILED",
                "index: %s bufferView %d buffer %r is outside the copied buffer set"
                % (label, view_index, buffer_index),
                path="/assets",
            )
        offset = view.get("byteOffset", 0)
        length = view.get("byteLength")
        if (
            not _is_int(offset)
            or offset < 0
            or not _is_int(length)
            or length < 0
            or offset + length > len(buffers[buffer_index])
        ):
            _fail(
                "EXPORT_FAILED",
                "index: %s bufferView %d byte range [%r, %r) exceeds buffer %d (%d bytes)"
                % (label, view_index, offset, length, buffer_index, len(buffers[buffer_index])),
                path="/assets",
            )

    # --- Textures / images / materials: index checks + extension names ------
    for tex_index, texture in enumerate(textures_src):
        source = texture.get("source")
        if source is not None and (not _is_int(source) or source < 0 or source >= len(images_src)):
            _fail(
                "EXPORT_FAILED",
                "index: %s texture %d source %r is outside the copied image set"
                % (label, tex_index, source),
                path="/assets",
            )
        sampler = texture.get("sampler")
        if sampler is not None and (not _is_int(sampler) or sampler < 0 or sampler >= len(samplers_src)):
            _fail(
                "EXPORT_FAILED",
                "index: %s texture %d sampler %r is outside the copied sampler set"
                % (label, tex_index, sampler),
                path="/assets",
            )
        if texture.get("extensions"):
            _check_extension_indexes(
                texture["extensions"], len(textures_src), len(images_src),
                check_source=True, where="%s texture %d" % (label, tex_index),
            )
    for img_index, image in enumerate(images_src):
        view = image.get("bufferView")
        if view is not None and (
            not _is_int(view) or view < 0 or view >= len(gltf.get("bufferViews", []) or [])
        ):
            _fail(
                "EXPORT_FAILED",
                "index: %s image %d bufferView %r is outside the copied bufferView set"
                % (label, img_index, view),
                path="/assets",
            )
    extension_names: set = set()
    for mat_index, material in enumerate(materials_src):
        for where, ref in _material_texture_refs(material):
            index = ref.get("index")
            if not _is_int(index) or index < 0 or index >= len(textures_src):
                _fail(
                    "EXPORT_FAILED",
                    "index: %s material %d %s index %r is outside the copied texture set"
                    % (label, mat_index, where, index),
                    path="/assets",
                )
        if material.get("extensions"):
            extension_names.update(material["extensions"].keys())
            _check_extension_indexes(
                material["extensions"], len(textures_src), len(images_src),
                check_source=False, where="%s material %d" % (label, mat_index),
            )
    for texture in textures_src:
        if texture.get("extensions"):
            extension_names.update(texture["extensions"].keys())
    for name in gltf.get("extensionsUsed", []) or []:
        if name == "KHR_lights_punctual" and name in document_extensions:
            continue
        if name not in extension_names:
            _fail(
                "EXPORT_FAILED",
                "extension: %s extensionsUsed names %r, which is not on any copied "
                "material or texture JSON" % (label, name),
                path="/assets",
            )

    # --- Copied cameras: referenced by copied nodes only, source order ------
    referenced_cameras: list = []
    for index in reachable:
        camera = nodes_src[index].get("camera")
        if camera is not None and camera not in referenced_cameras:
            referenced_cameras.append(camera)
    for camera in referenced_cameras:
        if cameras_src[camera].get("extensions"):
            _fail(
                "EXPORT_FAILED",
                "extension: %s camera %d has an extensions object" % (label, camera),
                path="/assets",
            )

    # --- Copy ------------------------------------------------------------------
    _check_deadline(deadline)
    builder.reserve_metadata({key: gltf.get(key, []) for key in ("bufferViews", "accessors", "images", "samplers", "textures", "materials", "meshes", "cameras", "extensions")})
    # Buffers: whole-BIN copy, one base offset per source buffer (the
    # one-buffer case is the same path with one base). The general
    # remap also covers a stored .glb with extra data: buffers.
    buffer_base: list = []
    for content in buffers:
        offset, _length = builder.add(bytes(content))
        buffer_base.append(offset)
    buffer_view_base: list = []
    for view in gltf.get("bufferViews", []) or []:
        new_view = copy.deepcopy(view)
        new_view["buffer"] = 0
        new_view["byteOffset"] = (
            buffer_base[view.get("buffer", 0)] + view.get("byteOffset", 0)
        )
        buffer_view_base.append(len(out["bufferViews"]))
        out["bufferViews"].append(new_view)
    accessor_base = len(out["accessors"])
    for accessor in gltf.get("accessors", []) or []:
        new_accessor = copy.deepcopy(accessor)
        if "bufferView" in new_accessor:
            new_accessor["bufferView"] = buffer_view_base[new_accessor["bufferView"]]
        out["accessors"].append(new_accessor)
    image_base = len(out["images"])
    for image in images_src:
        new_image = copy.deepcopy(image)
        if "bufferView" in new_image:
            new_image["bufferView"] = buffer_view_base[new_image["bufferView"]]
        out["images"].append(new_image)
    sampler_base = len(out["samplers"])
    for sampler in samplers_src:
        out["samplers"].append(copy.deepcopy(sampler))
    texture_base = len(out["textures"])
    for texture in textures_src:
        new_texture = copy.deepcopy(texture)
        if "source" in new_texture:
            new_texture["source"] = image_base + new_texture["source"]
        if "sampler" in new_texture:
            new_texture["sampler"] = sampler_base + new_texture["sampler"]
        if new_texture.get("extensions"):
            _remap_extension_indexes(
                new_texture["extensions"], texture_base, image_base, remap_source=True
            )
        out["textures"].append(new_texture)
    material_base = len(out["materials"])
    for material in materials_src:
        new_material = copy.deepcopy(material)
        for _where, ref in _material_texture_refs(new_material):
            ref["index"] = texture_base + ref["index"]
        if new_material.get("extensions"):
            _remap_extension_indexes(
                new_material["extensions"], texture_base, image_base, remap_source=False
            )
        out["materials"].append(new_material)
    mesh_base = len(out["meshes"])
    for mesh in meshes_src:
        new_mesh = copy.deepcopy(mesh)
        for primitive in new_mesh.get("primitives", []) or []:
            primitive["attributes"] = {
                key: accessor_base + value
                for key, value in primitive["attributes"].items()
            }
            if "indices" in primitive:
                primitive["indices"] = accessor_base + primitive["indices"]
            if "material" in primitive:
                primitive["material"] = material_base + primitive["material"]
            if "targets" in primitive:
                primitive["targets"] = [
                    {key: accessor_base + value for key, value in target.items()}
                    for target in primitive["targets"]
                ]
        out["meshes"].append(new_mesh)
    camera_map: dict = {}
    for old_camera in referenced_cameras:
        camera_map[old_camera] = len(out["cameras"])
        out["cameras"].append(copy.deepcopy(cameras_src[old_camera]))

    spliced = _SplicedAsset(
        sha,
        gltf,
        roots=roots,
        other_scene_count=other_scene_count,
        buffer_base=buffer_base,
        buffer_view_base=buffer_view_base,
        accessor_base=accessor_base,
        image_base=image_base,
        sampler_base=sampler_base,
        texture_base=texture_base,
        material_base=material_base,
        mesh_base=mesh_base,
        camera_map=camera_map,
        extension_names=extension_names,
        reachable=reachable,
    )
    spliced.pruned_deformation = pruned_deformation
    return spliced


def _instance_nodes(
    spliced: _SplicedAsset,
    first_index: int,
    skins_out: Optional[list] = None,
    animations_out: Optional[list] = None,
    *, owner_name="Model", owner_index=None, lights_out=None,
) -> tuple:
    """Fresh glTF nodes for one ``model`` node's copy of the asset subtree.

    Returns ``(nodes, root_indexes)``: the copied nodes in pre-order
    (parents before children, siblings in source order) starting at
    ``first_index``, and the fresh indexes of the default-scene roots.
    Mesh/camera indexes are the shared per-asset ones; children point
    at the fresh indexes of this instance. Node JSON (name, TRS or
    ``matrix``, extras) is copied verbatim.

    Skins and animations (PR13) belong to the instance, because their
    joints and channel targets are node indexes: this instance's copy of
    every source skin and animation is appended to ``skins_out`` /
    ``animations_out`` with those references pointed at the fresh nodes.
    Accessors (inverse bind matrices, sampler input/output) stay the
    shared per-asset copy. ``_check_deformation`` already proved that
    every reference lands inside the copied subtree.
    """
    nodes_src = spliced.gltf.get("nodes", []) or []
    order: list = []
    seen: set = set()
    stack = list(reversed(spliced.roots))
    while stack:
        index = stack.pop()
        if index in seen:
            _fail(
                "EXPORT_FAILED",
                "index: asset %r node %d is listed twice; a glTF node cannot have "
                "two parents" % (spliced.sha, index),
                path="/assets",
            )
        seen.add(index)
        order.append(index)
        for child in reversed(nodes_src[index].get("children", []) or []):
            stack.append(child)
    mapping = {old: first_index + i for i, old in enumerate(order)}
    skin_first = len(skins_out) if skins_out is not None else 0
    nodes: list = []
    light_map: dict = {}
    for old in order:
        node = copy.deepcopy(nodes_src[old])
        light_ref = node.get("extensions", {}).get("KHR_lights_punctual")
        if light_ref is not None:
            if lights_out is None:
                _fail("EXPORT_FAILED", "extension: missing output light collection", path="/assets")
            source_light = light_ref["light"]
            if source_light not in light_map:
                light_map[source_light] = len(lights_out)
                lights_out.append(copy.deepcopy(spliced.gltf["extensions"]["KHR_lights_punctual"]["lights"][source_light]))
            light_ref["light"] = light_map[source_light]
        if "skin" in node:
            node["skin"] = skin_first + node["skin"]
        if "mesh" in node:
            node["mesh"] = spliced.mesh_base + node["mesh"]
        if "camera" in node:
            node["camera"] = spliced.camera_map[node["camera"]]
        if "children" in node:
            node["children"] = [mapping[child] for child in node["children"]]
        nodes.append(node)
    if skins_out is not None:
        for skin in spliced.gltf.get("skins", []) or []:
            new_skin = copy.deepcopy(skin)
            new_skin["joints"] = [mapping[joint] for joint in new_skin["joints"]]
            if "skeleton" in new_skin:
                new_skin["skeleton"] = mapping[new_skin["skeleton"]]
            if "inverseBindMatrices" in new_skin:
                new_skin["inverseBindMatrices"] = (
                    spliced.accessor_base + new_skin["inverseBindMatrices"]
                )
            skins_out.append(new_skin)
    if animations_out is not None:
        for ordinal, animation in enumerate(spliced.gltf.get("animations", []) or []):
            new_animation = copy.deepcopy(animation)
            new_animation["name"] = _clip_name(owner_name, first_index if owner_index is None else owner_index, ordinal, animation.get("name"))
            for sampler in new_animation["samplers"]:
                sampler["input"] = spliced.accessor_base + sampler["input"]
                sampler["output"] = spliced.accessor_base + sampler["output"]
            for channel in new_animation["channels"]:
                channel["target"]["node"] = mapping[channel["target"]["node"]]
            animations_out.append(new_animation)
    return nodes, [mapping[root] for root in spliced.roots]


def _part_mesh(
    spliced: _SplicedAsset,
    mesh_index: int,
    primitive_index: int,
    override_material_index: Optional[int],
    meshes_out: list,
    textured: bool = False,
) -> int:
    """One single-primitive mesh for a ``part`` node.

    A copy of the source mesh containing only that primitive, with
    accessors remapped to the shared per-asset copy. The material is
    the override (a spec material index) when one is given, else the
    source primitive's copied material, else no material at all.
    Returns the new mesh's index in ``meshes_out``.
    """
    src_mesh = spliced.gltf["meshes"][mesh_index]
    src_prim = src_mesh["primitives"][primitive_index]
    # C-05: deformation reaches export only through a locked model node.
    # A part has no skin and no mixer, so a skinned or morphing primitive
    # would export frozen at its bind pose while looking like it deforms.
    if src_prim.get("targets"):
        _fail(
            "EXPORT_FAILED",
            "morph: part of asset %r (mesh %d primitive %d) has morph targets; "
            "keep the model locked (explode: false) to export its morphs"
            % (spliced.sha, mesh_index, primitive_index),
            path="/nodes",
        )
    if any(
        str(key).startswith(("JOINTS_", "WEIGHTS_"))
        for key in src_prim.get("attributes", {})
    ):
        _fail(
            "EXPORT_FAILED",
            "skin: part of asset %r (mesh %d primitive %d) is skinned; keep the "
            "model locked (explode: false) to export its skin"
            % (spliced.sha, mesh_index, primitive_index),
            path="/nodes",
        )
    if textured and "TEXCOORD_0" not in src_prim.get("attributes", {}):
        _fail(
            "EXPORT_FAILED",
            "uv: part of asset %r (mesh %d primitive %d) has no TEXCOORD_0, so its texture "
            "map cannot be exported; give it a material without maps"
            % (spliced.sha, mesh_index, primitive_index),
            path="/nodes",
        )
    primitive = copy.deepcopy(src_prim)
    primitive["attributes"] = {
        key: spliced.accessor_base + value
        for key, value in primitive["attributes"].items()
    }
    if "indices" in primitive:
        primitive["indices"] = spliced.accessor_base + primitive["indices"]
    if override_material_index is not None:
        primitive["material"] = override_material_index
    elif "material" in primitive:
        primitive["material"] = spliced.material_base + primitive["material"]
    mesh: dict = {"primitives": [primitive]}
    if "name" in src_mesh:
        mesh["name"] = src_mesh["name"]
    if "extras" in src_mesh:
        mesh["extras"] = copy.deepcopy(src_mesh["extras"])
    meshes_out.append(mesh)
    return len(meshes_out) - 1


def _pack_indices(indices: list) -> tuple:
    maximum = max(indices, default=0)
    if maximum >= 0xFFFFFFFF:
        raise PlastisError("EXPORT_FAILED", "primitive index exceeds glTF index limit")
    if maximum < 0xFFFF:
        return struct.pack("<%dH" % len(indices), *indices), 5123
    return struct.pack("<%dI" % len(indices), *indices), 5125


def export_scene(scene: dict, store: Any, timeout: float = EXPORT_TIMEOUT) -> dict:
    from .asset_transactions import AssetOperation
    with AssetOperation(store, assets=scene.get("assets", [])):
        return _export_scene(scene, store, timeout)


def prepare_export_scene(scene: dict, store: Any, timeout: float = EXPORT_TIMEOUT, *, max_bytes=DEFAULT_INSPECTION_BYTES) -> dict:
    """Prepare the exact export artifact without publication or scene/GC mutations.

    Returns internal bytes/document/associations, never a public download path.
    Reports may refuse bounded inspection even when the full export is allowed.
    """
    from .asset_transactions import AssetOperation
    with AssetOperation(store, assets=scene.get("assets", [])):
        return _export_scene(scene, store, timeout, publish=False, inspection_limit=max_bytes)


def _export_scene(scene: dict, store: Any, timeout: float = EXPORT_TIMEOUT, *, publish=True, inspection_limit=None) -> dict:
    """Export ``scene`` (a validated scene dict) to GLB.

    ``store`` supplies ``exports_dir`` and ``assets_dir``. Returns
    ``{ok, path, bytes, revision, stats, filename}``; ``stats`` gains
    an ``ignored`` entry (only) when a spliced asset had scenes beyond
    the copied default. Raises :class:`PlastisError` with a stable code
    (``EXPORT_FAILED`` / ``EXPORT_EMPTY`` / ``EXPORT_TIMEOUT``) and
    writes nothing on any refusal. The scene itself is never mutated.
    """
    # Step 1 of the design's export algorithm: load and validate. The
    # validator already refuses decay other than omitted/2, so export
    # never sees an illegal light.
    validate_scene(scene)
    deadline = time.monotonic() + timeout
    _check_deadline(deadline)

    splat_ignored = ["Splat node %s omitted from GLB" % n["id"] for n in scene.get("nodes", []) if n.get("kind") == "splat"]
    nodes = [n for n in scene.get("nodes", []) if n.get("kind") != "splat"]
    materials = scene.get("materials", [])

    mesh_nodes = [n for n in nodes if n.get("kind") == "mesh"]
    model_part_nodes = [n for n in nodes if n.get("kind") in ("model", "part")]
    if not mesh_nodes and not model_part_nodes:
        _fail(
            "EXPORT_EMPTY",
            "scene has no meshes to export",
            path="/nodes",
        )

    material_index = {m["id"]: i for i, m in enumerate(materials)}

    # --- Materials: one glTF material per spec material -------------------
    gltf_materials = []
    for material in materials:
        color = material.get("color", "#c8ccd0")
        opacity = material.get("opacity", 1.0)
        rgb = _hex_rgb(color)
        gltf_materials.append(
            {
                "name": material.get("name") or material["id"],
                "pbrMetallicRoughness": {
                    "baseColorFactor": [rgb[0], rgb[1], rgb[2], opacity],
                    "metallicFactor": material.get("metalness", 0.0),
                    "roughnessFactor": material.get("roughness", 0.6),
                },
                "emissiveFactor": _hex_rgb(material.get("emissive", "#000000")),
                "alphaMode": "BLEND" if opacity < 1 else "OPAQUE",
                "doubleSided": bool(material.get("doubleSide", False)),
            }
        )

    # --- Lights: KHR_lights_punctual, extensionsUsed only -----------------
    gltf_lights = []
    light_index_by_node: dict = {}
    for node in nodes:
        if node.get("kind") != "light":
            continue
        light = node["light"]
        ltype = light["type"]
        entry: dict = {
            "name": node.get("name"),
            "type": ltype,
            "color": _hex_rgb(light.get("color", "#ffffff")),
            "intensity": light.get("intensity", 1.0),
        }
        distance = light.get("distance")
        if ltype in ("point", "spot") and distance is not None and distance > 0:
            entry["range"] = distance
        if ltype == "spot":
            angle = light.get("angle")
            if angle is None:
                angle = _SPOT_DEFAULT_ANGLE_DEGREES
            outer = math.radians(angle)
            penumbra = light.get("penumbra")
            if penumbra is None:
                penumbra = 0.0
            entry["spot"] = {
                "innerConeAngle": outer * (1.0 - penumbra),
                "outerConeAngle": outer,
            }
        light_index_by_node[node["id"]] = len(gltf_lights)
        gltf_lights.append(entry)

    # --- Meshes: one glTF mesh per mesh node ------------------------------
    builder = _BinBuilder(inspection_limit)
    builder.reserve_metadata({"nodes": nodes, "materials": materials})
    accessors: list = []
    buffer_views: list = []
    asset_by_id = {a.get("id"): a for a in scene.get("assets", [])}

    # --- Texture maps (PR15): one embedded image and one texture per image
    # asset, one shared sampler (linear, mipmapped, REPEAT: the glTF
    # default wrap, which the primitive UVs rely on at a seam). Colour maps
    # are sRGB and data maps are linear by their slot; glTF has no flag for
    # it. The same texture serves any slot that names the same image.
    gltf_images: list = []
    gltf_samplers: list = []
    gltf_textures: list = []
    textured_materials: set = set()
    texture_by_asset: dict = {}

    def _texture_for(asset_id: str) -> int:
        existing = texture_by_asset.get(asset_id)
        if existing is not None:
            return existing
        asset = asset_by_id.get(asset_id)
        if asset is None or asset.get("format") not in IMAGE_ASSET_FORMATS:
            _fail(
                "EXPORT_FAILED",
                "index: texture map names %r, which is not an image asset in the scene" % asset_id,
                path="/materials",
            )
        sha = asset.get("sha256")
        image_path = store.assets_dir / (sha + ASSET_FILE_EXTENSIONS[asset["format"]])
        try:
            image_bytes = image_path.read_bytes()
        except OSError:
            _fail(
                "EXPORT_FAILED",
                "image %r file is missing on disk (%s); export refuses rather than dropping the texture"
                % (asset_id, image_path.name),
                path="/assets",
            )
        if hashlib.sha256(image_bytes).hexdigest() != sha:
            _fail(
                "EXPORT_FAILED",
                "image %r does not match its sha256; the stored bytes changed since import" % asset_id,
                path="/assets",
            )
        offset, length = builder.add(image_bytes)
        buffer_views.append({"buffer": 0, "byteOffset": offset, "byteLength": length})
        gltf_images.append(
            {
                "bufferView": len(buffer_views) - 1,
                "mimeType": "image/png" if asset["format"] == "png" else "image/jpeg",
                "name": asset.get("originalName") or asset_id,
            }
        )
        if not gltf_samplers:
            gltf_samplers.append(
                {"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}
            )
        gltf_textures.append({"sampler": 0, "source": len(gltf_images) - 1})
        texture_by_asset[asset_id] = len(gltf_textures) - 1
        return texture_by_asset[asset_id]

    for index, material in enumerate(materials):
        out = gltf_materials[index]
        for field in MATERIAL_MAP_FIELDS:
            asset_id = material.get(field)
            if asset_id in (None, []):
                continue
            ref = {"index": _texture_for(asset_id)}
            textured_materials.add(index)
            if field == "baseColorMap":
                out["pbrMetallicRoughness"]["baseColorTexture"] = ref
            elif field == "metallicRoughnessMap":
                out["pbrMetallicRoughness"]["metallicRoughnessTexture"] = ref
            elif field == "normalMap":
                out["normalTexture"] = dict(ref, scale=1.0)
            else:
                out["emissiveTexture"] = ref

    gltf_meshes = []
    mesh_index_by_node: dict = {}
    for node in mesh_nodes:
        _check_deadline(deadline)
        try:
            mesh = primitives.generate(node["primitive"])
        except ValueError as exc:
            _fail(
                "EXPORT_FAILED",
                "cannot generate primitive for node %r: %s" % (node.get("id"), exc),
                path="/nodes",
            )
            raise AssertionError("unreachable")
        positions = _float32(mesh["positions"])
        normals = _float32(mesh["normals"])
        indices = mesh["indices"]
        material_slot = material_index[node["materialId"]]
        pos_blob = struct.pack("<%df" % len(positions), *positions)
        nrm_blob = struct.pack("<%df" % len(normals), *normals)
        index_blob, index_component = _pack_indices(indices)
        pos_offset, pos_length = builder.add(pos_blob)
        nrm_offset, nrm_length = builder.add(nrm_blob)
        idx_offset, idx_length = builder.add(index_blob)
        pos_view = len(buffer_views)
        buffer_views.append(
            {"buffer": 0, "byteOffset": pos_offset, "byteLength": pos_length}
        )
        nrm_view = len(buffer_views)
        buffer_views.append(
            {"buffer": 0, "byteOffset": nrm_offset, "byteLength": nrm_length}
        )
        idx_view = len(buffer_views)
        buffer_views.append(
            {"buffer": 0, "byteOffset": idx_offset, "byteLength": idx_length}
        )
        pos_min = [min(positions[i::3]) for i in range(3)]
        pos_max = [max(positions[i::3]) for i in range(3)]
        pos_accessor = len(accessors)
        accessors.append(
            {
                "bufferView": pos_view,
                "componentType": 5126,  # FLOAT
                "count": len(positions) // 3,
                "type": "VEC3",
                "min": pos_min,
                "max": pos_max,
            }
        )
        nrm_accessor = len(accessors)
        accessors.append(
            {
                "bufferView": nrm_view,
                "componentType": 5126,
                "count": len(normals) // 3,
                "type": "VEC3",
            }
        )
        idx_accessor = len(accessors)
        accessors.append(
            {
                "bufferView": idx_view,
                "componentType": index_component,
                "count": len(indices),
                "type": "SCALAR",
            }
        )
        attributes = {"POSITION": pos_accessor, "NORMAL": nrm_accessor}
        if material_slot in textured_materials:
            # UVs only where a texture needs them, so an untextured export
            # is byte-for-byte what it was before PR15. Glb convention
            # (v down); the generator already uses it.
            uvs = _float32(mesh["uvs"])
            uv_offset, uv_length = builder.add(struct.pack("<%df" % len(uvs), *uvs))
            uv_view = len(buffer_views)
            buffer_views.append(
                {"buffer": 0, "byteOffset": uv_offset, "byteLength": uv_length}
            )
            attributes["TEXCOORD_0"] = len(accessors)
            accessors.append(
                {
                    "bufferView": uv_view,
                    "componentType": 5126,
                    "count": len(uvs) // 2,
                    "type": "VEC2",
                }
            )
        mesh_index_by_node[node["id"]] = len(gltf_meshes)
        gltf_meshes.append(
            {
                "name": node.get("name"),
                "primitives": [
                    {
                        "attributes": attributes,
                        "indices": idx_accessor,
                        "material": material_slot,
                    }
                ],
            }
        )

    # --- Tiny splice: once per asset, fresh nodes per model node ----------
    # Shared output arrays (spec meshes/materials first, spliced
    # appended in first-use order); spliced cameras are collected
    # separately so they can precede the spec cameras.
    splice_out: dict = {
        "bufferViews": buffer_views,
        "accessors": accessors,
        "images": gltf_images,
        "samplers": gltf_samplers,
        "textures": gltf_textures,
        "materials": gltf_materials,
        "meshes": gltf_meshes,
        "cameras": [],
    }
    spliced_by_id: dict = {}
    # Fresh instance nodes, appended after all spec nodes, in the
    # spec order of the model nodes that own them.
    fresh_nodes: list = []
    gltf_skins: list = []
    gltf_animations: list = []
    instance_roots_by_spec_id: dict = {}
    part_mesh_by_spec_id: dict = {}
    part_mesh_cache: dict = {}
    copied_extension_names: set = set()
    ignored_entries: list = list(splat_ignored)
    owner_index_by_id = {node["id"]: i for i, node in enumerate(nodes)}
    for node in model_part_nodes:
        _check_deadline(deadline)
        asset_id = node.get("modelAssetId")
        asset = asset_by_id.get(asset_id)
        if asset is None:
            # Unreachable through validate_scene (unknown modelAssetId
            # is SPEC_INVALID there); guarded here so the splice never
            # silently drops a node.
            _fail(
                "EXPORT_FAILED",
                "node %r names unknown asset %r" % (node.get("id"), asset_id),
                path="/nodes",
            )
        spliced = spliced_by_id.get(asset_id)
        if spliced is None:
            spliced = _splice_asset(asset, store, builder, splice_out, deadline)
            spliced_by_id[asset_id] = spliced
            copied_extension_names.update(spliced.extension_names)
            if any(spliced.pruned_deformation.values()):
                ignored_entries.append("asset %s: %d unused skins and %d unused clips omitted" % (asset["sha256"], spliced.pruned_deformation["skins"], spliced.pruned_deformation["clips"]))
            if spliced.other_scene_count:
                ignored_entries.append(
                    "asset %s: %d other scene(s) not copied"
                    % (asset.get("sha256"), spliced.other_scene_count)
                )
        if node.get("kind") == "model":
            if inspection_limit is not None:
                if not hasattr(spliced, "inspection_instance_bytes"):
                    records = {"nodes": [spliced.gltf["nodes"][i] for i in spliced.reachable], "skins": spliced.gltf.get("skins", []), "animations": spliced.gltf.get("animations", []), "lights": spliced.gltf.get("extensions", {}).get("KHR_lights_punctual", {}).get("lights", [])}
                    spliced.inspection_instance_bytes = len(json.dumps(records, separators=(",", ":"))) * 2 + 512 * (len(spliced.reachable) + len(records["skins"]) + len(records["animations"]))
                builder.reserve_metadata_size(spliced.inspection_instance_bytes)
            instance_nodes, roots = _instance_nodes(
                spliced,
                len(nodes) + len(fresh_nodes),
                gltf_skins,
                gltf_animations,
                owner_name=node.get("name") or "Model", owner_index=owner_index_by_id[node["id"]], lights_out=gltf_lights,
            )
            fresh_nodes.extend(instance_nodes)
            instance_roots_by_spec_id[node["id"]] = roots
        else:
            mesh_index = node.get("meshIndex")
            primitive_index = node.get("primitiveIndex")
            meshes_src = spliced.gltf.get("meshes", []) or []
            if not _is_int(mesh_index) or mesh_index < 0 or mesh_index >= len(meshes_src):
                _fail(
                    "EXPORT_FAILED",
                    "index: part node %r meshIndex %r is outside the copied mesh set"
                    % (node.get("id"), mesh_index),
                    path="/nodes",
                )
            primitives_src = meshes_src[mesh_index].get("primitives", []) or []
            if (
                not _is_int(primitive_index)
                or primitive_index < 0
                or primitive_index >= len(primitives_src)
            ):
                _fail(
                    "EXPORT_FAILED",
                    "index: part node %r primitiveIndex %r is outside the copied "
                    "primitive set" % (node.get("id"), primitive_index),
                    path="/nodes",
                )
            override_id = node.get("materialId")
            override_index = (
                material_index[override_id] if override_id is not None else None
            )
            cache_key = (asset_id, mesh_index, primitive_index, override_index)
            part_mesh = part_mesh_cache.get(cache_key)
            if part_mesh is None:
                part_mesh = _part_mesh(
                    spliced,
                    mesh_index,
                    primitive_index,
                    override_index,
                    gltf_meshes,
                    textured=override_index in textured_materials,
                )
                part_mesh_cache[cache_key] = part_mesh
            part_mesh_by_spec_id[node["id"]] = part_mesh

    # --- Cameras: spliced cameras precede spec cameras ---------------------
    spliced_cameras = splice_out["cameras"]
    gltf_cameras = list(spliced_cameras)
    camera_index_by_node: dict = {}
    for node in nodes:
        if node.get("kind") != "camera":
            continue
        camera = node["camera"]
        camera_index_by_node[node["id"]] = len(gltf_cameras)
        gltf_cameras.append(
            {
                "name": node.get("name"),
                "type": "perspective",
                "perspective": {
                    "yfov": math.radians(camera.get("fov", 40.0)),
                    "znear": camera.get("near", 0.01),
                    "zfar": camera.get("far", 500.0),
                },
            }
        )

    # --- Nodes: one glTF node per spec node, parented by the spec link ----
    node_index_by_id = {node["id"]: i for i, node in enumerate(nodes)}
    children: dict = {node["id"]: [] for node in nodes}
    roots: list = []
    for node in nodes:
        parent = node.get("parent")
        if parent is not None and parent in children:
            children[parent].append(node_index_by_id[node["id"]])
        else:
            roots.append(node_index_by_id[node["id"]])
    gltf_nodes = []
    for node in nodes:
        _check_deadline(deadline)
        transform = node.get("transform", {})
        quaternion = _matrix_to_quaternion(
            primitives.rotation_matrix_xyz(transform.get("r", [0.0, 0.0, 0.0]))
        )
        gltf_node: dict = {
            "name": node.get("name"),
            "translation": list(transform.get("t", [0.0, 0.0, 0.0])),
            "rotation": quaternion,
            "scale": list(transform.get("s", [1.0, 1.0, 1.0])),
        }
        node_children = list(children[node["id"]])
        kind = node.get("kind")
        if kind == "model":
            # Imported default-scene roots first, then spec children.
            node_children = instance_roots_by_spec_id[node["id"]] + node_children
        if node_children:
            gltf_node["children"] = node_children
        if kind == "mesh":
            gltf_node["mesh"] = mesh_index_by_node[node["id"]]
        elif kind == "part":
            gltf_node["mesh"] = part_mesh_by_spec_id[node["id"]]
        elif kind == "light":
            gltf_node["extensions"] = {
                "KHR_lights_punctual": {"light": light_index_by_node[node["id"]]}
            }
        elif kind == "camera":
            gltf_node["camera"] = camera_index_by_node[node["id"]]
        # A group has no mesh/camera/light. A model node has no mesh of
        # its own. Invisible nodes are emitted as written: visibility
        # is editor-only in 0.1.0.
        gltf_nodes.append(gltf_node)
    gltf_nodes.extend(fresh_nodes)

    # Primitive clips write independent glTF samplers onto the spec nodes.
    for node in nodes:
        for ordinal, clip in enumerate(node.get("clips", [])):
            _check_deadline(deadline)
            samplers, channels = [], []
            for channel_index, channel in enumerate(clip["channels"]):
                times = list(channel["times"])
                values = list(channel["values"])
                # glTF duration is the last sampler key, not an animation field.
                # Extend one sampler with a held value when an explicit duration
                # exceeds all keys, so export and view loop at the same time.
                duration = clip.get("duration")
                last_key = max(c["times"][-1] for c in clip["channels"])
                if channel_index == 0 and duration is not None and duration > last_key:
                    times.append(duration)
                    values.append(values[-1])
                try:
                    times = _float32(times)
                except (OverflowError, struct.error):
                    _fail("EXPORT_FAILED", "animation key time cannot be represented as float32", path="/nodes")
                if any(times[i] >= times[i + 1] for i in range(len(times) - 1)):
                    _fail("EXPORT_FAILED", "animation key times collapse in float32", path="/nodes")
                target = channel["target"]
                if target == "rotation":
                    values = [_matrix_to_quaternion(primitives.rotation_matrix_xyz(v)) for v in values]
                try:
                    flat = _float32([component for value in values for component in value])
                except (OverflowError, struct.error):
                    _fail("EXPORT_FAILED", "animation values cannot be represented as float32", path="/nodes")
                input_offset, input_length = builder.add(struct.pack("<%df" % len(times), *times))
                input_view = len(buffer_views)
                buffer_views.append({"buffer": 0, "byteOffset": input_offset, "byteLength": input_length})
                input_accessor = len(accessors)
                accessors.append({"bufferView": input_view, "componentType": 5126, "count": len(times),
                                  "type": "SCALAR", "min": [min(times)], "max": [max(times)]})
                output_offset, output_length = builder.add(struct.pack("<%df" % len(flat), *flat))
                output_view = len(buffer_views)
                buffer_views.append({"buffer": 0, "byteOffset": output_offset, "byteLength": output_length})
                output_accessor = len(accessors)
                accessors.append({"bufferView": output_view, "componentType": 5126,
                                  "count": len(values), "type": "VEC4" if target == "rotation" else "VEC3"})
                samplers.append({"input": input_accessor, "output": output_accessor, "interpolation": "LINEAR"})
                channels.append({"sampler": len(samplers)-1, "target": {"node": node_index_by_id[node["id"]], "path": target}})
            animation = {"samplers": samplers, "channels": channels}
            animation["name"] = _clip_name(node.get("name") or "Shape", node_index_by_id[node["id"]], ordinal, clip.get("name"))
            gltf_animations.append(animation)

    # --- Assemble the glTF document ----------------------------------------
    extensions_used: list = []
    if gltf_lights:
        extensions_used.append("KHR_lights_punctual")
    extensions_used.extend(sorted(copied_extension_names))
    gltf: dict = {
        "asset": {"version": "2.0", "generator": "plastis3d"},
        "scene": 0,
        "scenes": [{"nodes": roots}],
        "nodes": gltf_nodes,
        "meshes": gltf_meshes,
        "materials": gltf_materials,
        "accessors": accessors,
        "bufferViews": buffer_views,
        "buffers": [{"byteLength": len(builder.data)}],
        "extensionsRequired": [],
    }
    if splice_out["images"]:
        gltf["images"] = splice_out["images"]
    if splice_out["samplers"]:
        gltf["samplers"] = splice_out["samplers"]
    if splice_out["textures"]:
        gltf["textures"] = splice_out["textures"]
    if gltf_cameras:
        gltf["cameras"] = gltf_cameras
    if gltf_skins:
        gltf["skins"] = gltf_skins
    if gltf_animations:
        gltf["animations"] = gltf_animations
    if extensions_used:
        gltf["extensionsUsed"] = extensions_used
    if gltf_lights:
        gltf["extensions"] = {"KHR_lights_punctual": {"lights": gltf_lights}}

    from .export_compact import compact
    gltf, builder.data, compaction_unchecked = compact(gltf, builder.data)
    _check_deadline(deadline)
    json_bytes = json.dumps(gltf, separators=(",", ":"), sort_keys=True).encode("utf-8")
    json_bytes += b" " * ((-len(json_bytes)) % 4)
    bin_data = bytes(builder.data)
    bin_data += b"\x00" * ((-len(bin_data)) % 4)
    total = 12 + 8 + len(json_bytes) + 8 + len(bin_data)
    if inspection_limit is not None and total > inspection_limit:
        raise ExportInspectionLimit()
    glb = (
        struct.pack("<III", _GLB_MAGIC, _GLB_VERSION, total)
        + struct.pack("<II", len(json_bytes), _CHUNK_JSON)
        + json_bytes
        + struct.pack("<II", len(bin_data), _CHUNK_BIN)
        + bin_data
    )

    if not publish:
        # Keep output association independent of loader name sanitization/uniqueness.
        own_roots = {index: node_id for node_id, index in node_index_by_id.items()}
        node_owners = {}
        pending = [(index, None) for index in roots]
        while pending:
            index, owner = pending.pop()
            owner = own_roots.get(index, owner)
            node_owners[str(index)] = owner
            pending.extend((child, owner) for child in gltf["nodes"][index].get("children", []))
        material_owners = {}
        for index, output_node in enumerate(gltf["nodes"]):
            if "mesh" in output_node:
                for primitive in gltf["meshes"][output_node["mesh"]]["primitives"]:
                    if "material" in primitive:
                        material_owners.setdefault(str(primitive["material"]), set()).add(node_owners.get(str(index)))
        output_facts = {"bytes": len(glb), "jsonBytes": len(json_bytes), "binaryBytes": len(bin_data),
                        "nodes": len(gltf["nodes"]), "meshes": len(gltf.get("meshes", [])),
                        "primitives": sum(len(m["primitives"]) for m in gltf.get("meshes", [])),
                        "materials": len(gltf.get("materials", [])), "skins": len(gltf.get("skins", [])),
                        "clips": len(gltf.get("animations", [])), "accessors": len(gltf.get("accessors", [])),
                        "nodeOwners": node_owners, "materialOwners": {key: sorted(v for v in values if v is not None) for key, values in material_owners.items()}}
        _check_deadline(deadline)
        return {"glb": glb, "gltf": gltf, "buffers": [bin_data], "output": output_facts,
                "revision": scene["revision"], "ignored": ignored_entries,
                "unchecked": ([{"what": "resource compaction", "reason": compaction_unchecked}] if compaction_unchecked else [])}

    # --- Atomic publish ------------------------------------------------------
    _check_deadline(deadline)
    # One folder per scene keeps the file name friendly (``crate.glb``) without two scenes of the same name
    # overwriting each other; the folder holds only the latest export.
    filename = export_filename(scene)
    scene_exports = store.exports_dir / scene["id"]
    dest = scene_exports / filename
    scene_exports.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        dir=str(scene_exports), prefix=".%s." % filename, suffix=".tmp"
    )
    tmp_path = os.fspath(tmp_name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(glb)
            handle.flush()
            os.fsync(handle.fileno())
        # Serialize publish and cleanup with deletion and other exports.
        from .store import _SceneLock
        with _SceneLock(store.lock_path(scene["id"])):
            current = store._read_scene_file(scene["id"])
            if current.get("revision") != scene["revision"]:
                raise PlastisError("REVISION_CONFLICT", "scene changed during export", current_revision=current.get("revision"))
            os.replace(tmp_path, dest)
            store.delete_exports(scene["id"], keep=dest)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        try:
            scene_exports.rmdir()  # only succeeds when nothing was published there
        except OSError:
            pass
        raise
    stats = compute_stats(scene)
    if ignored_entries:
        stats = dict(stats)
        stats["ignored"] = ignored_entries
    return {
        "ok": True,
        "path": os.path.abspath(str(dest)),
        "bytes": len(glb),
        "revision": scene["revision"],
        "stats": stats,
        "filename": filename,
    }
