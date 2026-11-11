"""PR22 tests (Tier 1): the correlated screenshot protocol (C-10).

The request is single-use and bound to a profile (data directory), a scene
and a revision; one surface wins the claim; late, duplicate, foreign and
stale replies change nothing; the tool waits boundedly and returns
DESKTOP_UNAVAILABLE instead of hanging.
"""

import base64
import struct
import threading
import time
import zlib

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from plastis3d_scene import capture, tools
from plastis3d_scene.spec import PlastisError
from plastis3d_scene.store import Store

from test_import import _load_plugin_api_standalone


def _png(width=32, height=24):
    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + b"\x20\x40\x60" * width for _ in range(height))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


@pytest.fixture()
def data_dir(tmp_path, monkeypatch):
    path = tmp_path / "data"
    monkeypatch.setenv("PLASTIS3D_DATA_DIR", str(path))
    return path


@pytest.fixture()
def store(data_dir):
    return Store(data_dir)


@pytest.fixture()
def scene(store):
    return tools.new_scene(name="Shot")["scene"]


@pytest.fixture()
def client(data_dir):
    api = _load_plugin_api_standalone()
    app = FastAPI()
    app.include_router(api.router)
    with TestClient(app) as c:
        yield c


def _code(call):
    with pytest.raises(PlastisError) as info:
        call()
    return info.value.code


# --- the protocol -------------------------------------------------------------------------------

def test_request_is_bound_to_scene_and_revision(store, scene):
    request = capture.create_request(store, scene["id"], scene["revision"])
    assert len(request["id"]) == 32 and request["status"] == "pending"
    assert [r["id"] for r in capture.pending_requests(store, scene["id"])] == [request["id"]]
    assert capture.pending_requests(store, "another-scene") == []


def test_one_surface_wins_the_claim(store, scene):
    request = capture.create_request(store, scene["id"], scene["revision"])
    capture.claim(store, request["id"], "surface-aaaa")
    assert _code(lambda: capture.claim(store, request["id"], "surface-bbbb")) == "CAPTURE_CONFLICT"
    # The same surface may repeat its own claim.
    capture.claim(store, request["id"], "surface-aaaa")
    assert capture.pending_requests(store, scene["id"]) == []


def test_a_lapsed_claim_can_be_taken_over_and_the_old_reply_is_refused(store, scene):
    now = time.time()
    request = capture.create_request(store, scene["id"], scene["revision"], now=now)
    capture.claim(store, request["id"], "surface-aaaa", now=now)
    later = now + capture.CLAIM_TTL + 1
    assert [r["id"] for r in capture.pending_requests(store, scene["id"], now=later)] == [request["id"]]
    capture.claim(store, request["id"], "surface-bbbb", now=later)
    assert _code(lambda: capture.submit(store, request["id"], "surface-aaaa", scene["revision"], _png(), now=later)) == "CAPTURE_CONFLICT"
    result = capture.submit(store, request["id"], "surface-bbbb", scene["revision"], _png(), now=later)
    assert result["ok"] and (store.data_dir / "screenshots" / result["filename"]).read_bytes() == _png()


def test_reply_is_single_use_duplicates_and_late_replies_are_ignored(store, scene):
    request = capture.create_request(store, scene["id"], scene["revision"])
    capture.claim(store, request["id"], "surface-aaaa")
    capture.submit(store, request["id"], "surface-aaaa", scene["revision"], _png())
    assert _code(lambda: capture.submit(store, request["id"], "surface-aaaa", scene["revision"], _png())) == "CAPTURE_NOT_FOUND"
    expired = capture.create_request(store, scene["id"], scene["revision"], now=time.time() - 100)
    assert _code(lambda: capture.claim(store, expired["id"], "surface-aaaa")) == "CAPTURE_NOT_FOUND"
    assert _code(lambda: capture.claim(store, "0" * 32, "surface-aaaa")) == "CAPTURE_NOT_FOUND"
    assert _code(lambda: capture.claim(store, "../../etc/passwd", "surface-aaaa")) == "CAPTURE_NOT_FOUND"


def test_an_unclaimed_request_cannot_be_answered(store, scene):
    request = capture.create_request(store, scene["id"], scene["revision"])
    assert _code(lambda: capture.submit(store, request["id"], "surface-aaaa", scene["revision"], _png())) == "CAPTURE_NOT_FOUND"


