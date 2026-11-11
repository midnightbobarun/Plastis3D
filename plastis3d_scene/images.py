"""Plastis3D — texture image import (PR15, correctness audit C-07 and C-08).

A material's texture map (``baseColorMap``, ``normalMap``,
``metallicRoughnessMap``, ``emissiveMap``) names an **image asset**: a PNG
or JPEG stored content-addressed as ``assets/<sha256>.png`` / ``.jpg`` and
listed in the scene's ``assets`` with ``format`` ``png`` or ``jpeg`` and
``stats.width`` / ``stats.height``.

Python cannot decode an image and does not try. :func:`inspect_image`
reads only the header (bounded: the PNG ``IHDR``, or the JPEG ``SOF``
marker) to prove the format and the pixel size **before** anything is
stored or decoded, so a small file that expands to a huge bitmap is refused
by size, not by running out of memory. Everything else a browser can decode
(interlacing, 16-bit PNGs, progressive JPEGs) is accepted. Refused, by
name: other formats (``IMPORT_FORMAT``), KTX2 (``IMPORT_COMPRESSED``), more
than 4096 pixels on a side or more than 16,777,216 pixels, or a file over
the byte-route limit (``IMPORT_TOO_LARGE`` / ``IMPORT_TOO_COMPLEX``).

Two doors, the same engine as a model import: a backend path (real path,
denylist, plugin-root refusal, inode re-check) or already-decoded upload
bytes. Both write the asset file atomically and then make **one** mutation
(``set_material_map``): attach the asset row if it is new, point the slot at
it. One revision, one undo entry; a refusal writes nothing.

Stdlib only.
"""

from __future__ import annotations

import hashlib
import struct
import time
import zlib
from pathlib import Path
from typing import Any, Optional

from . import mutate
from .glb import MAX_BYTE_ROUTE_BYTES
from .import_model import (
    IMPORT_TIMEOUT,
    MAX_ASSET_QUOTA_BYTES,
    _check_deadline,
    _read_source,
    _resolve_source_path,
)
from .spec import (
    ASSET_FILE_EXTENSIONS,
    MATERIAL_MAP_FIELDS,
    MAX_ASSETS,
    MAX_IMAGE_PIXELS,
    MAX_IMAGE_SIDE,
    PlastisError,
)
from .store import Store

# An image must be servable through the byte route, or the editor cannot draw
# it: the same measured limit a GLB has (~12 MiB).
MAX_IMAGE_BYTES = MAX_BYTE_ROUTE_BYTES

IMAGE_EXTENSIONS = {".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg"}
_IMAGE_EXTENSION_LIST = ".png, .jpg, .jpeg"

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_KTX2_SIGNATURE = b"\xabKTX 20\xbb\r\n\x1a\n"
_MIME = {"png": "image/png", "jpeg": "image/jpeg"}

# JPEG start-of-frame markers a browser decodes: baseline (C0), extended
# sequential (C1) and progressive (C2), all Huffman-coded. C3, C5-C7 (lossless
# and hierarchical) and C9-CF (arithmetic coding) are refused.
_JPEG_SOF_OK = (0xC0, 0xC1, 0xC2)
_JPEG_SOF_ALL = tuple(range(0xC0, 0xD0))
_JPEG_NOT_SOF = (0xC4, 0xC8, 0xCC)


def _fail(code: str, message: str) -> None:
    raise PlastisError(code, "%s: %s" % (code, message))


def mime_type(image_format: str) -> str:
    return _MIME[image_format]


def _check_size(width: int, height: int) -> None:
    if width < 1 or height < 1:
        _fail("IMPORT_FORMAT", "the image has a zero dimension")
    if width > MAX_IMAGE_SIDE or height > MAX_IMAGE_SIDE or width * height > MAX_IMAGE_PIXELS:
        _fail(
            "IMPORT_TOO_COMPLEX",
            "the image is %d x %d pixels; the limit is %d on a side and %d in all. "
            "Use the image picker's explicit upload resize when it fits the decode budget, or make it smaller in an image editor and pick it again."
            % (width, height, MAX_IMAGE_SIDE, MAX_IMAGE_PIXELS),
        )


