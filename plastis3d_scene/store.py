"""Concurrent JSON scene store with persistent OS-owned lock files.

Lock handles are held through revision checks and atomic replacement. Lock files
are never unlinked. The operating system releases locks on process exit.
"""

from __future__ import annotations

import errno
import copy
import re
import json
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Optional

from .spec import (
    LOCK_POLL_SECONDS,
    LOCK_TIMEOUT_SECONDS,
    MAX_HISTORY,
    MAX_SCENE_BYTES,
    PlastisError,
    feedback_envelope,
    new_scene_dict,
    now_iso,
    slugify_scene_id,
)
from .upgrade import upgrade_scene
from .validate import validate_scene


def _retry_sharing(operation, attempts: int = 200, delay: float = 0.005):
    """Run ``operation``, retrying briefly on a Windows sharing violation.

    On Windows a file cannot be opened while another handle is mid-replace
    (and vice versa); the other side finishes in microseconds, so a bounded
    retry is correct. On POSIX ``PermissionError`` is a real error: re-raised.
    """
    if os.name != "nt":
        return operation()
    for attempt in range(attempts):
        try:
            return operation()
        except PermissionError:
            if attempt == attempts - 1:
                raise
            time.sleep(delay)

# --- Data directory resolution ------------------------------------------------
# Precedence: explicit argument > PLASTIS3D_DATA_DIR (tests) > HERMES_HOME
# env var > ~/.hermes. The host's own plugin_data_dir("plastis3d")
# resolves to the same <HERMES_HOME>/plugin-data/plastis3d location at
# runtime; the env override exists so tests never touch real user data.


def resolve_data_dir(explicit: Optional[Any] = None) -> Path:
    """Resolve the ``plugin-data/plastis3d`` directory.

    Precedence: explicit argument > ``PLASTIS3D_DATA_DIR`` (tests) >
    the host's per-request Hermes home > ``HERMES_HOME`` env var >
    ``~/.hermes``.

    The host step is the profile-scoping seam (PR3, stage-2 §4.5): the
    dashboard host mounts the plugin router with a dependency that
    enters the requesting profile's scope
    (``web_server_dashboard._plugin_route_secret_scope`` →
    ``web_server_profiles._config_profile_scope``), which sets the
    ``HERMES_HOME`` contextvar in ``hermes_constants`` to that
    profile's directory. Reading it here — instead of only
    ``os.environ`` — is what keeps two profiles' scenes apart when one
    gateway serves both. The import is lazy and guarded: in a process
    with no Hermes install (plain pytest, ``validate``'s probe) it
    falls through to the env/default path unchanged. ``get_hermes_home``
    itself falls back to the ``HERMES_HOME`` env var and then the
    platform default, so the old behaviour is preserved when no
    contextvar override is set.

    Residual gap (recorded, not faked): no ``connectionId`` reaches the
    backend — ``sourceKey = connectionId + profile`` is a desktop-side
    key (from ``host.profileRoutes()``); the backend can only isolate
    by profile home. Two connections to the *same* profile therefore
    share one scene namespace, which is the profile's own namespace.
    """
    if explicit is not None:
        return Path(explicit)
    override = os.environ.get("PLASTIS3D_DATA_DIR")
    if override:
        return Path(override)
    try:
        from hermes_constants import get_hermes_home  # type: ignore

        home = get_hermes_home()
    except Exception:
        home = None
    if home is not None:
        return Path(home) / "plugin-data" / "plastis3d"
    hermes_home = os.environ.get("HERMES_HOME")
    if hermes_home:
        return Path(hermes_home) / "plugin-data" / "plastis3d"
    return Path.home() / ".hermes" / "plugin-data" / "plastis3d"


# --- OS lock -----------------------------------------------------------------
# Isolated behind acquire/release so a plugin_db() SQLite WAL backend can
# replace it behind the same Store API (see the Windows note above).


_thread_locks: dict[str, threading.Lock] = {}
_thread_locks_guard = threading.Lock()


