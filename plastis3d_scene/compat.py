"""Plastis3D — glTF compatibility report (PR16, standalone-editor.md
"three.js game fitness").

Answers "will this load and behave in a three.js game?" for a scene (what
Save as GLB would write) or for one imported asset. A report is a **tool
result and a route response, never a file format and never a mutation**: it
reads the scene and the stored asset bytes and writes nothing.

Every check runs here, in Python, stdlib only; there is no ``gltf-validator``.
Findings carry a severity (``error``, ``warning``, ``info``), a stable code and
one plain sentence. What could not be checked is listed under ``unchecked``
with the reason, so an empty ``issues`` list never means "looked at
everything" when it did not.

The checklist (design table, with C-20: no power-of-two warning, three.js
runs on WebGL2):

========================  ========  ==========================================
code                      severity  meaning
========================  ========  ==========================================
EXTENSION_REQUIRED        error     ``extensionsRequired`` outside the allowed
                                    three (lights, unlit, texture transform)
COMPRESSED_EXTENSION      error     Draco, Meshopt or KTX2 named
EXTERNAL_URI              error     a buffer or image is not embedded
NON_FINITE_TRANSFORM      error     a transform is NaN/infinite
ZERO_SCALE                error     a scale component is 0
MISSING_NORMALS           warning   a triangle mesh without normals
NORMAL_MAP_NO_TANGENTS    warning   a normal map on a mesh without tangents
MANY_MATERIALS            warning   more than 16 materials
TRIANGLES_MOBILE          warning   more than 100,000 triangles
TRIANGLES_HEAVY           warning   more than 500,000 triangles
DEGENERATE_TRIANGLES      warning   triangles with area under 1e-12
MANY_CLIPS                warning   more than 8 animation clips
SKIN_NO_JOINTS            warning   a skin with no joints
ALPHA_BLEND_MAJORITY      warning   alpha blend on more than half the materials
NON_METER_EXTENT          warning   extent over 10,000 m or under 1 mm
TEXTURE_LARGE             info      a texture edge over 2048 px
========================  ========  ==========================================

Bounded: the degenerate-triangle scan reads at most 500,000 triangles per asset
and stops at the deadline; anything skipped is named in ``unchecked``.
"""

from __future__ import annotations

import math
import struct
import time
from typing import Any, Optional

from . import glb as _glb
from . import images as _images
from .spec import IMAGE_ASSET_FORMATS, MATERIAL_MAP_FIELDS, PlastisError, compute_stats

REPORT_TIMEOUT = 10.0
MAX_PROSPECTIVE_BYTES = 32 * 1024 * 1024

ALLOWED_REQUIRED = frozenset({"KHR_lights_punctual", "KHR_materials_unlit", "KHR_texture_transform"})
COMPRESSED = frozenset({"KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_texture_basisu"})

MAX_MATERIALS = 16
TRIS_MOBILE = 100_000
TRIS_HEAVY = 500_000
MAX_DEGENERATE_SCAN_TRIS = 500_000
DEGENERATE_AREA = 1e-12
MAX_CLIPS = 8
TEXTURE_EDGE_INFO = 2048
EXTENT_MAX = 10_000.0
EXTENT_MIN = 0.001

_SEVERITY_ORDER = {"error": 0, "warning": 1, "info": 2}
_COMPONENT = {5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2), 5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4)}
_TYPE_WIDTH = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def _issue(code: str, severity: str, message: str, where: Optional[str] = None, **references) -> dict:
    issue = {"code": code, "severity": severity, "message": message}
    if where:
        issue["where"] = where
    issue.update(references)
    return issue


def _finite(values: Any) -> bool:
    return isinstance(values, (list, tuple)) and all(
        isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in values
    )


def _plural(count: int, one: str, many: str) -> str:
    return "%d %s" % (count, one if count == 1 else many)


# --- Triangle data -------------------------------------------------------------------


class _AccessorView:
    """Validated on-demand tuples; never allocate an entire POSITION/index array."""
    def __init__(self, buffer, start, stride, count, width, code, component, normalized):
        self.buffer, self.start, self.stride, self.count = buffer, start, stride, count
        self.width, self.fmt, self.component, self.normalized = width, "<%d%s" % (width, code), component, normalized

    def __len__(self):
        return self.count

    def __getitem__(self, index):
        if not isinstance(index, int) or not 0 <= index < self.count:
            raise IndexError(index)
        values = struct.unpack_from(self.fmt, self.buffer, self.start + index * self.stride)
        if not self.normalized or self.component == 5126:
            return values
        maximum = {5120: 127, 5121: 255, 5122: 32767, 5123: 65535, 5125: 4294967295}[self.component]
        return tuple(max(-1., value / maximum) if self.component in (5120, 5122) else value / maximum for value in values)


