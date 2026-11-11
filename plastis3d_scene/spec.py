"""Plastis3D — scene document model, schema 3 (PR31).

The schema was designed for the full entry scope (pin-rescope-2026-11-06.md
§3.2): the ``part`` kind (editable-imports plan §2), spot-light fields,
texture-map fields and clip fields were all in schema 1. **Schema 2** (PR24,
extension-foundation D-EXT-02) adds ONE optional node field, ``generator``
(how a baked part was made). The 1 -> 2 step is an identity
(``plastis3d_scene.upgrade``), performed in memory when a scene file is read.
Schema 3 adds transform-only splat nodes, per owner decision D-PR31-01.

Key rules (standalone-editor.md, Scene spec):

* ``schema: 2``, ``units: "m"``, ``upAxis: "Y"`` — constants.
* Scene ids: ``^[a-z0-9-]{1,64}$`` (slugged from the name, ``-2``/``-3``
  on collision). Node/material ids: ``^[A-Za-z][A-Za-z0-9_-]{0,63}$``;
  the server generates ``n_<hex8>`` / ``m_<hex8>``.
* Node kinds: ``group``, ``mesh``, ``light``, ``camera``, ``model``,
  ``part``. ``materialId`` is forbidden on ``model``
  (``MODEL_MATERIAL_OPAQUE``); the override exists only on ``part``.
* Geometry never goes in scene JSON. A ``part`` node is a reference
  (``modelAssetId`` + ``meshIndex`` + ``primitiveIndex``).
* Asset ``stats`` gains per-part bounds: ``stats.parts`` entries of
  ``{meshIndex, primitiveIndex, tris, verts, bounds: {min, max}}``.
* Rotation is Euler XYZ degrees, three.js ``"XYZ"`` order
  (``R = Rx * Ry * Rz``); see ``primitives.rotation_matrix_xyz``.

This module is the typed construction API (dataclasses) plus the
constants, id helpers, and the pure default-rig functions. The store
works in plain-dict (JSON) land and validates with ``validate.py``.

Stdlib only. Python 3.11-compatible.
"""

from __future__ import annotations

import copy
import re
import secrets
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

from . import primitives

# --- Schema constants --------------------------------------------------------
# Schema 2 (PR24, D-EXT-02) adds the optional node ``generator`` field. 1 -> 2 is an
# identity, performed on read by plastis3d_scene.upgrade.
SCHEMA_VERSION = 3
UNITS = "m"
UP_AXIS = "Y"

# --- Caps (stage-1 §4.2; agent-invented, not host limits — enforce as
# written; raise only with a real model in hand) ------------------------------
MAX_NODES = 2000
MAX_MATERIALS = 256
MAX_ASSETS = 64
MAX_HISTORY = 50
MAX_SCENE_BYTES = 4 * 1024 * 1024  # 4 MiB, history included
MIN_SEGMENTS = 3
MAX_SEGMENTS = 64
MAX_OPS_PER_PATCH = 32  # PR3 (PATCH); recorded here so the cap lives once.

# --- Store timeouts (standalone-editor.md rule 12) ---------------------------
# The 2-second lock timeout is a STORE timeout, not the poll — the desktop
# refetch interval is 4 seconds.
LOCK_TIMEOUT_SECONDS = 2.0
LOCK_POLL_SECONDS = 0.025

# --- Enumerations ------------------------------------------------------------
NODE_KINDS = ("group", "mesh", "light", "camera", "model", "part", "splat")
LIGHT_TYPES = ("directional", "point", "spot")
CAMERA_TYPES = ("perspective",)
CLIP_CHANNEL_TARGETS = ("translation", "rotation", "scale")
SOURCE_FORMATS = ("glb", "gltf", "obj", "stl", "ply", "png", "jpeg", "splat")  # obj/stl/ply: PR12; png/jpeg: PR15.
# Asset ``format`` values: a stored model is always a GLB; a texture image
# keeps its own format (PR15). The file is ``assets/<sha256><extension>``.
ASSET_FORMATS = ("glb", "png", "jpeg", "splat")
IMAGE_ASSET_FORMATS = ("png", "jpeg")
ASSET_FILE_EXTENSIONS = {"glb": ".glb", "png": ".png", "jpeg": ".jpg", "splat": ".splat"}
# Decoded-texture budgets (correctness audit C-07). Product budgets, not host
# limits: one image up to 4096 x 4096 (64 MiB decoded as RGBA), and every image
# a scene's materials use together up to four of those.
MAX_IMAGE_SIDE = 4096
MAX_IMAGE_PIXELS = MAX_IMAGE_SIDE * MAX_IMAGE_SIDE
MAX_SCENE_IMAGE_PIXELS = 4 * MAX_IMAGE_PIXELS

