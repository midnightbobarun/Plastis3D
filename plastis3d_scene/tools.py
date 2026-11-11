"""Plastis3D — the agent tools (PR3, Stage 2).

Thin handlers over :mod:`plastis3d_scene.mutate`: every mutating tool
calls ``mutate.apply()``; read-only tools (``list_scenes``,
``get_scene``, ``open_in_desktop``, ``export_glb``) do not mutate.

``plastis3d_import_model`` landed in Stage 3 (PR7): its body is
:func:`plastis3d_scene.import_model.import_path`, bounded by the
30-second ``IMPORT_TIMEOUT``; 30 s is a default, not a host limit.
``plastis3d_export_glb`` landed in PR6: its body is
:func:`plastis3d_scene.export_glb.export_scene`, bounded by its own
30-second timeout (``EXPORT_TIMEOUT``).

Failures raise :class:`plastis3d_scene.spec.PlastisError` whose message
starts with the stable code (``"CODE: message"``). Handlers never
retry and never prompt. Only ``plastis3d_screenshot`` waits, for a bounded
time, for an open scene view (PR22); no other handler sleeps or waits
for Desktop.

All tools run headless (the screenshot tool needs an open view to answer). ``open_in_desktop`` broadcasts
``plugin.plastis3d.editor.focus`` and returns immediately, no ack.

Stdlib only. Python 3.11-compatible.
"""

from __future__ import annotations

from typing import Any, Optional

from . import capture, generators, mutate
from .export_glb import EXPORT_TIMEOUT as _EXPORT_TIMEOUT
from .export_glb import export_scene as _export_scene
from .import_model import IMPORT_TIMEOUT as _IMPORT_TIMEOUT
from .import_model import import_path as _import_path
from .spec import PlastisError
from .store import Store

# Stage 3 bodies are bounded by their own 30-second timeouts. 30 s is a
# default, not a host limit (standalone-editor.md, Caps table).
IMPORT_TIMEOUT = _IMPORT_TIMEOUT
EXPORT_TIMEOUT = _EXPORT_TIMEOUT

# The stable code returned while a Stage 3 body is pending. No body is
# pending any more (import landed in PR7); the constant stays because
# the code itself remains in the error table (spec.ERROR_HTTP_STATUS).
NOT_IMPLEMENTED_CODE = "NOT_IMPLEMENTED"

_TOOLSET = "plastis3d"


# --- Handler plumbing ----------------------------------------------------------

def _store() -> Store:
    """A fresh Store per call (directory resolved from the environment
    at call time, so tests can point it at a tmp dir)."""
    return Store()


def _fail(error: PlastisError) -> None:
    """Re-raise with the stable code leading the message."""
    raise PlastisError(
        error.code,
        "%s: %s" % (error.code, error.message),
        path=error.path,
        current_revision=error.current_revision,
    )


def _scene_arg(kwargs: dict) -> str:
    scene = kwargs.get("scene")
    if not isinstance(scene, str) or not scene:
        raise PlastisError("SPEC_INVALID", "SPEC_INVALID: scene id is required", path="/scene")
    return scene


def _base_revision_arg(kwargs: dict) -> int:
    base = kwargs.get("baseRevision")
    if not isinstance(base, int) or isinstance(base, bool):
        raise PlastisError(
            "SPEC_INVALID",
            "SPEC_INVALID: baseRevision must be an integer",
            path="/baseRevision",
        )
    return base


def _apply(kwargs: dict, mutation: dict) -> dict:
    """Call ``mutate.apply`` for a mutating tool, code-first on failure."""
    store = _store()
    try:
        return mutate.apply(
            _scene_arg(kwargs), _base_revision_arg(kwargs), mutation, store=store, origin="tool"
        )
    except PlastisError as error:
        _fail(error)
        raise AssertionError("unreachable")


# --- Read-only tools -----------------------------------------------------------

def list_scenes(**kwargs: Any) -> dict:
    """``{ok, scenes: [{id, name, revision, updatedAt}]}``."""
    try:
        return {"ok": True, "scenes": _store().list_scenes()}
    except PlastisError as error:
        _fail(error)
        raise AssertionError("unreachable")


def get_scene(**kwargs: Any) -> dict:
    """One scene as a feedback envelope (no history stacks, no mesh bytes)."""
    store = _store()
    try:
        scene = store.get_scene(_scene_arg(kwargs))
    except PlastisError as error:
        _fail(error)
        raise AssertionError("unreachable")
    from .asset_facts import enrich_legacy_uvs
    return store.envelope(enrich_legacy_uvs(scene, store))


def check_gltf(**kwargs: Any) -> dict:
    """The compatibility report for a scene, or for one model asset (PR16).

    Read-only: it reads the scene and the stored model files and writes
    nothing, so it needs no ``baseRevision``. ``assetId`` (an id from
    ``get_scene``) narrows it to one imported model. Returns promptly and
    never waits on a viewport, so it is safe under cron and the gateway.
    """
    from .compat import check_scene

    store = _store()
    scene_id = _scene_arg(kwargs)
    asset_id = kwargs.get("assetId")
    if asset_id is not None and not isinstance(asset_id, str):
        raise PlastisError("SPEC_INVALID", "SPEC_INVALID: assetId must be a string", path="/assetId")
    try:
        return check_scene(store.get_scene(scene_id), store, asset_id=asset_id)
    except PlastisError as error:
        _fail(error)
        raise AssertionError("unreachable")