def _read_accessor(gltf: dict, buffers: list, index: int, wanted: tuple):
    """A bounded accessor view, None for unsupported sparse/type data.

    Invalid layouts raise ValueError and become explicit geometry errors rather
    than unchecked successful scans. Normalized integers match glTF decoding.
    """
    try:
        accessors = gltf["accessors"]
        if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index < len(accessors):
            raise ValueError("invalid accessor index")
        accessor = accessors[index]
        if "sparse" in accessor or accessor.get("componentType") not in wanted:
            return None
        width = _TYPE_WIDTH.get(accessor.get("type"))
        if width is None or "bufferView" not in accessor:
            return None
        component = accessor["componentType"]
        code, size = _COMPONENT[component]
        view_index = accessor["bufferView"]
        if isinstance(view_index, bool) or not isinstance(view_index, int) or not 0 <= view_index < len(gltf["bufferViews"]):
            raise ValueError("invalid bufferView index")
        view = gltf["bufferViews"][view_index]
        buffer_index = view.get("buffer", 0)
        if isinstance(buffer_index, bool) or not isinstance(buffer_index, int) or not 0 <= buffer_index < len(buffers):
            raise ValueError("invalid buffer index")
        buffer = buffers[buffer_index]
        stride = view.get("byteStride", size * width)
        offset, length, local, count = view.get("byteOffset", 0), view["byteLength"], accessor.get("byteOffset", 0), accessor["count"]
        if any(isinstance(v, bool) or not isinstance(v, int) or v < 0 for v in (offset, length, local, count, stride)):
            raise ValueError("invalid accessor range")
        if stride < size * width or stride % size or ("byteStride" in view and stride > 252) or (offset + local) % size:
            raise ValueError("invalid accessor stride or alignment")
        end = local + ((count - 1) * stride + size * width if count else 0)
        if local > length or end > length or offset + length > len(buffer):
            raise ValueError("invalid accessor range")
        return _AccessorView(buffer, offset + local, stride, count, width, code, component, accessor.get("normalized", False))
    except (KeyError, IndexError, TypeError) as error:
        raise ValueError("invalid accessor layout") from error


def _triangle_count(gltf: dict) -> Optional[int]:
    """Triangles in the file (mode 4 primitives), or ``None`` if a count is unknowable."""
    accessors = gltf.get("accessors", []) or []
    total = 0
    for mesh in gltf.get("meshes", []) or []:
        for primitive in mesh.get("primitives", []) or []:
            if primitive.get("mode", 4) != 4:
                continue
            indices = primitive.get("indices")
            position = primitive.get("attributes", {}).get("POSITION")
            source = indices if indices is not None else position
            if source is None or not 0 <= source < len(accessors):
                return None
            total += accessors[source].get("count", 0) // 3
    return total


def _count_degenerate(gltf: dict, buffers: list, deadline: float, bad_refs=None) -> tuple:
    """``(degenerate, scanned, skipped_reason)`` over every triangle primitive."""
    degenerate = 0
    scanned = 0
    for mi, mesh in enumerate(gltf.get("meshes", []) or []):
        for pi, primitive in enumerate(mesh.get("primitives", []) or []):
            if primitive.get("mode", 4) != 4:
                continue
            position = primitive.get("attributes", {}).get("POSITION")
            if position is None:
                continue
            try:
                points = _read_accessor(gltf, buffers, position, tuple(_COMPONENT))
                if points is None:
                    return degenerate, scanned, "a position accessor has sparse or unsupported data"
                if points.width != 3:
                    return degenerate, scanned, "invalid POSITION type (expected VEC3)"
                indices = primitive.get("indices")
                order = _read_accessor(gltf, buffers, indices, (5121, 5123, 5125)) if indices is not None else None
                if indices is not None and (order is None or order.width != 1 or order.normalized):
                    return degenerate, scanned, "invalid or unsupported index accessor"
            except ValueError as error:
                return degenerate, scanned, str(error)
            count = len(order) if order is not None else len(points)
            for t in range(0, count - 2, 3):
                if scanned >= MAX_DEGENERATE_SCAN_TRIS:
                    return degenerate, scanned, "more than %d triangles; the scan stopped" % MAX_DEGENERATE_SCAN_TRIS
                if scanned % 4096 == 0 and time.monotonic() >= deadline:
                    return degenerate, scanned, "the time budget ran out"
                ids = [order[t + k][0] if order is not None else t + k for k in range(3)]
                if any(not 0 <= i < len(points) for i in ids):
                    return degenerate, scanned, "invalid triangle index outside the POSITION accessor"
                a, b, c = (points[i] for i in ids)
                if not all(math.isfinite(v) for p in (a, b, c) for v in p):
                    return degenerate, scanned, "invalid non-finite POSITION data"
                ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
                vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
                cx, cy, cz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
                area = 0.5 * math.sqrt(cx * cx + cy * cy + cz * cz)
                if not area > DEGENERATE_AREA:
                    degenerate += 1
                    if bad_refs is not None:
                        bad_refs.add((mi, pi))
                scanned += 1
    return degenerate, scanned, None


