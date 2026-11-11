"""Plastis3D — GLB/glTF import engine (PR7, Stage 3).

Two doors, one engine:

* :func:`import_path` — the agent tool door: a backend path is
  ``realpath``-ed, denylisted on the real path, opened once (inode
  re-checked between stat and open), streamed, hashed, scanned, and
  stored content-addressed.
* :func:`import_bytes` — the gateway upload door: already-decoded
  bytes plus the filename they arrived under.

Order inside the flow (editable-imports plan §3): scan first, then
the cap checks, then the asset write, then the scene lock. Hashing,
scanning, and the exploder never hold the lock (rule 12); the lock is
held only by ``mutate.apply``'s scene write. No partial asset on any
refusal: the asset file is written (atomically, temp + ``os.replace``)
only after every check that can refuse has passed, and a refused
import writes no asset row.

Security (standalone-editor.md, Import contract):

* The caller string is never opened again after ``realpath``; the
  remembered ``(st_dev, st_ino)`` is re-checked with ``fstat`` on the
  opened fd, and a mismatch is ``IMPORT_PATH_DENIED``.
* Denylist on the real path: final component ``credentials.json``,
  ``auth.json``, ``.env``, or ending in ``.pem`` / ``.key``; anything
  inside the plugin install directory. A symlink named ``model.glb``
  whose real path ends in ``credentials.json`` is denied.
* Extension allowlist on the real path's final component: ``.glb``,
  ``.gltf`` and (PR12) ``.obj``, ``.stl``, ``.ply``. The three mesh
  formats are converted to a one-mesh GLB by :mod:`mesh_import` before
  the usual scan, so everything after that point is the GLB flow. An
  OBJ's ``mtllib`` is read only from the OBJ's own directory (path
  door) or from the upload's ``sidecars``; ``map_*`` files are never
  opened.
* Caps: 256 MiB per file, 2 GiB asset quota, 30 s ``IMPORT_TIMEOUT``
  (a default, not a host limit). The scene node cap (2,000) and the
  asset cap (64) are checked before the asset file is written, so a
  refused import never leaves an orphaned asset file.

Exploder (editable-imports plan §3, ``explode`` default true): one
spec ``group`` per glTF node (local TRS, name when present), one spec
``part`` per TRIANGLES mesh primitive (identity transform, parented
under the group of the glTF node referencing the mesh). The caller's
``name`` / ``parent`` / ``transform`` land on one wrapper group that
parents the glTF roots (D5); with ``explode: false`` they land on the
single locked ``model`` node instead. The exploded count (wrapper +
groups + parts) over the 2,000-node cap fails closed as
``LIMIT_NODES`` naming the count and the cap (D4).

A ``.gltf`` file is stored as GLB (standalone-editor.md rule 6): the
scan runs on the document plus its decoded ``data:`` buffers, the
buffers are packed into one BIN chunk, and the SHA is over the stored
GLB bytes. A ``.glb`` file is stored byte-for-byte.

Decisions recorded in
``docs/planning/stages/pr7-decisions-and-follow-ups-2026-11-07.md``:
D4 (cap guard code), D5 (wrapper group), D6 (asset id is the sha256),
D7 (``.gltf`` stored as GLB, SHA over the stored bytes).

Stdlib only. Python 3.11-compatible.
"""

from __future__ import annotations

import copy
import hashlib
import math
import os
import stat as stat_module
import time
from pathlib import Path
from typing import Any, Optional

from . import glb as _glb
from . import mesh_import
from . import mutate
from .spec import MAX_ASSETS, MAX_NODES, PlastisError, new_node_id
from .store import Store
from .validate import validate_scene

# The import budget (standalone-editor.md, Caps table): 30 s is a
# default, not a host limit.
IMPORT_TIMEOUT = 30.0

# 256 MiB per file, 2 GiB asset quota (stage-3.md §4.3).
MAX_IMPORT_BYTES = 256 * 1024 * 1024
MAX_ASSET_QUOTA_BYTES = 2 * 1024 * 1024 * 1024

_READ_CHUNK = 1024 * 1024  # 1 MiB streaming reads (PR1 §4.8 timing basis)