def test_an_older_revision_is_stale_and_a_newer_one_is_reported(store, scene):
    request = capture.create_request(store, scene["id"], 5)
    capture.claim(store, request["id"], "surface-aaaa")
    assert _code(lambda: capture.submit(store, request["id"], "surface-aaaa", 4, _png())) == "CAPTURE_STALE"
    result = capture.submit(store, request["id"], "surface-aaaa", 7, _png())
    assert result["revision"] == 7


@pytest.mark.parametrize(
    "data",
    [b"", b"not a png", _png()[:-3], _png(8, 8), _png(5000, 16)],
)
def test_bad_pngs_are_refused_and_nothing_is_stored(store, scene, data):
    request = capture.create_request(store, scene["id"], scene["revision"])
    capture.claim(store, request["id"], "surface-aaaa")
    assert _code(lambda: capture.submit(store, request["id"], "surface-aaaa", scene["revision"], data)) == "CAPTURE_INVALID"
    assert list(capture.screenshots_dir(store).iterdir()) == []


def test_byte_cap(store, scene):
    request = capture.create_request(store, scene["id"], scene["revision"])
    capture.claim(store, request["id"], "surface-aaaa")
    big = _png() + b"\0" * capture.MAX_PNG_BYTES
    assert _code(lambda: capture.submit(store, request["id"], "surface-aaaa", scene["revision"], big)) == "CAPTURE_TOO_LARGE"


def test_two_profiles_with_the_same_scene_id_never_see_each_others_requests(tmp_path, scene):
    other = Store(tmp_path / "other-profile")
    other.create_scene("Shot", scene_id=scene["id"]) if not other.scene_exists(scene["id"]) else None
    mine = Store(tmp_path / "data")
    request = capture.create_request(mine, scene["id"], scene["revision"])
    assert capture.pending_requests(other, scene["id"]) == []
    assert _code(lambda: capture.claim(other, request["id"], "surface-aaaa")) == "CAPTURE_NOT_FOUND"


def test_only_the_newest_screenshots_per_scene_are_kept(store, scene):
    for i in range(capture.KEEP_PER_SCENE + 3):
        request = capture.create_request(store, scene["id"], scene["revision"])
        capture.claim(store, request["id"], "surface-aaaa")
        capture.submit(store, request["id"], "surface-aaaa", scene["revision"], _png())
    assert len(list(capture.screenshots_dir(store).glob("*.png"))) == capture.KEEP_PER_SCENE


def test_deleting_a_scene_deletes_its_screenshots(store, scene):
    request = capture.create_request(store, scene["id"], scene["revision"])
    capture.claim(store, request["id"], "surface-aaaa")
    capture.submit(store, request["id"], "surface-aaaa", scene["revision"], _png())
    store.delete_scene(scene["id"], scene["revision"])
    assert list(capture.screenshots_dir(store).glob("*.png")) == []


# --- the tool -----------------------------------------------------------------------------------

def _surface(store, scene_id, surface, revision_offset=0, delay=0.05):
    """A fake scene view: polls pending, claims, answers."""
    def run():
        deadline = time.time() + 5
        while time.time() < deadline:
            for request in capture.pending_requests(store, scene_id):
                try:
                    capture.claim(store, request["id"], surface)
                except PlastisError:
                    continue
                time.sleep(delay)
                capture.submit(store, request["id"], surface, request["revision"] + revision_offset, _png())
                return
            time.sleep(0.02)
    thread = threading.Thread(target=run)
    thread.start()
    return thread


def test_tool_returns_the_file_the_surface_posted(store, scene):
    thread = _surface(store, scene["id"], "surface-aaaa")
    result = tools.screenshot(scene=scene["id"], waitSeconds=5)
    thread.join()
    assert result["ok"] and result["revision"] == result["requestedRevision"] == scene["revision"]
    assert (result["width"], result["height"]) == (32, 24)
    assert open(result["path"], "rb").read() == _png()
    assert store.get_scene(scene["id"])["revision"] == scene["revision"]


def test_tool_with_two_surfaces_gets_exactly_one_answer(store, scene):
    threads = [_surface(store, scene["id"], "surface-aaaa"), _surface(store, scene["id"], "surface-bbbb")]
    result = tools.screenshot(scene=scene["id"], waitSeconds=5)
    for thread in threads:
        thread.join()
    assert result["ok"]
    assert len(list(capture.screenshots_dir(store).glob("*.png"))) == 1


