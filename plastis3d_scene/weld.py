"""Plastis3D — weld and degenerate-triangle removal for imported meshes (PR19).

Correctness audit C-11 and C-19 set the rules, and this module follows them:

* **Attribute-equivalent only.** Two vertices merge only when their *complete
  attribute record* is equal: position, normal, tangent, every UV set, every
  colour set. Vertices that share a position but differ in any attribute (a UV
  seam, a hard normal edge, a colour boundary) stay apart, so no seam is lost.
  "Equal" means equal after rounding to a fixed tolerance (1e-6) per component;
  a vertex pair that straddles a rounding boundary is simply not merged, which
  is the safe direction.
* **Degenerates.** After welding, a triangle that names the same vertex twice,
  or whose area is under 1e-12 m², is dropped. It draws nothing.
* **Imported mesh data only (C-19).** This works on a stored model asset (the GLB
  an import wrote). Analytic primitives are never converted; the caller lists
  them as skipped.
* **Unsupported cases are rejected, not guessed (C-11).** A file with skins,
  animations or morph targets is skipped whole: their data is keyed on vertex
  indexes and a weld would break it. A primitive that is not plain triangles,
  uses sparse or joint/weight data, or whose accessor layout this does not
  read, is left exactly as it was.
* **New bytes, never in place (C-03).** The result is a new GLB (the caller
  stores it under its own sha256); the source bytes are not touched. Unused
  accessors and buffer views are dropped and the buffer is compacted, so a weld
  usually makes the file smaller.

Index width follows C-12: ``uint16`` only when the largest index is below 65535.
Pure: bytes in, bytes out. Stdlib only.
"""

from __future__ import annotations

import copy
import math
import struct
import time
from typing import Any, Optional

from . import glb as _glb
from .spec import PlastisError

POSITION_TOLERANCE = 1e-6
ATTRIBUTE_TOLERANCE = 1e-6
DEGENERATE_AREA = 1e-12
MAX_VERTICES = 500_000  # per asset: the work is linear, and bounded by the 30 s budget

_COMPONENT = {5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2), 5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4)}
_WIDTH = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


class _Skip(Exception):
    """A primitive or file this weld does not handle; the reason is the message."""


def _check_deadline(deadline: float) -> None:
    if time.monotonic() >= deadline:
        raise PlastisError(
            "IMPORT_TIMEOUT",
            "IMPORT_TIMEOUT: the weld exceeded its time budget; nothing was written",
        )


def _decode(gltf: dict, buffers: list, index: int) -> tuple:
    """``(elements, spec)`` for a dense accessor, else raise :class:`_Skip`."""
    accessor = gltf["accessors"][index]
    if "sparse" in accessor or "bufferView" not in accessor:
        raise _Skip("an accessor is sparse or has no data")
    width = _WIDTH.get(accessor.get("type"))
    code = _COMPONENT.get(accessor.get("componentType"))
    if width is None or code is None:
        raise _Skip("an accessor has a type this does not read")
    letter, size = code
    view = gltf["bufferViews"][accessor["bufferView"]]
    blob = buffers[view.get("buffer", 0)]
    stride = view.get("byteStride") or size * width
    start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    fmt = "<%d%s" % (width, letter)
    rows = [struct.unpack_from(fmt, blob, start + i * stride) for i in range(accessor["count"])]
    spec = {
        "componentType": accessor["componentType"],
        "type": accessor["type"],
        "normalized": bool(accessor.get("normalized", False)),
    }
    return rows, spec


def _encode(rows: list, spec: dict, *, vertex: bool) -> tuple:
    """``(bytes, byteStride or None)``; vertex elements are padded to 4 bytes (glTF)."""
    letter, size = _COMPONENT[spec["componentType"]]
    width = _WIDTH[spec["type"]]
    element = width * size
    pad = (-element) % 4 if vertex else 0
    out = bytearray()
    fmt = "<%d%s" % (width, letter)
    for row in rows:
        out += struct.pack(fmt, *row)
        if pad:
            out += b"\x00" * pad
    return bytes(out), (element + pad if pad else None)