def analyze(**kwargs: Any) -> dict:
    """The analyzer (PR17): the compatibility report plus measured counts and a
    heuristic score against a named budget (``mobile`` or ``desktop``).

    Read-only, like ``check_gltf``: no ``baseRevision``, nothing written.
    """
    from .analyze import DEFAULT_BUDGET, analyze_scene

    store = _store()
    scene_id = _scene_arg(kwargs)
    asset_id = kwargs.get("assetId")
    if asset_id is not None and not isinstance(asset_id, str):
        raise PlastisError("SPEC_INVALID", "SPEC_INVALID: assetId must be a string", path="/assetId")
    try:
        return analyze_scene(
            store.get_scene(scene_id), store, asset_id=asset_id, budget=kwargs.get("budget") or DEFAULT_BUDGET
        )
    except PlastisError as error:
        _fail(error)
        raise AssertionError("unreachable")


def cleanup(**kwargs: Any) -> dict:
    """Prune and dedupe a scene (PR18): one undoable revision.

    ``operations`` is any of ``dedupe_materials``, ``prune_materials``,
    ``prune_groups`` (default: all three). ``dryRun`` returns what would
    change and writes nothing. The result is the feedback envelope plus a
    ``cleanup`` block naming exactly what was merged and removed.
    """
    from .cleanup import run

    scene_id = _scene_arg(kwargs)
    base_revision = _base_revision_arg(kwargs)
    dry_run = kwargs.get("dryRun", False)
    if not isinstance(dry_run, bool):
        raise PlastisError("SPEC_INVALID", "SPEC_INVALID: dryRun must be a boolean", path="/dryRun")
    asset_id = kwargs.get("assetId")
    if asset_id is not None and not isinstance(asset_id, str):
        raise PlastisError("SPEC_INVALID", "SPEC_INVALID: assetId must be a string", path="/assetId")
    try:
        return run(
            scene_id,
            _store(),
            base_revision,
            kwargs.get("operations"),
            dry_run=dry_run,
            origin="tool",
            asset_id=asset_id,
        )
    except PlastisError as error:
        _fail(error)
        raise AssertionError("unreachable")


def open_in_desktop(**kwargs: Any) -> dict:
    """Broadcast ``plugin.plastis3d.editor.focus`` and return immediately.

    No ack: waiting for a focus acknowledgement would hang on a person
    or a window (rule 12). ``SCENE_NOT_FOUND`` only; a missing window
    is success.
    """
    scene_id = _scene_arg(kwargs)
    store = _store()
    try:
        store.get_scene(scene_id)
    except PlastisError as error:
        _fail(error)
        raise AssertionError("unreachable")
    mutate.broadcast("editor.focus", {"scene": scene_id})
    return {"ok": True, "broadcast": "plugin.plastis3d.editor.focus", "scene": scene_id}


def screenshot(**kwargs: Any) -> dict:
    """A PNG of the scene as an open view draws it (PR22, C-10).

    Unlike every other tool this one waits, for a bounded time, for a
    scene view (Desktop or Webapp) to answer; with none open it returns
    ``DESKTOP_UNAVAILABLE`` and never hangs. The request is single-use
    and bound to this profile, the scene id and the current revision; see
    :mod:`plastis3d_scene.capture`. Read-only: no revision bump.
    """
    scene_id = _scene_arg(kwargs)
    wait = kwargs.get("waitSeconds", capture.DEFAULT_WAIT)
    if isinstance(wait, bool) or not isinstance(wait, (int, float)) or not 1 <= wait <= capture.MAX_WAIT:
        raise PlastisError(
            "SPEC_INVALID",
            "SPEC_INVALID: waitSeconds must be a number from 1 to %d" % int(capture.MAX_WAIT),
            path="/waitSeconds",
        )
    store = _store()
    try:
        scene = store.get_scene(scene_id)
        return capture.screenshot(
            store, scene, wait, announce=lambda payload: mutate.broadcast("capture.requested", payload)
        )
    except PlastisError as error:
        _fail(error)
        raise AssertionError("unreachable")


def curve(**kwargs: Any) -> dict:
    """Create a curve (a tube along a spline, or a lathe) as a part, or change one (``id``) and regenerate it (PR28).

    With ``followPath`` a second revision gives a built-in shape a translation clip that walks along the curve."""
    try:
        store = _store()
        envelope = generators.make_curve(
            store, _scene_arg(kwargs), _base_revision_arg(kwargs), kwargs.get("curve"),
            node_id=kwargs.get("id"), name=kwargs.get("name"), parent=kwargs.get("parent"), transform=kwargs.get("transform"), origin="tool",
        )
        follow = kwargs.get("followPath")
        if follow is not None:
            if not isinstance(follow, dict) or set(follow) - {"target", "keys", "duration"} or "target" not in follow:
                raise PlastisError("SPEC_INVALID", "SPEC_INVALID: followPath takes target, keys and duration", path="/followPath")
            curve_id = kwargs.get("id") or next(n["id"] for n in envelope["nodes"] if n.get("generator", {}).get("type") == "curve" and n["name"] == (kwargs.get("name") or ("Tube" if kwargs["curve"].get("kind") == "tube" else "Lathe")))
            envelope = generators.follow_path(store, _scene_arg(kwargs), envelope["scene"]["revision"], curve_id, follow["target"], follow.get("keys", 16), follow.get("duration", 4), origin="tool")
        return envelope
    except PlastisError as error:
        _fail(error)
        raise AssertionError("unreachable")