class _SceneLock:
    """Stable OS lock; lock files are never removed while the store is in use."""

    def __init__(self, lock_path: Path) -> None:
        self.lock_path = lock_path
        self._fd = None
        self._thread_lock = None

    def acquire(self, timeout: float = LOCK_TIMEOUT_SECONDS) -> None:
        deadline = time.monotonic() + timeout
        key = os.path.normcase(os.path.abspath(self.lock_path))
        with _thread_locks_guard:
            lock = _thread_locks.setdefault(key, threading.Lock())
        if not lock.acquire(timeout=max(0.0, timeout)):
            raise PlastisError("STORE_BUSY", "scene store is busy")
        self._thread_lock = lock
        try:
            fd = os.open(self.lock_path, os.O_RDWR | os.O_CREAT, 0o644)
            self._fd = fd
            if os.fstat(fd).st_size == 0:
                os.write(fd, b"0")
            if os.name == "nt":
                try:
                    import msvcrt
                except ImportError as exc:
                    raise PlastisError("STORE_BUSY", "scene locking unavailable") from exc
                def try_lock():
                    os.lseek(fd, 0, os.SEEK_SET)
                    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            else:
                try:
                    import fcntl
                except ImportError as exc:
                    raise PlastisError("STORE_BUSY", "scene locking unavailable") from exc
                def try_lock():
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            while True:
                try:
                    try_lock()
                    return
                except OSError as exc:
                    if exc.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                        raise PlastisError("STORE_BUSY", "scene lock unavailable: %s" % exc) from exc
                    if time.monotonic() >= deadline:
                        raise PlastisError("STORE_BUSY", "scene store is busy") from exc
                    time.sleep(min(LOCK_POLL_SECONDS, max(0, deadline - time.monotonic())))
        except BaseException:
            if self._fd is not None:
                os.close(self._fd)
                self._fd = None
            lock.release()
            self._thread_lock = None
            raise

    def release(self) -> None:
        if self._fd is None:
            return
        fd, self._fd = self._fd, None
        try:
            if os.name == "nt":
                import msvcrt
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)
            self._thread_lock.release()
            self._thread_lock = None

    def __enter__(self) -> "_SceneLock":
        self.acquire()
        return self

    def __exit__(self, *exc: Any) -> None:
        self.release()


# --- Store --------------------------------------------------------------------


