"""PR17 tests (Tier 1): the analyzer (C-11).

It is the compatibility report plus measurements: named failures first,
unknowns next, then counts, then an optional heuristic score that is labelled,
versioned, tied to a visible budget and withheld whenever a hard error exists.
"""

import struct

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from plastis3d_scene import analyze, compat, tools
from plastis3d_scene.spec import PlastisError
from plastis3d_scene.store import Store

from test_import import _load_plugin_api_standalone
from test_textures import _png


@pytest.fixture()
def data_dir(tmp_path, monkeypatch):
    path = tmp_path / "data"
    monkeypatch.setenv("PLASTIS3D_DATA_DIR", str(path))
    return path


@pytest.fixture()
def store(data_dir):
    return Store(data_dir)


T = {"t": [0, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]}


def _scene():
    return tools.new_scene(name="Analyze")["scene"]["id"]


def _spheres(scene_id, count, rev=1, name="S"):
    sphere = {"type": "sphere", "widthSegments": 64, "heightSegments": 64}  # 8,064 triangles
    nodes = [{"name": "%s%d" % (name, i), "kind": "mesh", "primitive": sphere, "materialId": "m_default", "transform": T} for i in range(count)]
    return tools.build_scene(scene=scene_id, baseRevision=rev, nodes=nodes)


def _stl(triangles):
    out = bytearray(b"x" * 80) + struct.pack("<I", len(triangles))
    for tri in triangles:
        out += struct.pack("<3f", 0, 0, 1)
        for v in tri:
            out += struct.pack("<3f", *v)
        out += b"\x00\x00"
    return bytes(out)


def _stl_file(tmp_path, name="plate.stl", n=1):
    path = tmp_path / name
    path.write_bytes(_stl([((0, 0, 0), (1, 0, 0), (0, 1, 0))] * n))
    return str(path)


def _component(result, name):
    return next(c for c in result["analysis"]["score"]["components"] if c["name"] == name)


# --- It is the compatibility report, plus an analysis block -----------------------------------


def test_the_analyzer_adds_to_the_report_and_does_not_replace_it(store, tmp_path):
    scene_id = _scene()
    tools.import_model(scene=scene_id, baseRevision=1, path=_stl_file(tmp_path))
    plain = tools.check_gltf(scene=scene_id)
    full = tools.analyze(scene=scene_id)
    analysis = full.pop("analysis")
    assert full == plain  # the same findings, the same order, the same stats: no second checker
    assert set(analysis) == {"version", "budget", "counts", "score"}


def test_failures_come_first_in_the_findings(store, tmp_path):
    scene_id = _scene()
    env = tools.import_model(scene=scene_id, baseRevision=1, path=_stl_file(tmp_path))
    (store.assets_dir / (env["assets"][0]["sha256"] + ".glb")).unlink()
    tools.add_node(scene=scene_id, baseRevision=env["scene"]["revision"], kind="mesh", name="Huge",
                   primitive={"type": "box"}, materialId="m_default", transform=dict(T, s=[20000, 1, 1]))
    result = tools.analyze(scene=scene_id)
    severities = [i["severity"] for i in result["issues"]]
    assert severities[0] == "error" and severities == sorted(severities, key={"error": 0, "warning": 1, "info": 2}.get)


# --- Measured counts -----------------------------------------------------------------------------


def test_counts_for_a_primitive_scene():
    scene_id = _scene()
    _spheres(scene_id, 3)
    counts = tools.analyze(scene=scene_id)["analysis"]["counts"]
    assert counts["triangles"] == 3 * 8064 and counts["meshNodes"] == 3
    assert counts["drawCalls"] == 3 and counts["drawCallsIsEstimate"] is True
    assert counts["materials"] == 1  # all three share m_default
    assert counts["textures"] == 0 and counts["textureBytes"] == 0
    assert counts["nodes"] == 3 and counts["lights"] == 0  # build_scene replaced the default rig


def test_a_hidden_node_is_not_a_draw_call():
    scene_id = _scene()
    env = _spheres(scene_id, 2)
    first = next(n for n in env["nodes"] if n["name"] == "S0")
    tools.update_node(scene=scene_id, baseRevision=env["scene"]["revision"], id=first["id"], visible=False)
    assert tools.analyze(scene=scene_id)["analysis"]["counts"]["drawCalls"] == 1


def test_counts_for_an_imported_model_and_each_instance(store, tmp_path):
    scene_id = _scene()
    env = tools.import_model(scene=scene_id, baseRevision=1, path=_stl_file(tmp_path, n=4), explode=False)
    one = tools.analyze(scene=scene_id)["analysis"]["counts"]
    assert one["triangles"] == 4 and one["modelNodes"] == 1
    assert one["drawCalls"] == 1 and one["materials"] == 1 and one["assetBytes"] > 0
    model = next(n for n in env["nodes"] if n["kind"] == "model")
    tools.duplicate_node(scene=scene_id, baseRevision=env["scene"]["revision"], id=model["id"])
    two = tools.analyze(scene=scene_id)["analysis"]["counts"]
    assert two["triangles"] == 8 and two["drawCalls"] == 2  # each instance draws
    assert two["materials"] == 1  # but the asset's materials are counted once