# Texture-map fields on a material (PR15 texture replace). The value is an
# asset id; the image bytes live in that asset. Schema 1 already carries
# the fields so no later PR re-opens the schema for them.
MATERIAL_MAP_FIELDS = (
    "baseColorMap",
    "normalMap",
    "metallicRoughnessMap",
    "emissiveMap",
)

# --- Id patterns -------------------------------------------------------------
SCENE_ID_RE = re.compile(r"^[a-z0-9-]{1,64}$")
NODE_ID_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
MATERIAL_ID_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
ASSET_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")

DEFAULT_MATERIAL_ID = "m_default"
DEFAULT_LIGHT_ID = "light_key"
DEFAULT_CAMERA_ID = "cam_main"

# --- Errors ------------------------------------------------------------------
# Every failure the tools and routes surface starts with one of these
# stable codes (standalone-editor.md, error table). ``path`` is an exact
# JSON pointer into the scene document where one applies.


class PlastisError(Exception):
    """A failure with a stable error code for tools/routes to surface."""

    def __init__(
        self,
        code: str,
        message: str,
        path: Optional[str] = None,
        current_revision: Optional[int] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.path = path
        self.current_revision = current_revision

    def to_dict(self) -> dict:
        body: dict = {"ok": False, "code": self.code, "message": self.message}
        if self.path is not None:
            body["path"] = self.path
        if self.current_revision is not None:
            body["currentRevision"] = self.current_revision
        return body


# HTTP status per error code (standalone-editor.md, HTTP API table).
ERROR_HTTP_STATUS = {
    "SPEC_INVALID": 400,
    "MODEL_MATERIAL_OPAQUE": 400,
    "SCENE_NOT_FOUND": 404,
    "SCENE_EXISTS": 409,
    "NODE_NOT_FOUND": 404,
    "NODE_LOCKED": 409,
    "MATERIAL_NOT_FOUND": 404,
    "REVISION_CONFLICT": 409,
    "STORE_BUSY": 423,
    "HISTORY_EMPTY": 409,
    "LIMIT_SCENE": 413,
    "LIMIT_NODES": 413,
    "LIMIT_MATERIALS": 413,
    "LIMIT_ASSETS": 413,
    "IMPORT_TOO_LARGE": 413,
    "IMPORT_NOT_FOUND": 404,
    "IMPORT_FORMAT": 400,
    "IMPORT_COMPRESSED": 400,
    "IMPORT_EXTERNAL_BUFFER": 400,
    "IMPORT_TOO_COMPLEX": 400,
    "IMPORT_TIMEOUT": 408,
    "IMPORT_PATH_DENIED": 403,
    "ASSET_NOT_FOUND": 404,
    "ASSET_TOO_LARGE": 413,
    "NOT_IMPLEMENTED": 501,
    "SCHEMA_NEWER": 400,
    "EXPORT_FAILED": 400,
    "TEXTURE_NO_UV": 400,
    "EXPORT_EMPTY": 400,
    "EXPORT_IMPORT_UNMERGED": 409,
    "EXPORT_TIMEOUT": 408,
    "DISPLACE_TOO_LARGE": 413,
    "THUMBNAIL_INVALID": 400,
    "THUMBNAIL_NOT_FOUND": 404,
    "RIG_INVALID": 400,
    "RIG_TOO_LARGE": 413,
    "RENDER_TOO_LARGE": 413,
    "BAKE_INVALID": 400,
    "BAKE_TOO_LARGE": 413,
    "DRAFT_NOT_FOUND": 404,
    "DRAFT_TOO_LARGE": 413,
    "DESKTOP_UNAVAILABLE": 503,
    "CAPTURE_NOT_FOUND": 404,
    "CAPTURE_CONFLICT": 409,
    "CAPTURE_STALE": 409,
    "CAPTURE_INVALID": 400,
    "CAPTURE_TOO_LARGE": 413,
}


def http_status_for(code: str) -> int:
    """HTTP status for an error code (400 default for unknown codes)."""
    return ERROR_HTTP_STATUS.get(code, 400)


# --- Id helpers --------------------------------------------------------------


def new_node_id() -> str:
    """Server-generated node id: ``n_`` + 8 hex chars."""
    return "n_" + secrets.token_hex(4)


def new_material_id() -> str:
    """Server-generated material id: ``m_`` + 8 hex chars."""
    return "m_" + secrets.token_hex(4)


def slugify_scene_id(name: str) -> str:
    """Slug a scene name to a valid scene id (``^[a-z0-9-]{1,64}$``)."""
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    slug = re.sub(r"-+", "-", slug)
    if not slug:
        slug = "scene"
    return slug[:64].rstrip("-") or "scene"


def now_iso() -> str:
    """Current UTC time as an ISO-8601 ``Z`` string."""
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


# --- Dataclasses -------------------------------------------------------------
# Each dataclass mirrors its JSON shape and serialises with ``to_dict()``.
# ``from_dict`` classmethods accept the JSON shape (filling defaults) so
# the store and PR3 can build typed objects from a validated document.


@dataclass
class Transform:
    t: list = field(default_factory=lambda: [0.0, 0.0, 0.0])
    r: list = field(default_factory=lambda: [0.0, 0.0, 0.0])
    s: list = field(default_factory=lambda: [1.0, 1.0, 1.0])

    def to_dict(self) -> dict:
        return {"t": list(self.t), "r": list(self.r), "s": list(self.s)}

    @classmethod
    def from_dict(cls, data: dict) -> "Transform":
        return cls(
            t=list(data.get("t", [0.0, 0.0, 0.0])),
            r=list(data.get("r", [0.0, 0.0, 0.0])),
            s=list(data.get("s", [1.0, 1.0, 1.0])),
        )

    @classmethod
    def identity(cls) -> "Transform":
        return cls()


@dataclass
class Primitive:
    type: str
    params: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        result = {"type": self.type}
        result.update(self.params)
        return result

    @classmethod
    def from_dict(cls, data: dict) -> "Primitive":
        data = dict(data)
        ptype = data.pop("type")
        return cls(type=ptype, params=data)


@dataclass
class Light:
    type: str = "directional"
    color: str = "#ffffff"
    intensity: float = 1.0
    distance: Optional[float] = None
    decay: Optional[int] = None
    # Spot only (KHR_lights_punctual): cone angle in degrees, penumbra 0..1.
    angle: Optional[float] = None
    penumbra: Optional[float] = None

    def to_dict(self) -> dict:
        result: dict = {
            "type": self.type,
            "color": self.color,
            "intensity": self.intensity,
        }
        if self.distance is not None:
            result["distance"] = self.distance
        if self.decay is not None:
            result["decay"] = self.decay
        if self.angle is not None:
            result["angle"] = self.angle
        if self.penumbra is not None:
            result["penumbra"] = self.penumbra
        return result

    @classmethod
    def from_dict(cls, data: dict) -> "Light":
        return cls(
            type=data.get("type", "directional"),
            color=data.get("color", "#ffffff"),
            intensity=data.get("intensity", 1.0),
            distance=data.get("distance"),
            decay=data.get("decay"),
            angle=data.get("angle"),
            penumbra=data.get("penumbra"),
        )


@dataclass
class Camera:
    type: str = "perspective"
    fov: float = 40.0
    near: float = 0.01
    far: float = 500.0

    def to_dict(self) -> dict:
        return {"type": self.type, "fov": self.fov, "near": self.near, "far": self.far}

    @classmethod
    def from_dict(cls, data: dict) -> "Camera":
        return cls(
            type=data.get("type", "perspective"),
            fov=data.get("fov", 40.0),
            near=data.get("near", 0.01),
            far=data.get("far", 500.0),
        )


@dataclass
class ClipChannel:
    """One animated channel on a node (PR21 primitive clips).

    ``target`` is ``translation`` / ``rotation`` / ``scale``; ``times``
    are seconds (strictly increasing, >= 0); ``values`` is one vec3 per time
    (rotation values are Euler XYZ degrees, matching the transform).
    """

    target: str
    times: list = field(default_factory=list)
    values: list = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "target": self.target,
            "times": list(self.times),
            "values": [list(v) for v in self.values],
        }

    @classmethod
    def from_dict(cls, data: dict) -> "ClipChannel":
        return cls(
            target=data["target"],
            times=list(data.get("times", [])),
            values=[list(v) for v in data.get("values", [])],
        )


