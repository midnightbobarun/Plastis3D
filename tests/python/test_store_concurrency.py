"""PR2 multi-process concurrency tests (Tier 1, stage-1 §5).

Ten parallel Python processes attempt simultaneous mutations on the
same scene. The store must show zero corrupted files, zero lost updates
(every worker's node lands, each at its own revision), and proper
``REVISION_CONFLICT`` handling (a stale writer retries with a fresh
revision; it never overwrites).

The two-process lock test (holder alive 45 s; dead-pid steal) lives in
``test_mutate.py``, Stage 2 — not here.

Run: pytest tests/python
"""

import subprocess
import sys
from pathlib import Path

from plastis3d_scene.store import Store, PlastisError

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
WORKER = Path(__file__).resolve().parent / "_concurrency_worker.py"


def test_ten_parallel_mutations_no_lost_updates(tmp_path):
    data_dir = tmp_path / "data"
    store = Store(data_dir)
    store.create_scene("Race")
    assert store.get_scene("race")["revision"] == 1

    processes = [
        subprocess.Popen(
            [sys.executable, str(WORKER), str(REPO_ROOT), str(data_dir), "race", str(i)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        for i in range(10)
    ]
    results = [p.communicate(timeout=120) for p in processes]
    for i, (process, (out, err)) in enumerate(zip(processes, results)):
        assert process.returncode == 0, "worker %d failed: %s%s" % (i, out, err)

    scene = store.get_scene("race")
    # Ten mutations, each at its own revision: 1 -> 11.
    assert scene["revision"] == 11
    node_ids = {n["id"] for n in scene["nodes"]}
    for i in range(10):
        assert "w%d" % i in node_ids, "worker %d's node was lost" % i
    # One history entry per mutation, none dropped.
    assert len(scene["history"]["undo"]) == 10
    # No partial files and no lock residue left behind.
    names = sorted(p.name for p in store.scenes_dir.iterdir())
    assert names == [".namespace.lock", "race.json", "race.lock"]
    # The file is still valid scene JSON.
    assert Store(data_dir).get_scene("race")["revision"] == 11


def test_threads_serialize_same_revision(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    store = Store(tmp_path)
    scene = store.create_scene("Threads")
    barrier = Barrier(2)
    def write():
        barrier.wait()
        try:
            store.write_scene("threads", scene, 1)
            return "ok"
        except PlastisError as error:
            return error.code
    with ThreadPoolExecutor(max_workers=2) as executor:
        assert sorted(executor.map(lambda _: write(), range(2))) == ["REVISION_CONFLICT", "ok"]
    assert store.get_scene("threads")["revision"] == 2


def test_killed_child_releases_lock(tmp_path):
    store = Store(tmp_path)
    store.create_scene("Crash")
    holder = subprocess.Popen([sys.executable, str(Path(__file__).parent / "_lock_holder.py"), str(REPO_ROOT), str(tmp_path), "crash"], stdout=subprocess.PIPE, text=True)
    try:
        assert holder.stdout.readline().startswith("holding ")
        holder.kill()
        holder.wait(timeout=10)
        scene = store.get_scene("crash")
        assert store.write_scene("crash", scene, 1)["scene"]["revision"] == 2
    finally:
        if holder.poll() is None:
            holder.kill()
            holder.wait(timeout=10)


def test_two_processes_same_revision_only_one_commits(tmp_path):
    import time
    store = Store(tmp_path)
    store.create_scene("Barrier")
    script = '''import sys, time
from pathlib import Path
from plastis3d_scene.store import Store, PlastisError
root, n = Path(sys.argv[1]), sys.argv[2]
store = Store(root)
scene = store.get_scene("barrier")
(root / ("ready" + n)).touch()
while not (root / "go").exists(): time.sleep(0.005)
try:
    store.write_scene("barrier", scene, 1)
    print("ok")
except PlastisError as exc:
    print(exc.code)
'''
    processes = [subprocess.Popen([sys.executable, "-c", script, str(tmp_path), str(i)], cwd=REPO_ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for i in range(2)]
    try:
        deadline = time.monotonic() + 10
        while not all((tmp_path / ("ready" + str(i))).exists() for i in range(2)):
            assert time.monotonic() < deadline
            time.sleep(0.01)
        (tmp_path / "go").touch()
        results = [process.communicate(timeout=10) for process in processes]
        assert all(process.returncode == 0 for process in processes), results
        assert sorted(out.strip() for out, _ in results) == ["REVISION_CONFLICT", "ok"]
        assert store.get_scene("barrier")["revision"] == 2
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=10)