def test_texture_memory_counts_each_image_once_with_a_mip_chain(store, tmp_path):
    from plastis3d_scene import images

    scene_id = _scene()
    env = tools.set_material(scene=scene_id, baseRevision=1, id="m_t", color="#ffffff")
    env = tools.add_node(scene=scene_id, baseRevision=env["scene"]["revision"], kind="mesh", name="Box",
                         primitive={"type": "box"}, materialId="m_t", transform=T)
    path = tmp_path / "t.png"
    path.write_bytes(_png(64, 32))
    rev = env["scene"]["revision"]
    for slot in ("baseColorMap", "emissiveMap"):  # the same image in two slots
        rev = images.import_image_path(scene_id, store, str(path), base_revision=rev, material_id="m_t", slot=slot)["scene"]["revision"]
    counts = tools.analyze(scene=scene_id)["analysis"]["counts"]
    assert counts["textures"] == 1 and counts["texturePixels"] == 64 * 32
    assert counts["textureBytes"] == int(64 * 32 * 4 * 4 / 3)


def test_an_asset_target_measures_only_that_asset(store, tmp_path):
    scene_id = _scene()
    env = tools.import_model(scene=scene_id, baseRevision=1, path=_stl_file(tmp_path, n=3), explode=False)
    _spheres(scene_id, 2, rev=env["scene"]["revision"], name="Extra")
    result = tools.analyze(scene=scene_id, assetId=env["assets"][0]["id"])
    assert result["target"]["kind"] == "asset"
    assert result["analysis"]["counts"]["triangles"] == 3
    assert "nodes" not in result["analysis"]["counts"]


# --- Budgets and the score ----------------------------------------------------------------------------


def test_the_budgets_are_published_and_chosen_by_name():
    assert set(analyze.BUDGETS) == {"mobile", "desktop"}
    assert analyze.BUDGETS["mobile"]["triangles"] == compat.TRIS_MOBILE  # one number, shared with the report
    assert analyze.BUDGETS["desktop"]["triangles"] == compat.TRIS_HEAVY
    scene_id = _scene()
    default = tools.analyze(scene=scene_id)["analysis"]["budget"]
    assert default["name"] == "mobile" and default["label"] == "Phone"
    assert tools.analyze(scene=scene_id, budget="desktop")["analysis"]["budget"]["name"] == "desktop"
    with pytest.raises(PlastisError) as excinfo:
        tools.analyze(scene=scene_id, budget="server")
    assert excinfo.value.code == "SPEC_INVALID"


def test_the_weights_are_versioned_and_sum_to_one():
    assert analyze.WEIGHTS_VERSION == 1 and analyze.ANALYZER_VERSION == 1
    assert sum(analyze.WEIGHTS.values()) == pytest.approx(1.0)
    score = tools.analyze(scene=_scene())["analysis"]["score"]
    assert score["weightsVersion"] == 1 and score["weights"] == analyze.WEIGHTS
    assert score["heuristic"] is True and "not a certificate" in score["label"]


def test_a_scene_inside_the_budget_scores_100():
    scene_id = _scene()
    _spheres(scene_id, 2)
    score = tools.analyze(scene=scene_id)["analysis"]["score"]
    assert score["value"] == 100 and score["reason"] is None
    assert [c["name"] for c in score["components"]] == ["triangles", "drawCalls", "materials", "textureMemory"]
    assert sum(c["points"] for c in score["components"]) == pytest.approx(100.0)


def test_the_score_falls_linearly_to_zero_at_twice_the_budget():
    assert analyze._credit(50, 100) == 1.0 and analyze._credit(100, 100) == 1.0
    assert analyze._credit(150, 100) == pytest.approx(0.5)
    assert analyze._credit(200, 100) == 0.0 and analyze._credit(900, 100) == 0.0
    scene_id = _scene()
    _spheres(scene_id, 15)  # 120,960 tris: 1.21x the phone budget
    result = tools.analyze(scene=scene_id)
    tris = _component(result, "triangles")
    assert tris["ratio"] == pytest.approx(1.21, abs=0.01)
    assert tris["points"] == pytest.approx(35 * (2 - 1.2096), abs=0.1)
    assert result["analysis"]["score"]["value"] == 100 - round(35 - tris["points"])
    # The same scene is comfortably inside the desktop budget.
    assert tools.analyze(scene=scene_id, budget="desktop")["analysis"]["score"]["value"] == 100


