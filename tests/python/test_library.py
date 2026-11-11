"""PR14 tests (Tier 1): thumbnails, the asset list and Remove unused."""

import base64
import os
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from plastis3d_scene import bake, library, mutate, sweep, tools
from plastis3d_scene.spec import PlastisError
from plastis3d_scene.store import Store

from test_bake import b64, bake_body, code_of, quad, scene_with_box
from test_capture import _png
from test_import import _load_plugin_api_standalone


@pytest.fixture()
def data_dir(tmp_path, monkeypatch):
    path = tmp_path / "data"
    monkeypatch.setenv("PLASTIS3D_DATA_DIR", str(path))
    return path


@pytest.fixture()
def store(data_dir):
    return Store(data_dir)


@pytest.fixture()
def client(data_dir):
    api = _load_plugin_api_standalone()
    app = FastAPI()
    app.include_router(api.router, prefix="/api/plugins/plastis3d")
    with TestClient(app) as c:
        yield c


def scene_with_unused_asset(store):
    """A scene whose only asset row is no longer used by any node (the node went back to a primitive)."""
    sid, rev, node_id = scene_with_box()
    baked = bake.bake_mesh(sid, store, bake_body(rev, node_id))
    undone = mutate.apply(sid, baked["scene"]["revision"], {"op": "undo"}, store=store)  # the row goes with the undo
    asset = baked["assets"][0]
    # Put the row back without a node using it, the way an import whose nodes were deleted leaves it.
    raw = store.get_scene(sid)
    raw["assets"] = [asset]
    from plastis3d_scene.store import Store as S

    S._atomic_write(store.scene_path(sid), S._dump(raw))
    return sid, asset


# --- thumbnails ------------------------------------------------------------------------------------

def test_thumbnail_round_trip_and_the_list_carries_its_revision(store):
    sid = tools.new_scene(name="Thumb")["scene"]["id"]
    assert library.thumbnail_revision(store, sid) is None
    library.put_thumbnail(store, sid, 1, _png(64, 48))
    got = library.get_thumbnail(store, sid)
    assert got["revision"] == 1 and base64.b64decode(got["png"]) == _png(64, 48)
    assert library.thumbnail_revision(store, sid) == 1
    library.put_thumbnail(store, sid, 3, _png(32, 32))  # replaced in place
    assert library.thumbnail_revision(store, sid) == 3


@pytest.mark.parametrize("png, code", [(b"x" * 10, "CAPTURE_INVALID"), (_png(600, 40), "THUMBNAIL_INVALID"), (_png(20, 20) + b"\0" * 600000, "THUMBNAIL_INVALID")])
def test_bad_thumbnails_are_refused(store, png, code):
    sid = tools.new_scene(name="Thumb")["scene"]["id"]
    assert code_of(lambda: library.put_thumbnail(store, sid, 1, png)) == code
    assert code_of(lambda: library.get_thumbnail(store, sid)) == "THUMBNAIL_NOT_FOUND"


def test_thumbnail_rules(store):
    sid = tools.new_scene(name="Thumb")["scene"]["id"]
    assert code_of(lambda: library.put_thumbnail(store, "no-such", 1, _png())) == "SCENE_NOT_FOUND"
    assert code_of(lambda: library.put_thumbnail(store, sid, 0, _png())) == "SPEC_INVALID"
    assert code_of(lambda: library.get_thumbnail(store, "../x")) == "SCENE_NOT_FOUND"


def test_deleting_a_scene_deletes_its_thumbnail(store):
    sid = tools.new_scene(name="Thumb")["scene"]["id"]
    library.put_thumbnail(store, sid, 1, _png())
    store.delete_scene(sid, store.get_scene(sid)["revision"])
    assert not (store.data_dir / "thumbnails" / ("%s.png" % sid)).exists()
    assert not (store.data_dir / "thumbnails" / ("%s.json" % sid)).exists()


# --- the asset list ---------------------------------------------------------------------------------

def test_the_asset_list_says_what_is_used(store):
    sid, rev, node_id = scene_with_box()
    baked = bake.bake_mesh(sid, store, bake_body(rev, node_id))
    view = library.list_assets(store.get_scene(sid))
    assert view["unused"] == 0 and view["assets"][0]["used"] and view["assets"][0]["usedBy"] == 1
    assert view["assets"][0]["name"] == "Edited mesh" and view["assets"][0]["bytes"] > 0


def test_a_texture_map_counts_as_use(store, tmp_path):
    from plastis3d_scene.images import import_image_path

    sid, rev, node_id = scene_with_box()
    tools.set_material(scene=sid, baseRevision=rev, id="m_pic", color="#ffffff")
    path = tmp_path / "pic.png"
    path.write_bytes(_png(8, 8))
    env = import_image_path(sid, store, str(path), base_revision=store.get_scene(sid)["revision"], material_id="m_pic", slot="baseColorMap")
    view = library.list_assets(store.get_scene(sid))
    assert view["unused"] == 0 and view["assets"][0]["format"] == "png"