def clone(**kwargs: Any) -> dict:
    """Clone a node in a grid, a line or a ring under a new group "Clones of <name>" (PR28)."""
    try:
        return generators.make_clones(_store(), _scene_arg(kwargs), _base_revision_arg(kwargs), kwargs.get("source"), kwargs.get("mode"), kwargs.get("params"), origin="tool")
    except PlastisError as error:
        _fail(error)
        raise AssertionError("unreachable")


def displace(**kwargs: Any) -> dict:
    """Displace a shape or part by seeded noise along its normals; the original mesh is kept so the settings can change (PR28)."""
    try:
        return generators.make_displace(_store(), _scene_arg(kwargs), _base_revision_arg(kwargs), kwargs.get("id"), kwargs.get("params"))
    except PlastisError as error:
        _fail(error)
        raise AssertionError("unreachable")


# --- Mutating tools (all via mutate.apply) -------------------------------------

def new_scene(**kwargs: Any) -> dict:
    """Create a scene with the default rig at revision 1."""
    name = kwargs.get("name")
    store = _store()
    try:
        return mutate.apply(
            None,
            None,
            {"op": "create", "name": name, "id": kwargs.get("id")},
            store=store, origin="tool",
        )
    except PlastisError as error:
        _fail(error)
        raise AssertionError("unreachable")


def build_scene(**kwargs: Any) -> dict:
    """Replace nodes/materials; keep asset rows."""
    nodes = kwargs.get("nodes")
    if not isinstance(nodes, list):
        raise PlastisError(
            "SPEC_INVALID", "SPEC_INVALID: build_scene requires a nodes array", path="/nodes"
        )
    mutation: dict = {"op": "build", "nodes": nodes}
    if kwargs.get("materials") is not None:
        mutation["materials"] = kwargs["materials"]
    if kwargs.get("name") is not None:
        mutation["name"] = kwargs["name"]
    return _apply(kwargs, mutation)


def _node_from_kwargs(kwargs: dict) -> dict:
    """Assemble a node dict from a tool call's flat node fields."""
    node: dict = {}
    for key in (
        "id",
        "name",
        "parent",
        "kind",
        "transform",
        "visible",
        "primitive",
        "materialId",
        "light",
        "camera",
        "clips",
    ):
        if key in kwargs and kwargs[key] is not None:
            node[key] = kwargs[key]
    if "node" in kwargs and isinstance(kwargs["node"], dict):
        node.update(kwargs["node"])
    return node


def add_node(**kwargs: Any) -> dict:
    """Append one node (id generated when omitted)."""
    return _apply(kwargs, {"op": "add_node", "node": _node_from_kwargs(kwargs)})


def update_node(**kwargs: Any) -> dict:
    """Change node fields, including clips on primitive meshes."""
    mutate._reject_reserved({"clips": kwargs.get("clips")})
    if "sceneName" in kwargs:
        return _apply(kwargs, {"op": "set_scene_name", "name": kwargs["sceneName"]})
    node_id = kwargs.get("id")
    if not isinstance(node_id, str) or not node_id:
        raise PlastisError("SPEC_INVALID", "SPEC_INVALID: update_node requires an id", path="/id")
    mutation: dict = {"op": "update_node", "id": node_id}
    for key in (
        "name",
        "parent",
        "visible",
        "transform",
        "primitive",
        "light",
        "camera",
        "materialId",
        "clips",
    ):
        if key in kwargs:
            mutation[key] = kwargs[key]
    return _apply(kwargs, mutation)


def set_material(**kwargs: Any) -> dict:
    """Upsert a material and optionally assign it to mesh/part node ids.

    ``assignTo`` naming a ``model`` node returns ``NODE_LOCKED``
    (``MODEL_MATERIAL_OPAQUE``: models are opaque; the override exists
    only on ``part`` nodes — editable-imports plan §5).

    The four texture-map fields (PR15) take the id of an image asset that is
    already in the scene, or ``null`` to clear the map. Picking a new image
    file is an editor action (Maps in the material section): no tool reads an
    image off disk.
    """
    material: dict = {}
    for key in (
        "id",
        "name",
        "color",
        "emissive",
        "metalness",
        "roughness",
        "opacity",
        "doubleSide",
    ):
        if key in kwargs and kwargs[key] is not None:
            material[key] = kwargs[key]
    for key in mutate.MATERIAL_MAP_FIELDS:
        if key in kwargs:  # null is meaningful here: it clears the map
            material[key] = kwargs[key]
    if "material" in kwargs and isinstance(kwargs["material"], dict):
        material.update(kwargs["material"])
    mutation: dict = {"op": "set_material", "material": material}
    if kwargs.get("assignTo") is not None:
        mutation["assignTo"] = kwargs["assignTo"]
    return _apply(kwargs, mutation)


