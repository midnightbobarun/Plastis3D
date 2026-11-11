"""Concurrency worker for test_mutate.py's two-process lock test.

Holds the scene's OS lock for ``--hold`` seconds (default 45, the
design's holder-alive window), then releases it. The parent process
attempts a mutation while this holder is alive and must get
``STORE_BUSY`` inside 2 seconds with the scene file unchanged.

Usage: python _lock_holder.py <repo_root> <data_dir> <scene_id> [--hold SECONDS]
"""

import argparse
import sys
import time

sys.path.insert(0, sys.argv[1])

from plastis3d_scene.store import Store, _SceneLock  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("repo_root")
    parser.add_argument("data_dir")
    parser.add_argument("scene_id")
    parser.add_argument("--hold", type=float, default=45.0)
    args = parser.parse_args()

    store = Store(args.data_dir)
    lock = _SceneLock(store.lock_path(args.scene_id))
    lock.acquire()
    # Signal readiness: the lockfile exists and is held.
    print("holding %s" % store.lock_path(args.scene_id), flush=True)
    try:
        time.sleep(args.hold)
    finally:
        lock.release()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