# --- One glTF document ------------------------------------------------------------------


def check_document(gltf: dict, buffers: list, *, label: str, deadline: float) -> dict:
    """Checks that read one glTF document (an imported asset).

    Returns ``{"issues": [...], "unchecked": [...], "facts": {...}}``. ``facts``
    carries the numbers a caller may roll up (triangles, extent).
    """
    issues: list = []
    unchecked: list = []
    where = label

    required = [n for n in (gltf.get("extensionsRequired") or []) if n not in ALLOWED_REQUIRED]
    for name in required:
        if name in COMPRESSED:
            continue  # reported once, below
        issues.append(
            _issue(
                "EXTENSION_REQUIRED",
                "error",
                "The file requires the extension %s, which a three.js game cannot be assumed to load. "
                "Only lights, unlit materials and texture transforms are safe to require." % name,
                where,
            )
        )
    named = sorted(
        {n for n in (gltf.get("extensionsUsed") or []) + (gltf.get("extensionsRequired") or []) if n in COMPRESSED}
    )
    for name in named:
        issues.append(
            _issue(
                "COMPRESSED_EXTENSION",
                "error",
                "The file uses %s compression. Plastis3D does not decode it; export an uncompressed file." % name,
                where,
            )
        )

    for kind in ("buffers", "images"):
        external = [
            i
            for i, item in enumerate(gltf.get(kind) or [])
            if isinstance(item, dict) and isinstance(item.get("uri"), str) and not item["uri"].startswith("data:")
        ]
        if external:
            issues.append(
                _issue(
                    "EXTERNAL_URI",
                    "error",
                    "%s %s a file outside the glTF. A game that loads this file alone will not find %s."
                    % (
                        _plural(len(external), kind[:-1], kind),
                        "points at" if len(external) == 1 else "point at",
                        "it" if len(external) == 1 else "them",
                    ),
                    where,
                )
            )

    # Transforms.
    bad_transform, zero_scale = [], []
    for node_index, node in enumerate(gltf.get("nodes") or []):
        values = [node.get(k) for k in ("translation", "rotation", "scale", "matrix") if k in node]
        if any(not _finite(v) for v in values):
            bad_transform.append(node_index)
        elif "scale" in node and any(c == 0 for c in node["scale"]):
            zero_scale.append(node_index)
    if bad_transform:
        issues.append(_issue("NON_FINITE_TRANSFORM", "error", "%s a transform that is not a finite number." % _plural(len(bad_transform), "node has", "nodes have"), where, nodeIndices=bad_transform))
    if zero_scale:
        issues.append(_issue("ZERO_SCALE", "error", "%s a scale of zero, which flattens it." % _plural(len(zero_scale), "node has", "nodes have"), where, nodeIndices=zero_scale))

    # Meshes.
    primitives = [
        p
        for mesh in gltf.get("meshes") or []
        for p in (mesh.get("primitives") or [])
        if isinstance(p, dict) and p.get("mode", 4) == 4
    ]
    primitive_refs = [(mi, pi, p) for mi, m in enumerate(gltf.get("meshes", [])) for pi, p in enumerate(m.get("primitives", [])) if p.get("mode", 4) == 4]
    missing_normals = [[mi, pi] for mi, pi, p in primitive_refs if "NORMAL" not in p.get("attributes", {})]
    no_normals = len(missing_normals)
    if no_normals:
        issues.append(
            _issue(
                "MISSING_NORMALS",
                "warning",
                "%s no normals, so it will be shaded flat or shaded wrongly. Add normals in the tool that made the file."
                % _plural(no_normals, "triangle mesh has", "triangle meshes have"),
                where, primitiveRefs=missing_normals,
            )
        )
    materials = gltf.get("materials") or []
    normal_users = {
        i for i, m in enumerate(materials) if isinstance(m, dict) and isinstance(m.get("normalTexture"), dict)
    }
    normal_uv = {}
    for index in normal_users:
        texture = materials[index]["normalTexture"]
        channel = texture.get("extensions", {}).get("KHR_texture_transform", {}).get("texCoord", texture.get("texCoord", 0))
        normal_uv[index] = "TEXCOORD_%d" % channel if isinstance(channel, int) and not isinstance(channel, bool) and channel >= 0 else None
    no_uv = [[mi, pi] for mi, pi, p in primitive_refs if p.get("material") in normal_users and normal_uv[p["material"]] not in p.get("attributes", {})]
    if no_uv:
        issues.append(_issue("NORMAL_MAP_NO_UV", "error", "%s a normal map but no texture coordinates." % _plural(len(no_uv), "mesh has", "meshes have"), where, primitiveRefs=no_uv))
    missing_tangents = [[mi, pi] for mi, pi, p in primitive_refs if p.get("material") in normal_users and "TANGENT" not in p.get("attributes", {})]
    no_tangents = len(missing_tangents)
    if any(p.get("material") in normal_users and "TANGENT" in p.get("attributes", {}) for p in primitives):
        unchecked.append({"what": "normal-map tangent frame values in %s" % label, "reason": "tangent presence is inspected, but numeric frame validity is not certified"})
    if no_tangents:
        issues.append(
            _issue(
                "NORMAL_MAP_NO_TANGENTS",
                "warning",
                "%s a normal map but no tangents. three.js will derive them, which can differ from the authoring tool."
                % _plural(no_tangents, "mesh has", "meshes have"),
                where, primitiveRefs=missing_tangents,
            )
        )
    if len(materials) > MAX_MATERIALS:
        issues.append(
            _issue("MANY_MATERIALS", "warning", "The file has %d materials; more than %d means many draw calls." % (len(materials), MAX_MATERIALS), where)
        )
    blend = sum(1 for m in materials if isinstance(m, dict) and m.get("alphaMode") == "BLEND")
    if materials and blend * 2 > len(materials):
        issues.append(
            _issue("ALPHA_BLEND_MAJORITY", "warning", "%d of %d materials use alpha blending, which sorts badly and costs fill rate." % (blend, len(materials)), where)
        )

    # Animation.
    clips = len(gltf.get("animations") or [])
    if clips > MAX_CLIPS:
        issues.append(_issue("MANY_CLIPS", "warning", "The file has %d animation clips; more than %d is unusual for one asset." % (clips, MAX_CLIPS), where))
    empty_skins = sum(1 for s in gltf.get("skins") or [] if isinstance(s, dict) and not s.get("joints"))
    if empty_skins:
        issues.append(_issue("SKIN_NO_JOINTS", "warning", "%s no joints, so it cannot deform anything." % _plural(empty_skins, "skin has", "skins have"), where))

    # Textures.
    sizes, unreadable_images = _image_sizes(gltf, buffers)
    for width, height in [s for s in sizes if max(s) > TEXTURE_EDGE_INFO]:
        issues.append(
            _issue("TEXTURE_LARGE", "info", "A texture is %d x %d pixels. Over %d on an edge costs memory on phones." % (width, height, TEXTURE_EDGE_INFO), where)
        )

    # Size and units.
    tris = _triangle_count(gltf)
    extent = _extent(gltf)
    if extent is not None and (extent > EXTENT_MAX or 0 < extent < EXTENT_MIN):
        issues.append(
            _issue(
                "NON_METER_EXTENT",
                "warning",
                "The model is %s across. It may not be in meters; scale the model node (for millimeters, 0.001)."
                % _format_extent(extent),
                where,
            )
        )

    # Degenerate triangles (bounded).
    if tris is None:
        unchecked.append({"what": "degenerate triangles in %s" % label, "reason": "a primitive has no readable position data"})
    elif tris > MAX_DEGENERATE_SCAN_TRIS:
        unchecked.append({"what": "degenerate triangles in %s" % label, "reason": "more than %d triangles" % MAX_DEGENERATE_SCAN_TRIS})
    else:
        bad_refs = set()
        bad, scanned, stopped = _count_degenerate(gltf, buffers, deadline, bad_refs)
        if bad:
            issues.append(
                _issue("DEGENERATE_TRIANGLES", "warning", "%s a corner area under 1e-12 m², which draws nothing and can break shading. Weld or remove them." % _plural(bad, "triangle has", "triangles have"), where, primitiveRefs=[list(pair) for pair in sorted(bad_refs)])
            )
        if stopped:
            if stopped.startswith("invalid"):
                issues.append(_issue("INVALID_GEOMETRY", "error", stopped, where))
            else:
                unchecked.append({"what": "degenerate triangles in %s" % label, "reason": "%s after %d triangles" % (stopped, scanned)})

    from .health_costs import primitive_costs
    primitive_rows, default_scene_cost = primitive_costs(gltf, deadline)
    facts = {
        "primitiveCosts": primitive_rows, "defaultSceneCost": default_scene_cost,
        "tris": tris,
        "extent": extent,
        "images": sizes,
        "unreadable_images": unreadable_images,
        "primitives": sum(len(m.get("primitives") or []) for m in gltf.get("meshes") or [] if isinstance(m, dict)),
        "materials": len(materials),
        "clips": clips,
        "skins": len(gltf.get("skins") or []),
    }
    return {"issues": issues, "unchecked": unchecked, "facts": facts}