def duplicate_node(**kwargs: Any) -> dict:
    """Copy a subtree with new ids; materials shared; models keep kind
    and ``modelAssetId``; parts keep asset + mesh/primitive indexes."""
    node_id = kwargs.get("id")
    if not isinstance(node_id, str) or not node_id:
        raise PlastisError(
            "SPEC_INVALID", "SPEC_INVALID: duplicate_node requires an id", path="/id"
        )
    return _apply(kwargs, {"op": "duplicate_node", "id": node_id})


def delete_node(**kwargs: Any) -> dict:
    """Delete a subtree; re-adds ``cam_main`` in the same entry when the
    delete would leave zero cameras."""
    node_id = kwargs.get("id")
    if not isinstance(node_id, str) or not node_id:
        raise PlastisError(
            "SPEC_INVALID", "SPEC_INVALID: delete_node requires an id", path="/id"
        )
    return _apply(kwargs, {"op": "delete_node", "id": node_id})


def undo(**kwargs: Any) -> dict:
    """Undo the last mutation (one history entry)."""
    return _apply(kwargs, {"op": "undo"})


def redo(**kwargs: Any) -> dict:
    """Redo the last undone mutation (one history entry)."""
    return _apply(kwargs, {"op": "redo"})


# --- Stage 3 import body (PR7) ------------------------------------------------

def import_model(**kwargs: Any) -> dict:
    """Import a GLB, embedded glTF, OBJ, STL or PLY file into a scene (PR7, PR12).

    ``path`` is an absolute path on the machine where Hermes runs.
    By default (``explode`` true) the file explodes into editable spec
    nodes — one group per glTF node, one part per TRIANGLES primitive;
    ``explode: false`` attaches one locked ``model`` node instead.
    Returns the feedback envelope. The scene is checked first so a bad
    id still reports ``SCENE_NOT_FOUND``; ``baseRevision`` is required.
    Refusals (``IMPORT_*``, ``LIMIT_NODES`` / ``LIMIT_ASSETS``) write
    nothing: no asset file, no asset row, no scene change.
    """
    scene_id = _scene_arg(kwargs)
    base_revision = _base_revision_arg(kwargs)
    store = _store()
    try:
        store.get_scene(scene_id)
    except PlastisError as error:
        _fail(error)
        raise AssertionError("unreachable")
    path = kwargs.get("path")
    if not isinstance(path, str) or not path:
        raise PlastisError(
            "SPEC_INVALID", "SPEC_INVALID: import_model requires a path", path="/path"
        )
    explode = kwargs.get("explode", True)
    if not isinstance(explode, bool):
        raise PlastisError(
            "SPEC_INVALID", "SPEC_INVALID: explode must be a boolean", path="/explode"
        )
    try:
        return _import_path(
            scene_id,
            store,
            path,
            base_revision=base_revision,
            name=kwargs.get("name"),
            parent=kwargs.get("parent"),
            transform=kwargs.get("transform"),
            explode=explode,
        )
    except PlastisError as error:
        _fail(error)
        raise AssertionError("unreachable")


def export_glb(**kwargs: Any) -> dict:
    """Export the scene to GLB (PR6 body).

    Returns ``{ok, path, bytes, revision, stats, filename}`` for the
    file written under ``exports/``. Export does not mutate the scene:
    no revision bump, no ``baseRevision`` input. The scene is checked
    first so a bad id still reports ``SCENE_NOT_FOUND``; refusals
    (``EXPORT_EMPTY`` / ``EXPORT_FAILED`` / ``EXPORT_TIMEOUT``) write
    nothing. The PR8 splice exports model/part nodes; a model/part
    node whose asset bytes are missing fails with ``EXPORT_FAILED``.
    """
    scene_id = _scene_arg(kwargs)
    store = _store()
    try:
        scene = store.get_scene(scene_id)
    except PlastisError as error:
        _fail(error)
        raise AssertionError("unreachable")
    try:
        return _export_scene(scene, store)
    except PlastisError as error:
        _fail(error)
        raise AssertionError("unreachable")


# --- Schemas (Python is the authority; the design doc's representative
# schemas are the shape, the validator is the rule) ---------------------------

_TRANSFORM = {
    "type": "object",
    "required": ["t", "r", "s"],
    "properties": {
        "t": {"type": "array", "items": {"type": "number"}, "minItems": 3, "maxItems": 3},
        "r": {
            "type": "array",
            "items": {"type": "number"},
            "minItems": 3,
            "maxItems": 3,
            "description": "Euler XYZ degrees, intrinsic",
        },
        "s": {"type": "array", "items": {"type": "number"}, "minItems": 3, "maxItems": 3},
    },
}

_ID = {"type": "string", "pattern": "^[A-Za-z][A-Za-z0-9_-]{0,63}$"}

_SCENE_ID = {"type": "string", "pattern": "^[a-z0-9-]{1,64}$"}

# A texture-map field: the id of an image asset already in the scene, or null.
_MAP = {
    "type": ["string", "null"],
    "pattern": "^[A-Za-z0-9_-]{1,64}$",
    "description": "id of an image asset already in the scene; null clears the map",
}