@dataclass
class Clip:
    """A primitive animation clip on a node (PR21)."""

    id: Optional[str] = None
    name: Optional[str] = None
    duration: Optional[float] = None
    channels: list = field(default_factory=list)  # list[ClipChannel]

    def to_dict(self) -> dict:
        result: dict = {"channels": [c.to_dict() for c in self.channels]}
        if self.id is not None:
            result["id"] = self.id
        if self.name is not None:
            result["name"] = self.name
        if self.duration is not None:
            result["duration"] = self.duration
        return result

    @classmethod
    def from_dict(cls, data: dict) -> "Clip":
        return cls(
            id=data.get("id"),
            name=data.get("name"),
            duration=data.get("duration"),
            channels=[ClipChannel.from_dict(c) for c in data.get("channels", [])],
        )


@dataclass
class Node:
    id: str
    name: str
    kind: str
    transform: Transform = field(default_factory=Transform.identity)
    parent: Optional[str] = None
    visible: bool = True
    primitive: Optional[Primitive] = None
    materialId: Optional[str] = None
    light: Optional[Light] = None
    camera: Optional[Camera] = None
    modelAssetId: Optional[str] = None
    splatAssetId: Optional[str] = None
    meshIndex: Optional[int] = None
    primitiveIndex: Optional[int] = None
    clips: list = field(default_factory=list)  # list[Clip]

    def to_dict(self) -> dict:
        result: dict = {
            "id": self.id,
            "name": self.name,
            "parent": self.parent,
            "kind": self.kind,
            "transform": self.transform.to_dict(),
            "visible": self.visible,
        }
        if self.primitive is not None:
            result["primitive"] = self.primitive.to_dict()
        if self.materialId is not None:
            result["materialId"] = self.materialId
        if self.light is not None:
            result["light"] = self.light.to_dict()
        if self.camera is not None:
            result["camera"] = self.camera.to_dict()
        if self.splatAssetId is not None:
            result["splatAssetId"] = self.splatAssetId
        if self.modelAssetId is not None:
            result["modelAssetId"] = self.modelAssetId
        if self.meshIndex is not None:
            result["meshIndex"] = self.meshIndex
        if self.primitiveIndex is not None:
            result["primitiveIndex"] = self.primitiveIndex
        if self.clips:
            result["clips"] = [c.to_dict() for c in self.clips]
        return result

    @classmethod
    def from_dict(cls, data: dict) -> "Node":
        return cls(
            id=data["id"],
            name=data["name"],
            kind=data["kind"],
            transform=Transform.from_dict(data.get("transform", {})),
            parent=data.get("parent"),
            visible=data.get("visible", True),
            primitive=Primitive.from_dict(data["primitive"]) if "primitive" in data else None,
            materialId=data.get("materialId"),
            light=Light.from_dict(data["light"]) if "light" in data else None,
            camera=Camera.from_dict(data["camera"]) if "camera" in data else None,
            modelAssetId=data.get("modelAssetId"),
            splatAssetId=data.get("splatAssetId"),
            meshIndex=data.get("meshIndex"),
            primitiveIndex=data.get("primitiveIndex"),
            clips=[Clip.from_dict(c) for c in (data.get("clips") or [])],
        )