def _format_extent(extent: float) -> str:
    return "%.3g m" % extent


def _image_sizes(gltf: dict, buffers: list) -> tuple:
    """``([(width, height), ...], unreadable)`` for the embedded images; an
    image whose header cannot be read (or that is not embedded) counts as
    unreadable, never as small."""
    sizes: list = []
    unreadable = 0
    for image in gltf.get("images") or []:
        if not isinstance(image, dict) or "bufferView" not in image:
            unreadable += 1
            continue
        try:
            view = gltf["bufferViews"][image["bufferView"]]
            data = bytes(buffers[view.get("buffer", 0)][view.get("byteOffset", 0) : view.get("byteOffset", 0) + view["byteLength"]])
            _fmt, width, height = _images.read_header(data)
        except (PlastisError, KeyError, IndexError, TypeError):
            unreadable += 1
            continue
        sizes.append((width, height))
    return sizes, unreadable


def _extent(gltf: dict) -> Optional[float]:
    lo = [math.inf] * 3
    hi = [-math.inf] * 3
    accessors = gltf.get("accessors") or []
    for mesh in gltf.get("meshes") or []:
        for primitive in mesh.get("primitives") or []:
            position = primitive.get("attributes", {}).get("POSITION") if isinstance(primitive, dict) else None
            if position is None or not 0 <= position < len(accessors):
                continue
            accessor = accessors[position]
            if _finite(accessor.get("min")) and _finite(accessor.get("max")) and len(accessor["min"]) == 3:
                for axis in range(3):
                    low, high = accessor["min"][axis], accessor["max"][axis]
                    component = accessor.get("componentType")
                    if accessor.get("normalized") and component in (5120, 5121, 5122, 5123, 5125):
                        maximum = {5120: 127, 5121: 255, 5122: 32767, 5123: 65535, 5125: 4294967295}[component]
                        low, high = low / maximum, high / maximum
                        if component in (5120, 5122):
                            low, high = max(-1., low), max(-1., high)
                    lo[axis] = min(lo[axis], low)
                    hi[axis] = max(hi[axis], high)
    if lo[0] == math.inf:
        return None
    return max(hi[axis] - lo[axis] for axis in range(3))


