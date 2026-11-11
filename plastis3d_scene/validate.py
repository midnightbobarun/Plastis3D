"""Plastis3D — strict scene validator, schema 2 (PR2, Stage 1; PR24).

Closed schema (v1 documents are accepted as v2, see ``upgrade``): unknown node, material, asset, or top-level keys fail.
Every failure raises :class:`plastis3d_scene.spec.PlastisError` with a
stable code (``SPEC_INVALID`` unless a more specific cap code applies)
and an exact JSON pointer path.

Checks (stage-1 §4.2):

* Matrix transforms: Euler XYZ degrees, scale != 0, all numbers finite
  (``math.isfinite`` — NaN and Inf are rejected, including inside JSON,
  where Python's ``json`` module would otherwise accept them).
* Graph integrity: missing parent references, parent cycles, missing
  material references on meshes.
* Caps: max 2,000 nodes (``LIMIT_NODES``), 256 materials
  (``LIMIT_MATERIALS``), 64 assets (``LIMIT_ASSETS``), primitive
  segments 3..64 (``SPEC_INVALID``).
* ``part`` rules (editable-imports plan §2): missing ``modelAssetId`` /
  ``meshIndex`` / ``primitiveIndex`` is ``SPEC_INVALID``; a part without
  ``materialId`` is valid; a part with an unknown ``materialId`` is
  ``SPEC_INVALID``. ``materialId`` on a ``model`` is
  ``MODEL_MATERIAL_OPAQUE``.

``validate_scene`` raises the first error; ``collect_errors`` returns
all of them (the store and the tests use the raising form).

Stdlib only. Python 3.11-compatible.
"""

from __future__ import annotations

MAPS_SUPPORTED = True  # PR15 consumes the schema-1 map fields (C-15)
CLIPS_SUPPORTED = True


import json
import math
from typing import Any, Optional

from . import primitives
from .spec import (
    ASSET_FILE_EXTENSIONS,
    ASSET_FORMATS,
    ASSET_ID_RE,
    COLOR_RE,
    IMAGE_ASSET_FORMATS,
    LIGHT_TYPES,
    MATERIAL_ID_RE,
    MATERIAL_MAP_FIELDS,
    MAX_ASSETS,
    MAX_IMAGE_PIXELS,
    MAX_SCENE_IMAGE_PIXELS,
    MAX_MATERIALS,
    MAX_NODES,
    NODE_ID_RE,
    NODE_KINDS,
    SCENE_ID_RE,
    SCHEMA_VERSION,
    SHA256_RE,
    SOURCE_FORMATS,
    UP_AXIS,
    UNITS,
    PlastisError,
    CLIP_CHANNEL_TARGETS,
)

# D-EXT-02: how a baked part was produced. Sculpt, paint, UV and mesh edit store no
# generator (strokes and edits are not replayable parameters).
GENERATOR_TYPES = ("text", "curve", "modifiers", "displace", "rig")
GENERATOR_PARAMS_MAX_BYTES = 64 * 1024
MAX_MODIFIER_STACK = 8


def _number(low: float, high: float):
    return lambda v: not isinstance(v, bool) and isinstance(v, (int, float)) and math.isfinite(v) and low <= v <= high


def _integer(low: int, high: int):
    return lambda v: not isinstance(v, bool) and isinstance(v, int) and low <= v <= high


# Per modifier type, the closed set of params and the rule for each (the TypeScript side mirrors these).
MODIFIER_RULES = {
    "mirror": {"axis": lambda v: v in ("x", "y", "z"), "threshold": _number(0, 1)},
    "array": {"count": _integer(1, 64), "offset": lambda v: isinstance(v, list) and len(v) == 3 and all(_number(-1000, 1000)(c) for c in v)},
    "subdivide": {"levels": _integer(1, 2)},
    "smooth": {"iterations": _integer(1, 10), "factor": _number(0, 1)},
    "decimate": {"ratio": _number(0.05, 0.95)},
    "edgeSplit": {"angle": _number(1, 180)},
}
TEXT_PARAM_KEYS = ("text", "size", "depth", "bevel", "curveSegments", "align", "lineHeight", "font")

_TOP_LEVEL_KEYS = {
    "schema",
    "id",
    "name",
    "revision",
    "units",
    "upAxis",
    "createdAt",
    "updatedAt",
    "nodes",
    "materials",
    "assets",
    "history",
}
_TOP_LEVEL_REQUIRED = {
    "schema",
    "id",
    "name",
    "revision",
    "units",
    "upAxis",
    "createdAt",
    "updatedAt",
    "nodes",
    "materials",
    "assets",
    "history",
}

_NODE_COMMON_KEYS = {"id", "name", "parent", "kind", "transform", "visible", "clips", "generator"}
_NODE_KIND_KEYS = {
    "group": set(),
    "mesh": {"primitive", "materialId"},
    "light": {"light"},
    "camera": {"camera"},
    "model": {"modelAssetId"},
    "splat": {"splatAssetId"},
    "part": {"modelAssetId", "meshIndex", "primitiveIndex", "materialId"},
}
_NODE_REQUIRED = {"id", "name", "kind", "transform"}

_MATERIAL_KEYS = {
    "id",
    "name",
    "color",
    "emissive",
    "metalness",
    "roughness",
    "opacity",
    "doubleSide",
} | set(MATERIAL_MAP_FIELDS)

_ASSET_KEYS = {
    "id",
    "sha256",
    "file",
    "format",
    "bytes",
    "originalName",
    "sourceFormat",
    "stats",
}

_LIGHT_KEYS = {"type", "color", "intensity", "distance", "decay", "angle", "penumbra"}
_CAMERA_KEYS = {"type", "fov", "near", "far"}
_CLIP_KEYS = {"id", "name", "duration", "channels"}
_CHANNEL_KEYS = {"target", "times", "values"}
_HISTORY_KEYS = {"undo", "redo", "limit"}
_HISTORY_ENTRY_KEYS = {"label", "at", "undo", "redo"}
_STATS_COUNT_KEYS = ("tris", "verts", "materials", "meshes", "clips", "skins", "width", "height")


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _is_finite_number(value: Any) -> bool:
    return _is_number(value) and math.isfinite(value)