@dataclass
class Material:
    id: str
    color: str
    name: Optional[str] = None
    emissive: str = "#000000"
    metalness: float = 0.0
    roughness: float = 0.6
    opacity: float = 1.0
    doubleSide: bool = False
    # Texture maps (PR15): asset ids, optional. No texture fields beyond
    # these four exist in schema 1.
    baseColorMap: Optional[str] = None
    normalMap: Optional[str] = None
    metallicRoughnessMap: Optional[str] = None
    emissiveMap: Optional[str] = None

    def to_dict(self) -> dict:
        result: dict = {
            "id": self.id,
            "color": self.color,
            "emissive": self.emissive,
            "metalness": self.metalness,
            "roughness": self.roughness,
            "opacity": self.opacity,
            "doubleSide": self.doubleSide,
        }
        if self.name is not None:
            result["name"] = self.name
        for key in MATERIAL_MAP_FIELDS:
            value = getattr(self, key)
            if value is not None:
                result[key] = value
        return result

    @classmethod
    def from_dict(cls, data: dict) -> "Material":
        return cls(
            id=data["id"],
            color=data["color"],
            name=data.get("name"),
            emissive=data.get("emissive", "#000000"),
            metalness=data.get("metalness", 0.0),
            roughness=data.get("roughness", 0.6),
            opacity=data.get("opacity", 1.0),
            doubleSide=data.get("doubleSide", False),
            baseColorMap=data.get("baseColorMap"),
            normalMap=data.get("normalMap"),
            metallicRoughnessMap=data.get("metallicRoughnessMap"),
            emissiveMap=data.get("emissiveMap"),
        )