_DENIED_NAMES = frozenset({"credentials.json", "auth.json", ".env"})
_DENIED_SUFFIXES = (".pem", ".key")
_ALLOWED_EXTENSIONS = {
    ".glb": "glb",
    ".gltf": "gltf",
    ".obj": "obj",
    ".stl": "stl",
    ".ply": "ply",
    ".splat": "splat",
}
_ALLOWED_LIST = ".glb, .gltf, .obj, .stl, .ply"
# Upload sidecars (the OBJ's .mtl): a few small files, by bare file name.
MAX_SIDECARS = 4


def _fail(code: str, message: str, path: Optional[str] = None) -> None:
    raise PlastisError(code, "%s: %s" % (code, message), path=path)


def _check_deadline(deadline: float) -> None:
    if time.monotonic() >= deadline:
        _fail(
            "IMPORT_TIMEOUT",
            "import exceeded the %.0f-second budget; nothing was written" % IMPORT_TIMEOUT,
        )


def _plugin_root() -> Path:
    """The plugin install directory: the parent of this package."""
    return Path(__file__).resolve().parent.parent


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_vec3(value: Any) -> bool:
    return (
        isinstance(value, list)
        and len(value) == 3
        and all(
            isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
            for v in value
        )
    )


# --- Transform conversion ----------------------------------------------------
# Spec convention (spec.py): Euler XYZ degrees, R = Rx * Ry * Rz. The
# extraction below is three.js's Euler.setFromRotationMatrix for order
# "XYZ" (m13 = R[0][2]); the round-trip is covered by
# tests/python/test_import.py::test_euler_round_trip.


def _euler_from_matrix(matrix: list) -> list:
    """Row-major 3x3 rotation matrix -> Euler XYZ degrees."""
    r02 = max(-1.0, min(1.0, matrix[0][2]))
    y = math.asin(r02)
    if abs(r02) < 0.9999999:
        x = math.atan2(-matrix[1][2], matrix[2][2])
        z = math.atan2(-matrix[0][1], matrix[0][0])
    else:
        x = math.atan2(matrix[2][1], matrix[1][1])
        z = 0.0
    return [math.degrees(x), math.degrees(y), math.degrees(z)]


def _quaternion_to_matrix(quaternion: list) -> list:
    """glTF quaternion [x, y, z, w] -> row-major 3x3 rotation matrix."""
    x, y, z, w = (float(v) for v in quaternion)
    norm = math.sqrt(x * x + y * y + z * z + w * w)
    if norm == 0.0 or not math.isfinite(norm):
        _fail("IMPORT_TOO_COMPLEX", "glTF node rotation quaternion has zero length")
    x, y, z, w = x / norm, y / norm, z / norm, w / norm
    return [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ]


def _node_transform(node: dict, what: str) -> dict:
    """A glTF node's local TRS as a spec transform.

    ``matrix`` nodes are decomposed (translation, scale from column
    lengths, rotation from the normalized columns); TRS nodes convert
    the quaternion. A zero scale component or a non-finite number is
    ``IMPORT_TOO_COMPLEX`` — the spec validator forbids scale 0, so
    the import fails here with the import code instead of leaving an
    un-importable node behind.
    """
    matrix = node.get("matrix")
    if matrix is not None:
        if (
            not isinstance(matrix, list)
            or len(matrix) != 16
            or not all(
                isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
                for v in matrix
            )
        ):
            _fail("IMPORT_TOO_COMPLEX", "%s matrix must be 16 finite numbers" % what)
        translation = [float(matrix[12]), float(matrix[13]), float(matrix[14])]
        columns = [
            [float(matrix[0]), float(matrix[1]), float(matrix[2])],
            [float(matrix[4]), float(matrix[5]), float(matrix[6])],
            [float(matrix[8]), float(matrix[9]), float(matrix[10])],
        ]
        scale = [math.sqrt(sum(v * v for v in column)) for column in columns]
        if any(component == 0.0 for component in scale):
            _fail("IMPORT_TOO_COMPLEX", "%s matrix has a zero scale column" % what)
        rotation = [
            [columns[c][r] / scale[c] for c in range(3)] for r in range(3)
        ]
        # A negative determinant is a reflection: flip the longest
        # column (three.js Matrix4.decompose does the same) so the
        # rotation stays proper and the scale carries the sign.
        det = (
            rotation[0][0] * (rotation[1][1] * rotation[2][2] - rotation[1][2] * rotation[2][1])
            - rotation[0][1] * (rotation[1][0] * rotation[2][2] - rotation[1][2] * rotation[2][0])
            + rotation[0][2] * (rotation[1][0] * rotation[2][1] - rotation[1][1] * rotation[2][0])
        )
        if det < 0:
            longest = max(range(3), key=lambda axis: scale[axis])
            scale[longest] = -scale[longest]
            for row in range(3):
                rotation[row][longest] = -rotation[row][longest]
        return {
            "t": translation,
            "r": _euler_from_matrix(rotation),
            "s": scale,
        }
    translation = node.get("translation", [0.0, 0.0, 0.0])
    rotation_q = node.get("rotation", [0.0, 0.0, 0.0, 1.0])
    scale = node.get("scale", [1.0, 1.0, 1.0])
    if not _is_vec3(translation):
        _fail("IMPORT_TOO_COMPLEX", "%s translation must be [x, y, z] of finite numbers" % what)
    if (
        not isinstance(rotation_q, list)
        or len(rotation_q) != 4
        or not all(
            isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
            for v in rotation_q
        )
    ):
        _fail("IMPORT_TOO_COMPLEX", "%s rotation must be a quaternion [x, y, z, w]" % what)
    if not _is_vec3(scale):
        _fail("IMPORT_TOO_COMPLEX", "%s scale must be [x, y, z] of finite numbers" % what)
    if any(component == 0.0 for component in scale):
        _fail("IMPORT_TOO_COMPLEX", "%s scale must not contain 0" % what)
    return {
        "t": [float(v) for v in translation],
        "r": _euler_from_matrix(_quaternion_to_matrix(rotation_q)),
        "s": [float(v) for v in scale],
    }