def _key(row: tuple, spec: dict, tolerance: float) -> tuple:
    if spec["componentType"] == 5126:
        out = []
        for value in row:
            if not math.isfinite(value):
                raise _Skip("an attribute holds a value that is not a finite number")
            out.append(round(value / tolerance))
        return tuple(out)
    return tuple(row)  # integers compare exactly


def _area(a: tuple, b: tuple, c: tuple) -> float:
    ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
    vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
    cx, cy, cz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
    return 0.5 * math.sqrt(cx * cx + cy * cy + cz * cz)


def _weld_primitive(gltf: dict, buffers: list, primitive: dict, deadline: float) -> Optional[dict]:
    """The welded data for one primitive, or ``None`` when it would not change.

    Returns ``{"attributes": {name: (rows, spec)}, "indices": [int], "vertices_removed",
    "triangles_removed"}``. Raises :class:`_Skip` for a primitive this does not handle.
    """
    attributes = primitive.get("attributes") or {}
    if primitive.get("mode", 4) != 4:
        raise _Skip("not a triangle list")
    if primitive.get("targets"):
        raise _Skip("it has morph targets")
    if any(name.startswith(("JOINTS_", "WEIGHTS_")) for name in attributes):
        raise _Skip("it has joint or weight data")
    if "POSITION" not in attributes:
        raise _Skip("it has no positions")
    decoded = {name: _decode(gltf, buffers, index) for name, index in attributes.items()}
    count = len(decoded["POSITION"][0])
    if count > MAX_VERTICES:
        raise _Skip("more than %d vertices" % MAX_VERTICES)
    if any(len(rows) != count for rows, _spec in decoded.values()):
        raise _Skip("its attributes disagree on the vertex count")
    if primitive.get("indices") is not None:
        index_rows, index_spec = _decode(gltf, buffers, primitive["indices"])
        if index_spec["type"] != "SCALAR" or index_spec["componentType"] not in (5121, 5123, 5125):
            raise _Skip("its indices are not unsigned integers")
        order = [r[0] for r in index_rows]
    else:
        order = list(range(count))
    if len(order) % 3:
        raise _Skip("its index count is not a multiple of 3")
    if order and max(order) >= count:
        raise _Skip("an index is out of range")

    names = sorted(decoded)  # a fixed order for the key
    remap: dict = {}
    first_of: list = []  # old vertex index that introduced each new vertex
    new_for_old: list = [0] * count
    for old in range(count):
        if old % 8192 == 0:
            _check_deadline(deadline)
        key = tuple(
            _key(
                decoded[name][0][old],
                decoded[name][1],
                POSITION_TOLERANCE if name == "POSITION" else ATTRIBUTE_TOLERANCE,
            )
            for name in names
        )
        found = remap.get(key)
        if found is None:
            found = len(first_of)
            remap[key] = found
            first_of.append(old)
        new_for_old[old] = found

    positions = decoded["POSITION"][0]
    kept: list = []
    dropped = 0
    for t in range(0, len(order), 3):
        if t % 12288 == 0:
            _check_deadline(deadline)
        a, b, c = (new_for_old[i] for i in order[t : t + 3])
        if a == b or b == c or a == c or not _area(
            positions[first_of[a]], positions[first_of[b]], positions[first_of[c]]
        ) > DEGENERATE_AREA:
            dropped += 1
            continue
        kept.extend((a, b, c))
    if not kept:
        raise _Skip("every triangle would be removed")
    vertices_removed = count - len(first_of)
    if vertices_removed == 0 and dropped == 0:
        return None
    # Only vertices a kept triangle still uses stay.
    used = sorted(set(kept))
    final = {old: new for new, old in enumerate(used)}
    kept = [final[i] for i in kept]
    return {
        "attributes": {
            name: ([decoded[name][0][first_of[i]] for i in used], decoded[name][1]) for name in names
        },
        "indices": kept,
        "vertices_removed": count - len(used),
        "triangles_removed": dropped,
    }