@dataclass
class AssetPartStats:
    """Per-part bounds for one mesh primitive (editable-imports plan §2)."""

    meshIndex: int
    primitiveIndex: int
    tris: int
    verts: int
    bounds: dict  # {"min": [x, y, z], "max": [x, y, z]}
    uv: Optional[bool] = None  # TEXCOORD_0 present (PR15); None = unknown

    def to_dict(self) -> dict:
        result = {
            "meshIndex": self.meshIndex,
            "primitiveIndex": self.primitiveIndex,
            "tris": self.tris,
            "verts": self.verts,
            "bounds": {
                "min": list(self.bounds["min"]),
                "max": list(self.bounds["max"]),
            },
        }
        if self.uv is not None:
            result["uv"] = self.uv
        return result

    @classmethod
    def from_dict(cls, data: dict) -> "AssetPartStats":
        return cls(
            meshIndex=data["meshIndex"],
            primitiveIndex=data["primitiveIndex"],
            tris=data["tris"],
            verts=data["verts"],
            bounds={
                "min": list(data["bounds"]["min"]),
                "max": list(data["bounds"]["max"]),
            },
            uv=data.get("uv"),
        )


@dataclass
class AssetStats:
    """Descriptive stats for an imported asset. All keys optional; the
    agent never authors stats (``import_model`` does, PR7). ``stats`` is
    the one open object in the closed schema: it may grow descriptive
    keys (``clips``, ``skins``, ...) without a schema bump."""

    tris: Optional[int] = None
    verts: Optional[int] = None
    materials: Optional[int] = None
    meshes: Optional[int] = None
    clips: Optional[int] = None
    skins: Optional[int] = None
    bounds: Optional[dict] = None
    ignored: list = field(default_factory=list)
    internals: list = field(default_factory=list)
    drawable: Optional[bool] = None
    parts: list = field(default_factory=list)  # list[AssetPartStats]
    width: Optional[int] = None  # image assets (PR15)
    height: Optional[int] = None

    def to_dict(self) -> dict:
        result: dict = {}
        for key in ("tris", "verts", "materials", "meshes", "clips", "skins", "width", "height"):
            value = getattr(self, key)
            if value is not None:
                result[key] = value
        if self.bounds is not None:
            result["bounds"] = {
                "min": list(self.bounds["min"]),
                "max": list(self.bounds["max"]),
            }
        if self.ignored:
            result["ignored"] = list(self.ignored)
        if self.internals:
            result["internals"] = list(self.internals)
        if self.drawable is not None:
            result["drawable"] = self.drawable
        if self.parts:
            result["parts"] = [p.to_dict() for p in self.parts]
        return result

    @classmethod
    def from_dict(cls, data: dict) -> "AssetStats":
        return cls(
            tris=data.get("tris"),
            verts=data.get("verts"),
            materials=data.get("materials"),
            meshes=data.get("meshes"),
            clips=data.get("clips"),
            skins=data.get("skins"),
            bounds=data.get("bounds"),
            ignored=list(data.get("ignored", [])),
            internals=list(data.get("internals", [])),
            drawable=data.get("drawable"),
            parts=[AssetPartStats.from_dict(p) for p in data.get("parts", [])],
            width=data.get("width"),
            height=data.get("height"),
        )


