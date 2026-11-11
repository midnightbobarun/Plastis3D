"""Plastis3D — gateway REST API (PR3, Stage 2).

Mounted by the dashboard host at ``/api/plugins/plastis3d`` (the host reads
the module-level ``router`` and mounts it with that prefix, with the
``_plugin_route_secret_scope`` dependency — see
``hermes_cli/web_server_dashboard.py``).

Decision 9, gateway half: this file is loaded standalone as
``hermes_dashboard_plugin_<id>`` with no package context and no ``sys.path``
entry, so ``import plastis3d_scene`` fails here unless this module makes the
package importable itself. It computes the plugin root from ``__file__``
and inserts it into ``sys.path`` before importing. The agent half
(``__init__.py``) uses a relative import instead. PR3 confirms
``plastis3d_scene.mutate.apply()`` from both halves (the PR1 probe only
covered the trivial ``ping()``).

Routes:

* ``GET /health`` — ``{"ok": true, "schema": 3}``.
* ``GET /scenes`` — list scenes ``[{id, name, revision, updatedAt}]``.
* ``POST /scenes`` — create a scene (``{"name": ...}``, optional ``"id"``);
  the new scene starts with the default rig at revision 1.
* ``GET /scenes/{id}`` — the feedback envelope (spec without history
  stacks, plus stats). No mesh bytes.
* ``PATCH /scenes/{id}`` — batch ops (max 32), one history entry, one
  revision bump; body ``{"baseRevision": N, "ops": [...]}``.
* ``DELETE /scenes/{id}`` — delete the scene JSON. Assets remain.
* ``POST /scenes/{id}/export`` — PR6 body + PR8 splice: writes
  ``exports/<id>/<scene name>.glb`` and returns ``{ok, path, bytes,
  revision, stats, filename}``. Refusals write nothing:
  ``EXPORT_EMPTY`` 400 (no meshes, no models/parts), ``EXPORT_FAILED``
  400 (clips or texture maps the writer cannot represent, or a splice
  refusal — sparse accessor, non-TRIANGLES mode, a skin, clip or
  morph reference outside the copied subtree, a part of a skinned or
  morphing mesh, a non-empty ``extensionsRequired``, a node-level
  extension, an ``extensionsUsed`` name not on copied material/texture
  JSON, an index outside the copied set, or a missing asset file),
  ``EXPORT_TIMEOUT`` 408.
* ``POST /scenes/{id}/imports`` — PR7 body: imports a GLB/glTF file
  into the scene and returns the feedback envelope. Body
  ``{"baseRevision": N, "backendPath": "<absolute path>"}`` (agent
  door: read off disk, 256 MiB per-file cap) or
  ``{"baseRevision": N, "upload": {"filename", "contentType",
  "bytes": "<base64>"}}`` (dialog door: the base64 JSON envelope of
  decisions D1/D2). Optional ``name`` / ``parent`` / ``transform`` /
  ``explode`` (default true). Uploads are capped at 16 MiB of JSON
  body (413 above that — the largest ``ctx.rest`` upload PR1 measured
  round-tripping); a JSON ``backendPath`` body is not an upload and is
  not capped here.
* ``GET /assets/{sha256}`` — PR7 body: returns the asset GLB as the
  base64 JSON envelope ``{ok, sha256, size, bytes}`` (D1 — ``ctx.rest``
  JSON-parses every response, so raw bytes cannot travel this door).
  404 for an unknown hash, 400 for a malformed one, 413
  ``ASSET_TOO_LARGE`` when the asset exceeds the ~12 MiB byte-route
  limit (D3): the asset stays importable and editable, only the
  preview bytes cannot be served.

* ``POST /scenes/{id}/bakes`` — PR24 (D-EXT-03). Body ``{baseRevision, nodeId,
  mesh: {positions, normals?, uvs?, colors?, indices}, generator?, name?}`` with
  base64 little-endian arrays (16 MiB JSON body cap). Writes the GLB, stores the
  asset and repoints the node as a ``part`` in one revision and one history
  entry, sweeping asset rows nothing reaches. ``BAKE_INVALID`` 400,
  ``BAKE_TOO_LARGE`` 413, ``NODE_LOCKED`` 409, ``LIMIT_ASSETS`` 413,
  ``REVISION_CONFLICT`` 409.
* ``GET /scenes/{id}/library`` — PR14. The scene's models and images, which are used,
  and what "Remove unused" would free. ``POST /scenes/{id}/library/remove-unused`` —
  ``{baseRevision, dryRun?}``: drops the unused rows in one undoable revision.
* ``PUT|GET /scenes/{id}/thumbnail`` — PR14. ``{revision, png: "<base64>"}`` (at most
  512 KB, 512 px a side); GET returns it. ``GET /scenes`` carries ``thumbnailRevision``.
* ``PUT|GET|DELETE /scenes/{id}/drafts/{nodeId}`` — PR24 (D-EXT-07). One crash-safe
  unsaved-edit draft slot per node, outside the scene and its history.
* ``GET /captures/pending`` — PR22 (C-10): the screenshot requests a
  scene view may still claim, ``{ok, requests: [{id, scene, revision,
  expiresIn}]}``; optional ``?scene=<id>``.
* ``POST /captures/{id}/claim`` — body ``{"surface": "<surface id>"}``.
  One surface wins a request; another gets ``CAPTURE_CONFLICT`` 409.
* ``POST /captures/{id}`` — body ``{"surface", "revision", "png":
  "<base64>"}``. Stores the PNG for the claimant; late, duplicate or
  foreign replies get ``CAPTURE_NOT_FOUND`` 404 / ``CAPTURE_CONFLICT``
  409 / ``CAPTURE_STALE`` 409 and change nothing.

Error mapping (standalone-editor.md, HTTP API table): ``SPEC_INVALID``
400, ``SCHEMA_NEWER`` 400, ``SCENE_NOT_FOUND`` / unknown asset hash 404,
``SCENE_EXISTS`` / ``REVISION_CONFLICT`` 409, ``STORE_BUSY`` 423,
``LIMIT_*`` / too large 413, ``IMPORT_NOT_FOUND`` 404,
``IMPORT_PATH_DENIED`` 403, ``IMPORT_FORMAT`` / ``IMPORT_COMPRESSED`` /
``IMPORT_EXTERNAL_BUFFER`` / ``IMPORT_TOO_COMPLEX`` 400,
``IMPORT_TIMEOUT`` 408, ``ASSET_TOO_LARGE`` 413,
``EXPORT_FAILED`` / ``EXPORT_EMPTY`` 400, ``EXPORT_TIMEOUT`` 408,
``NOT_IMPLEMENTED`` 501. (``EXPORT_IMPORT_UNMERGED`` 409 stays in
``spec.ERROR_HTTP_STATUS`` for compatibility but is no longer raised
by export since the PR8 splice.) The body always carries the stable
``code`` (``{"ok": false, "code", "message", ...}``).

Profile scoping (stage-2 §4.5): the store directory resolves per
request from ``PLASTIS3D_DATA_DIR`` / the host's per-request Hermes
home / ``HERMES_HOME`` / ``~/.hermes`` (see
``plastis3d_scene.store.resolve_data_dir``). The host enters the
requesting profile's scope before the handler runs, so two profiles
served by one gateway read different scene namespaces and no
process-global state leaks between them. Residual gap, recorded not
faked: no ``connectionId`` reaches the backend (``sourceKey`` is a
desktop-side key); isolation is by profile home, so two connections
to the same profile share that profile's namespace.

Stdlib + FastAPI only. Python 3.11-compatible.
"""