def _referenced_accessors(gltf: dict) -> list:
    out: list = []
    seen: set = set()

    def add(index: Any) -> None:
        if isinstance(index, int) and index not in seen:
            seen.add(index)
            out.append(index)

    for mesh in gltf.get("meshes") or []:
        for primitive in mesh.get("primitives") or []:
            for index in (primitive.get("attributes") or {}).values():
                add(index)
            add(primitive.get("indices"))
    return out


def weld_document(gltf: dict, buffers: list, deadline: float) -> dict:
    """Weld every primitive that can be, and return the new document.

    ``{"status": "welded"|"unchanged"|"skipped", "reason", "gltf", "bin",
    "vertices_removed", "triangles_removed", "primitives_changed", "primitives_skipped"}``.
    ``gltf`` and ``bin`` are only present for ``welded``.
    """
    if gltf.get("skins") or gltf.get("animations"):
        return {"status": "skipped", "reason": "it has skins or animations, which a weld would break"}
    if any(
        isinstance(p, dict) and p.get("targets")
        for mesh in gltf.get("meshes") or []
        for p in mesh.get("primitives") or []
    ):
        return {"status": "skipped", "reason": "it has morph targets, which a weld would break"}

    new = copy.deepcopy(gltf)
    accessors = new["accessors"]
    views = new.setdefault("bufferViews", [])
    appended_blobs: list = []  # (view index, bytes) for the new views, in order
    vertices_removed = triangles_removed = changed = skipped = 0
    skip_reasons: list = []

    for mesh in new.get("meshes") or []:
        for primitive in mesh.get("primitives") or []:
            try:
                result = _weld_primitive(gltf, buffers, primitive, deadline)
            except _Skip as why:
                skipped += 1
                if str(why) not in skip_reasons:
                    skip_reasons.append(str(why))
                continue
            if result is None:
                continue
            changed += 1
            vertices_removed += result["vertices_removed"]
            triangles_removed += result["triangles_removed"]
            new_attributes = {}
            for name, (rows, spec) in result["attributes"].items():
                data, stride = _encode(rows, spec, vertex=True)
                view = {"buffer": 0, "byteOffset": 0, "byteLength": len(data), "target": 34962}
                if stride:
                    view["byteStride"] = stride
                views.append(view)
                appended_blobs.append((len(views) - 1, data))
                accessor = {
                    "bufferView": len(views) - 1,
                    "componentType": spec["componentType"],
                    "count": len(rows),
                    "type": spec["type"],
                }
                if spec["normalized"]:
                    accessor["normalized"] = True
                if name == "POSITION":
                    accessor["min"] = [min(r[a] for r in rows) for a in range(3)]
                    accessor["max"] = [max(r[a] for r in rows) for a in range(3)]
                accessors.append(accessor)
                new_attributes[name] = len(accessors) - 1
            indices = result["indices"]
            # C-12: uint16 only when the largest index is below 65535.
            wide = max(indices) >= 65535
            data = struct.pack("<%d%s" % (len(indices), "I" if wide else "H"), *indices)
            views.append({"buffer": 0, "byteOffset": 0, "byteLength": len(data), "target": 34963})
            appended_blobs.append((len(views) - 1, data))
            accessors.append(
                {
                    "bufferView": len(views) - 1,
                    "componentType": 5125 if wide else 5123,
                    "count": len(indices),
                    "type": "SCALAR",
                }
            )
            primitive["attributes"] = new_attributes
            primitive["indices"] = len(accessors) - 1

    if changed == 0:
        return {
            "status": "unchanged",
            "reason": "nothing to weld" if skipped == 0 else "; ".join(skip_reasons),
            "primitives_skipped": skipped,
        }

    # Keep only what is still referenced, then compact the buffer.
    keep_accessors = _referenced_accessors(new)
    remap_accessor = {old: i for i, old in enumerate(keep_accessors)}
    needed_views: set = set()
    for old in keep_accessors:
        accessor = accessors[old]
        if "bufferView" in accessor:
            needed_views.add(accessor["bufferView"])
        sparse = accessor.get("sparse")
        if isinstance(sparse, dict):
            for part in ("indices", "values"):
                if isinstance(sparse.get(part), dict) and "bufferView" in sparse[part]:
                    needed_views.add(sparse[part]["bufferView"])
    for image in new.get("images") or []:
        if isinstance(image, dict) and "bufferView" in image:
            needed_views.add(image["bufferView"])
    appended = dict(appended_blobs)
    order = sorted(needed_views)
    remap_view = {old: i for i, old in enumerate(order)}
    blob = bytearray()
    final_views: list = []
    for old in order:
        view = copy.deepcopy(views[old])
        if old in appended:
            data = appended[old]
        else:
            source = buffers[view.get("buffer", 0)]
            start = view.get("byteOffset", 0)
            data = bytes(source[start : start + view["byteLength"]])
        blob += b"\x00" * ((-len(blob)) % 4)
        view["buffer"] = 0
        view["byteOffset"] = len(blob)
        view["byteLength"] = len(data)
        blob += data
        final_views.append(view)
    final_accessors = []
    for old in keep_accessors:
        accessor = copy.deepcopy(accessors[old])
        if "bufferView" in accessor:
            accessor["bufferView"] = remap_view[accessor["bufferView"]]
        sparse = accessor.get("sparse")
        if isinstance(sparse, dict):
            for part in ("indices", "values"):
                if isinstance(sparse.get(part), dict) and "bufferView" in sparse[part]:
                    sparse[part]["bufferView"] = remap_view[sparse[part]["bufferView"]]
        final_accessors.append(accessor)
    for mesh in new.get("meshes") or []:
        for primitive in mesh.get("primitives") or []:
            primitive["attributes"] = {k: remap_accessor[v] for k, v in primitive["attributes"].items()}
            if primitive.get("indices") is not None:
                primitive["indices"] = remap_accessor[primitive["indices"]]
    for image in new.get("images") or []:
        if isinstance(image, dict) and "bufferView" in image:
            image["bufferView"] = remap_view[image["bufferView"]]
    new["accessors"] = final_accessors
    new["bufferViews"] = final_views
    new["buffers"] = [{"byteLength": len(blob)}]
    return {
        "status": "welded",
        "gltf": new,
        "bin": bytes(blob),
        "vertices_removed": vertices_removed,
        "triangles_removed": triangles_removed,
        "primitives_changed": changed,
        "primitives_skipped": skipped,
        "reason": None if skipped == 0 else "; ".join(skip_reasons),
    }


def weld_asset(data: bytes, deadline: float) -> dict:
    """Weld a stored GLB. The result carries ``bytes`` (a new GLB that has been
    scanned and accepted) when ``status`` is ``welded``; the input is never changed."""
    scan = _glb.scan(data, source_format="glb", deadline=deadline)
    result = weld_document(scan.gltf, scan.buffers, deadline)
    if result["status"] != "welded":
        return result
    new_bytes = _glb.build_glb(result.pop("gltf"), [result.pop("bin")])
    # The output must pass the same scan an import does, or it is not stored.
    try:
        rescanned = _glb.scan(new_bytes, source_format="glb", deadline=deadline)
    except PlastisError as error:
        return {"status": "skipped", "reason": "the welded file did not pass the scan: %s" % error.message}
    result["bytes"] = new_bytes
    result["scan"] = rescanned
    result["drawable_before"] = scan.stats.get("drawable") is True
    return result
