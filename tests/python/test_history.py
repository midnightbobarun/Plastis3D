"""PR2 history / size-cap tests (Tier 1, stage-1 §5).

* Push 60 mutations: history never exceeds 50 entries.
* Inject a ~3.8 MiB payload, trigger a mutation: the oldest history
  entries drop and ``historyTruncated`` is true.
* Inject a scene body over 4 MiB: ``LIMIT_SCENE`` with no write.
* With an empty history still over the cap: ``LIMIT_SCENE`` and
  ``historyTruncated`` stays false (no write happened at all).

The big payloads live in an asset row's ``stats.ignored`` (an open,
descriptive stats field), so the injected documents stay schema-valid
and the next write is judged on size alone.

Run: pytest tests/python
"""

import json
from pathlib import Path

import pytest

from plastis3d_scene.spec import MAX_SCENE_BYTES, PlastisError, now_iso
from plastis3d_scene.store import Store


def _group_node(node_id):
    return {
        "id": node_id,
        "name": "Group",
        "parent": None,
        "kind": "group",
        "transform": {"t": [0, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
        "visible": True,
    }


def _mutate(store, scene_id, node_id, label):
    """Append one group node + one history entry; return the write result."""
    scene = store.get_scene(scene_id)
    new_scene = json.loads(json.dumps(scene))
    new_scene["nodes"].append(_group_node(node_id))
    entry = {
        "label": label,
        "at": now_iso(),
        "undo": {"nodes": {node_id: None}},
        "redo": {},
    }
    return store.write_scene(scene_id, new_scene, scene["revision"], entry)


def _rewrite_scene_file(store, scene_id, fn):
    """Directly rewrite the scene file (test injection, bypassing the store).

    ``fn`` mutates the parsed dict in place. Returns the raw bytes written.
    """
    path = store.scene_path(scene_id)
    scene = json.loads(path.read_text(encoding="utf-8"))
    fn(scene)
    raw = json.dumps(scene, sort_keys=True, separators=(",", ":")).encode("utf-8")
    path.write_bytes(raw)
    return raw


def _payload_asset(pad_chars):
    return {
        "id": "a_payload",
        "sha256": "0" * 64,
        "file": "assets/" + "0" * 64 + ".glb",
        "format": "glb",
        "bytes": 0,
        "originalName": "payload",
        "sourceFormat": "glb",
        "stats": {"ignored": ["x" * pad_chars]},
    }


def _body_size(store, scene_id):
    scene = json.loads(store.scene_path(scene_id).read_text(encoding="utf-8"))
    body = {k: v for k, v in scene.items() if k != "history"}
    return len(json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8"))


# --- bounded history -----------------------------------------------------------


def test_sixty_mutations_never_exceed_fifty_history(tmp_path):
    store = Store(tmp_path / "data")
    store.create_scene("History")
    for i in range(60):
        _mutate(store, "history", "h%d" % i, "mutation %d" % i)
    scene = store.get_scene("history")
    assert scene["revision"] == 61
    assert len(scene["history"]["undo"]) == 50
    assert len(scene["history"]["redo"]) == 0
    # The oldest 10 entries were dropped; the newest 50 remain, in order.
    labels = [e["label"] for e in scene["history"]["undo"]]
    assert labels[0] == "mutation 10"
    assert labels[-1] == "mutation 59"
    # All 60 nodes are still in the scene — only history was pruned.
    assert len(scene["nodes"]) == 62


# --- history pruning under the 4 MiB cap ----------------------------------------


def test_large_payload_prunes_oldest_history(tmp_path):
    store = Store(tmp_path / "data")
    store.create_scene("Big")
    for i in range(50):
        _mutate(store, "big", "p%d" % i, "p%d" % i)

    # Grow the scene body (without history) to just under the cap.
    scene = store.get_scene("big")
    body = {k: v for k, v in scene.items() if k != "history"}
    body["assets"] = [_payload_asset(0)]
    current_body = len(json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8"))
    pad = (MAX_SCENE_BYTES - 2000) - current_body
    assert pad > 0
    _rewrite_scene_file(store, "big", lambda s: s.update(assets=[_payload_asset(pad)]))
    body_size = _body_size(store, "big")
    assert MAX_SCENE_BYTES - 3000 < body_size < MAX_SCENE_BYTES
    file_size_before = store.scene_path("big").stat().st_size
    assert file_size_before > MAX_SCENE_BYTES  # body + 50 entries overflows

    result = _mutate(store, "big", "p_after", "after payload")
    assert result["historyTruncated"] is True
    scene = result["scene"]
    assert store.scene_path("big").stat().st_size <= MAX_SCENE_BYTES
    assert len(scene["history"]["undo"]) < 50
    labels = [e["label"] for e in scene["history"]["undo"]]
    assert labels[0] != "p0"  # the oldest entries were dropped
    assert labels[-1] == "after payload"
    # The new node survived the prune. The payload row is an asset nothing reaches, so the
    # truncation sweep (PR24, C-03) removed it in the same revision.
    assert scene["assets"] == []
    assert any(n["id"] == "p_after" for n in scene["nodes"])


# --- LIMIT_SCENE -----------------------------------------------------------------


def test_body_over_cap_returns_limit_scene_without_writing(tmp_path):
    store = Store(tmp_path / "data")
    store.create_scene("Over")
    for i in range(3):
        _mutate(store, "over", "o%d" % i, "o%d" % i)

    scene = store.get_scene("over")
    body = {k: v for k, v in scene.items() if k != "history"}
    body["assets"] = [_payload_asset(0)]
    current_body = len(json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8"))
    pad = (MAX_SCENE_BYTES + 1000) - current_body
    _rewrite_scene_file(store, "over", lambda s: s.update(assets=[_payload_asset(pad)]))
    assert _body_size(store, "over") > MAX_SCENE_BYTES
    before = store.scene_path("over").read_bytes()

    current = json.loads(before.decode("utf-8"))
    new_scene = json.loads(json.dumps(current))
    new_scene["nodes"].append(_group_node("o_after"))
    with pytest.raises(PlastisError) as excinfo:
        store.write_scene("over", new_scene, current["revision"], None)
    assert excinfo.value.code == "LIMIT_SCENE"
    # Nothing was written: the file bytes are identical.
    assert store.scene_path("over").read_bytes() == before


def test_body_over_cap_with_empty_history(tmp_path):
    store = Store(tmp_path / "data")
    store.create_scene("OverEmpty")

    scene = store.get_scene("overempty")
    body = {k: v for k, v in scene.items() if k != "history"}
    body["assets"] = [_payload_asset(0)]
    current_body = len(json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8"))
    pad = (MAX_SCENE_BYTES + 1000) - current_body
    _rewrite_scene_file(store, "overempty", lambda s: s.update(assets=[_payload_asset(pad)]))
    assert _body_size(store, "overempty") > MAX_SCENE_BYTES
    before = store.scene_path("overempty").read_bytes()

    current = json.loads(before.decode("utf-8"))
    assert current["history"] == {"undo": [], "redo": [], "limit": 50}
    new_scene = json.loads(json.dumps(current))
    new_scene["nodes"].append(_group_node("o_after"))
    with pytest.raises(PlastisError) as excinfo:
        store.write_scene("overempty", new_scene, current["revision"], None)
    assert excinfo.value.code == "LIMIT_SCENE"
    # No write happened, so nothing was truncated: the file is byte-identical
    # and its history is still empty (historyTruncated stays false — there
    # is no successful write for it to be true of).
    after = store.scene_path("overempty").read_bytes()
    assert after == before
    assert json.loads(after.decode("utf-8"))["history"]["undo"] == []