# --- A scene ---------------------------------------------------------------------------------


def _world_scale(node: dict, by_id: dict) -> float:
    scale = 1.0
    seen = set()
    while node is not None and node["id"] not in seen:
        seen.add(node["id"])
        s = (node.get("transform") or {}).get("s") or [1, 1, 1]
        if _finite(s):
            scale *= max(abs(c) for c in s)
        node = by_id.get(node.get("parent"))
    return scale


def check_scene(
    scene: dict,
    store: Any,
    *,
    asset_id: Optional[str] = None,
    timeout: float = REPORT_TIMEOUT,
) -> dict:
    """The report for ``scene``, or for one of its assets when ``asset_id`` is given."""
    return inspect_scene(scene, store, asset_id=asset_id, timeout=timeout)[0]


def inspect_scene(scene: dict, store: Any, *, asset_id: Optional[str] = None, timeout: float = REPORT_TIMEOUT) -> tuple:
    from .asset_transactions import AssetOperation
    with AssetOperation(store, assets=scene.get("assets", [])):
        return _inspect_scene(scene, store, asset_id=asset_id, timeout=timeout)


def _inspect_scene(
    scene: dict,
    store: Any,
    *,
    asset_id: Optional[str] = None,
    timeout: float = REPORT_TIMEOUT,
) -> tuple:
    """``(report, asset_facts)``: :func:`check_scene` plus the measured facts of
    every asset it read (the analyzer rolls these up; it has no checker of its
    own).

    The report is for ``scene``, or for one of its assets when ``asset_id`` is given.

    Reads the scene and the stored asset files; writes nothing. A missing or
    changed asset file is reported as a finding, not raised. Raises
    :class:`PlastisError` ``ASSET_NOT_FOUND`` for an unknown ``asset_id``.
    """
    deadline = time.monotonic() + timeout
    issues: list = []
    unchecked: list = []
    assets = {a.get("id"): a for a in scene.get("assets", [])}
    nodes = scene.get("nodes", [])
    by_id = {n["id"]: n for n in nodes if isinstance(n, dict) and "id" in n}
    spec_materials = {m["id"]: m for m in scene.get("materials", [])}
    normal_nodes = [] if asset_id is not None else [n for n in nodes if n.get("kind") in ("mesh", "part") and isinstance(spec_materials.get(n.get("materialId"), {}).get("normalMap"), str)]
    for node in normal_nodes:
        if node["kind"] == "mesh":
            issues.append(_issue("NORMAL_MAP_NO_TANGENTS", "warning", "This shape's normal map uses reconstructed tangents; shading can differ from the authoring tool.", "node %s" % node["id"]))

    if asset_id is not None:
        asset = assets.get(asset_id)
        if asset is None or asset.get("format") != "glb":
            raise PlastisError("ASSET_NOT_FOUND", "ASSET_NOT_FOUND: the scene has no model asset %r" % asset_id)
        target_assets = [asset]
        target = {"kind": "asset", "assetId": asset_id}
    else:
        used = []
        for node in nodes:
            if node.get("kind") in ("model", "part") and node.get("modelAssetId") in assets and node["modelAssetId"] not in used:
                used.append(node["modelAssetId"])
        target_assets = [assets[i] for i in used if assets[i].get("format") == "glb"]
        target = {"kind": "scene"}

        # Scene-level: transforms, materials, size, units, spec textures.
        bad = [n for n in nodes if any(not _finite((n.get("transform") or {}).get(k)) for k in ("t", "r", "s") if k in (n.get("transform") or {}))]
        if bad:
            issues.append(_issue("NON_FINITE_TRANSFORM", "error", "%s a transform that is not a finite number." % _plural(len(bad), "node has", "nodes have"), "scene"))
        flat = [n for n in nodes if _finite((n.get("transform") or {}).get("s")) and any(c == 0 for c in n["transform"]["s"])]
        if flat:
            issues.append(_issue("ZERO_SCALE", "error", "%s a scale of zero, which flattens it." % _plural(len(flat), "node has", "nodes have"), "scene"))
        materials = scene.get("materials", [])
        if len(materials) > MAX_MATERIALS:
            issues.append(_issue("MANY_MATERIALS", "warning", "The scene has %d materials; more than %d means many draw calls." % (len(materials), MAX_MATERIALS), "scene"))
        blend = sum(1 for m in materials if isinstance(m.get("opacity"), (int, float)) and m["opacity"] < 1)
        if materials and blend * 2 > len(materials):
            issues.append(_issue("ALPHA_BLEND_MAJORITY", "warning", "%d of %d materials are see-through, which uses alpha blending: it sorts badly and costs fill rate." % (blend, len(materials)), "scene"))
        for material in materials:
            for slot in MATERIAL_MAP_FIELDS:
                image = assets.get(material.get(slot))
                stats = (image or {}).get("stats") or {}
                if image and image.get("format") in IMAGE_ASSET_FORMATS and max(stats.get("width", 0), stats.get("height", 0)) > TEXTURE_EDGE_INFO:
                    issues.append(_issue("TEXTURE_LARGE", "info", "A texture is %d x %d pixels. Over %d on an edge costs memory on phones." % (stats["width"], stats["height"], TEXTURE_EDGE_INFO), "material %s" % material.get("id")))
        extents = _scene_extents(nodes, by_id, assets)
        for name, extent in extents:
            if extent > EXTENT_MAX or 0 < extent < EXTENT_MIN:
                issues.append(_issue("NON_METER_EXTENT", "warning", "%s is %s across. It may not be in meters; scale it (for millimeters, 0.001)." % (name, _format_extent(extent)), name))

    tris = 0 if asset_id is None else None
    if asset_id is None:
        tris = compute_stats(scene)["tris"]

    for issue in issues:
        issue["provenance"] = "scene"
        where = issue.get("where", "")
        if where.startswith("node ") and where[5:] in by_id:
            issue["nodeIds"] = [where[5:]]
    for item in unchecked:
        item["provenance"] = "scene"
    asset_tris = 0
    asset_facts: dict = {}
    for asset in target_assets:
        label = asset.get("originalName") or asset.get("id")
        mapped_parts = [n for n in normal_nodes if n["kind"] == "part" and n.get("modelAssetId") == asset["id"]]
        keys = {(n.get("meshIndex", 0), n.get("primitiveIndex", 0)) for n in mapped_parts}
        report = _check_asset(asset, store, label, deadline, part_keys=keys)
        for node in mapped_parts:
            pair = "%d:%d" % (node.get("meshIndex", 0), node.get("primitiveIndex", 0))
            attributes = report["facts"].get("partAttributes", {}).get(pair)
            where = "node %s" % node["id"]
            if attributes is None:
                unchecked.append({"what": "normal-map prerequisites for %s" % node["id"], "reason": "the selected source primitive could not be inspected"})
                continue
            if attributes["tangent"]:
                unchecked.append({"what": "normal-map tangent frame values for %s" % node["id"], "reason": "tangent presence is inspected, but numeric frame validity is not certified"})
            for field, code, severity, sentence in (
                ("uv", "NORMAL_MAP_NO_UV", "error", "This normal-mapped part has no texture coordinates."),
                ("normal", "NORMAL_MAP_MISSING_NORMALS", "warning", "This normal-mapped part has no saved normals; reconstructed normals may change its shading."),
                ("tangent", "NORMAL_MAP_NO_TANGENTS", "warning", "This part's normal map uses reconstructed tangents; shading can differ from the authoring tool."),
            ):
                if not attributes[field]:
                    issues.append(_issue(code, severity, sentence, where, provenance="scene", nodeIds=[node["id"]]))
        for issue in report["issues"]:
            issue["provenance"] = "source"
            issue["assetId"] = asset["id"]
            refs = {tuple(pair) for pair in issue.get("primitiveRefs", [])}
            issue["nodeIds"] = [n["id"] for n in nodes if n.get("modelAssetId") == asset["id"] and (not refs or n.get("kind") == "model" or (n.get("meshIndex"), n.get("primitiveIndex")) in refs)]
        for item in report["unchecked"]:
            item["provenance"] = "source"
            item["what"] = "source: " + item["what"]
        issues.extend(report["issues"])
        unchecked.extend(report["unchecked"])
        asset_facts[asset["id"]] = dict(report["facts"], label=label)
        if report["tris"] is not None:
            asset_tris += report["tris"]
    if asset_id is not None:
        tris = asset_tris

    if tris is not None:
        if tris > TRIS_HEAVY:
            issues.append(_issue("TRIANGLES_HEAVY", "warning", "%d triangles is heavy: most phones and many laptops will struggle (over %d)." % (tris, TRIS_HEAVY), target["kind"]))
        elif tris > TRIS_MOBILE:
            issues.append(_issue("TRIANGLES_MOBILE", "warning", "%d triangles is more than a phone should draw comfortably (over %d)." % (tris, TRIS_MOBILE), target["kind"]))

    output_facts = None
    if asset_id is None:
        for node in nodes:
            if node.get("kind") == "splat":
                issues.append(_issue("SPLAT_NOT_IN_GLB", "info", "This Gaussian object is omitted from GLB export.", "node " + node["id"], provenance="scene", nodeIds=[node["id"]]))
        from .export_glb import ExportInspectionLimit, prepare_export_scene
        try:
            prepared = prepare_export_scene(scene, store, timeout=max(0., deadline - time.monotonic()), max_bytes=MAX_PROSPECTIVE_BYTES)
            measured = check_document(prepared["gltf"], prepared["buffers"], label="prospective GLB", deadline=deadline)
            for omitted in prepared["ignored"]:
                if not omitted.startswith("Splat node "):
                    issues.append(_issue("OUTPUT_OMISSION", "info", omitted, "prospective GLB", provenance="output"))
            owners = prepared["output"]["nodeOwners"]
            for issue in measured["issues"]:
                issue["provenance"] = "output"
                refs = {pair[0] for pair in issue.get("primitiveRefs", [])}
                indices = issue.get("nodeIndices", [])
                if refs:
                    indices = [i for i, n in enumerate(prepared["gltf"]["nodes"]) if n.get("mesh") in refs]
                issue["nodeIds"] = sorted({owners[str(i)] for i in indices if owners.get(str(i)) is not None})
                if len(issue["nodeIds"]) == 1:
                    issue["where"] = "node " + issue["nodeIds"][0]
                # One output finding per class, with clearly scoped source evidence.
                related = [row for row in issues if row["code"] == issue["code"] and row.get("provenance") in ("scene", "source")]
                if related:
                    issue["sourceFindings"] = related
                    issue["severity"] = min([issue["severity"]] + [r["severity"] for r in related], key=lambda v: _SEVERITY_ORDER[v])
                    issues = [row for row in issues if row not in related]
                issues.append(issue)
            for item in measured["unchecked"] + prepared["unchecked"]:
                unchecked.append(dict(item, provenance="output", what="output: " + item["what"]))
            output_facts = {key: value for key, value in prepared["output"].items() if key not in ("nodeOwners", "materialOwners")}
        except ExportInspectionLimit as error:
            unchecked.append({"what": "prospective GLB", "reason": error.message, "provenance": "output"})
        except PlastisError as error:
            if error.code in ("EXPORT_EMPTY", "EXPORT_TIMEOUT", "IMPORT_TIMEOUT"):
                unchecked.append({"what": "prospective GLB", "reason": error.message, "provenance": "output"})
            elif not any(row["severity"] == "error" for row in issues):
                issues.append(_issue(error.code, "error", "The prospective GLB cannot be prepared: " + error.message, "prospective GLB", provenance="output"))
            else:
                unchecked.append({"what": "prospective GLB", "reason": "not prepared because of the reported source/export failure: " + error.message, "provenance": "output"})

    for issue in issues:
        issue.setdefault("provenance", "scene")
    issues.sort(key=lambda i: _SEVERITY_ORDER[i["severity"]])
    summary = {"errors": 0, "warnings": 0, "infos": 0}
    for issue in issues:
        summary[{"error": "errors", "warning": "warnings", "info": "infos"}[issue["severity"]]] += 1
    report = {
        "ok": summary["errors"] == 0,
        "scene": scene.get("id"),
        "revision": scene.get("revision"),
        "target": target,
        "summary": summary,
        "issues": issues,
        "unchecked": unchecked,
        "stats": {"tris": tris, "materials": len(scene.get("materials", [])), "nodes": len(nodes), "assetsChecked": len(target_assets)},
    }
    if output_facts is not None:
        report["output"] = output_facts
    return report, asset_facts