class Store:
    """File-backed scene store. One instance per data directory; all
    shared state lives on disk (decision 10)."""

    def __init__(self, data_dir: Optional[Any] = None) -> None:
        self.data_dir = resolve_data_dir(data_dir)
        self.scenes_dir = self.data_dir / "scenes"
        self.assets_dir = self.data_dir / "assets"
        self.exports_dir = self.data_dir / "exports"
        self.deleted_dir = self.data_dir / "deleted"
        self.scenes_dir.mkdir(parents=True, exist_ok=True)
        self.assets_dir.mkdir(parents=True, exist_ok=True)
        self.exports_dir.mkdir(parents=True, exist_ok=True)
        self.deleted_dir.mkdir(parents=True, exist_ok=True)

    # -- paths ------------------------------------------------------------------
    def asset_lock(self) -> "_SceneLock":
        """The asset lock (C-03). Taken BEFORE any scene lock, never after."""
        return _SceneLock(self.data_dir / "assets.lock")

    def scene_path(self, scene_id: str) -> Path:
        return self.scenes_dir / ("%s.json" % scene_id)

    def lock_path(self, scene_id: str) -> Path:
        return self.scenes_dir / ("%s.lock" % scene_id)

    # -- reads ------------------------------------------------------------------
    def scene_exists(self, scene_id: str) -> bool:
        return self.scene_path(scene_id).is_file()

    def _read_scene_file(self, scene_id: str) -> dict:
        """Read and parse a scene file (no validation — the caller
        validates what it needs). Raises ``SCENE_NOT_FOUND``."""
        try:
            raw = _retry_sharing(self.scene_path(scene_id).read_bytes)
        except FileNotFoundError:
            raise PlastisError(
                "SCENE_NOT_FOUND", "no scene with id %r" % scene_id
            ) from None
        try:
            scene = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise PlastisError(
                "SPEC_INVALID",
                "scene file %r is not valid JSON" % scene_id,
                path="",
            ) from None
        if not isinstance(scene, dict):
            raise PlastisError(
                "SPEC_INVALID", "scene file %r is not an object" % scene_id, path=""
            )
        # Schema upgrades happen in memory as the file is read (PR24, D-EXT-02).
        return upgrade_scene(scene)

    def get_scene(self, scene_id: str) -> dict:
        """Read a scene by id, strictly validated. ``SCENE_NOT_FOUND``
        when the file is absent."""
        scene = self._read_scene_file(scene_id)
        validate_scene(scene)
        return scene

    def list_scenes(self) -> list:
        """``[{id, name, revision, updatedAt}]`` for every readable scene
        file, sorted by id. Unparseable files are skipped here (``get``
        reports them); the files remain the source of truth."""
        result = []
        for path in sorted(self.scenes_dir.glob("*.json")):
            try:
                scene = json.loads(path.read_text(encoding="utf-8"))
                validate_scene(scene)
            except (ValueError, UnicodeDecodeError, PlastisError, OSError):
                continue
            result.append(
                {
                    "id": scene["id"],
                    "name": scene["name"],
                    "revision": scene["revision"],
                    "updatedAt": scene["updatedAt"],
                }
            )
        return result

    # -- writes -----------------------------------------------------------------
    @staticmethod
    def _atomic_write(path: Path, data: bytes) -> None:
        """Write ``data`` to ``path`` atomically: temp file in the same
        directory, fsync, ``os.replace``. No partial file is ever visible
        at ``path``."""
        fd, tmp_name = tempfile.mkstemp(
            dir=str(path.parent), prefix=".%s." % path.name, suffix=".tmp"
        )
        tmp_path = Path(tmp_name)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            _retry_sharing(lambda: os.replace(tmp_path, path))
        except BaseException:
            try:
                tmp_path.unlink()
            except OSError:
                pass
            raise
        # Best-effort directory fsync so the rename itself is durable.
        try:
            dir_fd = os.open(str(path.parent), os.O_RDONLY)
        except OSError:
            return
        try:
            os.fsync(dir_fd)
        except OSError:
            pass
        finally:
            os.close(dir_fd)

    @staticmethod
    def _dump(scene: dict) -> bytes:
        """Canonical JSON bytes for a scene dict (sorted keys, compact)."""
        return json.dumps(scene, sort_keys=True, separators=(",", ":")).encode("utf-8")

    def create_scene(self, name: str, scene_id: Optional[str] = None, copy_from: Optional[str] = None) -> dict:
        with _SceneLock(self.scenes_dir / ".namespace.lock"):
            return self._create_scene(name, scene_id, copy_from)

    def _create_scene(self, name: str, scene_id: Optional[str] = None, copy_from: Optional[str] = None) -> dict:
        """Create a scene with the default rig at revision 1.

        The id is slugged from ``name`` (``-2``, ``-3`` on collision),
        or the caller's ``scene_id`` when given (``SCENE_EXISTS`` on
        collision). Returns the new scene dict.
        """
        if not isinstance(name, str) or not name.strip():
            raise PlastisError("SPEC_INVALID", "scene name must be a non-empty string", path="/name")
        if scene_id is not None:
            from .spec import SCENE_ID_RE

            if not isinstance(scene_id, str) or not SCENE_ID_RE.match(scene_id):
                raise PlastisError(
                    "SPEC_INVALID",
                    "scene id must match ^[a-z0-9-]{1,64}$",
                    path="/id",
                )
            if self.scene_exists(scene_id):
                raise PlastisError("SCENE_EXISTS", "scene %r already exists" % scene_id)
            chosen = scene_id
        else:
            base = slugify_scene_id(name)
            chosen = base
            suffix = 2
            while self.scene_exists(chosen):
                chosen = "%s-%d" % (base, suffix)
                suffix += 1
        source = None
        if copy_from is not None:
            from .spec import SCENE_ID_RE
            if not isinstance(copy_from, str) or not SCENE_ID_RE.fullmatch(copy_from):
                raise PlastisError("SPEC_INVALID", "invalid copyFrom", path="/copyFrom")
            with _SceneLock(self.lock_path(copy_from)):
                source = copy.deepcopy(self.get_scene(copy_from))
        scene = new_scene_dict(chosen, name)
        if source is not None:
            for key in ("nodes", "materials", "assets"):
                scene[key] = source[key]
        with _SceneLock(self.lock_path(chosen)):
            if self.scene_exists(chosen):
                raise PlastisError(
                    "SCENE_EXISTS", "scene %r already exists" % chosen
                )
            floor_path = self.deleted_dir / (chosen + ".json")
            if floor_path.exists():
                scene["revision"] = json.loads(floor_path.read_text(encoding="utf-8"))["floor"] + 1
            validate_scene(scene)
            if len(self._dump(scene)) > MAX_SCENE_BYTES:
                raise PlastisError("LIMIT_SCENE", "scene exceeds the 4 MiB cap")
            self._atomic_write(self.scene_path(chosen), self._dump(scene))
        return scene

    def write_scene(
        self,
        scene_id: str,
        new_scene: dict,
        base_revision: int,
        history_entry: Optional[dict] = None,
        history_override: Optional[dict] = None,
    ) -> dict:
        """Write a new scene revision under the OS lock.

        ``new_scene`` is the post-mutation document. Normally its
        ``history`` key is replaced by the store-composed history: the
        current history plus ``history_entry`` appended to undo, redo
        cleared. ``history_override`` (undo/redo only) replaces the
        composed history wholesale with the caller's history dict — a
        plain append-and-clear would put an undone entry back on the
        undo stack and drop the redo stack, which is wrong for
        undo/redo. ``history_entry`` and ``history_override`` are
        mutually exclusive.

        The revision is set to ``base_revision + 1`` and ``updatedAt``
        to now; ``createdAt`` is preserved from the current file.

        Returns ``{"scene": <written dict>, "historyTruncated": bool}``.

        Failures (nothing written): ``SCENE_NOT_FOUND``,
        ``REVISION_CONFLICT`` (with ``currentRevision``), ``LIMIT_SCENE``,
        ``STORE_BUSY``, ``SPEC_INVALID``.
        """
        # Validate before the lock: hashing / scanning / validation never
        # hold the lock (rule 12).
        validate_scene(new_scene)
        if new_scene.get("id") != scene_id:
            raise PlastisError(
                "SPEC_INVALID",
                "scene id %r does not match %r" % (new_scene.get("id"), scene_id),
                path="/id",
            )
        if not isinstance(base_revision, int) or isinstance(base_revision, bool):
            raise PlastisError(
                "SPEC_INVALID", "baseRevision must be an integer", path="/baseRevision"
            )

        with _SceneLock(self.lock_path(scene_id)):
            current = self._read_scene_file(scene_id)
            current_revision = current.get("revision")
            if current_revision != base_revision:
                raise PlastisError(
                    "REVISION_CONFLICT",
                    "baseRevision %r does not match current revision %r"
                    % (base_revision, current_revision),
                    current_revision=current_revision,
                )
            scene = dict(new_scene)
            scene["revision"] = base_revision + 1
            scene["updatedAt"] = now_iso()
            if not scene.get("createdAt"):
                scene["createdAt"] = current.get("createdAt", scene["updatedAt"])

            # Body cap: the scene without history must fit on its own.
            body = {k: v for k, v in scene.items() if k != "history"}
            if len(self._dump(body)) > MAX_SCENE_BYTES:
                raise PlastisError(
                    "LIMIT_SCENE",
                    "scene body without history exceeds the 4 MiB cap",
                )

            # Compose history: current undo + new entry, redo cleared;
            # or the caller's override (undo/redo), used verbatim.
            # The 50-entry bound is a ring buffer: the oldest entries
            # drop by count. That is normal operation, not truncation —
            # ``historyTruncated`` is reserved for size-driven drops
            # below (the flag's design meaning: entries were dropped
            # because the file would otherwise exceed 4 MiB).
            popped = 0  # history entries dropped by this write (PR24, C-03)
            if history_override is not None:
                if history_entry is not None:
                    raise PlastisError(
                        "SPEC_INVALID",
                        "history_entry and history_override are mutually exclusive",
                        path="/history",
                    )
                history = dict(history_override)
                undo = list(history.get("undo") or [])
                redo = list(history.get("redo") or [])
                while len(undo) > MAX_HISTORY:
                    undo.pop(0)
                    popped += 1
                while len(redo) > MAX_HISTORY:
                    redo.pop(0)
                    popped += 1
            else:
                history = current.get("history") or {}
                undo = list(history.get("undo") or [])
                if history_entry is not None:
                    undo.append(history_entry)
                while len(undo) > MAX_HISTORY:
                    undo.pop(0)
                    popped += 1
                redo = []
            history_truncated = False
            scene["history"] = {
                "undo": undo,
                "redo": redo,
                "limit": MAX_HISTORY,
            }
            # Prune oldest undo entries until the file fits. If it still
            # does not fit with empty history, fail without writing.
            while len(self._dump(scene)) > MAX_SCENE_BYTES and undo:
                undo.pop(0)
                popped += 1
                history_truncated = True
            # PR24 (C-03): the asset rows only the dropped entries could reach go
            # in this same revision; their files go after the commit.
            swept_rows: list = []
            if popped:
                from .sweep import sweep_rows

                swept_rows = sweep_rows(scene)
            if len(self._dump(scene)) > MAX_SCENE_BYTES:
                raise PlastisError(
                    "LIMIT_SCENE",
                    "scene exceeds the 4 MiB cap even with empty history",
                )
            self._atomic_write(self.scene_path(scene_id), self._dump(scene))
        if swept_rows:
            # After the commit and the scene lock, under the asset lock.
            from .sweep import sweep_after_commit

            sweep_after_commit(self)
        return {"scene": scene, "historyTruncated": history_truncated}

    def delete_exports(self, scene_id: str, keep: Optional[Path] = None) -> None:
        # Older exports were flat files named <id>-r<revision>.glb; current ones live in exports/<id>/.
        pattern = re.compile(re.escape(scene_id) + r"-r[0-9]+\.glb\Z")
        for path in self.exports_dir.iterdir():
            if pattern.fullmatch(path.name) and path != keep:
                try:
                    path.unlink()
                except FileNotFoundError:
                    pass
        scene_exports = self.exports_dir / scene_id
        if scene_exports.is_dir():
            for path in scene_exports.iterdir():
                if path != keep:
                    try:
                        path.unlink()
                    except (FileNotFoundError, IsADirectoryError):
                        pass
            try:
                scene_exports.rmdir()  # gone with the scene; stays while the kept export is in it
            except OSError:
                pass

    def delete_scene(self, scene_id: str, base_revision: int) -> None:
        with _SceneLock(self.lock_path(scene_id)):
            current = self.get_scene(scene_id)
            revision = current["revision"]
            if not isinstance(base_revision, int) or isinstance(base_revision, bool) or revision != base_revision:
                raise PlastisError("REVISION_CONFLICT", "baseRevision does not match current revision", current_revision=revision)
            floor_path = self.deleted_dir / (scene_id + ".json")
            floor = json.loads(floor_path.read_text(encoding="utf-8"))["floor"] if floor_path.exists() else 0
            self._atomic_write(floor_path, self._dump({"floor": max(floor, revision)}))
            self.scene_path(scene_id).unlink()
            self.delete_exports(scene_id)
            from .capture import delete_screenshots

            delete_screenshots(self, scene_id)
            from .drafts import delete_scene_drafts

            delete_scene_drafts(self, scene_id)
            from .library import delete_thumbnail

            delete_thumbnail(self, scene_id)
            render = self.data_dir / "renders" / (scene_id + ".png")
            render.unlink(missing_ok=True)

    # -- envelopes ---------------------------------------------------------------
    def envelope(
        self,
        scene: dict,
        defaults_added: Optional[list] = None,
        history_truncated: bool = False,
    ) -> dict:
        """The feedback envelope for a scene dict (no history stacks)."""
        return feedback_envelope(scene, defaults_added, history_truncated)
