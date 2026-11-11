"""Profile asset reservations and OS-owned operation pins (C-03).

Only admission and atomic renames hold the profile lock. Parsing, hashing,
staging writes, scene commits and export processing do not. A per-operation
OS lock makes pins crash-recoverable without PIDs or expiring live readers.
The assets quota counts unique published objects and missing reserved objects;
exports, screenshots, renders and drafts retain their own existing policies.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import time
import uuid
from pathlib import Path

from .spec import LOCK_TIMEOUT_SECONDS, PlastisError
from .store import Store, _SceneLock, _thread_locks, _thread_locks_guard

_NAME = re.compile(r'([0-9a-f]{64})\.(glb|png|jpg|splat)\Z')
_TOKEN = re.compile(r'[0-9a-f]{32}\Z')


def _directory(store):
    directory = store.data_dir / 'asset-operations'
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _forget_operation_lock(path):
    # UUID operation IDs are never reused. Call only under the profile lock,
    # after removing the marker, so no new collector can discover a waiter.
    key = os.path.normcase(os.path.abspath(path))
    with _thread_locks_guard:
        lock = _thread_locks.get(key)
        if lock is not None and not lock.locked():
            _thread_locks.pop(key, None)


def active_operations_locked(store):
    """Called only with the profile lock. Reap crashed operations, keep live ones."""
    result = []
    directory = _directory(store)
    for marker in directory.glob('*.json'):
        if not _TOKEN.fullmatch(marker.stem):
            continue
        probe = _SceneLock(directory / (marker.stem + '.lock'))
        try:
            probe.acquire(timeout=0)
        except PlastisError as error:
            if error.code != 'STORE_BUSY':
                raise
            try:
                result.append(json.loads(marker.read_text()))
            except (OSError, ValueError):
                # A malformed live marker must never authorize collection.
                raise PlastisError('STORE_BUSY', 'asset operation state is unavailable') from None
        else:
            probe.release()
            marker.unlink(missing_ok=True)
            shutil.rmtree(directory / ('stage-' + marker.stem), ignore_errors=True)
            path = directory / (marker.stem + '.lock')
            path.unlink(missing_ok=True)
            _forget_operation_lock(path)
    return result


def active_asset_ids_locked(store):
    return {sha for operation in active_operations_locked(store) for sha in operation.get('pins', [])}


class AssetOperation:
    """Pin references, optionally reserve and publish a batch; retain pins through commit."""
    def __init__(self, store, assets=(), files=None, quota=None, scene_id=None):
        self.store = store
        self.scene_id = scene_id
        self.files = dict(files or {})
        self.quota = quota
        self.pins = {row.get('sha256') for row in assets if isinstance(row, dict) and isinstance(row.get('sha256'), str)}
        # All payload validation/hash work occurs before any profile lock.
        for name, data in self.files.items():
            match = _NAME.fullmatch(name)
            if not match or hashlib.sha256(data).hexdigest() != match[1]:
                raise PlastisError('SPEC_INVALID', 'asset publication requires matching content-addressed bytes')
            self.pins.add(match[1])
        self.token = uuid.uuid4().hex
        self.directory = _directory(store)
        self.marker = self.directory / (self.token + '.json')
        self.lock = _SceneLock(self.directory / (self.token + '.lock'))
        self.stage = self.directory / ('stage-' + self.token)

    def __enter__(self):
        self.lock.acquire()
        try:
            deadline = time.monotonic() + LOCK_TIMEOUT_SECONDS
            while True:
                wait = False
                with self.store.asset_lock():
                    if self.scene_id is not None:
                        scene = self.store.get_scene(self.scene_id)
                        self.pins.update(row["sha256"] for row in scene.get("assets", []) if isinstance(row.get("sha256"), str))
                    live = active_operations_locked(self.store)
                    reserved = {}
                    for operation in live:
                        for name, size in operation.get('reserved', {}).items():
                            if not (self.store.assets_dir / name).is_file():
                                reserved[name] = size
                    missing = {}
                    for name, data in self.files.items():
                        destination = self.store.assets_dir / name
                        if destination.is_file():
                            if destination.stat().st_size != len(data):
                                raise PlastisError('IMPORT_TOO_COMPLEX', 'an asset file already exists for this hash with a different size')
                        elif name in reserved:
                            wait = True
                        else:
                            missing[name] = len(data)
                    used = sum(path.stat().st_size for path in self.store.assets_dir.iterdir() if path.is_file())
                    if self.quota is not None and used + sum(reserved.values()) + sum(missing.values()) > self.quota:
                        raise PlastisError('IMPORT_TOO_LARGE', 'asset quota exceeded by stored bytes and active reservations')
                    if not wait:
                        Store._atomic_write(self.marker, json.dumps({'pins': sorted(self.pins), 'reserved': missing}).encode())
                        break
                if time.monotonic() >= deadline:
                    raise PlastisError('STORE_BUSY', 'asset publication is busy')
                time.sleep(0.01)
            # Slow writes/fsync happen outside the profile lock, covered by reservation.
            self.stage.mkdir(exist_ok=True)
            for name, data in self.files.items():
                if name in missing:
                    Store._atomic_write(self.stage / name, data)
            with self.store.asset_lock():
                for name in missing:
                    (self.stage / name).replace(self.store.assets_dir / name)
            # The final rename crosses from staging into assets/. Flush that
            # directory before permitting a scene to reference the published files.
            if missing:
                try:
                    descriptor = os.open(self.store.assets_dir, os.O_RDONLY)
                except OSError:
                    descriptor = None
                if descriptor is not None:
                    try:
                        os.fsync(descriptor)
                    except OSError:
                        pass  # Match Store._atomic_write's portable best effort.
                    finally:
                        os.close(descriptor)
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *_):
        self.lock.release()
        # A committed scene must not be reported failed if marker retirement
        # contends. The now-unlocked marker is reaped at the next admission/GC.
        try:
            with self.store.asset_lock():
                self.marker.unlink(missing_ok=True)
                path = self.directory / (self.token + '.lock')
                path.unlink(missing_ok=True)
                _forget_operation_lock(path)
        except (PlastisError, OSError):
            pass
        shutil.rmtree(self.stage, ignore_errors=True)
        return False


def pin_scene(function):
    """Pin the source scene's asset snapshot during CPU preparation and commit."""
    import functools
    import inspect
    signature = inspect.signature(function)

    @functools.wraps(function)
    def pinned(*args, **kwargs):
        arguments = signature.bind(*args, **kwargs).arguments
        store, scene_id = arguments['store'], arguments['scene_id']
        # Capture source roots and register their pin within one profile-lock
        # admission. Expensive work proceeds with only the operation lock held.
        with AssetOperation(store, scene_id=scene_id):
            return function(*args, **kwargs)
    return pinned