def _is_vec3(value: Any) -> bool:
    return (
        isinstance(value, list)
        and len(value) == 3
        and all(_is_finite_number(v) for v in value)
    )


class _Validator:
    """Collects validation errors; ``validate_scene`` raises the first."""

    def __init__(self, scene: Any) -> None:
        self.scene = scene
        self.errors: list = []
        self.node_ids: set = set()
        self.material_ids: set = set()
        self.asset_ids: set = set()
        self.asset_rows: dict = {}

    # -- helpers -------------------------------------------------------------
    def err(self, code: str, path: str, message: str) -> None:
        self.errors.append(PlastisError(code, message, path=path))

    def spec(self, path: str, message: str) -> None:
        self.err("SPEC_INVALID", path, message)

    def _check_unknown_keys(self, obj: dict, allowed: set, path: str) -> None:
        for key in obj:
            if key not in allowed:
                self.spec("%s/%s" % (path, key), "unknown key %r" % key)

    def _check_name(self, value: Any, path: str) -> None:
        if not isinstance(value, str) or not 1 <= len(value) <= 64:
            self.spec(path, "name must be a string of 1..64 characters")

    # -- top level -----------------------------------------------------------
    def validate(self) -> list:
        scene = self.scene
        if not isinstance(scene, dict):
            self.spec("", "scene must be an object")
            return self.errors
        self._check_unknown_keys(scene, _TOP_LEVEL_KEYS, "")
        for key in sorted(_TOP_LEVEL_REQUIRED):
            if key not in scene:
                self.spec("/%s" % key, "missing required key %r" % key)
        if self.errors:
            return self.errors

        # A schema-1 document is valid schema 2 (the 1 -> 2 step is an identity,
        # plastis3d_scene.upgrade); the store upgrades it on read.
        if scene.get("schema") not in (1, 2, SCHEMA_VERSION) or isinstance(scene.get("schema"), bool):
            schema = scene.get("schema")
            if _is_int(schema) and schema > SCHEMA_VERSION:
                # A newer writer's scene: refuse with its own code so
                # the reader never strips fields it does not understand
                # (standalone-editor.md, Schema evolution). Non-integer
                # or missing schema stays SPEC_INVALID, as before.
                self.err(
                    "SCHEMA_NEWER",
                    "/schema",
                    "SCHEMA_NEWER: this scene was written by a newer Plastis3D",
                )
            else:
                self.spec("/schema", "schema must be 1 or %d" % SCHEMA_VERSION)
        if scene.get("units") != UNITS:
            self.spec("/units", 'units must be "m"')
        if scene.get("upAxis") != UP_AXIS:
            self.spec("/upAxis", 'upAxis must be "Y"')
        scene_id = scene.get("id")
        if not isinstance(scene_id, str) or not SCENE_ID_RE.match(scene_id):
            self.spec("/id", "scene id must match ^[a-z0-9-]{1,64}$")
        self._check_name(scene.get("name"), "/name")
        revision = scene.get("revision")
        if not _is_int(revision) or revision < 1:
            self.spec("/revision", "revision must be an integer >= 1")
        for key in ("createdAt", "updatedAt"):
            if not isinstance(scene.get(key), str) or not scene.get(key):
                self.spec("/%s" % key, "%s must be a non-empty string" % key)

        nodes = scene.get("nodes")
        materials = scene.get("materials")
        assets = scene.get("assets")
        history = scene.get("history")
        if not isinstance(nodes, list):
            self.spec("/nodes", "nodes must be an array")
            nodes = []
        if not isinstance(materials, list):
            self.spec("/materials", "materials must be an array")
            materials = []
        if not isinstance(assets, list):
            self.spec("/assets", "assets must be an array")
            assets = []
        if not isinstance(history, dict):
            self.spec("/history", "history must be an object")
            history = {}

        if len(nodes) > MAX_NODES:
            self.err(
                "LIMIT_NODES",
                "/nodes",
                "node count %d exceeds the %d-node cap" % (len(nodes), MAX_NODES),
            )
        if len(materials) > MAX_MATERIALS:
            self.err(
                "LIMIT_MATERIALS",
                "/materials",
                "material count %d exceeds the %d-material cap"
                % (len(materials), MAX_MATERIALS),
            )
        if len(assets) > MAX_ASSETS:
            self.err(
                "LIMIT_ASSETS",
                "/assets",
                "asset count %d exceeds the %d-asset cap" % (len(assets), MAX_ASSETS),
            )

        for index, asset in enumerate(assets):
            self._validate_asset(asset, "/assets/%d" % index)
        for index, material in enumerate(materials):
            self._validate_material(material, "/materials/%d" % index)
        for index, node in enumerate(nodes):
            self._validate_node(node, "/nodes/%d" % index)
        self._validate_textures(nodes, materials)
        self._validate_graph(nodes)
        self._validate_history(history)
        return self.errors

    # -- assets --------------------------------------------------------------
    def _validate_asset(self, asset: Any, path: str) -> None:
        if not isinstance(asset, dict):
            self.spec(path, "asset must be an object")
            return
        self._check_unknown_keys(asset, _ASSET_KEYS, path)
        asset_id = asset.get("id")
        if not isinstance(asset_id, str) or not ASSET_ID_RE.match(asset_id):
            self.spec(path + "/id", "asset id must match ^[A-Za-z0-9_-]{1,64}$")
        elif asset_id in self.asset_ids:
            self.spec(path + "/id", "duplicate asset id %r" % asset_id)
        else:
            self.asset_ids.add(asset_id)
            self.asset_rows[asset_id] = asset
        sha = asset.get("sha256")
        if not isinstance(sha, str) or not SHA256_RE.match(sha):
            self.spec(path + "/sha256", "sha256 must be 64 lowercase hex chars")
            sha = None
        if asset.get("file") is not None:
            if not isinstance(asset.get("file"), str):
                self.spec(path + "/file", "file must be a string")
            elif sha is not None and asset.get("format") in ASSET_FORMATS and asset[
                "file"
            ] != "assets/%s%s" % (sha, ASSET_FILE_EXTENSIONS[asset["format"]]):
                self.spec(
                    path + "/file",
                    "file must be assets/<sha256>%s for format %s"
                    % (ASSET_FILE_EXTENSIONS[asset["format"]], asset["format"]),
                )
        else:
            self.spec(path + "/file", "missing required key 'file'")
        if asset.get("format") not in ASSET_FORMATS:
            self.spec(path + "/format", "format must be one of %s" % (list(ASSET_FORMATS),))
        if not _is_int(asset.get("bytes")) or asset.get("bytes", -1) < 0:
            self.spec(path + "/bytes", "bytes must be an integer >= 0")
        if not isinstance(asset.get("originalName"), str):
            self.spec(path + "/originalName", "originalName must be a string")
        if asset.get("sourceFormat") not in SOURCE_FORMATS:
            self.spec(
                path + "/sourceFormat",
                "sourceFormat must be one of %s" % (list(SOURCE_FORMATS),),
            )
        if asset.get("format") in IMAGE_ASSET_FORMATS and asset.get("sourceFormat") != asset.get("format"):
            self.spec(path + "/sourceFormat", "an image asset's sourceFormat must equal its format")
        if asset.get("format") == "glb" and asset.get("sourceFormat") in IMAGE_ASSET_FORMATS:
            self.spec(path + "/sourceFormat", "a model asset cannot have an image sourceFormat")
        stats = asset.get("stats")
        if stats is not None:
            self._validate_stats(stats, path + "/stats")
        if asset.get("format") in IMAGE_ASSET_FORMATS:
            for key in ("width", "height"):
                value = (stats or {}).get(key) if isinstance(stats, dict) else None
                if not _is_int(value) or value < 1:
                    self.spec(path + "/stats/" + key, "an image asset needs stats.%s, an integer >= 1" % key)

    def _validate_stats(self, stats: Any, path: str) -> None:
        if not isinstance(stats, dict):
            self.spec(path, "stats must be an object")
            return
        for key in _STATS_COUNT_KEYS:
            value = stats.get(key)
            if value is not None and (not _is_int(value) or value < 0):
                self.spec(path + "/" + key, "%s must be an integer >= 0 or null" % key)
        bounds = stats.get("bounds")
        if bounds is not None:
            self._validate_bounds(bounds, path + "/bounds")
        ignored = stats.get("ignored")
        if ignored is not None:
            if not isinstance(ignored, list) or not all(
                isinstance(v, str) for v in ignored
            ):
                self.spec(path + "/ignored", "ignored must be an array of strings")
        internals = stats.get("internals")
        if internals is not None:
            if not isinstance(internals, list):
                self.spec(path + "/internals", "internals must be an array")
            else:
                for i, item in enumerate(internals):
                    if not isinstance(item, dict):
                        self.spec(path + "/internals/%d" % i, "entry must be an object")
                    else:
                        if not _is_int(item.get("index")) or item.get("index", -1) < 0:
                            self.spec(
                                path + "/internals/%d/index" % i,
                                "index must be an integer >= 0",
                            )
                        if not isinstance(item.get("name"), str):
                            self.spec(
                                path + "/internals/%d/name" % i,
                                "name must be a string",
                            )
        drawable = stats.get("drawable")
        if drawable is not None and not isinstance(drawable, bool):
            self.spec(path + "/drawable", "drawable must be a boolean")
        parts = stats.get("parts")
        if parts is not None:
            if not isinstance(parts, list):
                self.spec(path + "/parts", "parts must be an array")
            else:
                for i, part in enumerate(parts):
                    self._validate_part_stats(part, "%s/parts/%d" % (path, i))

    def _validate_part_stats(self, part: Any, path: str) -> None:
        if not isinstance(part, dict):
            self.spec(path, "part stats entry must be an object")
            return
        self._check_unknown_keys(
            part, {"meshIndex", "primitiveIndex", "tris", "verts", "bounds", "uv"}, path
        )
        if "uv" in part and not isinstance(part["uv"], bool):
            self.spec(path + "/uv", "uv must be a boolean")
        for key in ("meshIndex", "primitiveIndex"):
            if not _is_int(part.get(key)) or part.get(key, -1) < 0:
                self.spec(path + "/" + key, "%s must be an integer >= 0" % key)
        for key in ("tris", "verts"):
            if not _is_int(part.get(key)) or part.get(key, -1) < 0:
                self.spec(path + "/" + key, "%s must be an integer >= 0" % key)
        bounds = part.get("bounds")
        if bounds is None:
            self.spec(path + "/bounds", "missing required key 'bounds'")
        else:
            self._validate_bounds(bounds, path + "/bounds")

    def _validate_bounds(self, bounds: Any, path: str) -> None:
        if not isinstance(bounds, dict):
            self.spec(path, "bounds must be an object")
            return
        self._check_unknown_keys(bounds, {"min", "max"}, path)
        lo, hi = bounds.get("min"), bounds.get("max")
        if not _is_vec3(lo):
            self.spec(path + "/min", "min must be [x, y, z] of finite numbers")
        if not _is_vec3(hi):
            self.spec(path + "/max", "max must be [x, y, z] of finite numbers")
        if _is_vec3(lo) and _is_vec3(hi):
            for axis in range(3):
                if lo[axis] > hi[axis]:
                    self.spec(
                        path,
                        "bounds min must not exceed max on axis %d" % axis,
                    )
                    break

    # -- materials -----------------------------------------------------------
    def _validate_material(self, material: Any, path: str) -> None:
        if not isinstance(material, dict):
            self.spec(path, "material must be an object")
            return
        self._check_unknown_keys(material, _MATERIAL_KEYS, path)
        material_id = material.get("id")
        if not isinstance(material_id, str) or not MATERIAL_ID_RE.match(material_id):
            self.spec(path + "/id", "material id must match ^[A-Za-z][A-Za-z0-9_-]{0,63}$")
        elif material_id in self.material_ids:
            self.spec(path + "/id", "duplicate material id %r" % material_id)
        else:
            self.material_ids.add(material_id)
        if "name" in material:
            self._check_name(material.get("name"), path + "/name")
        color = material.get("color")
        if not isinstance(color, str) or not COLOR_RE.match(color):
            self.spec(path + "/color", "color must be #rrggbb")
        emissive = material.get("emissive")
        if emissive is not None and (
            not isinstance(emissive, str) or not COLOR_RE.match(emissive)
        ):
            self.spec(path + "/emissive", "emissive must be #rrggbb")
        for key in ("metalness", "roughness", "opacity"):
            value = material.get(key)
            if value is not None and (
                not _is_finite_number(value) or value < 0 or value > 1
            ):
                self.spec(path + "/" + key, "%s must be a finite number in 0..1" % key)
        if "doubleSide" in material and not isinstance(material["doubleSide"], bool):
            self.spec(path + "/doubleSide", "doubleSide must be a boolean")
        for key in MATERIAL_MAP_FIELDS:
            value = material.get(key)
            if value is not None and value != []:
                if not isinstance(value, str) or not value:
                    self.spec(path + "/" + key, "%s must be an asset id string" % key)
                elif value not in self.asset_ids:
                    self.spec(
                        path + "/" + key,
                        "%s names unknown asset %r" % (key, value),
                    )
                elif self.asset_rows[value].get("format") not in IMAGE_ASSET_FORMATS:
                    self.spec(
                        path + "/" + key,
                        "%s names asset %r, which is a model, not an image" % (key, value),
                    )

    # -- nodes ---------------------------------------------------------------
    def _validate_node(self, node: Any, path: str) -> None:
        if not isinstance(node, dict):
            self.spec(path, "node must be an object")
            return
        kind = node.get("kind")
        if kind not in NODE_KINDS:
            self.spec(path + "/kind", "kind must be one of %s" % (list(NODE_KINDS),))
            kind = None
        allowed = _NODE_COMMON_KEYS | _NODE_KIND_KEYS.get(kind, set())
        if kind == "model":
            # materialId on a model is reported by its own rule below
            # (MODEL_MATERIAL_OPAQUE), not as an unknown key.
            allowed = allowed | {"materialId"}
        self._check_unknown_keys(node, allowed, path)
        for key in sorted(_NODE_REQUIRED):
            if key not in node:
                self.spec(path + "/" + key, "missing required key %r" % key)
        node_id = node.get("id")
        if not isinstance(node_id, str) or not NODE_ID_RE.match(node_id):
            self.spec(path + "/id", "node id must match ^[A-Za-z][A-Za-z0-9_-]{0,63}$")
        elif node_id in self.node_ids:
            self.spec(path + "/id", "duplicate node id %r" % node_id)
        else:
            self.node_ids.add(node_id)
        self._check_name(node.get("name"), path + "/name")
        parent = node.get("parent")
        if parent is not None and not isinstance(parent, str):
            self.spec(path + "/parent", "parent must be a node id or null")
        if "visible" in node and not isinstance(node["visible"], bool):
            self.spec(path + "/visible", "visible must be a boolean")
        transform = node.get("transform")
        if transform is not None:
            self._validate_transform(transform, path + "/transform")
        if "generator" in node:
            self._validate_generator(node["generator"], kind, path + "/generator")
        if "clips" in node:
            if node["clips"] and kind != "mesh":
                self.spec(path + "/clips", "primitive clips are supported only on mesh nodes")
            self._validate_clips(node["clips"], path + "/clips")

        if kind == "mesh":
            primitive = node.get("primitive")
            if primitive is None:
                self.spec(path + "/primitive", "mesh nodes require a primitive")
            else:
                self._validate_primitive(primitive, path + "/primitive")
            material_id = node.get("materialId")
            if material_id is None:
                self.spec(path + "/materialId", "mesh nodes require a materialId")
            elif not isinstance(material_id, str):
                self.spec(path + "/materialId", "materialId must be a string")
            elif material_id not in self.material_ids:
                self.spec(
                    path + "/materialId",
                    "materialId names unknown material %r" % material_id,
                )
        elif kind == "light":
            light = node.get("light")
            if light is None:
                self.spec(path + "/light", "light nodes require a light object")
            else:
                self._validate_light(light, path + "/light")
        elif kind == "camera":
            camera = node.get("camera")
            if camera is None:
                self.spec(path + "/camera", "camera nodes require a camera object")
            else:
                self._validate_camera(camera, path + "/camera")
        elif kind == "model":
            if "materialId" in node:
                self.err(
                    "MODEL_MATERIAL_OPAQUE",
                    path + "/materialId",
                    "materialId is forbidden on model nodes "
                    "(models enter only through plastis3d_import_model)",
                )
            self._validate_model_asset(node, path)
        elif kind == "splat":
            asset_id = node.get("splatAssetId")
            asset = self.asset_rows.get(asset_id) if isinstance(asset_id, str) else None
            if not asset or asset.get("format") != "splat":
                self.spec(path + "/splatAssetId", "splat nodes require a splat asset")
        elif kind == "part":
            self._validate_model_asset(node, path)
            for key in ("meshIndex", "primitiveIndex"):
                if key not in node:
                    self.spec(path + "/" + key, "part nodes require %s" % key)
                elif not _is_int(node[key]) or node[key] < 0:
                    self.spec(path + "/" + key, "%s must be an integer >= 0" % key)
            material_id = node.get("materialId")
            if material_id is not None:
                if not isinstance(material_id, str):
                    self.spec(path + "/materialId", "materialId must be a string")
                elif material_id not in self.material_ids:
                    self.spec(
                        path + "/materialId",
                        "materialId names unknown material %r" % material_id,
                    )

    def _validate_generator(self, generator: Any, kind: Any, path: str) -> None:
        """``generator: {type, version, params, baseAssetId?}`` (schema 2, D-EXT-02).

        Records how a baked ``part`` was made so the inspector can re-open it.
        It never drives rendering: the asset does. ``params`` is a bounded
        object, not free JSON, and each feature PR adds its own per-type rules.
        """
        is_rig = isinstance(generator, dict) and generator.get("type") == "rig"
        if kind != "part" and not (kind == "model" and is_rig):
            self.spec(path, "generator is allowed only on part nodes (a rig on a model)")
            return
        if kind == "part" and is_rig:
            self.spec(path + "/type", "a rig makes a model, not a part")
            return
        if not isinstance(generator, dict):
            self.spec(path, "generator must be an object")
            return
        self._check_unknown_keys(generator, {"type", "version", "params", "baseAssetId"}, path)
        if generator.get("type") not in GENERATOR_TYPES:
            self.spec(path + "/type", "generator type must be one of %s" % (list(GENERATOR_TYPES),))
        version = generator.get("version")
        if not _is_int(version) or version < 1:
            self.spec(path + "/version", "generator version must be an integer >= 1")
        params = generator.get("params")
        if not isinstance(params, dict):
            self.spec(path + "/params", "generator params must be an object")
        elif len(json.dumps(params, separators=(",", ":"))) > GENERATOR_PARAMS_MAX_BYTES:
            self.spec(path + "/params", "generator params exceed %d bytes" % GENERATOR_PARAMS_MAX_BYTES)
        if generator.get("type") == "text" and isinstance(params, dict):
            self._validate_text_params(params, path + "/params")
        if generator.get("type") == "curve" and isinstance(params, dict):
            self._validate_curve_params(params, path + "/params")
        if generator.get("type") == "displace" and isinstance(params, dict):
            self._validate_displace_params(params, path + "/params")
        if generator.get("type") == "rig" and isinstance(params, dict):
            self._validate_rig_params(params, path + "/params")
        if generator.get("type") == "modifiers" and isinstance(params, dict):
            self._validate_modifiers_params(params, path + "/params")
        base = generator.get("baseAssetId")
        if base is not None and (not isinstance(base, str) or base not in self.asset_rows):
            self.spec(path + "/baseAssetId", "baseAssetId must name an asset in this scene")

    def _validate_rig_params(self, params: dict, path: str) -> None:
        """The ``rig`` generator (PR30): bones and clips (see rig.py)."""
        from .rig import validate_params

        try:
            validate_params(params)
        except PlastisError as error:
            self.spec(path, error.message)

    def _validate_curve_params(self, params: dict, path: str) -> None:
        """The ``curve`` generator (PR28): the closed, bounded curve settings (see curves.py)."""
        from .curves import validate_params

        try:
            validate_params(params)
        except PlastisError as error:
            self.spec(path, error.message)

    def _validate_displace_params(self, params: dict, path: str) -> None:
        """The ``displace`` generator (PR28): a kept base asset plus the noise settings (see displace.py)."""
        from .displace import validate_params

        base = params.get("baseAssetId")
        if not isinstance(base, str) or base not in self.asset_rows:
            self.spec(path + "/baseAssetId", "baseAssetId must name an asset in this scene")
        try:
            validate_params({k: v for k, v in params.items() if k != "baseAssetId"})
        except PlastisError as error:
            self.spec(path, error.message)

    def _validate_modifiers_params(self, params: dict, path: str) -> None:
        """The ``modifiers`` generator (PR25): a base asset kept for non-destructive re-application and a
        bounded stack. The base asset is a sweep root (its id appears in this node)."""
        self._check_unknown_keys(params, {"baseAssetId", "stack", "baseMeshIndex", "basePrimitiveIndex"}, path)
        if ("baseMeshIndex" in params) != ("basePrimitiveIndex" in params):
            self.spec(path, "baseMeshIndex and basePrimitiveIndex must be supplied together")
        for key in ("baseMeshIndex", "basePrimitiveIndex"):
            if key in params and (isinstance(params[key], bool) or not isinstance(params[key], int) or params[key] < 0):
                self.spec(path + "/" + key, "%s must be a nonnegative integer" % key)
        base = params.get("baseAssetId")
        if not isinstance(base, str) or base not in self.asset_rows:
            self.spec(path + "/baseAssetId", "baseAssetId must name an asset in this scene")
        stack = params.get("stack")
        if not isinstance(stack, list) or len(stack) > MAX_MODIFIER_STACK:
            self.spec(path + "/stack", "stack must be a list of at most %d modifiers" % MAX_MODIFIER_STACK)
            return
        for i, entry in enumerate(stack):
            where = "%s/stack/%d" % (path, i)
            if not isinstance(entry, dict):
                self.spec(where, "a modifier must be an object")
                continue
            self._check_unknown_keys(entry, {"type", "enabled", "params"}, where)
            if not isinstance(entry.get("enabled"), bool):
                self.spec(where + "/enabled", "enabled must be a boolean")
            kind = entry.get("type")
            p = entry.get("params")
            if kind not in MODIFIER_RULES or not isinstance(p, dict):
                self.spec(where, "a modifier needs a known type and a params object")
                continue
            rule = MODIFIER_RULES[kind]
            self._check_unknown_keys(p, set(rule), where + "/params")
            for key, check in rule.items():
                if key not in p or not check(p[key]):
                    self.spec(where + "/params/" + key, "%s.%s is missing or out of range" % (kind, key))

    def _validate_text_params(self, params: dict, path: str) -> None:
        """The ``text`` generator (PR23): bounded, closed, one bundled font."""
        self._check_unknown_keys(params, set(TEXT_PARAM_KEYS), path)
        for key in TEXT_PARAM_KEYS:
            if key not in params:
                self.spec(path + "/" + key, "text generator params require %s" % key)
        text = params.get("text")
        if not isinstance(text, str) or not 1 <= len(text) <= 200 or any(
            ord(c) < 32 and c != "\n" or ord(c) == 127 for c in text
        ):
            self.spec(path + "/text", "text must be 1 to 200 characters with no control characters except newline")

        def number(key: str, low: float, high: float) -> Optional[float]:
            value = params.get(key)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
                self.spec(path + "/" + key, "%s must be a number from %s to %s" % (key, low, high))
                return None
            return float(value)

        size = number("size", 0.01, 10)
        number("depth", 0, size if size is not None else 10)
        number("lineHeight", 0.8, 3)
        segments = params.get("curveSegments")
        if isinstance(segments, bool) or not _is_int(segments) or not 1 <= segments <= 12:
            self.spec(path + "/curveSegments", "curveSegments must be an integer from 1 to 12")
        if params.get("align") not in ("left", "center", "right"):
            self.spec(path + "/align", "align must be left, center or right")
        if params.get("font") != "bundled-sans-v1":
            self.spec(path + "/font", "font must be bundled-sans-v1")
        bevel = params.get("bevel")
        if not isinstance(bevel, dict):
            self.spec(path + "/bevel", "bevel must be an object")
        else:
            self._check_unknown_keys(bevel, {"enabled", "thickness", "size"}, path + "/bevel")
            if not isinstance(bevel.get("enabled"), bool):
                self.spec(path + "/bevel/enabled", "bevel.enabled must be a boolean")
            for key in ("thickness", "size"):
                value = bevel.get(key)
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= (size if size is not None else 10):
                    self.spec(path + "/bevel/" + key, "bevel.%s must be a number from 0 to the text size" % key)

    def _validate_model_asset(self, node: dict, path: str) -> None:
        asset_id = node.get("modelAssetId")
        if asset_id is None:
            self.spec(
                path + "/modelAssetId",
                "%s nodes require modelAssetId" % node.get("kind"),
            )
        elif not isinstance(asset_id, str):
            self.spec(path + "/modelAssetId", "modelAssetId must be a string")
        elif asset_id not in self.asset_ids:
            self.spec(
                path + "/modelAssetId",
                "modelAssetId names unknown asset %r" % asset_id,
            )
        elif self.asset_rows[asset_id].get("format") != "glb":
            self.spec(
                path + "/modelAssetId",
                "modelAssetId names asset %r, which is an image, not a model" % asset_id,
            )

    def _validate_textures(self, nodes: list, materials: list) -> None:
        """Texture rules that need the whole document (PR15, C-08, C-07).

        A part drawn with a textured material needs UVs on its source
        primitive (``stats.parts[].uv``); a mesh node's primitive always has
        generated UVs, so it needs nothing. The decoded size of every image
        the materials use is bounded in total.
        """
        by_id = {m.get("id"): m for m in materials if isinstance(m, dict)}
        used: set = set()
        for material in by_id.values():
            for key in MATERIAL_MAP_FIELDS:
                value = material.get(key)
                if isinstance(value, str) and value in self.asset_rows:
                    used.add(value)
        pixels = 0
        for asset_id in used:
            stats = self.asset_rows[asset_id].get("stats") or {}
            width, height = stats.get("width"), stats.get("height")
            if _is_int(width) and _is_int(height):
                if width * height > MAX_IMAGE_PIXELS:
                    self.err("IMPORT_TOO_COMPLEX", "/assets", "image %r is %d x %d pixels, over the %d-pixel limit" % (asset_id, width, height, MAX_IMAGE_PIXELS))
                pixels += width * height
        if pixels > MAX_SCENE_IMAGE_PIXELS:
            self.err(
                "IMPORT_TOO_COMPLEX",
                "/materials",
                "the textures this scene uses decode to %d pixels, over the %d-pixel budget; "
                "use smaller images or fewer maps" % (pixels, MAX_SCENE_IMAGE_PIXELS),
            )
        for index, node in enumerate(nodes):
            if not isinstance(node, dict) or node.get("kind") != "part":
                continue
            material = by_id.get(node.get("materialId"))
            if material is None or not any(
                isinstance(material.get(key), str) for key in MATERIAL_MAP_FIELDS
            ):
                continue
            asset = self.asset_rows.get(node.get("modelAssetId")) or {}
            entry = next(
                (
                    p
                    for p in ((asset.get("stats") or {}).get("parts") or [])
                    if isinstance(p, dict)
                    and p.get("meshIndex") == node.get("meshIndex")
                    and p.get("primitiveIndex") == node.get("primitiveIndex")
                ),
                None,
            )
            if entry is None or "uv" not in entry:
                self.err("TEXTURE_NO_UV", "/nodes/%d/materialId" % index,
                         "UV coordinates for part %r could not be verified; restore its source model or choose a material without maps" % node.get("name"))
            elif entry.get("uv") is not True:
                self.err(
                    "TEXTURE_NO_UV",
                    "/nodes/%d/materialId" % index,
                    "part %r has no UV coordinates, so material %r cannot put a texture on it; "
                    "give it a material without maps, or use a model that carries UVs"
                    % (node.get("name"), node.get("materialId")),
                )

    def _validate_transform(self, transform: Any, path: str) -> None:
        if not isinstance(transform, dict):
            self.spec(path, "transform must be an object")
            return
        self._check_unknown_keys(transform, {"t", "r", "s"}, path)
        for key in ("t", "r", "s"):
            value = transform.get(key)
            if not _is_vec3(value):
                self.spec(
                    path + "/" + key,
                    "%s must be [x, y, z] of finite numbers" % key,
                )
        scale = transform.get("s")
        if _is_vec3(scale):
            for axis, component in enumerate(scale):
                if component == 0:
                    self.spec(
                        path + "/s/%d" % axis,
                        "scale component must not be 0",
                    )

    def _validate_primitive(self, primitive: Any, path: str) -> None:
        if not isinstance(primitive, dict):
            self.spec(path, "primitive must be an object")
            return
        ptype = primitive.get("type")
        if ptype not in primitives.PRIMITIVE_TYPES:
            self.spec(
                path + "/type",
                "primitive type must be one of %s" % (list(primitives.PRIMITIVE_TYPES),),
            )
            return
        allowed = {"type"} | set(primitives.PRIMITIVE_DEFAULTS[ptype])
        self._check_unknown_keys(primitive, allowed, path)
        for key in primitives._DIMENSION_PARAMS[ptype]:
            value = primitive.get(key, primitives.PRIMITIVE_DEFAULTS[ptype][key])
            if not _is_finite_number(value) or value <= 0:
                self.spec(path + "/" + key, "%s must be a finite number > 0" % key)
        for key in primitives._SEGMENT_PARAMS.get(ptype, ()):
            value = primitive.get(key, primitives.PRIMITIVE_DEFAULTS[ptype][key])
            if not _is_int(value) or value < primitives.MIN_SEGMENTS or value > primitives.MAX_SEGMENTS:
                self.spec(
                    path + "/" + key,
                    "%s must be an integer in %d..%d"
                    % (key, primitives.MIN_SEGMENTS, primitives.MAX_SEGMENTS),
                )

    def _validate_light(self, light: Any, path: str) -> None:
        if not isinstance(light, dict):
            self.spec(path, "light must be an object")
            return
        self._check_unknown_keys(light, _LIGHT_KEYS, path)
        ltype = light.get("type")
        if ltype not in LIGHT_TYPES:
            self.spec(path + "/type", "light type must be one of %s" % (list(LIGHT_TYPES),))
        color = light.get("color")
        if not isinstance(color, str) or not COLOR_RE.match(color):
            self.spec(path + "/color", "color must be #rrggbb")
        intensity = light.get("intensity")
        if not _is_finite_number(intensity) or intensity < 0:
            self.spec(path + "/intensity", "intensity must be a finite number >= 0")
        distance = light.get("distance")
        if distance is not None and (not _is_finite_number(distance) or distance < 0):
            self.spec(path + "/distance", "distance must be a finite number >= 0")
        decay = light.get("decay")
        if decay is not None and decay != 2:
            self.spec(path + "/decay", "decay, when present, must be exactly 2")
        # Spot-only fields (KHR_lights_punctual): angle in degrees, penumbra 0..1.
        angle = light.get("angle")
        if angle is not None:
            if ltype != "spot":
                self.spec(path + "/angle", "angle is only valid on spot lights")
            elif not _is_finite_number(angle) or angle <= 0 or angle > 90:
                self.spec(path + "/angle", "angle must be a finite number in (0, 90]")
        penumbra = light.get("penumbra")
        if penumbra is not None:
            if ltype != "spot":
                self.spec(path + "/penumbra", "penumbra is only valid on spot lights")
            elif not _is_finite_number(penumbra) or penumbra < 0 or penumbra > 1:
                self.spec(path + "/penumbra", "penumbra must be a finite number in 0..1")

    def _validate_camera(self, camera: Any, path: str) -> None:
        if not isinstance(camera, dict):
            self.spec(path, "camera must be an object")
            return
        self._check_unknown_keys(camera, _CAMERA_KEYS, path)
        if camera.get("type") != "perspective":
            self.spec(path + "/type", 'camera type must be "perspective"')
        fov = camera.get("fov")
        if not _is_finite_number(fov) or fov <= 0 or fov >= 180:
            self.spec(path + "/fov", "fov must be a finite number in (0, 180)")
        near = camera.get("near")
        if not _is_finite_number(near) or near <= 0:
            self.spec(path + "/near", "near must be a finite number > 0")
        far = camera.get("far")
        if not _is_finite_number(far) or far <= 0:
            self.spec(path + "/far", "far must be a finite number > 0")
        elif _is_finite_number(near) and far <= near:
            self.spec(path + "/far", "far must be greater than near")

    def _validate_clips(self, clips: Any, path: str) -> None:
        if clips is None:
            return
        if not isinstance(clips, list):
            self.spec(path, "clips must be an array")
            return
        for i, clip in enumerate(clips):
            cpath = "%s/%d" % (path, i)
            if not isinstance(clip, dict):
                self.spec(cpath, "clip must be an object")
                continue
            self._check_unknown_keys(clip, _CLIP_KEYS, cpath)
            if "id" in clip and (
                not isinstance(clip["id"], str) or not NODE_ID_RE.match(clip["id"])
            ):
                self.spec(cpath + "/id", "clip id must match ^[A-Za-z][A-Za-z0-9_-]{0,63}$")
            if "name" in clip:
                self._check_name(clip["name"], cpath + "/name")
            duration = clip.get("duration")
            if duration is not None and (
                not _is_finite_number(duration) or duration <= 0
            ):
                self.spec(cpath + "/duration", "duration must be a finite number > 0")
            channels = clip.get("channels")
            if not isinstance(channels, list) or not channels:
                self.spec(cpath + "/channels", "channels must be a non-empty array")
                continue
            seen_targets = set()
            for j, channel in enumerate(channels):
                channel_path = "%s/channels/%d" % (cpath, j)
                self._validate_channel(channel, channel_path)
                if not isinstance(channel, dict):
                    continue
                target = channel.get("target")
                if isinstance(target, str):
                    if target in seen_targets:
                        self.spec(channel_path + "/target", "each target may appear only once")
                    seen_targets.add(target)
                times = channel.get("times")
                if (isinstance(duration, (int, float)) and not isinstance(duration, bool)
                    and isinstance(times, list) and times and all(_is_finite_number(t) for t in times)
                    and duration < max(times)):
                    self.spec(cpath + "/duration", "duration must cover every key")
                values = channel.get("values")
                if target == "rotation" and isinstance(values, list) and all(_is_vec3(v) for v in values):
                    for a, b in zip(values, values[1:]):
                        before = primitives.rotation_matrix_xyz(a)
                        after = primitives.rotation_matrix_xyz(b)
                        relative_trace = sum(before[row][col] * after[row][col] for row in range(3) for col in range(3))
                        if any(abs(x-y) >= 180 for x, y in zip(a, b)) or relative_trace <= -1 + 1e-12:
                            self.spec(channel_path + "/values", "rotation intervals must be below 180 degrees")
                            break

    def _validate_channel(self, channel: Any, path: str) -> None:
        if not isinstance(channel, dict):
            self.spec(path, "channel must be an object")
            return
        self._check_unknown_keys(channel, _CHANNEL_KEYS, path)
        if channel.get("target") not in CLIP_CHANNEL_TARGETS:
            self.spec(
                path + "/target",
                "target must be one of %s" % (list(CLIP_CHANNEL_TARGETS),),
            )
        times = channel.get("times")
        values = channel.get("values")
        if not isinstance(times, list) or not times:
            self.spec(path + "/times", "times must be a non-empty array")
            times = None
        elif not all(_is_finite_number(t) and t >= 0 for t in times):
            self.spec(path + "/times", "times must be finite numbers >= 0")
        elif any(times[i] >= times[i + 1] for i in range(len(times) - 1)):
            self.spec(path + "/times", "times must be strictly increasing")
        if not isinstance(values, list):
            self.spec(path + "/values", "values must be an array")
            values = None
        elif not all(_is_vec3(v) for v in values):
            self.spec(path + "/values", "each value must be [x, y, z] of finite numbers")
        if times is not None and values is not None and len(times) != len(values):
            self.spec(
                path,
                "times and values must have the same length "
                "(%d times, %d values)" % (len(times), len(values)),
            )

    # -- graph integrity -------------------------------------------------------
    def _validate_graph(self, nodes: list) -> None:
        by_id = {}
        for node in nodes:
            if isinstance(node, dict) and isinstance(node.get("id"), str):
                by_id[node["id"]] = node
        for index, node in enumerate(nodes):
            if not isinstance(node, dict):
                continue
            parent = node.get("parent")
            if parent is not None and isinstance(parent, str) and parent not in by_id:
                self.spec(
                    "/nodes/%d/parent" % index,
                    "parent names unknown node %r" % parent,
                )
        # Cycle detection: follow each parent chain; a repeat is a cycle.
        for node in nodes:
            if not isinstance(node, dict):
                continue
            seen = set()
            current = node.get("id")
            while isinstance(current, str):
                if current in seen:
                    self.spec(
                        "/nodes",
                        "parent cycle detected at node %r" % current,
                    )
                    break
                seen.add(current)
                parent_node = by_id.get(current)
                if parent_node is None:
                    break
                current = parent_node.get("parent")

    # -- history ---------------------------------------------------------------
    def _validate_history(self, history: Any) -> None:
        if not isinstance(history, dict):
            return  # already reported at the top level
        self._check_unknown_keys(history, _HISTORY_KEYS, "/history")
        limit = history.get("limit")
        if limit is not None and (not _is_int(limit) or limit < 0):
            self.spec("/history/limit", "limit must be an integer >= 0")
        for key in ("undo", "redo"):
            entries = history.get(key)
            if entries is None:
                continue
            if not isinstance(entries, list):
                self.spec("/history/%s" % key, "%s must be an array" % key)
                continue
            if _is_int(limit) and len(entries) > limit:
                self.spec(
                    "/history/%s" % key,
                    "%s has %d entries, over the limit of %d"
                    % (key, len(entries), limit),
                )
            for i, entry in enumerate(entries):
                self._validate_history_entry(entry, "/history/%s/%d" % (key, i))

    def _validate_history_entry(self, entry: Any, path: str) -> None:
        if not isinstance(entry, dict):
            self.spec(path, "history entry must be an object")
            return
        self._check_unknown_keys(entry, _HISTORY_ENTRY_KEYS, path)
        if not isinstance(entry.get("label"), str) or not entry.get("label"):
            self.spec(path + "/label", "label must be a non-empty string")
        if not isinstance(entry.get("at"), str) or not entry.get("at"):
            self.spec(path + "/at", "at must be a non-empty string")
        for key in ("undo", "redo"):
            maps = entry.get(key)
            if maps is None:
                continue
            if not isinstance(maps, dict):
                self.spec(path + "/" + key, "%s must be an object" % key)
                continue
            for map_name, id_map in maps.items():
                if map_name == "scene":
                    if not isinstance(id_map, dict) or set(id_map) != {"name"} or not isinstance(id_map.get("name"), str) or not id_map["name"].strip() or len(id_map["name"]) > 80:
                        self.spec(path + "/" + key + "/scene", "invalid scene name history")
                    continue
                if map_name not in ("nodes", "materials", "assets"):
                    self.spec(
                        path + "/" + key + "/" + map_name,
                        "history map must be nodes, materials, or assets",
                    )
                    continue
                if not isinstance(id_map, dict):
                    self.spec(
                        path + "/" + key + "/" + map_name,
                        "history map must be an object of id -> object-or-null",
                    )


def collect_errors(scene: Any) -> list:
    """All validation errors for a scene document (possibly empty)."""
    return _Validator(scene).validate()


def validate_scene(scene: Any) -> None:
    """Validate a scene document; raise :class:`PlastisError` on the
    first error (code + exact JSON pointer path)."""
    errors = collect_errors(scene)
    if errors:
        raise errors[0]


def is_valid(scene: Any) -> bool:
    """``True`` when a scene document passes strict validation."""
    return not collect_errors(scene)