def test_tool_reports_the_actual_newer_revision(store, scene):
    thread = _surface(store, scene["id"], "surface-aaaa", revision_offset=2)
    result = tools.screenshot(scene=scene["id"], waitSeconds=5)
    thread.join()
    assert result["revision"] == result["requestedRevision"] + 2


def test_tool_with_no_surface_returns_desktop_unavailable_within_the_bound(store, scene):
    started = time.monotonic()
    with pytest.raises(PlastisError) as info:
        tools.screenshot(scene=scene["id"], waitSeconds=1)
    assert info.value.code == "DESKTOP_UNAVAILABLE" and str(info.value).startswith("DESKTOP_UNAVAILABLE")
    assert time.monotonic() - started < 3
    # The timed-out request is dead: a late claim and reply are refused.
    assert capture.pending_requests(store, scene["id"]) == []


def test_tool_argument_errors(store, scene):
    assert _code(lambda: tools.screenshot(scene="no-such-scene", waitSeconds=1)) == "SCENE_NOT_FOUND"
    assert _code(lambda: tools.screenshot(scene=scene["id"], waitSeconds=0)) == "SPEC_INVALID"
    assert _code(lambda: tools.screenshot(scene=scene["id"], waitSeconds=99)) == "SPEC_INVALID"
    assert _code(lambda: tools.screenshot()) == "SPEC_INVALID"


def test_tool_broadcasts_the_request(store, scene, monkeypatch):
    seen = []
    monkeypatch.setattr(tools.mutate, "broadcast", lambda event, payload: seen.append((event, payload)))
    with pytest.raises(PlastisError):
        tools.screenshot(scene=scene["id"], waitSeconds=1)
    assert seen[0][0] == "capture.requested"
    assert set(seen[0][1]) == {"id", "scene", "revision"} and seen[0][1]["scene"] == scene["id"]


# --- the routes ---------------------------------------------------------------------------------

def test_routes_round_trip(client, store, scene):
    request = capture.create_request(store, scene["id"], scene["revision"])
    pending = client.get("/captures/pending", params={"scene": scene["id"]}).json()
    assert [r["id"] for r in pending["requests"]] == [request["id"]]
    assert client.get("/captures/pending", params={"scene": "elsewhere"}).json()["requests"] == []
    assert client.post("/captures/%s/claim" % request["id"], json={"surface": "surface-aaaa"}).status_code == 200
    lost = client.post("/captures/%s/claim" % request["id"], json={"surface": "surface-bbbb"})
    assert lost.status_code == 409 and lost.json()["code"] == "CAPTURE_CONFLICT"
    wrong = client.post("/captures/%s" % request["id"], json={"surface": "surface-bbbb", "revision": scene["revision"], "png": base64.b64encode(_png()).decode()})
    assert wrong.status_code == 409
    body = {"surface": "surface-aaaa", "revision": scene["revision"], "png": base64.b64encode(_png()).decode()}
    ok = client.post("/captures/%s" % request["id"], json=body)
    assert ok.status_code == 200 and ok.json()["width"] == 32
    again = client.post("/captures/%s" % request["id"], json=body)
    assert again.status_code == 404 and again.json()["code"] == "CAPTURE_NOT_FOUND"


def test_route_rejects_bad_input(client, store, scene):
    request = capture.create_request(store, scene["id"], scene["revision"])
    client.post("/captures/%s/claim" % request["id"], json={"surface": "surface-aaaa"})
    url = "/captures/%s" % request["id"]
    assert client.post(url, json={"surface": "surface-aaaa", "revision": 1, "png": 5}).json()["code"] == "CAPTURE_INVALID"
    assert client.post(url, json={"surface": "surface-aaaa", "revision": 1, "png": "!!!"}).json()["code"] == "CAPTURE_INVALID"
    assert client.post(url, content=b"[]").json()["code"] == "SPEC_INVALID"
    assert client.post("/captures/%s/claim" % request["id"], json={}).json()["code"] == "CAPTURE_INVALID"
    assert client.post("/captures/nope/claim", json={"surface": "surface-aaaa"}).status_code == 404