from __future__ import annotations

import base64
import binascii
import json
import sys
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

# --- Decision 9: standalone import of plastis3d_scene -----------------------
# The host never puts the plugin directory on sys.path, so resolve the
# plugin root from this file's own location and add it.
_PLUGIN_ROOT = Path(__file__).resolve().parent.parent
if str(_PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_ROOT))

from plastis3d_scene import bake as _bake  # noqa: E402
from plastis3d_scene import capture as _capture  # noqa: E402
from plastis3d_scene import drafts as _drafts  # noqa: E402
from plastis3d_scene import generators as _generators  # noqa: E402
from plastis3d_scene import library as _library  # noqa: E402
from plastis3d_scene import mutate as _mutate  # noqa: E402
from plastis3d_scene import ping as _scene_ping  # noqa: E402
from plastis3d_scene.export_glb import export_scene as _export_scene  # noqa: E402
from plastis3d_scene.glb import MAX_BYTE_ROUTE_BYTES as _MAX_BYTE_ROUTE_BYTES  # noqa: E402
from plastis3d_scene.import_model import import_bytes as _import_bytes  # noqa: E402
from plastis3d_scene.import_model import import_path as _import_path  # noqa: E402
from plastis3d_scene.images import import_image_bytes as _import_image_bytes  # noqa: E402
from plastis3d_scene.images import import_image_path as _import_image_path  # noqa: E402
from plastis3d_scene.images import mime_type as _image_mime  # noqa: E402
from plastis3d_scene.spec import PlastisError, SHA256_RE, http_status_for  # noqa: E402
from plastis3d_scene.store import Store  # noqa: E402