def _clean_name(value: Any, fallback: str) -> str:
    """A spec node name (1..64 chars): the glTF name when usable,
    truncated to 64, else the fallback."""
    if isinstance(value, str) and value:
        return value[:64]
    return fallback


# --- Caller-path checks --------------------------------------------------------


def _resolve_source_path(
    path: str, allowed: Optional[dict] = None, allowed_list: Optional[str] = None
) -> tuple:
    """``realpath`` + denylist + extension allowlist + stat.

    Returns ``(real_path, source_format, remembered_stat)``. Raises
    ``IMPORT_PATH_DENIED`` / ``IMPORT_NOT_FOUND`` / ``IMPORT_FORMAT``.
    The caller string is never used again after this returns.
    """
    if not isinstance(path, str) or not path:
        _fail("SPEC_INVALID", "import path must be a non-empty string", path="/path")
    if not os.path.isabs(path):
        _fail("IMPORT_PATH_DENIED", "import path must be absolute")
    real_path = Path(os.path.realpath(path))
    final = real_path.name
    lowered = final.lower()
    if lowered in _DENIED_NAMES or lowered.endswith(_DENIED_SUFFIXES):
        _fail("IMPORT_PATH_DENIED", "import path names a denied credential file")
    plugin_root = _plugin_root()
    if real_path == plugin_root or plugin_root in real_path.parents:
        _fail("IMPORT_PATH_DENIED", "import path is inside the plugin install directory")
    try:
        remembered = os.stat(real_path)
    except FileNotFoundError:
        _fail("IMPORT_NOT_FOUND", "no file at the import path")
    except OSError as exc:
        _fail("IMPORT_PATH_DENIED", "cannot stat the import path: %s" % exc)
        raise AssertionError("unreachable")
    if not stat_module.S_ISREG(remembered.st_mode):
        _fail("IMPORT_FORMAT", "import path is not a regular file")
    suffix = real_path.suffix.lower()
    source_format = (allowed if allowed is not None else _ALLOWED_EXTENSIONS).get(suffix)
    if source_format is None:
        _fail(
            "IMPORT_FORMAT",
            "extension %r is not in the allowlist (%s)"
            % (suffix, allowed_list or _ALLOWED_LIST),
        )
    return real_path, source_format, remembered