@dataclass
class Asset:
    id: str
    sha256: str
    file: str
    format: str = "glb"
    bytes: int = 0
    originalName: str = ""
    sourceFormat: str = "glb"
    stats: AssetStats = field(default_factory=AssetStats)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "sha256": self.sha256,
            "file": self.file,
            "format": self.format,
            "bytes": self.bytes,
            "originalName": self.originalName,
            "sourceFormat": self.sourceFormat,
            "stats": self.stats.to_dict(),
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Asset":
        return cls(
            id=data["id"],
            sha256=data["sha256"],
            file=data["file"],
            format=data.get("format", "glb"),
            bytes=data.get("bytes", 0),
            originalName=data.get("originalName", ""),
            sourceFormat=data.get("sourceFormat", "glb"),
            stats=AssetStats.from_dict(data.get("stats", {})),
        )


@dataclass
class HistoryEntry:
    """One undoable mutation. A value is the full object, or ``None``
    when that id was absent. Empty maps are omitted on disk but treated
    as empty."""

    label: str
    at: str
    undo: dict = field(default_factory=dict)  # {"nodes": {...}, ...}
    redo: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        result: dict = {"label": self.label, "at": self.at}
        if self.undo:
            result["undo"] = self.undo
        if self.redo:
            result["redo"] = self.redo
        return result

    @classmethod
    def from_dict(cls, data: dict) -> "HistoryEntry":
        return cls(
            label=data["label"],
            at=data["at"],
            undo=dict(data.get("undo", {})),
            redo=dict(data.get("redo", {})),
        )