def test_a_heavier_scene_never_scores_higher():
    scores = []
    for count in (2, 14, 20, 30):
        scene_id = _scene()
        _spheres(scene_id, count)
        scores.append(tools.analyze(scene=scene_id)["analysis"]["score"]["value"])
    assert scores == sorted(scores, reverse=True) and scores[0] > scores[-1]


def test_any_hard_error_withholds_the_score(store, tmp_path):
    scene_id = _scene()
    env = tools.import_model(scene=scene_id, baseRevision=1, path=_stl_file(tmp_path))
    assert tools.analyze(scene=scene_id)["analysis"]["score"]["value"] is not None
    (store.assets_dir / (env["assets"][0]["sha256"] + ".glb")).unlink()
    result = tools.analyze(scene=scene_id)
    score = result["analysis"]["score"]
    assert result["ok"] is False and score["value"] is None
    assert "hard problems" in score["reason"].lower() and score["components"] == []


def test_warnings_do_not_withhold_the_score_but_partial_checks_are_flagged(store, tmp_path, monkeypatch):
    scene_id = _scene()
    tools.import_model(scene=scene_id, baseRevision=1, path=_stl_file(tmp_path, n=3))
    complete = tools.analyze(scene=scene_id)
    assert any(i["code"] == "MISSING_NORMALS" for i in complete["issues"])  # a warning
    assert complete["analysis"]["score"]["value"] is not None
    assert complete["analysis"]["score"]["basedOnPartialChecks"] is False
    monkeypatch.setattr(compat, "MAX_DEGENERATE_SCAN_TRIS", 1)
    partial = tools.analyze(scene=scene_id)
    assert partial["unchecked"] and partial["analysis"]["score"]["basedOnPartialChecks"] is True


def test_an_unsizable_embedded_image_is_an_unknown_and_a_lower_bound(store, tmp_path):
    scene_id = _scene()
    env = tools.import_model(scene=scene_id, baseRevision=1, path=_stl_file(tmp_path), explode=False)
    # Pretend the asset carries an image the header reader cannot size.
    real = compat._image_sizes
    compat._image_sizes = lambda gltf, buffers: ([], 2)
    try:
        result = tools.analyze(scene=scene_id)
    finally:
        compat._image_sizes = real
    assert any("lower bound" in u["reason"] for u in result["unchecked"])
    assert env["assets"]


def test_the_analyzer_is_read_only_and_repeatable(store, tmp_path):
    scene_id = _scene()
    tools.import_model(scene=scene_id, baseRevision=1, path=_stl_file(tmp_path))
    before = store.get_scene(scene_id)
    files = sorted(p.name for p in store.assets_dir.iterdir())
    assert tools.analyze(scene=scene_id) == tools.analyze(scene=scene_id)
    assert store.get_scene(scene_id) == before
    assert sorted(p.name for p in store.assets_dir.iterdir()) == files and list(store.exports_dir.iterdir()) == []


# --- The tool and the route ----------------------------------------------------------------------------


def test_the_tool_is_registered_read_only_with_a_budget_enum():
    entry = next(t for t in tools.tool_schemas() if t["name"] == "plastis3d_analyze")
    props = entry["schema"]["parameters"]["properties"]
    assert set(props) == {"scene", "assetId", "budget"} and "baseRevision" not in props
    assert props["budget"]["enum"] == ["mobile", "desktop"]
    assert "heuristic" in entry["description"]


@pytest.fixture()
def client(data_dir):
    api = _load_plugin_api_standalone()
    app = FastAPI()
    app.include_router(api.router, prefix="/api/plugins/plastis3d")
    with TestClient(app) as c:
        yield c


def test_route_matches_the_tool_and_refuses_a_bad_budget(client, tmp_path):
    sid = client.post("/api/plugins/plastis3d/scenes", json={"name": "R"}).json()["scene"]["id"]
    env = client.post("/api/plugins/plastis3d/scenes/%s/imports" % sid,
                      json={"backendPath": _stl_file(tmp_path), "baseRevision": 1}).json()
    body = client.get("/api/plugins/plastis3d/scenes/%s/analyze" % sid).json()
    assert body["analysis"]["budget"]["name"] == "mobile" and body["analysis"]["score"]["value"] == 100
    desktop = client.get("/api/plugins/plastis3d/scenes/%s/analyze" % sid, params={"budget": "desktop"}).json()
    assert desktop["analysis"]["budget"]["name"] == "desktop"
    asset = client.get("/api/plugins/plastis3d/scenes/%s/analyze" % sid, params={"assetId": env["assets"][0]["id"]})
    assert asset.json()["target"]["kind"] == "asset"
    assert client.get("/api/plugins/plastis3d/scenes/%s/analyze" % sid, params={"budget": "x"}).status_code == 400
    assert client.get("/api/plugins/plastis3d/scenes/%s/analyze" % sid, params={"assetId": "x" * 64}).status_code == 404
    assert client.get("/api/plugins/plastis3d/scenes/nope/analyze").status_code == 404