_PRIMITIVE = {
    "type": "object",
    "required": ["type"],
    "properties": {
        "type": {
            "type": "string",
            "enum": ["box", "sphere", "cylinder", "cone", "torus", "plane", "capsule"],
        },
        "width": {"type": "number"},
        "height": {"type": "number"},
        "depth": {"type": "number"},
        "radius": {"type": "number"},
        "radiusTop": {"type": "number"},
        "radiusBottom": {"type": "number"},
        "tube": {"type": "number"},
        "length": {"type": "number"},
        "widthSegments": {"type": "integer"},
        "heightSegments": {"type": "integer"},
        "radialSegments": {"type": "integer"},
        "tubularSegments": {"type": "integer"},
        "capSegments": {"type": "integer"},
    },
}

_CLIPS = {
    "type": "array",
    "items": {
        "type": "object", "additionalProperties": False, "required": ["channels"],
        "properties": {
            "id": _ID, "name": {"type": "string"}, "duration": {"type": "number", "exclusiveMinimum": 0},
            "channels": {"type": "array", "minItems": 1, "items": {
                "type": "object", "additionalProperties": False, "required": ["target", "times", "values"],
                "properties": {
                    "target": {"type": "string", "enum": ["translation", "rotation", "scale"]},
                    "times": {"type": "array", "minItems": 1, "items": {"type": "number", "minimum": 0}},
                    "values": {"type": "array", "minItems": 1, "items": _TRANSFORM["properties"]["t"]},
                },
            }},
        },
    },
}

_NODE = {
    "type": "object",
    "additionalProperties": False,
    "required": ["name", "kind", "transform"],
    "properties": {
        "id": _ID,
        "name": {"type": "string", "minLength": 1, "maxLength": 64},
        "parent": {"type": ["string", "null"]},
        "kind": {"type": "string", "enum": ["group", "mesh", "light", "camera"]},
        "transform": _TRANSFORM,
        "visible": {"type": "boolean"},
        "materialId": _ID,
        "primitive": _PRIMITIVE,
        "clips": _CLIPS,
        "light": {
            "type": "object",
            "required": ["type", "color", "intensity"],
            "properties": {
                "type": {"type": "string", "enum": ["directional", "point", "spot"]},
                "color": {"type": "string", "pattern": "^#[0-9a-fA-F]{6}$"},
                "intensity": {"type": "number", "minimum": 0},
                "distance": {"type": "number", "minimum": 0},
                "decay": {"type": "number", "const": 2},
                "angle": {"type": "number", "exclusiveMinimum": 0, "maximum": 90},
                "penumbra": {"type": "number", "minimum": 0, "maximum": 1},
            },
        },
        "camera": {
            "type": "object",
            "required": ["type", "fov", "near", "far"],
            "properties": {
                "type": {"type": "string", "enum": ["perspective"]},
                "fov": {
                    "type": "number",
                    "exclusiveMinimum": 0,
                    "exclusiveMaximum": 180,
                    "description": "Vertical degrees, not radians",
                },
                "near": {"type": "number", "exclusiveMinimum": 0},
                "far": {"type": "number", "exclusiveMinimum": 0},
            },
        },
    },
}

_MATERIAL_ITEM = {
    "type": "object",
    "required": ["id", "color"],
    "additionalProperties": False,
    "properties": {
        "id": _ID,
        "name": {"type": "string"},
        "color": {"type": "string", "pattern": "^#[0-9a-fA-F]{6}$"},
        "emissive": {"type": "string", "pattern": "^#[0-9a-fA-F]{6}$"},
        "metalness": {"type": "number", "minimum": 0, "maximum": 1},
        "roughness": {"type": "number", "minimum": 0, "maximum": 1},
        "opacity": {"type": "number", "minimum": 0, "maximum": 1},
        "doubleSide": {"type": "boolean"},
    },
}


def _tool_schema(
    description: str, properties: dict, required: list
) -> dict:
    return {
        "name": "",
        "description": description,
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "properties": properties,
            "required": required,
        },
    }


def _schema(name: str, description: str, properties: dict, required: list) -> dict:
    schema = _tool_schema(description, properties, required)
    schema["name"] = name
    return schema