@dataclass
class Scene:
    id: str
    name: str
    revision: int = 1
    nodes: list = field(default_factory=list)  # list[Node]
    materials: list = field(default_factory=list)  # list[Material]
    assets: list = field(default_factory=list)  # list[Asset]
    history_undo: list = field(default_factory=list)  # list[HistoryEntry]
    history_redo: list = field(default_factory=list)  # list[HistoryEntry]
    createdAt: str = ""
    updatedAt: str = ""

    def to_dict(self) -> dict:
        return {
            "schema": SCHEMA_VERSION,
            "id": self.id,
            "name": self.name,
            "revision": self.revision,
            "units": UNITS,
            "upAxis": UP_AXIS,
            "createdAt": self.createdAt or now_iso(),
            "updatedAt": self.updatedAt or now_iso(),
            "nodes": [n.to_dict() for n in self.nodes],
            "materials": [m.to_dict() for m in self.materials],
            "assets": [a.to_dict() for a in self.assets],
            "history": {
                "undo": [e.to_dict() for e in self.history_undo],
                "redo": [e.to_dict() for e in self.history_redo],
                "limit": MAX_HISTORY,
            },
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Scene":
        history = data.get("history", {})
        return cls(
            id=data["id"],
            name=data["name"],
            revision=data.get("revision", 1),
            nodes=[Node.from_dict(n) for n in data.get("nodes", [])],
            materials=[Material.from_dict(m) for m in data.get("materials", [])],
            assets=[Asset.from_dict(a) for a in data.get("assets", [])],
            history_undo=[HistoryEntry.from_dict(e) for e in history.get("undo", [])],
            history_redo=[HistoryEntry.from_dict(e) for e in history.get("redo", [])],
            createdAt=data.get("createdAt", ""),
            updatedAt=data.get("updatedAt", ""),
        )


@dataclass
class FeedbackEnvelope:
    """Every successful tool/route result (standalone-editor.md)."""

    scene_id: str
    revision: int
    nodes: list
    materials: list
    assets: list
    stats: dict
    can_undo: bool = False
    can_redo: bool = False
    defaults_added: list = field(default_factory=list)
    history_truncated: bool = False

    def to_dict(self) -> dict:
        return {
            "ok": True,
            "scene": {
                "id": self.scene_id,
                "revision": self.revision,
                "schema": SCHEMA_VERSION,
                "units": UNITS,
                "upAxis": UP_AXIS,
            },
            "nodes": self.nodes,
            "materials": self.materials,
            "assets": self.assets,
            "stats": self.stats,
            "feedback": {
                "canUndo": self.can_undo,
                "canRedo": self.can_redo,
                "defaultsAdded": list(self.defaults_added),
                "historyTruncated": self.history_truncated,
            },
        }


# --- Scene statistics --------------------------------------------------------


def compute_stats(scene: dict) -> dict:
    """``{"tris", "verts", "materials", "nodes"}`` for a scene dict.

    Triangle/vertex counts come from the analytic primitive counters
    (no mesh allocation). Model/part nodes contribute their asset's
    recorded stats when present, else 0 — the GLB bytes are never
    decoded here.
    """
    tris = 0
    verts = 0
    asset_stats = {a.get("id"): a.get("stats", {}) for a in scene.get("assets", [])}
    for node in scene.get("nodes", []):
        kind = node.get("kind")
        if kind == "mesh":
            counts = primitives.count_primitive(node["primitive"])
            tris += counts["tris"]
            verts += counts["verts"]
        elif kind in ("model", "part"):
            stats = asset_stats.get(node.get("modelAssetId"), {})
            if kind == "model":
                tris += stats.get("tris") or 0
                verts += stats.get("verts") or 0
            else:
                for part in stats.get("parts", []):
                    if (
                        part.get("meshIndex") == node.get("meshIndex")
                        and part.get("primitiveIndex") == node.get("primitiveIndex")
                    ):
                        tris += part.get("tris") or 0
                        verts += part.get("verts") or 0
    return {
        "tris": tris,
        "verts": verts,
        "materials": len(scene.get("materials", [])),
        "nodes": len(scene.get("nodes", [])),
    }


def _modifier_feedback_nodes(scene: dict) -> list:
    """Expose unambiguous legacy source indices without returning history or writing it.

    The next modifier Apply persists these proven facts in the generator. Ambiguous
    old bases remain unspecified and the loader refuses a multi-primitive fallback.
    """
    nodes = scene.get("nodes", [])
    legacy = [n for n in nodes if (n.get("generator") or {}).get("type") == "modifiers"
              and "baseMeshIndex" not in n["generator"].get("params", {})]
    if not legacy:
        return nodes
    choices, blocked = {}, set()
    history = scene.get("history") or {}
    for entry in history.get("undo", []) + history.get("redo", []):
        for direction in ("undo", "redo"):
            rows = (entry.get(direction) or {}).get("nodes") or {}
            for old in rows.values():
                if isinstance(old, dict) and old.get("kind") == "part":
                    key = (old.get("id"), old.get("modelAssetId"))
                    if not all(isinstance(v, str) for v in key):
                        continue
                    pair = (old.get("meshIndex", 0), old.get("primitiveIndex", 0))
                    if not all(isinstance(v, int) and not isinstance(v, bool) and v >= 0 for v in pair):
                        blocked.add(key)
                        continue
                    choices.setdefault(key, set()).add(pair)
    resolved = {}
    for node in legacy:
        key = (node["id"], node["generator"]["params"].get("baseAssetId"))
        options = choices.get(key, set())
        if key not in blocked and len(options) == 1:
            mi, pi = next(iter(options))
            copied = copy.deepcopy(node)
            copied["generator"]["params"].update(baseMeshIndex=mi, basePrimitiveIndex=pi)
            resolved[node["id"]] = copied
    return [resolved.get(node["id"], node) for node in nodes]


def feedback_envelope(
    scene: dict,
    defaults_added: Optional[list] = None,
    history_truncated: bool = False,
) -> dict:
    """Build the feedback envelope for a scene dict (no history stacks)."""
    history = scene.get("history", {})
    envelope = FeedbackEnvelope(
        scene_id=scene["id"],
        revision=scene["revision"],
        nodes=_modifier_feedback_nodes(scene),
        materials=scene.get("materials", []),
        assets=scene.get("assets", []),
        stats=compute_stats(scene),
        can_undo=bool(history.get("undo")),
        can_redo=bool(history.get("redo")),
        defaults_added=list(defaults_added or []),
        history_truncated=history_truncated,
    )
    return envelope.to_dict()


# --- Default rig (stage-1 §4.5) ----------------------------------------------
# Verified 2026-11-06 by recomputation (three.js Euler "XYZ" order,
# R = Rx * Ry * Rz): both local -Z axes dot the direction to the origin
# at 1.000000. Identity rotation is wrong for the default camera: it
# looks along world -Z and misses the origin. Do NOT recompute these
# from Object3D.lookAt — that swaps eye and target for non-camera/light
# objects. The four-decimal values are kept as written in the design.

# light_key: directional, white, intensity 3, t=[4,6,3]
LIGHT_KEY_TRANSFORM = {"t": [4, 6, 3], "r": [-63.4349, 30.807, 45.6876], "s": [1, 1, 1]}
# cam_main: perspective, fov 40, near 0.01, far 500, t=[4,3,6]
CAM_MAIN_TRANSFORM = {"t": [4, 3, 6], "r": [-26.5651, 30.807, 14.3633], "s": [1, 1, 1]}


def default_material() -> Material:
    """``m_default``: #c8ccd0, metalness 0, roughness 0.6."""
    return Material(
        id=DEFAULT_MATERIAL_ID,
        color="#c8ccd0",
        emissive="#000000",
        metalness=0.0,
        roughness=0.6,
        opacity=1.0,
        doubleSide=False,
    )


def default_light_node() -> Node:
    """``light_key``: directional, white, intensity 3, aimed at the origin."""
    return Node(
        id=DEFAULT_LIGHT_ID,
        name="Key light",
        kind="light",
        transform=Transform.from_dict(LIGHT_KEY_TRANSFORM),
        light=Light(type="directional", color="#ffffff", intensity=3.0),
    )


def default_camera_node() -> Node:
    """``cam_main``: perspective, fov 40, near 0.01, far 500, aimed at origin."""
    return Node(
        id=DEFAULT_CAMERA_ID,
        name="Main camera",
        kind="camera",
        transform=Transform.from_dict(CAM_MAIN_TRANSFORM),
        camera=Camera(type="perspective", fov=40.0, near=0.01, far=500.0),
    )


def default_rig() -> tuple:
    """``(nodes, materials)`` of the default rig: light + camera + m_default."""
    return [default_light_node(), default_camera_node()], [default_material()]


def default_rig_dicts() -> tuple:
    """The default rig as plain JSON dicts ``(nodes, materials)``."""
    nodes, materials = default_rig()
    return [n.to_dict() for n in nodes], [m.to_dict() for m in materials]


def new_scene_dict(scene_id: str, name: str) -> dict:
    """A new scene dict at revision 1 with the default rig."""
    nodes, materials = default_rig_dicts()
    stamp = now_iso()
    return {
        "schema": SCHEMA_VERSION,
        "id": scene_id,
        "name": name,
        "revision": 1,
        "units": UNITS,
        "upAxis": UP_AXIS,
        "createdAt": stamp,
        "updatedAt": stamp,
        "nodes": nodes,
        "materials": materials,
        "assets": [],
        "history": {"undo": [], "redo": [], "limit": MAX_HISTORY},
    }
