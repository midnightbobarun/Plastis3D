"""Plastis3D — the correlated screenshot protocol (PR22, C-10).

The agent tool ``plastis3d_screenshot`` asks an open scene surface (the
Desktop/Webapp editor or viewport pane) for a PNG of the scene. Several
surfaces may be open at once (panes, windows, two profiles on one gateway,
the same scene id in two places), so a bare broadcast is not enough: the
first reply could show the wrong scene or revision.

The protocol, all of it kept on disk under the profile's data directory so
it works across processes (the agent tool may run in a cron process that is
not the gateway; a Python module global would not be shared):

1. The tool creates a request: an unguessable id bound to the profile (the
   data directory itself), the scene id and the scene's current revision.
   It expires after ``REQUEST_TTL`` seconds and is single-use.
2. Surfaces learn of it by the ``capture.requested`` broadcast or by
   polling ``GET /captures/pending``. A surface that can draw that scene
   *claims* it (``POST /captures/{id}/claim`` with its own surface id).
   Exactly one claim wins; the others get ``CAPTURE_CONFLICT`` and do
   nothing. A claim lapses after ``CLAIM_TTL`` seconds so a dead surface
   cannot block the request.
3. The winner posts the PNG (``POST /captures/{id}``). The gateway checks
   the id, the claimant, expiry, the revision (never older than the
   request), the PNG signature and size, and the byte cap, then stores the
   file under ``screenshots/``. Duplicate or late replies change nothing.
4. The tool waits, boundedly, for the result. With no surface answering it
   returns ``DESKTOP_UNAVAILABLE`` instead of hanging.

Only the plugin's own canvas is ever captured; nothing from the host or the
chat. Stdlib only. Python 3.11-compatible.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import struct
import time
from pathlib import Path
from typing import Any, Optional

from .spec import PlastisError
from .store import Store, _SceneLock

# A request lives this long, and the tool never waits longer than the
# bound. Short enough that a cron job is never held up for long.
REQUEST_TTL = 20.0
DEFAULT_WAIT = 12.0
MAX_WAIT = 25.0
CLAIM_TTL = 6.0
POLL_INTERVAL = 0.15

MAX_PNG_BYTES = 6 * 1024 * 1024
MIN_EDGE = 16
MAX_EDGE = 4096
KEEP_PER_SCENE = 20

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_SURFACE_RE = re.compile(r"^[A-Za-z0-9_-]{4,64}$")
_SCENE_RE = re.compile(r"^[a-z0-9-]{1,64}$")


def captures_dir(store: Store) -> Path:
    path = store.data_dir / "captures"
    path.mkdir(parents=True, exist_ok=True)
    return path


def screenshots_dir(store: Store) -> Path:
    path = store.data_dir / "screenshots"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _request_path(store: Store, request_id: str) -> Path:
    if not isinstance(request_id, str) or not _ID_RE.match(request_id):
        raise PlastisError("CAPTURE_NOT_FOUND", "no such capture request")
    return captures_dir(store) / ("%s.json" % request_id)


def _read(path: Path) -> Optional[dict]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _write(path: Path, request: dict) -> None:
    Store._atomic_write(path, json.dumps(request, sort_keys=True, separators=(",", ":")).encode("utf-8"))


def _public(request: dict) -> dict:
    """The part of a request a surface may see."""
    return {
        "id": request["id"],
        "scene": request["scene"],
        "revision": request["revision"],
        "expiresIn": max(0.0, round(request["expiresAt"] - time.time(), 2)),
    }


def _live(request: dict, now: float) -> bool:
    return request["status"] in ("pending", "claimed") and request["expiresAt"] > now


def _prune(store: Store, now: float) -> None:
    """Drop request files an hour past their expiry (best effort)."""
    for path in captures_dir(store).glob("*.json"):
        request = _read(path)
        if request is None or request.get("expiresAt", 0) < now - 3600:
            try:
                path.unlink()
            except OSError:
                pass
            try:
                path.with_suffix(".lock").unlink()
            except OSError:
                pass


def create_request(store: Store, scene_id: str, revision: int, now: Optional[float] = None) -> dict:
    now = time.time() if now is None else now
    _prune(store, now)
    request = {
        "id": secrets.token_hex(16),
        "scene": scene_id,
        "revision": revision,
        "status": "pending",
        "createdAt": now,
        "expiresAt": now + REQUEST_TTL,
        "surface": None,
        "claimedAt": None,
    }
    _write(_request_path(store, request["id"]), request)
    return request


def pending_requests(store: Store, scene_id: Optional[str] = None, now: Optional[float] = None) -> list:
    """Requests a surface may still claim (pending, or a lapsed claim)."""
    now = time.time() if now is None else now
    found = []
    for path in captures_dir(store).glob("*.json"):
        request = _read(path)
        if request is None or not _live(request, now):
            continue
        if scene_id is not None and request["scene"] != scene_id:
            continue
        if request["status"] == "claimed" and now - (request["claimedAt"] or 0) < CLAIM_TTL:
            continue
        found.append(_public(request))
    found.sort(key=lambda item: item["id"])
    return found


def _check_surface(surface: Any) -> str:
    if not isinstance(surface, str) or not _SURFACE_RE.match(surface):
        raise PlastisError("CAPTURE_INVALID", "surface id is missing or malformed", path="/surface")
    return surface


def claim(store: Store, request_id: str, surface: Any, now: Optional[float] = None) -> dict:
    """One surface wins the request; any other claimant is refused."""
    now = time.time() if now is None else now
    surface = _check_surface(surface)
    path = _request_path(store, request_id)
    with _SceneLock(path.with_suffix(".lock")):
        request = _read(path)
        if request is None or not _live(request, now):
            raise PlastisError("CAPTURE_NOT_FOUND", "the capture request has expired or was already answered")
        if request["status"] == "claimed" and request["surface"] != surface and now - (request["claimedAt"] or 0) < CLAIM_TTL:
            raise PlastisError("CAPTURE_CONFLICT", "another surface already claimed this capture request")
        request["status"] = "claimed"
        request["surface"] = surface
        request["claimedAt"] = now
        _write(path, request)
    return _public(request)


def png_dimensions(data: bytes) -> tuple:
    """Validate PNG framing and return ``(width, height)``."""
    if len(data) < 45 or not data.startswith(_PNG_SIGNATURE):
        raise PlastisError("CAPTURE_INVALID", "the screenshot is not a PNG file")
    length, kind = struct.unpack(">I4s", data[8:16])
    if kind != b"IHDR" or length != 13:
        raise PlastisError("CAPTURE_INVALID", "the PNG has no header chunk")
    width, height = struct.unpack(">II", data[16:24])
    if not data.endswith(b"IEND\xaeB`\x82"):
        raise PlastisError("CAPTURE_INVALID", "the PNG is truncated")
    if not (MIN_EDGE <= width <= MAX_EDGE and MIN_EDGE <= height <= MAX_EDGE):
        raise PlastisError(
            "CAPTURE_INVALID",
            "the screenshot must be between %d and %d pixels on each side" % (MIN_EDGE, MAX_EDGE),
        )
    return width, height


def submit(
    store: Store,
    request_id: str,
    surface: Any,
    revision: Any,
    png: bytes,
    now: Optional[float] = None,
) -> dict:
    """Store the claimant's PNG. A second or late reply is refused."""
    now = time.time() if now is None else now
    surface = _check_surface(surface)
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 0:
        raise PlastisError("CAPTURE_INVALID", "revision must be a non-negative integer", path="/revision")
    if len(png) > MAX_PNG_BYTES:
        raise PlastisError("CAPTURE_TOO_LARGE", "the screenshot is larger than %d bytes" % MAX_PNG_BYTES)
    width, height = png_dimensions(png)
    path = _request_path(store, request_id)
    with _SceneLock(path.with_suffix(".lock")):
        request = _read(path)
        if request is None or request["status"] not in ("claimed",) or request["expiresAt"] <= now:
            raise PlastisError("CAPTURE_NOT_FOUND", "the capture request has expired or was already answered")
        if request["surface"] != surface:
            raise PlastisError("CAPTURE_CONFLICT", "this capture request was claimed by another surface")
        if revision < request["revision"]:
            raise PlastisError(
                "CAPTURE_STALE",
                "the surface drew revision %d but revision %d was requested" % (revision, request["revision"]),
            )
        filename = "%s-r%d-%s.png" % (request["scene"], revision, request["id"][:8])
        dest = screenshots_dir(store) / filename
        Store._atomic_write(dest, png)
        request.update(
            {
                "status": "done",
                "capturedRevision": revision,
                "filename": filename,
                "width": width,
                "height": height,
                "bytes": len(png),
            }
        )
        _write(path, request)
    prune_screenshots(store, request["scene"], keep=dest)
    return {"ok": True, "filename": filename, "revision": revision, "width": width, "height": height, "bytes": len(png)}