def _read_source(
    real_path: Path, remembered: Any, deadline: float, max_bytes: int = MAX_IMPORT_BYTES
) -> tuple:
    """Open the real path only, re-check the inode, stream the bytes.

    Returns ``(data, sha256_hex)``. Enforces the 256 MiB per-file cap
    while reading (a larger file is refused without reading it whole)
    and the import deadline per chunk.
    """
    _check_deadline(deadline)
    try:
        fd = os.open(real_path, os.O_RDONLY | getattr(os, "O_BINARY", 0))
    except OSError as exc:
        _fail("IMPORT_NOT_FOUND", "cannot open the import path: %s" % exc)
        raise AssertionError("unreachable")
    try:
        opened = os.fstat(fd)
        if (opened.st_dev, opened.st_ino) != (remembered.st_dev, remembered.st_ino):
            _fail(
                "IMPORT_PATH_DENIED",
                "the file changed between the path check and the open",
            )
        hasher = hashlib.sha256()
        chunks = bytearray()
        while True:
            _check_deadline(deadline)
            chunk = os.read(fd, _READ_CHUNK)
            if not chunk:
                break
            chunks.extend(chunk)
            hasher.update(chunk)
            if len(chunks) > max_bytes:
                _fail(
                    "IMPORT_TOO_LARGE",
                    "file exceeds the %d MiB per-file cap" % (max_bytes // (1024 * 1024))
                    if max_bytes >= 1024 * 1024
                    else "file exceeds the per-file cap",
                )
        return bytes(chunks), hasher.hexdigest()
    finally:
        os.close(fd)


# --- Exploder -------------------------------------------------------------------


def _explode(
    gltf: dict,
    *,
    asset_id: str,
    name: str,
    parent: Optional[str],
    transform: Optional[dict],
    explode: bool,
    taken_ids: set,
) -> list:
    """Build the spec nodes for one import.

    ``explode`` true: a wrapper group (the caller's name / parent /
    transform, D5) parenting one spec group per glTF node, with one
    spec part per TRIANGLES primitive under its node's group.
    ``explode`` false: one locked ``model`` node. Node ids are
    generated against ``taken_ids`` (the scene's ids plus the ids
    already generated here) so parent links resolve.
    """
    meshes = gltf.get("meshes", []) or []
    nodes_gltf = gltf.get("nodes", []) or []
    if explode:
        reasons = []
        if gltf.get("skins"):
            reasons.append("skins")
        if gltf.get("animations"):
            reasons.append("animations")
        if any(p.get("targets") for m in meshes for p in (m.get("primitives", []) or [])):
            reasons.append("morph targets")
        if reasons:
            _fail("SPEC_INVALID", "Cannot explode imports with %s; use explode: false" % ", ".join(reasons))

    def _new_id() -> str:
        while True:
            candidate = new_node_id()
            if candidate not in taken_ids:
                taken_ids.add(candidate)
                return candidate

    def _caller_transform() -> dict:
        if transform is None:
            return {"t": [0.0, 0.0, 0.0], "r": [0.0, 0.0, 0.0], "s": [1.0, 1.0, 1.0]}
        return {
            "t": [float(v) for v in transform["t"]],
            "r": [float(v) for v in transform["r"]],
            "s": [float(v) for v in transform["s"]],
        }

    if not explode:
        return [
            {
                "id": _new_id(),
                "name": name,
                "parent": parent,
                "kind": "model",
                "transform": _caller_transform(),
                "visible": True,
                "modelAssetId": asset_id,
            }
        ]

    wrapper_id = _new_id()
    nodes: list = [
        {
            "id": wrapper_id,
            "name": name,
            "parent": parent,
            "kind": "group",
            "transform": _caller_transform(),
            "visible": True,
        }
    ]

    # Roots: the default scene's nodes, or every node no other node
    # parents when the file has no scenes. An explicitly empty scenes
    # array has no scene to import from.
    scenes = gltf.get("scenes")
    if scenes is None:
        children: set = set()
        for node in nodes_gltf:
            children.update(node.get("children", []) or [])
        roots = [i for i in range(len(nodes_gltf)) if i not in children]
    elif not scenes:
        _fail("IMPORT_TOO_COMPLEX", "glTF scenes array is empty; no scene to import")
        raise AssertionError("unreachable")
    else:
        scene_index = gltf.get("scene", 0)
        roots = list(scenes[scene_index].get("nodes", []) or [])

    # Iterative walk (a malicious file could nest nodes deeper than
    # the Python recursion limit). Parents are emitted before their
    # children; the stack reverses each sibling list to keep order.
    group_id_by_gltf: dict = {}
    stack: list = [(root, wrapper_id) for root in reversed(roots)]
    while stack:
        gltf_index, spec_parent = stack.pop()
        node = nodes_gltf[gltf_index]
        group_id = _new_id()
        group_id_by_gltf[gltf_index] = group_id
        nodes.append(
            {
                "id": group_id,
                "name": _clean_name(node.get("name"), "Node %d" % gltf_index),
                "parent": spec_parent,
                "kind": "group",
                "transform": _node_transform(node, "node %d" % gltf_index),
                "visible": True,
            }
        )
        mesh_index = node.get("mesh")
        if mesh_index is not None:
            mesh = meshes[mesh_index]
            primitives = mesh.get("primitives", []) or []
            mesh_name = mesh.get("name")
            for prim_index, primitive in enumerate(primitives):
                if primitive.get("mode", 4) != 4:
                    continue
                if isinstance(mesh_name, str) and mesh_name:
                    part_name = (
                        mesh_name
                        if len(primitives) == 1
                        else "%s %d" % (mesh_name, prim_index)
                    )
                else:
                    part_name = "Part %d.%d" % (mesh_index, prim_index)
                nodes.append(
                    {
                        "id": _new_id(),
                        "name": _clean_name(part_name, "Part %d.%d" % (mesh_index, prim_index)),
                        "parent": group_id,
                        "kind": "part",
                        "transform": {"t": [0.0, 0.0, 0.0], "r": [0.0, 0.0, 0.0], "s": [1.0, 1.0, 1.0]},
                        "visible": True,
                        "modelAssetId": asset_id,
                        "meshIndex": mesh_index,
                        "primitiveIndex": prim_index,
                    }
                )
        for child in reversed(node.get("children", []) or []):
            stack.append((child, group_id))
    return nodes


def _skipped_scene_content(gltf: dict) -> list:
    """``stats.ignored`` entries for what the import does not bring in (R-28).

    Import takes the default scene's tree, as ``GLTFLoader``'s
    ``gltf.scene`` does, so other scenes and nodes unreachable from the
    default scene's roots are not imported. They are reported here
    instead of being dropped silently. The wording must not contain
    "mode": the overlay's not-triangles line matches ``/mode/i``.
    """
    scenes = gltf.get("scenes")
    nodes_gltf = gltf.get("nodes", []) or []
    if not scenes:
        # No scenes: every unparented node is a root, so nothing is
        # unreachable. (An empty array is refused before this runs.)
        return []
    entries = []
    others = len(scenes) - 1
    if others > 0:
        entries.append(
            "%d other glTF scene%s %s not imported"
            % (others, "" if others == 1 else "s", "was" if others == 1 else "were")
        )
    scene_index = gltf.get("scene", 0)
    seen: set = set()
    stack = list(scenes[scene_index].get("nodes", []) or [])
    while stack:
        index = stack.pop()
        if index in seen:
            continue
        seen.add(index)
        stack.extend(nodes_gltf[index].get("children", []) or [])
    outside = len(nodes_gltf) - len(seen)
    if outside > 0:
        entries.append(
            "%d node%s %s outside scene %d and %s not imported"
            % (
                outside,
                "" if outside == 1 else "s",
                "is" if outside == 1 else "are",
                scene_index,
                "was" if outside == 1 else "were",
            )
        )
    return entries


# --- OBJ material (.mtl) loaders -------------------------------------------------


def _path_mtl_loader(obj_real_path: Path):
    """The path door's ``mtllib`` loader, confined to the OBJ's directory.

    The ``mtllib`` name is resolved against the OBJ's directory and
    ``realpath``-ed; if that real path is not inside the OBJ's own real
    directory it is ``IMPORT_PATH_DENIED`` and nothing is opened. The
    file that passed the check is the one opened, by its real path, with
    the inode compared between ``stat`` and ``open``. Only ``.mtl`` files
    up to 1 MiB are read; a missing or unusable one is reported and the
    default material is used.
    """
    directory = obj_real_path.parent

    def load(name: str) -> tuple:
        candidate = Path(os.path.realpath(os.path.join(str(directory), name)))
        if candidate != directory and directory not in candidate.parents:
            _fail("IMPORT_PATH_DENIED", "mtllib %r is outside the OBJ file's directory" % name)
        lowered = candidate.name.lower()
        plugin_root = _plugin_root()
        if (
            lowered in _DENIED_NAMES
            or lowered.endswith(_DENIED_SUFFIXES)
            or candidate == plugin_root
            or plugin_root in candidate.parents
        ):
            _fail("IMPORT_PATH_DENIED", "mtllib %r names a denied file" % name)
        if candidate.suffix.lower() != ".mtl":
            return None, "mtllib %r is not a .mtl file and was not read; the default colour is used" % name
        try:
            remembered = os.stat(candidate)
        except OSError:
            return None, "mtllib %r was not found; the default colour is used" % name
        if not stat_module.S_ISREG(remembered.st_mode):
            return None, "mtllib %r is not a regular file and was not read" % name
        if remembered.st_size > mesh_import.MAX_MTL_BYTES:
            return None, "mtllib %r is over 1 MiB and was not read" % name
        try:
            fd = os.open(candidate, os.O_RDONLY | getattr(os, "O_BINARY", 0))
        except OSError:
            return None, "mtllib %r could not be opened; the default colour is used" % name
        try:
            opened = os.fstat(fd)
            if (opened.st_dev, opened.st_ino) != (remembered.st_dev, remembered.st_ino):
                _fail("IMPORT_PATH_DENIED", "the .mtl file changed between the path check and the open")
            return os.read(fd, mesh_import.MAX_MTL_BYTES + 1)[: mesh_import.MAX_MTL_BYTES], None
        finally:
            os.close(fd)

    return load


def _sidecar_mtl_loader(sidecars: dict):
    """The upload door's ``mtllib`` loader: a lookup by bare file name in
    the uploaded sidecars. It never touches the filesystem."""

    def load(name: str) -> tuple:
        wanted = name.replace("\\", "/").rsplit("/", 1)[-1]
        data = sidecars.get(wanted)
        if data is None:
            return None, "mtllib %r was not uploaded with the file; the default colour is used" % name
        if len(data) > mesh_import.MAX_MTL_BYTES:
            return None, "mtllib %r is over 1 MiB and was not read" % name
        return data, None

    return load


def _check_sidecars(sidecars: Any) -> dict:
    """Validate ``upload.sidecars`` into ``{bare file name: bytes}``."""
    if sidecars is None:
        return {}
    if not isinstance(sidecars, dict):
        _fail("SPEC_INVALID", "sidecars must be a mapping of file name to bytes", path="/sidecars")
    if len(sidecars) > MAX_SIDECARS:
        _fail("SPEC_INVALID", "at most %d sidecar files are accepted" % MAX_SIDECARS, path="/sidecars")
    out: dict = {}
    for key, value in sidecars.items():
        if (
            not isinstance(key, str)
            or not key
            or "/" in key
            or "\\" in key
            or key in (".", "..")
            or not isinstance(value, (bytes, bytearray))
        ):
            _fail("SPEC_INVALID", "each sidecar needs a bare file name and bytes", path="/sidecars")
        out[key] = bytes(value)
    return out


# --- Shared engine ---------------------------------------------------------------


def _validate_caller_options(
    name: Optional[str],
    parent: Optional[str],
    transform: Optional[dict],
    explode: Any,
) -> None:
    if name is not None and (not isinstance(name, str) or not 1 <= len(name) <= 64):
        _fail("SPEC_INVALID", "name must be a string of 1..64 characters", path="/name")
    if parent is not None and not isinstance(parent, str):
        _fail("SPEC_INVALID", "parent must be a node id or null", path="/parent")
    if transform is not None:
        if not isinstance(transform, dict):
            _fail("SPEC_INVALID", "transform must be an object", path="/transform")
        for key in ("t", "r", "s"):
            if not _is_vec3(transform.get(key)):
                _fail(
                    "SPEC_INVALID",
                    "transform.%s must be [x, y, z] of finite numbers" % key,
                    path="/transform/%s" % key,
                )
        if any(component == 0 for component in transform["s"]):
            _fail("SPEC_INVALID", "transform.s must not contain 0", path="/transform/s")
    if not isinstance(explode, bool):
        _fail("SPEC_INVALID", "explode must be a boolean", path="/explode")


def import_bytes(
    scene_id: str,
    store: Store,
    data: bytes,
    *,
    original_name: str,
    source_format: str,
    base_revision: int,
    name: Optional[str] = None,
    parent: Optional[str] = None,
    transform: Optional[dict] = None,
    explode: bool = True,
    timeout: float = IMPORT_TIMEOUT,
    sidecars: Optional[dict] = None,
    mtl_loader: Any = None,
) -> dict:
    """Import already-read bytes into ``scene_id``.

    ``data`` is the file as received (GLB bytes, glTF JSON text for
    ``source_format == "gltf"``, or an OBJ / STL / PLY file). ``sidecars``
    is the upload door's ``{file name: bytes}`` (an OBJ's ``.mtl``);
    ``mtl_loader`` is the path door's directory-confined loader.
    Returns the feedback envelope.
    Raises :class:`PlastisError` with a stable import code on any
    validation/quota refusal before publication. A later scene conflict may
    retain complete unreferenced immutable bytes for GC (C-03), but never
    commits a partial file or dangling scene reference.
    """
    deadline = time.monotonic() + timeout
    _check_deadline(deadline)
    _validate_caller_options(name, parent, transform, explode)
    if not isinstance(original_name, str) or not original_name:
        _fail("SPEC_INVALID", "originalName must be a non-empty string", path="/originalName")
    if len(data) > MAX_IMPORT_BYTES:
        _fail("IMPORT_TOO_LARGE", "file of %d bytes exceeds the 256 MiB per-file cap" % len(data))
    from . import splats
    if source_format == "splat" or (source_format == "ply" and splats.is_gaussian_ply(data)):
        return _import_splats(store, scene_id, base_revision, data, source_format, original_name, name, parent, transform)
    if source_format not in ("glb", "gltf") + mesh_import.MESH_FORMATS:
        _fail("IMPORT_FORMAT", "source format %r is not in the allowlist" % source_format)
    sidecar_map = _check_sidecars(sidecars)

    converted_ignored: list = []
    if source_format in mesh_import.MESH_FORMATS:
        # OBJ / STL / PLY become one one-mesh GLB, which then takes the
        # GLB flow. The SHA is over the converted GLB (like D7).
        if mtl_loader is None:
            mtl_loader = _sidecar_mtl_loader(sidecar_map)
        data, converted_ignored = mesh_import.convert(
            data,
            source_format,
            name=_clean_name(Path(original_name).stem, "Model"),
            deadline=deadline,
            mtl_loader=mtl_loader,
        )
        if sidecar_map and source_format != "obj":
            converted_ignored.append(
                "%d sidecar file%s not used (only an OBJ reads a .mtl)"
                % (len(sidecar_map), " was" if len(sidecar_map) == 1 else "s were")
            )
        scan = _glb.scan(data, source_format="glb", deadline=deadline)
    else:
        scan = _glb.scan(data, source_format=source_format, deadline=deadline)
    _check_deadline(deadline)

    # A .gltf file is stored as GLB (rule 6); the SHA is over the
    # stored bytes (D7). A .glb file (and a converted mesh) is stored
    # byte-for-byte.
    if source_format == "gltf":
        stored = _glb.build_glb(scan.gltf, scan.buffers)
        sha = hashlib.sha256(stored).hexdigest()
    else:
        stored = data
        sha = hashlib.sha256(data).hexdigest()
    asset_id = sha  # D6: the asset id IS the sha256 (content-addressed).
    if len(stored) > MAX_IMPORT_BYTES:
        _fail("IMPORT_TOO_LARGE", "stored GLB of %d bytes exceeds the 256 MiB per-file cap" % len(stored))

    scene = store.get_scene(scene_id)
    stem = Path(original_name).stem or "Model"
    display_name = name if name is not None else _clean_name(stem, "Model")
    taken_ids = {n.get("id") for n in scene.get("nodes", [])}
    nodes = _explode(
        scan.gltf,
        asset_id=asset_id,
        name=display_name,
        parent=parent,
        transform=transform,
        explode=explode,
        taken_ids=taken_ids,
    )

    # Cap guards, before any file is written (D4): the exploded count
    # itself, the scene total, and the asset count.
    exploded_count = len(nodes)
    if exploded_count > MAX_NODES:
        _fail(
            "LIMIT_NODES",
            "import explodes to %d nodes (groups + parts), over the %d-node cap; "
            "retry with explode: false" % (exploded_count, MAX_NODES),
        )
    if len(scene.get("nodes", [])) + exploded_count > MAX_NODES:
        _fail(
            "LIMIT_NODES",
            "scene would have %d nodes after import, over the %d-node cap"
            % (len(scene.get("nodes", [])) + exploded_count, MAX_NODES),
        )
    existing_asset = next(
        (a for a in scene.get("assets", []) if a.get("id") == asset_id), None
    )
    if existing_asset is None and len(scene.get("assets", [])) >= MAX_ASSETS:
        _fail(
            "LIMIT_ASSETS",
            "scene already has %d assets, the %d-asset cap" % (len(scene.get("assets", [])), MAX_ASSETS),
        )

    stats = copy.deepcopy(scan.stats)
    if converted_ignored:
        stats["ignored"] = list(stats.get("ignored") or []) + converted_ignored
    skipped = _skipped_scene_content(scan.gltf)
    if skipped:
        stats["ignored"] = list(stats.get("ignored") or []) + skipped
    stats["internals"] = [
        {"index": i, "name": _clean_name(n.get("name"), "Node %d" % i)}
        for i, n in enumerate(scan.gltf.get("nodes", []) or [])
    ]
    asset = {
        "id": asset_id,
        "sha256": sha,
        "file": "assets/%s.glb" % sha,
        "format": "glb",
        "bytes": len(stored),
        "originalName": original_name,
        "sourceFormat": source_format,
        "stats": stats,
    }

    # Validate the post-import document BEFORE writing the asset file,
    # so a bad caller option (unknown parent, bad transform) refuses
    # without leaving an orphaned asset file behind.
    candidate = copy.deepcopy(scene)
    if existing_asset is None:
        candidate["assets"] = list(scene.get("assets", [])) + [asset]
    candidate["nodes"] = list(scene.get("nodes", [])) + copy.deepcopy(nodes)
    validate_scene(candidate)
    _check_deadline(deadline)

    # Publish the asset file (atomic; skipped when these exact bytes
    # are already stored — content-addressed, shared across imports).
    from .asset_transactions import AssetOperation
    with AssetOperation(store, files={sha + ".glb": stored}, quota=MAX_ASSET_QUOTA_BYTES):
        return mutate.apply(
            scene_id, base_revision,
            {"op": "import_asset", "asset": asset, "nodes": nodes}, store=store,
        )



def import_path(
    scene_id: str,
    store: Store,
    path: str,
    *,
    base_revision: int,
    name: Optional[str] = None,
    parent: Optional[str] = None,
    transform: Optional[dict] = None,
    explode: bool = True,
    timeout: float = IMPORT_TIMEOUT,
) -> dict:
    """Import a GLB, glTF, OBJ, STL or PLY file from a backend path.

    Returns the feedback envelope. Raises :class:`PlastisError` with a
    stable import code on any refusal, writing nothing.
    """
    deadline = time.monotonic() + timeout
    _check_deadline(deadline)
    _validate_caller_options(name, parent, transform, explode)
    real_path, source_format, remembered = _resolve_source_path(path)
    data, _sha = _read_source(real_path, remembered, deadline)
    return import_bytes(
        scene_id,
        store,
        data,
        original_name=real_path.name,
        source_format=source_format,
        base_revision=base_revision,
        name=name,
        parent=parent,
        transform=transform,
        explode=explode,
        timeout=max(0.0, deadline - time.monotonic()),
        mtl_loader=_path_mtl_loader(real_path) if source_format == "obj" else None,
    )


def _import_splats(store, scene_id, base_revision, data, source_format, original_name, name, parent, transform):
    from .splats import decode
    stored = decode(data, source_format)
    sha = hashlib.sha256(stored).hexdigest()
    scene = store.get_scene(scene_id)
    if len(scene['nodes']) >= MAX_NODES:
        _fail('LIMIT_NODES', 'Scene node cap reached')
    if not any(a['id'] == sha for a in scene['assets']) and len(scene['assets']) >= MAX_ASSETS:
        _fail('LIMIT_ASSETS', 'Scene asset cap reached')
    asset = dict(id=sha, sha256=sha, file='assets/'+sha+'.splat', format='splat', bytes=len(stored), originalName=original_name, sourceFormat=source_format, stats={})
    node = dict(id=new_node_id(), name=name or _clean_name(Path(original_name).stem, 'Splats'), kind='splat', splatAssetId=sha, parent=parent, visible=True, transform=transform or dict(t=[0,0,0], r=[0,0,0], s=[1,1,1]))
    candidate = copy.deepcopy(scene)
    if not any(a['id'] == sha for a in candidate['assets']): candidate['assets'].append(asset)
    candidate['nodes'].append(node)
    validate_scene(candidate)
    from .asset_transactions import AssetOperation
    with AssetOperation(store, files={sha+'.splat': stored}, quota=MAX_ASSET_QUOTA_BYTES):
        return mutate.apply(scene_id, base_revision, dict(op='import_asset', asset=asset, nodes=[node]), store=store)