# Prove the standalone import at load time; the probe result is kept for
# tests to assert on. A failed import here must fail loudly, not silently
# degrade, so this runs unconditionally at module import.
_SCENE_PROBE = _scene_ping()
# PR3: the mutation core is reachable from the gateway half too.
_MUTATE_APPLY = _mutate.apply

# Largest upload this route accepts (16 MiB): the largest ctx.rest upload
# PR1 measured round-tripping (pr1-report-2026-11-06.md §4.8). A larger
# upload is 413 IMPORT_TOO_LARGE. Backend-path imports (a JSON body
# naming a path) are not uploads and are not capped here; the 256 MiB
# single-asset cap applies when the PR7 body lands.
_MAX_UPLOAD_BYTES = 16 * 1024 * 1024

router = APIRouter()


_UPLOAD_FORMATS = {
    ".splat": "splat",
    ".glb": "glb",
    ".gltf": "gltf",
    ".obj": "obj",
    ".stl": "stl",
    ".ply": "ply",
}


def _decode_sidecars(raw) -> dict:
    """``upload.sidecars`` (``[{filename, bytes}]``, base64) -> ``{name: bytes}``.

    Used for an OBJ's ``.mtl``. The names are matched by bare file name
    inside the engine; nothing here touches the filesystem.
    """
    if raw is None:
        return {}
    if not isinstance(raw, list):
        raise PlastisError(
            "SPEC_INVALID", "upload.sidecars must be a list", path="/upload/sidecars"
        )
    out = {}
    for item in raw:
        if (
            not isinstance(item, dict)
            or not isinstance(item.get("filename"), str)
            or not isinstance(item.get("bytes"), str)
        ):
            raise PlastisError(
                "SPEC_INVALID",
                "each sidecar needs a filename and base64 bytes",
                path="/upload/sidecars",
            )
        try:
            out[item["filename"]] = base64.b64decode(
                "".join(item["bytes"].split()), validate=True
            )
        except (binascii.Error, ValueError):
            raise PlastisError(
                "SPEC_INVALID",
                "a sidecar's bytes are not valid base64",
                path="/upload/sidecars",
            ) from None
    return out


def _store() -> Store:
    """A Store for this request (directory resolved from the environment
    and, when the host set it, the requesting profile's Hermes home)."""
    return Store()


def _error_response(error: PlastisError) -> JSONResponse:
    return JSONResponse(
        status_code=http_status_for(error.code), content=error.to_dict()
    )


async def _json_body(request: Request) -> dict:
    """Parse a JSON object body, or raise SPEC_INVALID."""
    try:
        body = await request.json()
    except Exception:
        raise PlastisError(
            "SPEC_INVALID", "request body must be a JSON object", path=""
        )
    if not isinstance(body, dict):
        raise PlastisError(
            "SPEC_INVALID", "request body must be a JSON object", path=""
        )
    return body


@router.get("/health")
def health() -> JSONResponse:
    """Liveness probe used by the Desktop empty state."""
    return JSONResponse({"ok": True, "schema": 3})


@router.get("/scenes")
def list_scenes() -> JSONResponse:
    """List scenes: ``[{id, name, revision, updatedAt}]``."""
    try:
        scenes = _store().list_scenes()
    except PlastisError as error:
        return _error_response(error)
    for scene in scenes:
        scene["thumbnailRevision"] = _library.thumbnail_revision(_store(), scene["id"])
    return JSONResponse({"ok": True, "scenes": scenes})


@router.post("/scenes")
async def create_scene(request: Request) -> JSONResponse:
    """Create a scene with the default rig. Body: ``{"name": ..., "id"?}``."""
    try:
        body = await _json_body(request)
        if body.get("copyFrom") is not None:
            store = _store()
            scene = store.create_scene(body.get("name"), scene_id=body.get("id"), copy_from=body["copyFrom"])
            return JSONResponse(status_code=201, content=store.envelope(scene))
        envelope = _mutate.apply(
            None,
            None,
            {"op": "create", "name": body.get("name"), "id": body.get("id")},
            store=_store(),
        )
    except PlastisError as error:
        return _error_response(error)
    return JSONResponse(status_code=201, content=envelope)


@router.get("/scenes/{scene_id}")
def get_scene(scene_id: str) -> JSONResponse:
    """One scene as a feedback envelope (no history stacks, no mesh bytes)."""
    store = _store()
    try:
        scene = store.get_scene(scene_id)
    except PlastisError as error:
        return _error_response(error)
    from plastis3d_scene.asset_facts import enrich_legacy_uvs
    return JSONResponse(store.envelope(enrich_legacy_uvs(scene, store)))