# (name, description, properties, required, handler) — the order here is
# the order in plugin.yaml provides_tools (catalog rule 6: the manifest
# must match register() character-for-character).
TOOL_DEFINITIONS = [
    (
        "plastis3d_list_scenes",
        "List Plastis3D scenes on this Hermes backend: id, name, revision, updatedAt.",
        {},
        [],
        list_scenes,
    ),
    (
        "plastis3d_new_scene",
        "Create a new Plastis3D scene with a default light and camera aimed at the origin. "
        "Units are meters, Y-up.",
        {
            "name": {"type": "string", "minLength": 1, "maxLength": 80},
            "id": _SCENE_ID,
        },
        ["name"],
        new_scene,
    ),
    (
        "plastis3d_get_scene",
        "Get a Plastis3D scene: nodes, materials, assets, stats, and the current revision. "
        "Pass the revision as baseRevision to the next edit.",
        {"scene": _SCENE_ID},
        ["scene"],
        get_scene,
    ),
    (
        "plastis3d_check_gltf",
        "Check a Plastis3D scene, or one imported model with assetId, for problems a three.js game "
        "would hit: required or compressed extensions, files outside the glTF, missing normals, "
        "triangle counts, degenerate triangles, many materials, a model that may not be in meters. "
        "Read-only; it changes nothing and needs no baseRevision. Returns findings with a severity "
        "(error, warning, info), a code and a sentence, plus what could not be checked. "
        "Quote the findings; do not invent others.",
        {
            "scene": _SCENE_ID,
            "assetId": {"type": "string", "pattern": "^[A-Za-z0-9_-]{1,64}$"},
        },
        ["scene"],
        check_gltf,
    ),
    (
        "plastis3d_analyze",
        "Analyze a Plastis3D scene, or one imported model with assetId, against a budget: the "
        "compatibility findings first (errors, then warnings and notes), then what could not be "
        "checked, then measured counts (triangles, estimated draw calls, materials, texture memory), "
        "then a 0-100 heuristic score for the budget (mobile, the default, or desktop). The score "
        "is withheld when there is any error. Read-only; no baseRevision. Say the score is a "
        "heuristic and quote the budget; never present it as proof of compatibility.",
        {
            "scene": _SCENE_ID,
            "assetId": {"type": "string", "pattern": "^[A-Za-z0-9_-]{1,64}$"},
            "budget": {"type": "string", "enum": ["mobile", "desktop"]},
        },
        ["scene"],
        analyze,
    ),
    (
        "plastis3d_cleanup",
        "Tidy a Plastis3D scene: merge materials that are identical in every field but id "
        "(dedupe_materials), remove materials no mesh or part uses except m_default "
        "(prune_materials), and remove groups with nothing in them (prune_groups). The default is "
        "those three; pass operations to choose. weld is only run when you name it: it merges "
        "vertices whose position, normal, UVs and colours are all equal (keeping UV seams and hard "
        "edges) and drops degenerate triangles in imported models, writing a new model file; "
        "assetId limits it to one model. Built-in shapes, and models with skins, animations or morph "
        "targets, are skipped and listed. One undoable revision. dryRun=true returns what would "
        "change and writes nothing; use it first when unsure. It does not touch mesh data, imported "
        "files or locked models. Pass baseRevision from plastis3d_get_scene. Quote the cleanup block "
        "in the result.",
        {
            "scene": _SCENE_ID,
            "baseRevision": {"type": "integer", "minimum": 1},
            "operations": {
                "type": "array",
                "items": {"type": "string", "enum": ["dedupe_materials", "prune_materials", "prune_groups", "weld"]},
                "minItems": 1,
            },
            "assetId": {"type": "string", "pattern": "^[A-Za-z0-9_-]{1,64}$"},
            "dryRun": {"type": "boolean"},
        },
        ["scene", "baseRevision"],
        cleanup,
    ),
    (
        "plastis3d_build_scene",
        "Replace the nodes and materials of a Plastis3D scene. "
        "Units are meters, Y-up, Euler degrees XYZ. "
        "kind is group, mesh, light, or camera. kind=model is rejected. "
        "Import models with plastis3d_import_model. "
        "kind=mesh needs primitive.type and materialId. "
        "kind=light is directional, point, or spot, never ambient. "
        "kind=camera fov is vertical degrees. "
        "Pass baseRevision from plastis3d_get_scene. "
        "This builds a local scene. It does not generate a textured mesh.",
        {
            "scene": _SCENE_ID,
            "baseRevision": {"type": "integer", "minimum": 1},
            "name": {"type": "string", "minLength": 1, "maxLength": 80},
            "nodes": {"type": "array", "maxItems": 2000, "items": _NODE},
            "materials": {"type": "array", "maxItems": 256, "items": _MATERIAL_ITEM},
        },
        ["scene", "baseRevision", "nodes"],
        build_scene,
    ),
    (
        "plastis3d_add_node",
        "Add one node to a Plastis3D scene: a group, a primitive mesh, a light, or a camera. "
        "kind=mesh needs primitive.type and materialId. Pass baseRevision from plastis3d_get_scene.",
        {
            "scene": _SCENE_ID,
            "baseRevision": {"type": "integer", "minimum": 1},
            "id": _ID,
            "name": {"type": "string", "minLength": 1, "maxLength": 64},
            "parent": {"type": ["string", "null"]},
            "kind": {"type": "string", "enum": ["group", "mesh", "light", "camera"]},
            "transform": _TRANSFORM,
            "visible": {"type": "boolean"},
            "materialId": _ID,
            "primitive": _PRIMITIVE,
            "clips": _CLIPS,
            "light": _NODE["properties"]["light"],
            "camera": _NODE["properties"]["camera"],
        },
        ["scene", "baseRevision", "name", "kind", "transform"],
        add_node,
    ),
    (
        "plastis3d_update_node",
        "Set sceneName to rename the scene, or change a Plastis3D node by id: name, parent, visible, transform, or primitive, light, "
        "camera, or primitive clip fields. kind never changes. Imported model nodes only move, rename, hide, or "
        "reparent. Pass baseRevision from plastis3d_get_scene.",
        {
            "scene": _SCENE_ID,
            "baseRevision": {"type": "integer", "minimum": 1},
            "sceneName": {"type": "string", "minLength": 1, "maxLength": 80},
            "id": _ID,
            "name": {"type": "string", "minLength": 1, "maxLength": 64},
            "parent": {"type": ["string", "null"]},
            "visible": {"type": "boolean"},
            "transform": _TRANSFORM,
            "primitive": _PRIMITIVE,
            "clips": _CLIPS,
            "light": _NODE["properties"]["light"],
            "camera": _NODE["properties"]["camera"],
            "materialId": _ID,
        },
        ["scene", "baseRevision"],
        update_node,
    ),
    (
        "plastis3d_set_material",
        "Create or update a Plastis3D material and optionally assign it to mesh or part nodes "
        "with assignTo. Assigning to a model node is refused: models are opaque, recolor their "
        "part nodes instead. The four map fields (baseColorMap, normalMap, metallicRoughnessMap, "
        "emissiveMap) take the id of an image asset already in the scene, or null to clear the "
        "map; this tool cannot add an image, which is done in the editor. "
        "Pass baseRevision from plastis3d_get_scene.",
        {
            "scene": _SCENE_ID,
            "baseRevision": {"type": "integer", "minimum": 1},
            "id": _ID,
            "name": {"type": "string"},
            "color": {"type": "string", "pattern": "^#[0-9a-fA-F]{6}$"},
            "emissive": {"type": "string", "pattern": "^#[0-9a-fA-F]{6}$"},
            "metalness": {"type": "number", "minimum": 0, "maximum": 1},
            "roughness": {"type": "number", "minimum": 0, "maximum": 1},
            "opacity": {"type": "number", "minimum": 0, "maximum": 1},
            "doubleSide": {"type": "boolean"},
            "baseColorMap": _MAP,
            "normalMap": _MAP,
            "metallicRoughnessMap": _MAP,
            "emissiveMap": _MAP,
            "assignTo": {"type": "array", "items": _ID},
        },
        ["scene", "baseRevision"],
        set_material,
    ),
    (
        "plastis3d_duplicate_node",
        "Duplicate a Plastis3D node and its descendants with new ids. Materials are shared. "
        "A duplicated model keeps the same model file; a duplicated part keeps the same mesh "
        "and primitive. Pass baseRevision from plastis3d_get_scene.",
        {
            "scene": _SCENE_ID,
            "baseRevision": {"type": "integer", "minimum": 1},
            "id": _ID,
        },
        ["scene", "baseRevision", "id"],
        duplicate_node,
    ),
    (
        "plastis3d_delete_node",
        "Delete a Plastis3D node and its descendants. If that would leave no camera, the default "
        "camera is re-added in the same step. Pass baseRevision from plastis3d_get_scene.",
        {
            "scene": _SCENE_ID,
            "baseRevision": {"type": "integer", "minimum": 1},
            "id": _ID,
        },
        ["scene", "baseRevision", "id"],
        delete_node,
    ),
    (
        "plastis3d_import_model",
        "Import a GLB, embedded glTF, OBJ, STL, or PLY file from an absolute path on the machine "
        "where Hermes runs into a Plastis3D scene. By default the file explodes into editable "
        "nodes — one group per glTF node, one part per TRIANGLES primitive — under a wrapper "
        "group named by `name` or the file stem; explode=false attaches one locked model node "
        "instead. OBJ, STL, and PLY are read as one mesh, with no axis or unit conversion "
        "(print files are often Z-up and millimeters); an OBJ keeps its first material only.",
        {
            "scene": _SCENE_ID,
            "baseRevision": {"type": "integer", "minimum": 1},
            "path": {"type": "string", "minLength": 1},
            "name": {"type": "string", "minLength": 1, "maxLength": 64},
            "parent": {"type": ["string", "null"]},
            "transform": _TRANSFORM,
            "explode": {"type": "boolean"},
        },
        ["scene", "baseRevision", "path"],
        import_model,
    ),
    (
        "plastis3d_open_in_desktop",
        "Open a Plastis3D scene in the Hermes Desktop editor. Returns immediately; it does not "
        "wait for the editor to open.",
        {"scene": _SCENE_ID},
        ["scene"],
        open_in_desktop,
    ),
    (
        "plastis3d_export_glb",
        "Export a Plastis3D scene to a GLB file on the backend. Returns "
        "{ path, bytes, revision, stats, filename } under plugin-data. "
        "Does not open a dialog. Scenes with model or part nodes are "
        "refused until the splice lands; scenes with no meshes are empty.",
        {"scene": _SCENE_ID},
        ["scene"],
        export_glb,
    ),
    (
        "plastis3d_undo",
        "Undo the last Plastis3D scene mutation. Pass baseRevision from plastis3d_get_scene.",
        {
            "scene": _SCENE_ID,
            "baseRevision": {"type": "integer", "minimum": 1},
        },
        ["scene", "baseRevision"],
        undo,
    ),
    (
        "plastis3d_redo",
        "Redo the last undone Plastis3D scene mutation. Pass baseRevision from plastis3d_get_scene.",
        {
            "scene": _SCENE_ID,
            "baseRevision": {"type": "integer", "minimum": 1},
        },
        ["scene", "baseRevision"],
        redo,
    ),
    (
        "plastis3d_curve",
        "Create a curve as an editable part: a tube along a smooth spline through your points, or a lathe that revolves a profile (x is the radius, y the height). "
        "Pass id to change a curve you made earlier (the mesh is regenerated from the new settings). Optional followPath {target, keys, duration} also gives a built-in shape a "
        "translation clip that walks the curve (a second revision). Pass baseRevision from plastis3d_get_scene.",
        {
            "scene": _SCENE_ID,
            "baseRevision": {"type": "integer", "minimum": 1},
            "id": _ID,
            "name": {"type": "string", "minLength": 1, "maxLength": 64},
            "parent": _ID,
            "transform": _TRANSFORM,
            "curve": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "kind": {"enum": ["tube", "lathe"]},
                    "points": {"type": "array", "minItems": 2, "maxItems": 256, "items": {"type": "array", "minItems": 3, "maxItems": 3, "items": {"type": "number"}}},
                    "closed": {"type": "boolean"},
                    "interpolation": {"enum": ["centripetal"]},
                    "radius": {"type": "number", "minimum": 0.001, "maximum": 10},
                    "radialSegments": {"type": "integer", "minimum": 3, "maximum": 32},
                    "tubularSegments": {"type": "integer", "minimum": 4, "maximum": 512},
                    "segments": {"type": "integer", "minimum": 3, "maximum": 128},
                    "angle": {"type": "number", "minimum": 1, "maximum": 360},
                },
                "required": ["kind", "points"],
            },
            "followPath": {
                "type": "object",
                "additionalProperties": False,
                "properties": {"target": _ID, "keys": {"type": "integer", "minimum": 2, "maximum": 64}, "duration": {"type": "number", "minimum": 0.1, "maximum": 3600}},
                "required": ["target"],
            },
        },
        ["scene", "baseRevision", "curve"],
        curve,
    ),
    (
        "plastis3d_clone",
        "Copy a node many times: mode grid (counts [nx, ny, nz] and spacing), line (count and offset) or radial (count, radius, axis, angle). "
        "The copies are real nodes in a new group named Clones of <name>, sharing the original's model and material. At most 256 clones. Pass baseRevision from plastis3d_get_scene.",
        {
            "scene": _SCENE_ID,
            "baseRevision": {"type": "integer", "minimum": 1},
            "source": _ID,
            "mode": {"enum": ["grid", "line", "radial"]},
            "params": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "counts": {"type": "array", "minItems": 3, "maxItems": 3, "items": {"type": "integer", "minimum": 1, "maximum": 64}},
                    "spacing": {"type": "array", "minItems": 3, "maxItems": 3, "items": {"type": "number"}},
                    "count": {"type": "integer", "minimum": 1, "maximum": 256},
                    "offset": {"type": "array", "minItems": 3, "maxItems": 3, "items": {"type": "number"}},
                    "radius": {"type": "number", "minimum": 0.001},
                    "axis": {"enum": ["x", "y", "z"]},
                    "angle": {"type": "number", "minimum": 1, "maximum": 360},
                },
            },
        },
        ["scene", "baseRevision", "source", "mode", "params"],
        clone,
    ),
    (
        "plastis3d_displace",
        "Roughen or bump a shape or part with seeded noise pushed along its surface normals (amplitude in metres, frequency, octaves 1 to 6, seed). The same seed gives the same result. "
        "The original mesh is kept, so calling it again with new settings starts from the original. Up to 200,000 vertices. Pass baseRevision from plastis3d_get_scene.",
        {
            "scene": _SCENE_ID,
            "baseRevision": {"type": "integer", "minimum": 1},
            "id": _ID,
            "params": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "amplitude": {"type": "number", "minimum": 0, "maximum": 10},
                    "frequency": {"type": "number", "minimum": 0.01, "maximum": 100},
                    "octaves": {"type": "integer", "minimum": 1, "maximum": 6},
                    "seed": {"type": "integer", "minimum": 0, "maximum": 2147483647},
                },
            },
        },
        ["scene", "baseRevision", "id", "params"],
        displace,
    ),
    (
        "plastis3d_screenshot",
        "Take a PNG screenshot of a Plastis3D scene as an open Hermes Desktop or Webapp view draws it, and return the file path on the Hermes machine "
        "with the revision that was drawn. Read-only; it needs no baseRevision. This is the one tool that waits (up to waitSeconds, default 12) "
        "for a view to answer. If no scene view is open it returns DESKTOP_UNAVAILABLE: tell the user to open the scene in Hermes and try again.",
        {
            "scene": _SCENE_ID,
            "waitSeconds": {"type": "integer", "minimum": 1, "maximum": 25},
        },
        ["scene"],
        screenshot,
    ),
]

TOOL_NAMES = [name for name, _, _, _, _ in TOOL_DEFINITIONS]


def tool_schemas() -> list:
    """``[{name, schema, handler, description}]`` for ``register()``."""
    result = []
    for name, description, properties, required, handler in TOOL_DEFINITIONS:
        result.append(
            {
                "name": name,
                "schema": _schema(name, description, properties, required),
                "handler": handler,
                "description": description,
            }
        )
    return result