def prune_screenshots(store: Store, scene_id: str, keep: Optional[Path] = None) -> None:
    """Keep the newest ``KEEP_PER_SCENE`` screenshots of a scene."""
    pattern = re.compile(re.escape(scene_id) + r"-r[0-9]+-[0-9a-f]{8}\.png\Z")
    files = []
    for path in screenshots_dir(store).iterdir():
        if pattern.fullmatch(path.name):
            try:
                files.append((path.stat().st_mtime, path))
            except OSError:
                pass
    files.sort(key=lambda item: item[0], reverse=True)
    for _, path in files[KEEP_PER_SCENE:]:
        if path != keep:
            try:
                path.unlink()
            except OSError:
                pass


def delete_screenshots(store: Store, scene_id: str) -> None:
    pattern = re.compile(re.escape(scene_id) + r"-r[0-9]+-[0-9a-f]{8}\.png\Z")
    for path in screenshots_dir(store).iterdir():
        if pattern.fullmatch(path.name):
            try:
                path.unlink()
            except OSError:
                pass


def wait_for_result(store: Store, request_id: str, wait: float = DEFAULT_WAIT) -> dict:
    """Block, boundedly, until the request is answered.

    Raises ``DESKTOP_UNAVAILABLE`` when nothing answers in time. The
    request is expired on the way out so a late reply is refused.
    """
    wait = max(0.0, min(float(wait), MAX_WAIT))
    path = _request_path(store, request_id)
    deadline = time.monotonic() + wait
    while True:
        request = _read(path)
        if request is not None and request["status"] == "done":
            return request
        if time.monotonic() >= deadline:
            break
        time.sleep(POLL_INTERVAL)
    with _SceneLock(path.with_suffix(".lock")):
        request = _read(path)
        if request is not None and request["status"] == "done":
            return request
        claimed = request is not None and request["status"] == "claimed"
        if request is not None:
            request["status"] = "expired"
            request["expiresAt"] = 0
            _write(path, request)
    raise PlastisError(
        "DESKTOP_UNAVAILABLE",
        "no open Plastis3D scene view answered in time"
        + (" (a view claimed the request but did not finish)" if claimed else "")
        + ". Open the scene in Hermes Desktop or the Webapp, keep its pane visible, and try again.",
    )


def screenshot(store: Store, scene: dict, wait: float = DEFAULT_WAIT, announce: Any = None) -> dict:
    """The tool body: request, announce, wait, return the stored file."""
    request = create_request(store, scene["id"], scene["revision"])
    if announce is not None:
        announce({"id": request["id"], "scene": request["scene"], "revision": request["revision"]})
    done = wait_for_result(store, request["id"], wait)
    path = screenshots_dir(store) / done["filename"]
    return {
        "ok": True,
        "path": str(path),
        "filename": done["filename"],
        "revision": done["capturedRevision"],
        "requestedRevision": request["revision"],
        "width": done["width"],
        "height": done["height"],
        "bytes": done["bytes"],
    }