@router.patch("/scenes/{scene_id}")
async def patch_scene(scene_id: str, request: Request) -> JSONResponse:
    """Execute batch ops (max 32) with ``baseRevision``.

    One history entry, one revision bump. Body:
    ``{"baseRevision": N, "ops": [...]}``. 409 on REVISION_CONFLICT
    (body includes ``currentRevision``).
    """
    try:
        body = await _json_body(request)
        envelope = _mutate.apply_patch(
            scene_id,
            body.get("baseRevision"),
            body.get("ops"),
            store=_store(),
        )
    except PlastisError as error:
        return _error_response(error)
    return JSONResponse(envelope)


@router.delete("/scenes/{scene_id}")
def delete_scene(scene_id: str, baseRevision: int = None) -> JSONResponse:
    """Delete a scene file. Assets remain."""
    store = _store()
    try:
        store.delete_scene(scene_id, baseRevision)
    except PlastisError as error:
        return _error_response(error)
    return JSONResponse({"ok": True, "deleted": scene_id})


@router.post("/scenes/{scene_id}/export")
def export_scene(scene_id: str) -> JSONResponse:
    """Export the scene to GLB (PR6 body).

    Writes ``exports/<id>/<scene name>.glb`` and returns ``{ok, path,
    bytes, revision, stats, filename}``. Export does not mutate the
    scene. Refusals write nothing under ``exports/``.
    """
    store = _store()
    try:
        scene = store.get_scene(scene_id)
        return JSONResponse(_export_scene(scene, store))
    except PlastisError as error:
        return _error_response(error)


