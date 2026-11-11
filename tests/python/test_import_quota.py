"""C-03/R-103: keep the Stage 7 cross-scene quota counterexample reproducible."""
import struct
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from plastis3d_scene import import_model
from plastis3d_scene.spec import PlastisError
from plastis3d_scene.store import Store


def test_concurrent_cross_scene_imports_cannot_exceed_profile_quota(tmp_path, monkeypatch):
    store = Store(tmp_path)
    scenes = [store.create_scene("Quota " + str(i)) for i in range(2)]
    payloads = [
        struct.pack("<6f8B", i, 0, 0, .1, .1, .1, 255, 0, 0, 255, 255, 128, 128, 128)
        for i in range(2)
    ]
    monkeypatch.setattr(import_model, "MAX_ASSET_QUOTA_BYTES", 60)
    ready = threading.Barrier(2)
    original_write = Store._atomic_write

    def publish(path, data):
        if Path(path).suffix == ".splat":
            # With correct locking only one writer reaches publication at a time;
            # let it proceed after the timeout rather than deadlocking the test.
            try:
                ready.wait(timeout=1)
            except threading.BrokenBarrierError:
                pass
        original_write(path, data)

    monkeypatch.setattr(Store, "_atomic_write", staticmethod(publish))

    def import_one(i):
        try:
            import_model.import_bytes(
                scenes[i]["id"], store, payloads[i], source_format="splat",
                original_name="quota.splat", base_revision=1,
            )
            return "ok"
        except PlastisError as error:
            return error.code

    with ThreadPoolExecutor(max_workers=2) as executor:
        outcomes = list(executor.map(import_one, range(2)))
    used = sum(path.stat().st_size for path in store.assets_dir.iterdir() if path.is_file())
    assert used <= 60, f"Concurrent imports used {used} bytes against a 60-byte quota: {outcomes}"
    assert sorted(outcomes) == ["IMPORT_TOO_LARGE", "ok"]


def test_bake_history_rollover_does_not_fail_after_commit(tmp_path, monkeypatch):
    from plastis3d_scene import bake, drafts, tools
    from test_bake import scene_with_box, bake_body, quad, b64
    monkeypatch.setenv('PLASTIS3D_DATA_DIR', str(tmp_path))
    store = Store(tmp_path)
    sid, revision, node = scene_with_box()
    # Repeated bakes pop the oldest asset-bearing entry while the bake holds
    # the profile lock in the original implementation.
    monkeypatch.setattr('plastis3d_scene.store.MAX_HISTORY', 2)
    for i in range(6):
        mesh = quad({'positions': b64('f', [0,0,0, 1+i,0,0, 1+i,1,0, 0,1,0])})
        result = bake.bake_mesh(sid, store, bake_body(revision, node, mesh))
        assert result['scene']['revision'] == revision + 1
        revision += 1
    assert store.get_scene(sid)['revision'] == revision