def _inspect_png(data: bytes) -> tuple:
    if len(data) < 33:
        _fail("IMPORT_FORMAT", "the PNG file is too short to hold a header")
    length, kind = struct.unpack(">I4s", data[8:16])
    if kind != b"IHDR" or length != 13:
        _fail("IMPORT_FORMAT", "the PNG file does not start with an IHDR header")
    ihdr = data[16:29]
    (crc,) = struct.unpack(">I", data[29:33])
    if zlib.crc32(b"IHDR" + ihdr) & 0xFFFFFFFF != crc:
        _fail("IMPORT_FORMAT", "the PNG header is damaged")
    width, height, depth, color, compression, filtering, interlace = struct.unpack(
        ">IIBBBBB", ihdr
    )
    valid = {0: (1, 2, 4, 8, 16), 2: (8, 16), 3: (1, 2, 4, 8), 4: (8, 16), 6: (8, 16)}
    if depth not in valid.get(color, ()) or compression != 0 or filtering != 0 or interlace not in (0, 1):
        _fail("IMPORT_FORMAT", "the PNG header names a combination PNG does not allow")
    return width, height


def _inspect_jpeg(data: bytes) -> tuple:
    position = 2
    end = len(data)
    while position + 4 <= end:
        if data[position] != 0xFF:
            _fail("IMPORT_FORMAT", "the JPEG file has a damaged marker")
        marker = data[position + 1]
        position += 2
        if marker == 0xFF:  # fill byte
            position -= 1
            continue
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:  # no length
            continue
        if marker == 0xD9 or marker == 0xDA:  # end of image / scan before any frame header
            break
        if position + 2 > end:
            break
        (segment,) = struct.unpack(">H", data[position : position + 2])
        if segment < 2 or position + segment > end:
            _fail("IMPORT_FORMAT", "the JPEG file is truncated inside a header segment")
        if marker in _JPEG_SOF_ALL and marker not in _JPEG_NOT_SOF:
            if marker not in _JPEG_SOF_OK:
                _fail(
                    "IMPORT_FORMAT",
                    "this JPEG uses lossless, hierarchical or arithmetic coding, which browsers do not decode",
                )
            if segment < 8:
                _fail("IMPORT_FORMAT", "the JPEG frame header is too short")
            precision, height, width, components = struct.unpack(
                ">BHHB", data[position + 2 : position + 8]
            )
            if precision != 8 or components not in (1, 3):
                _fail(
                    "IMPORT_FORMAT",
                    "this JPEG is not 8-bit grey or colour (CMYK and similar are not supported)",
                )
            return width, height
        position += segment
    _fail("IMPORT_FORMAT", "the JPEG file has no frame header")
    raise AssertionError("unreachable")


def read_header(data: bytes) -> tuple:
    """``(format, width, height)`` from a PNG or JPEG header, with no size
    budget applied (the compatibility report uses it on images already
    stored). Raises :class:`PlastisError` for a file that is neither."""
    if data.startswith(_PNG_SIGNATURE):
        width, height = _inspect_png(data)
        return "png", width, height
    if data.startswith(b"\xff\xd8"):
        width, height = _inspect_jpeg(data)
        return "jpeg", width, height
    _fail("IMPORT_FORMAT", "only PNG and JPEG images are read for textures")
    raise AssertionError("unreachable")


def inspect_image(data: bytes) -> dict:
    """``{"format": "png"|"jpeg", "width": int, "height": int}`` from the header.

    Raises :class:`PlastisError` with a stable import code on any refusal.
    Reads at most the first segments of the file; never decodes pixels.
    """
    if data.startswith(_KTX2_SIGNATURE):
        _fail(
            "IMPORT_COMPRESSED",
            "KTX2 textures are not supported. Export the texture as a PNG or JPEG.",
        )
    if data.startswith(_PNG_SIGNATURE):
        image_format = "png"
        width, height = _inspect_png(data)
    elif data.startswith(b"\xff\xd8"):
        image_format = "jpeg"
        width, height = _inspect_jpeg(data)
    else:
        _fail("IMPORT_FORMAT", "only PNG and JPEG images are read for textures")
        raise AssertionError("unreachable")
    _check_size(width, height)
    return {"format": image_format, "width": width, "height": height}