def test_remove_unused_previews_then_applies_in_one_undoable_revision(store):
    sid, asset = scene_with_unused_asset(store)
    rev = store.get_scene(sid)["revision"]
    preview = library.remove_unused(store, sid, rev, dry_run=True)
    assert preview["applied"] is False and preview["removed"] == [asset["id"]] and store.get_scene(sid)["revision"] == rev
    applied = library.remove_unused(store, sid, rev)
    assert applied["applied"] is True and applied["scene"]["revision"] == rev + 1
    assert applied["library"]["unused"] == 0 and applied["assets"] == []
    # Undo restores the row; its file is still on disk because the undo entry references it.
    undone = mutate.apply(sid, rev + 1, {"op": "undo"}, store=store)
    assert [a["id"] for a in undone["assets"]] == [asset["id"]]
    assert (store.assets_dir / ("%s.glb" % asset["id"])).is_file()


def test_remove_unused_with_nothing_to_remove_writes_nothing(store):
    sid, rev, node_id = scene_with_box()
    result = library.remove_unused(store, sid, rev)
    assert result["applied"] is False and result["removed"] == [] and store.get_scene(sid)["revision"] == rev
    assert code_of(lambda: library.remove_unused(store, sid, rev + 4)) == "REVISION_CONFLICT"
    assert code_of(lambda: library.remove_unused(store, sid, "x")) == "SPEC_INVALID"
    assert code_of(lambda: mutate.apply(sid, rev, {"op": "remove_unused_assets"}, store=store)) == "SPEC_INVALID"


def test_remove_unused_never_touches_what_another_scene_uses(store):
    sid, asset = scene_with_unused_asset(store)
    other, rev, node_id = scene_with_box()
    other_baked = bake.bake_mesh(other, store, bake_body(rev, node_id))
    in_use = other_baked["assets"][0]["id"]
    old = time.time() - 3600
    for path in store.assets_dir.iterdir():
        os.utime(path, (old, old))
    library.remove_unused(store, sid, store.get_scene(sid)["revision"])
    assert (store.assets_dir / ("%s.glb" % in_use)).is_file()  # used by the other scene
    assert (store.assets_dir / ("%s.glb" % asset["id"])).is_file()  # still referenced by this scene's undo entry


def test_remove_unused_is_not_patchable(store):
    sid, rev, node_id = scene_with_box()
    with pytest.raises(PlastisError) as info:
        mutate.apply_patch(sid, rev, [{"op": "remove_unused_assets"}], store=store)
    assert info.value.code == "SPEC_INVALID"


# --- routes -----------------------------------------------------------------------------------------

def test_routes(client, store):
    base = "/api/plugins/plastis3d/scenes"
    sid, asset = scene_with_unused_asset(store)
    listed = client.get(base).json()["scenes"]
    assert next(s for s in listed if s["id"] == sid)["thumbnailRevision"] is None
    put = client.put("%s/%s/thumbnail" % (base, sid), json={"revision": store.get_scene(sid)["revision"], "png": base64.b64encode(_png(64, 64)).decode()})
    assert put.status_code == 200
    assert next(s for s in client.get(base).json()["scenes"] if s["id"] == sid)["thumbnailRevision"] == store.get_scene(sid)["revision"]
    assert client.get("%s/%s/thumbnail" % (base, sid)).json()["png"]
    assert client.put("%s/%s/thumbnail" % (base, sid), json={"revision": 1, "png": 5}).json()["code"] == "THUMBNAIL_INVALID"
    assert client.put("%s/%s/thumbnail" % (base, sid), json={"revision": 1, "png": "!!"}).json()["code"] == "THUMBNAIL_INVALID"
    assert client.get("%s/nope/thumbnail" % base).status_code == 404
    view = client.get("%s/%s/library" % (base, sid)).json()
    assert view["unused"] == 1
    rev = store.get_scene(sid)["revision"]
    dry = client.post("%s/%s/library/remove-unused" % (base, sid), json={"baseRevision": rev, "dryRun": True}).json()
    assert dry["applied"] is False and dry["removed"] == [asset["id"]]
    assert client.post("%s/%s/library/remove-unused" % (base, sid), json={"baseRevision": rev, "dryRun": "x"}).status_code == 400
    assert client.post("%s/%s/library/remove-unused" % (base, sid), json={"baseRevision": rev + 3}).status_code == 409
    done = client.post("%s/%s/library/remove-unused" % (base, sid), json={"baseRevision": rev}).json()
    assert done["applied"] is True and done["scene"]["revision"] == rev + 1