def _scene_extents(nodes: list, by_id: dict, assets: dict) -> list:
    out = []
    from . import primitives

    for node in nodes:
        bounds = None
        if node.get("kind") == "mesh" and isinstance(node.get("primitive"), dict):
            try:
                bounds = primitives.primitive_bounds(node["primitive"])
            except (ValueError, KeyError, TypeError):
                bounds = None
        elif node.get("kind") == "model":
            bounds = ((assets.get(node.get("modelAssetId")) or {}).get("stats") or {}).get("bounds")
        if not bounds or not _finite(bounds.get("min")) or not _finite(bounds.get("max")):
            continue
        base = max(b - a for a, b in zip(bounds["min"], bounds["max"]))
        out.append((node.get("name") or node.get("id"), base * _world_scale(node, by_id)))
    return out


def _check_asset(asset: dict, store: Any, label: str, deadline: float, *, part_keys=None) -> dict:
    import hashlib

    sha = asset.get("sha256")
    path = store.assets_dir / ("%s.glb" % sha)
    try:
        data = path.read_bytes()
    except OSError:
        return {"issues": [_issue("ASSET_FILE_MISSING", "error", "The stored file for this model is missing, so the scene cannot be exported.", label)], "unchecked": [], "tris": None, "facts": {}}
    if hashlib.sha256(data).hexdigest() != sha:
        return {"issues": [_issue("ASSET_FILE_CHANGED", "error", "The stored file for this model no longer matches what was imported.", label)], "unchecked": [], "tris": None, "facts": {}}
    try:
        scan = _glb.scan(data, source_format="glb", deadline=deadline)
    except PlastisError as error:
        if error.code == "IMPORT_TIMEOUT":
            return {"issues": [], "unchecked": [{"what": label, "reason": "the time budget ran out while reading it"}], "tris": None, "facts": {}}
        return {"issues": [_issue("ASSET_UNREADABLE", "error", "The stored file cannot be read: %s" % error.message, label)], "unchecked": [], "tris": None, "facts": {}}
    result = check_document(scan.gltf, scan.buffers, label=label, deadline=deadline)
    if part_keys:
        facts = {}
        for mi, pi in part_keys:
            try:
                attrs = scan.gltf["meshes"][mi]["primitives"][pi]["attributes"]
            except (KeyError, IndexError):
                continue
            facts["%d:%d" % (mi, pi)] = {"uv": "TEXCOORD_0" in attrs, "normal": "NORMAL" in attrs, "tangent": "TANGENT" in attrs}
        result["facts"]["partAttributes"] = facts
    return {"issues": result["issues"], "unchecked": result["unchecked"], "tris": result["facts"]["tris"], "facts": result["facts"]}