def build_asset_row(data: bytes, *, original_name: str) -> dict:
    """The scene ``assets`` row for an image (and refuses what is not one)."""
    info = inspect_image(data)
    if len(data) > MAX_IMAGE_BYTES:
        _fail(
            "IMPORT_TOO_LARGE",
            "the image is %d bytes; the limit is %d (about 12 MB). Save it at a smaller size "
            "or as a JPEG." % (len(data), MAX_IMAGE_BYTES),
        )
    sha = hashlib.sha256(data).hexdigest()
    return {
        "id": sha,
        "sha256": sha,
        "file": "assets/%s%s" % (sha, ASSET_FILE_EXTENSIONS[info["format"]]),
        "format": info["format"],
        "bytes": len(data),
        "originalName": original_name,
        "sourceFormat": info["format"],
        "stats": {"width": info["width"], "height": info["height"]},
    }


def import_image_bytes(
    scene_id: str,
    store: Store,
    data: bytes,
    *,
    original_name: str,
    base_revision: int,
    material_id: str,
    slot: str,
    timeout: float = IMPORT_TIMEOUT,
) -> dict:
    """Attach already-read image bytes as ``slot`` of ``material_id``.

    Returns the feedback envelope. Raises :class:`PlastisError` on any
    refusal, writing nothing (no asset file, no asset row, no scene change).
    """
    deadline = time.monotonic() + timeout
    _check_deadline(deadline)
    if slot not in MATERIAL_MAP_FIELDS:
        _fail("SPEC_INVALID", "slot must be one of %s" % (list(MATERIAL_MAP_FIELDS),))
    if not isinstance(material_id, str) or not material_id:
        _fail("SPEC_INVALID", "materialId must be a non-empty string")
    if not isinstance(original_name, str) or not original_name:
        _fail("SPEC_INVALID", "originalName must be a non-empty string")
    asset = build_asset_row(data, original_name=original_name)
    _check_deadline(deadline)

    from .asset_facts import enrich_legacy_uvs
    scene = enrich_legacy_uvs(store.get_scene(scene_id), store, deadline=deadline)
    if not any(m.get("id") == material_id for m in scene.get("materials", [])):
        raise PlastisError(
            "MATERIAL_NOT_FOUND", "MATERIAL_NOT_FOUND: no material with id %r" % material_id
        )
    existing = next((a for a in scene.get("assets", []) if a.get("id") == asset["id"]), None)
    if existing is None:
        if len(scene.get("assets", [])) >= MAX_ASSETS:
            _fail("LIMIT_ASSETS", "the scene already has %d assets, the %d-asset cap" % (len(scene["assets"]), MAX_ASSETS))


    # Prove the whole post-import document (the part-UV rule, the decoded
    # texture budget) before any file is written.
    candidate = mutate.apply_set_material_map(scene, material_id, slot, asset)
    mutate.validate_scene(candidate)
    _check_deadline(deadline)

    from .asset_transactions import AssetOperation
    with AssetOperation(store, files={Path(asset["file"]).name: data}, quota=MAX_ASSET_QUOTA_BYTES):
        return mutate.apply(
            scene_id, base_revision,
            {"op": "set_material_map", "materialId": material_id, "slot": slot, "asset": asset}, store=store,
        )



def import_image_path(
    scene_id: str,
    store: Store,
    path: str,
    *,
    base_revision: int,
    material_id: str,
    slot: str,
    timeout: float = IMPORT_TIMEOUT,
) -> dict:
    """Attach an image file from a backend path (the Webapp's door)."""
    deadline = time.monotonic() + timeout
    _check_deadline(deadline)
    real_path, _format, remembered = _resolve_source_path(
        path, allowed=IMAGE_EXTENSIONS, allowed_list=_IMAGE_EXTENSION_LIST
    )
    data, _sha = _read_source(real_path, remembered, deadline, max_bytes=MAX_IMAGE_BYTES)
    return import_image_bytes(
        scene_id,
        store,
        data,
        original_name=real_path.name,
        base_revision=base_revision,
        material_id=material_id,
        slot=slot,
        timeout=max(0.0, deadline - time.monotonic()),
    )