@router.post("/scenes/{scene_id}/imports")
async def import_scene(scene_id: str, request: Request) -> JSONResponse:
    """Import a GLB/glTF file into a scene (PR7 body).

    Body (JSON object, always with ``baseRevision``):

    * ``{"backendPath": "<absolute path>"}`` — the agent door: the
      file is read off the backend disk (256 MiB per-file cap).
    * ``{"upload": {"filename", "contentType", "bytes": "<base64>"}}``
      — the dialog door: base64 inside JSON (D1). The whole JSON body
      is capped at 16 MiB (413 above that — the largest ``ctx.rest``
      upload PR1 measured round-tripping), which bounds the decoded
      file to ~12 MiB (D2).

    Optional ``name`` / ``parent`` / ``transform`` / ``explode``
    (default true). Returns the feedback envelope. Refusals write
    nothing: no asset file, no asset row, no scene change.
    """
    content_type = (request.headers.get("content-type") or "").lower()
    if "application/json" not in content_type:
        length = request.headers.get("content-length")
        try:
            size = int(length) if length is not None else None
        except ValueError:
            size = None
        if size is not None and size > _MAX_UPLOAD_BYTES:
            return _error_response(
                PlastisError(
                    "IMPORT_TOO_LARGE",
                    "upload of %d bytes exceeds the 16 MiB import upload cap"
                    % size,
                )
            )
        # Read (and discard) the upload body up to the cap so an
        # oversized body without a Content-Length still 413s.
        read = 0
        async for chunk in request.stream():
            read += len(chunk)
            if read > _MAX_UPLOAD_BYTES:
                return _error_response(
                    PlastisError(
                        "IMPORT_TOO_LARGE",
                        "upload exceeds the 16 MiB import upload cap",
                    )
                )
        return _error_response(
            PlastisError(
                "SPEC_INVALID",
                "request body must be a JSON object",
                path="",
            )
        )
    # JSON body: stream-read with the 16 MiB cap, so an oversized
    # upload 413s without buffering an unbounded body.
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > _MAX_UPLOAD_BYTES:
            return _error_response(
                PlastisError(
                    "IMPORT_TOO_LARGE",
                    "upload JSON body exceeds the 16 MiB import upload cap",
                )
            )
    try:
        body = json.loads(bytes(raw).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return _error_response(
            PlastisError("SPEC_INVALID", "request body must be a JSON object", path="")
        )
    if not isinstance(body, dict):
        return _error_response(
            PlastisError("SPEC_INVALID", "request body must be a JSON object", path="")
        )
    store = _store()
    try:
        store.get_scene(scene_id)
    except PlastisError as error:
        return _error_response(error)
    base_revision = body.get("baseRevision")
    if not isinstance(base_revision, int) or isinstance(base_revision, bool):
        return _error_response(
            PlastisError(
                "SPEC_INVALID",
                "baseRevision must be an integer",
                path="/baseRevision",
            )
        )
    upload = body.get("upload")
    backend_path = body.get("backendPath")
    if upload is not None and backend_path is not None:
        return _error_response(
            PlastisError(
                "SPEC_INVALID",
                "import takes either upload or backendPath, not both",
                path="",
            )
        )
    if upload is None and backend_path is None:
        return _error_response(
            PlastisError(
                "SPEC_INVALID",
                "import needs upload or backendPath",
                path="",
            )
        )
    options = {
        "name": body.get("name"),
        "parent": body.get("parent"),
        "transform": body.get("transform"),
        "explode": body.get("explode", True),
    }
    try:
        if upload is not None:
            if not isinstance(upload, dict):
                raise PlastisError(
                    "SPEC_INVALID", "upload must be an object", path="/upload"
                )
            filename = upload.get("filename")
            encoded = upload.get("bytes")
            if not isinstance(filename, str) or not filename:
                raise PlastisError(
                    "SPEC_INVALID",
                    "upload.filename must be a non-empty string",
                    path="/upload/filename",
                )
            if not isinstance(encoded, str):
                raise PlastisError(
                    "SPEC_INVALID",
                    "upload.bytes must be a base64 string",
                    path="/upload/bytes",
                )
            suffix = Path(filename).suffix.lower()
            source_format = _UPLOAD_FORMATS.get(suffix)
            if source_format is None:
                raise PlastisError(
                    "IMPORT_FORMAT",
                    "upload filename extension %r is not in the allowlist "
                    "(.glb, .gltf, .obj, .stl, .ply)" % suffix,
                )
            sidecars = _decode_sidecars(upload.get("sidecars"))
            try:
                data = base64.b64decode("".join(encoded.split()), validate=True)
            except (binascii.Error, ValueError):
                raise PlastisError(
                    "SPEC_INVALID",
                    "upload.bytes is not valid base64",
                    path="/upload/bytes",
                ) from None
            envelope = _import_bytes(
                scene_id,
                store,
                data,
                original_name=filename,
                source_format=source_format,
                base_revision=base_revision,
                sidecars=sidecars,
                **options,
            )
        else:
            if not isinstance(backend_path, str) or not backend_path:
                raise PlastisError(
                    "SPEC_INVALID",
                    "backendPath must be a non-empty string",
                    path="/backendPath",
                )
            envelope = _import_path(
                scene_id,
                store,
                backend_path,
                base_revision=base_revision,
                **options,
            )
    except PlastisError as error:
        return _error_response(error)
    return JSONResponse(envelope)


@router.get("/scenes/{scene_id}/check")
def check_scene_route(scene_id: str, assetId: str = None) -> JSONResponse:
    """The compatibility report (PR16): ``?assetId=`` narrows it to one model.

    Read-only; the Health section of the editor shows it. 404 for an unknown
    scene or asset. A report with findings is still 200: it is a result, not
    an error.
    """
    from plastis3d_scene.compat import check_scene

    store = _store()
    try:
        report = check_scene(store.get_scene(scene_id), store, asset_id=assetId)
    except PlastisError as error:
        return _error_response(error)
    return JSONResponse(report)


@router.get("/scenes/{scene_id}/analyze")
def analyze_scene_route(scene_id: str, assetId: str = None, budget: str = "mobile") -> JSONResponse:
    """The analyzer (PR17): the compatibility report with an ``analysis`` block.

    ``?budget=mobile|desktop`` and ``?assetId=``. Read-only. 400 for an unknown
    budget, 404 for an unknown scene or asset.
    """
    from plastis3d_scene.analyze import analyze_scene

    store = _store()
    try:
        report = analyze_scene(store.get_scene(scene_id), store, asset_id=assetId, budget=budget)
    except PlastisError as error:
        return _error_response(error)
    return JSONResponse(report)


@router.post("/scenes/{scene_id}/cleanup")
async def cleanup_scene_route(scene_id: str, request: Request) -> JSONResponse:
    """Prune and dedupe (PR18). Body: ``{baseRevision, operations?, dryRun?}``.

    ``dryRun`` previews and writes nothing. Otherwise one revision and one
    history entry. 409 for a stale ``baseRevision``. The editor's Health
    section uses this for its Tidy up preview and apply.
    """
    from plastis3d_scene.cleanup import run as _run_cleanup

    try:
        body = await request.json()
    except ValueError:
        body = None
    if not isinstance(body, dict):
        return _error_response(
            PlastisError("SPEC_INVALID", "request body must be a JSON object", path="")
        )
    dry_run = body.get("dryRun", False)
    if not isinstance(dry_run, bool):
        return _error_response(PlastisError("SPEC_INVALID", "dryRun must be a boolean", path="/dryRun"))
    try:
        asset_id = body.get("assetId")
        if asset_id is not None and not isinstance(asset_id, str):
            raise PlastisError("SPEC_INVALID", "assetId must be a string", path="/assetId")
        envelope = _run_cleanup(
            scene_id, _store(), body.get("baseRevision"), body.get("operations"),
            dry_run=dry_run, asset_id=asset_id,
        )
    except PlastisError as error:
        return _error_response(error)
    return JSONResponse(envelope)


@router.post("/scenes/{scene_id}/images")
async def import_image(scene_id: str, request: Request) -> JSONResponse:
    """Put a PNG or JPEG on one texture slot of a material (PR15).

    Body (JSON object): ``materialId``, ``slot`` (``baseColorMap``,
    ``normalMap``, ``metallicRoughnessMap`` or ``emissiveMap``),
    ``baseRevision``, and either ``backendPath`` (a file on the Hermes
    machine) or ``upload`` (``{filename, contentType, bytes: "<base64>"}``,
    the desktop door; the whole body is capped at 16 MiB). One mutation:
    the asset row (when new) and the slot, one revision, one undo entry.
    Refusals write nothing. Returns the feedback envelope.
    """
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > _MAX_UPLOAD_BYTES:
            return _error_response(
                PlastisError(
                    "IMPORT_TOO_LARGE",
                    "upload JSON body exceeds the 16 MiB import upload cap",
                )
            )
    try:
        body = json.loads(bytes(raw).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        body = None
    if not isinstance(body, dict):
        return _error_response(
            PlastisError("SPEC_INVALID", "request body must be a JSON object", path="")
        )
    base_revision = body.get("baseRevision")
    if not isinstance(base_revision, int) or isinstance(base_revision, bool):
        return _error_response(
            PlastisError("SPEC_INVALID", "baseRevision must be an integer", path="/baseRevision")
        )
    upload = body.get("upload")
    backend_path = body.get("backendPath")
    if (upload is None) == (backend_path is None):
        return _error_response(
            PlastisError("SPEC_INVALID", "images take exactly one of upload or backendPath", path="")
        )
    options = {
        "base_revision": base_revision,
        "material_id": body.get("materialId"),
        "slot": body.get("slot"),
    }
    store = _store()
    try:
        if upload is not None:
            if not isinstance(upload, dict):
                raise PlastisError("SPEC_INVALID", "upload must be an object", path="/upload")
            filename = upload.get("filename")
            encoded = upload.get("bytes")
            if not isinstance(filename, str) or not filename:
                raise PlastisError("SPEC_INVALID", "upload.filename must be a non-empty string", path="/upload/filename")
            if not isinstance(encoded, str):
                raise PlastisError("SPEC_INVALID", "upload.bytes must be a base64 string", path="/upload/bytes")
            try:
                data = base64.b64decode("".join(encoded.split()), validate=True)
            except (binascii.Error, ValueError):
                raise PlastisError("SPEC_INVALID", "upload.bytes is not valid base64", path="/upload/bytes") from None
            envelope = _import_image_bytes(
                scene_id, store, data, original_name=filename, **options
            )
        else:
            if not isinstance(backend_path, str) or not backend_path:
                raise PlastisError("SPEC_INVALID", "backendPath must be a non-empty string", path="/backendPath")
            envelope = _import_image_path(scene_id, store, backend_path, **options)
    except PlastisError as error:
        return _error_response(error)
    return JSONResponse(envelope)


@router.get("/assets/{sha256}")
def get_asset(sha256: str) -> JSONResponse:
    if not SHA256_RE.fullmatch(sha256):
        return _error_response(PlastisError("SPEC_INVALID", "sha256 must be 64 lowercase hex chars", path="/assets"))
    try:
        from plastis3d_scene.asset_transactions import AssetOperation
        with AssetOperation(_store(), assets=[{"sha256": sha256}]):
            return _get_asset(sha256)
    except PlastisError as error:
        return _error_response(error)


def _get_asset(sha256: str) -> JSONResponse:
    """Return one asset's GLB as the base64 JSON envelope (D1).

    ``{ok, sha256, size, bytes: "<base64>"}`` — never raw bytes, which
    ``ctx.rest`` cannot carry (PR1 §4.8 M2). 404 for an unknown hash,
    400 for a malformed one, 413 ``ASSET_TOO_LARGE`` (D3) when the
    asset exceeds the ~12 MiB byte-route limit: the asset stays
    importable and editable, only its preview bytes cannot be served.
    """
    if not SHA256_RE.match(sha256):
        return _error_response(
            PlastisError(
                "SPEC_INVALID",
                "sha256 must be 64 lowercase hex chars",
                path="/assets",
            )
        )
    store = _store()
    # A model is stored as a GLB; a texture keeps its own format (PR15).
    path = None
    asset_format = None
    for candidate, candidate_format in (
        (".splat", "splat"),
        (".glb", "glb"),
        (".png", "png"),
        (".jpg", "jpeg"),
    ):
        found = store.assets_dir / (sha256 + candidate)
        if found.is_file():
            path, asset_format = found, candidate_format
            break
    if path is None:
        return _error_response(
            PlastisError("ASSET_NOT_FOUND", "no asset with sha256 %r" % sha256)
        )
    data = path.read_bytes()
    if len(data) > _MAX_BYTE_ROUTE_BYTES:
        return _error_response(
            PlastisError(
                "ASSET_TOO_LARGE",
                "asset is %d bytes; the base64 byte route serves at most "
                "%d raw bytes (~12 MiB), so this asset shows stats and "
                "bounds instead of a preview" % (len(data), _MAX_BYTE_ROUTE_BYTES),
            )
        )
    return JSONResponse(
        {
            "ok": True,
            "sha256": sha256,
            "size": len(data),
            "format": asset_format,
            "mimeType": "model/gltf-binary" if asset_format == "glb" else ("application/octet-stream" if asset_format == "splat" else _image_mime(asset_format)),
            "bytes": base64.b64encode(data).decode("ascii"),
        }
    )


# --- PR22: the correlated screenshot protocol (C-10) -------------------------
# The request state lives on disk in the profile's data directory
# (plastis3d_scene.capture), so the agent tool and these routes agree even
# when the tool runs in another process. Routes are plain ``def`` handlers
# (or stream-reading async ones) so a waiting tool never blocks them.

@router.get("/captures/pending")
def pending_captures(scene: str = None) -> JSONResponse:
    try:
        return JSONResponse({"ok": True, "requests": _capture.pending_requests(_store(), scene)})
    except PlastisError as error:
        return _error_response(error)


@router.post("/captures/{request_id}/claim")
async def claim_capture(request_id: str, request: Request) -> JSONResponse:
    try:
        body = await _json_body(request)
        claimed = _capture.claim(_store(), request_id, body.get("surface"))
    except PlastisError as error:
        return _error_response(error)
    return JSONResponse({"ok": True, "request": claimed})


@router.post("/captures/{request_id}")
async def submit_capture(request_id: str, request: Request) -> JSONResponse:
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > _MAX_UPLOAD_BYTES:
            return _error_response(PlastisError("CAPTURE_TOO_LARGE", "the screenshot body exceeds the 16 MiB cap"))
    try:
        body = json.loads(bytes(raw).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        body = None
    if not isinstance(body, dict):
        return _error_response(PlastisError("SPEC_INVALID", "request body must be a JSON object", path=""))
    encoded = body.get("png")
    try:
        if not isinstance(encoded, str):
            raise PlastisError("CAPTURE_INVALID", "png must be a base64 string", path="/png")
        try:
            data = base64.b64decode("".join(encoded.split()), validate=True)
        except (binascii.Error, ValueError):
            raise PlastisError("CAPTURE_INVALID", "png is not valid base64", path="/png") from None
        result = _capture.submit(_store(), request_id, body.get("surface"), body.get("revision"), data)
    except PlastisError as error:
        return _error_response(error)
    return JSONResponse(result)


# --- PR24: bakes and drafts (D-EXT-03, D-EXT-07) ------------------------------

async def _read_json_capped(request: Request, code: str, what: str) -> dict:
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > _MAX_UPLOAD_BYTES:
            raise PlastisError(code, "%s exceeds the 16 MiB body cap" % what)
    try:
        body = json.loads(bytes(raw).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        body = None
    if not isinstance(body, dict):
        raise PlastisError("SPEC_INVALID", "request body must be a JSON object", path="")
    return body


@router.post("/scenes/{scene_id}/bakes")
async def bake_scene(scene_id: str, request: Request) -> JSONResponse:
    try:
        body = await _read_json_capped(request, "BAKE_TOO_LARGE", "the mesh")
        return JSONResponse(_bake.bake_mesh(scene_id, _store(), body))
    except PlastisError as error:
        return _error_response(error)


@router.put("/scenes/{scene_id}/drafts/{node_id}")
async def put_draft(scene_id: str, node_id: str, request: Request) -> JSONResponse:
    try:
        body = await _read_json_capped(request, "DRAFT_TOO_LARGE", "the draft")
        return JSONResponse(_drafts.put_draft(_store(), scene_id, node_id, body))
    except PlastisError as error:
        return _error_response(error)


@router.get("/scenes/{scene_id}/drafts/{node_id}")
def get_draft(scene_id: str, node_id: str) -> JSONResponse:
    try:
        return JSONResponse(_drafts.get_draft(_store(), scene_id, node_id))
    except PlastisError as error:
        return _error_response(error)


@router.delete("/scenes/{scene_id}/drafts/{node_id}")
def delete_draft(scene_id: str, node_id: str) -> JSONResponse:
    try:
        return JSONResponse({"ok": True, "deleted": _drafts.delete_draft(_store(), scene_id, node_id)})
    except PlastisError as error:
        return _error_response(error)


# --- PR14: the local library ------------------------------------------------------------------

@router.get("/scenes/{scene_id}/library")
def library_view(scene_id: str) -> JSONResponse:
    try:
        return JSONResponse(_library.list_assets(_store().get_scene(scene_id)))
    except PlastisError as error:
        return _error_response(error)


@router.post("/scenes/{scene_id}/library/remove-unused")
async def library_remove_unused(scene_id: str, request: Request) -> JSONResponse:
    try:
        body = await _json_body(request)
        dry = body.get("dryRun", False)
        if not isinstance(dry, bool):
            raise PlastisError("SPEC_INVALID", "dryRun must be a boolean", path="/dryRun")
        return JSONResponse(_library.remove_unused(_store(), scene_id, body.get("baseRevision"), dry))
    except PlastisError as error:
        return _error_response(error)


@router.put("/scenes/{scene_id}/thumbnail")
async def put_thumbnail(scene_id: str, request: Request) -> JSONResponse:
    try:
        body = await _read_json_capped(request, "THUMBNAIL_INVALID", "the thumbnail")
        encoded = body.get("png")
        if not isinstance(encoded, str):
            raise PlastisError("THUMBNAIL_INVALID", "png must be a base64 string", path="/png")
        try:
            data = base64.b64decode("".join(encoded.split()), validate=True)
        except (binascii.Error, ValueError):
            raise PlastisError("THUMBNAIL_INVALID", "png is not valid base64", path="/png") from None
        return JSONResponse(_library.put_thumbnail(_store(), scene_id, body.get("revision"), data))
    except PlastisError as error:
        return _error_response(error)


@router.get("/scenes/{scene_id}/thumbnail")
def get_thumbnail(scene_id: str) -> JSONResponse:
    try:
        return JSONResponse(_library.get_thumbnail(_store(), scene_id))
    except PlastisError as error:
        return _error_response(error)


# --- PR28: curves, cloners and displacement ----------------------------------------------------
# The same functions the agent tools call (plastis3d_scene.generators); one revision each.

@router.post("/scenes/{scene_id}/curves")
async def curves_route(scene_id: str, request: Request) -> JSONResponse:
    try:
        body = await _json_body(request)
        return JSONResponse(_generators.make_curve(
            _store(), scene_id, body.get("baseRevision"), body.get("curve"),
            node_id=body.get("id"), name=body.get("name"), parent=body.get("parent"), transform=body.get("transform"),
        ))
    except PlastisError as error:
        return _error_response(error)


@router.post("/scenes/{scene_id}/rigs")
async def rigs_route(scene_id: str, request: Request) -> JSONResponse:
    try:
        body = await _read_json_capped(request, "BAKE_TOO_LARGE", "the mesh")
        if not isinstance(body, dict):
            raise PlastisError("SPEC_INVALID", "request body must be a JSON object", path="")
        return JSONResponse(_generators.make_rig(_store(), scene_id, body.get("baseRevision"), body.get("id"), body.get("mesh"), body.get("rig")))
    except PlastisError as error:
        return _error_response(error)


@router.post("/scenes/{scene_id}/clones")
async def clones_route(scene_id: str, request: Request) -> JSONResponse:
    try:
        body = await _json_body(request)
        return JSONResponse(_generators.make_clones(_store(), scene_id, body.get("baseRevision"), body.get("source"), body.get("mode"), body.get("params")))
    except PlastisError as error:
        return _error_response(error)


@router.post("/scenes/{scene_id}/displace")
async def displace_route(scene_id: str, request: Request) -> JSONResponse:
    try:
        body = await _json_body(request)
        return JSONResponse(_generators.make_displace(_store(), scene_id, body.get("baseRevision"), body.get("id"), body.get("params")))
    except PlastisError as error:
        return _error_response(error)


@router.post("/scenes/{scene_id}/renders")
async def save_render(scene_id: str, request: Request) -> JSONResponse:
    try:
        from plastis3d_scene.renders import save_render as save
        body = await _read_json_capped(request, "CAPTURE_INVALID", "the render")
        encoded = body.get("png")
        if not isinstance(encoded, str):
            raise PlastisError("CAPTURE_INVALID", "png must be base64")
        try:
            data = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError):
            raise PlastisError("CAPTURE_INVALID", "png must be base64") from None
        return JSONResponse(save(_store(), scene_id, body.get("revision"), data))
    except PlastisError as error:
        return _error_response(error)
