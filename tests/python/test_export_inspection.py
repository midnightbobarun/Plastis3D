"""W05: exact, bounded, nonpublishing export preparation."""
import copy
from pathlib import Path

import pytest

from plastis3d_scene import mutate
from plastis3d_scene.export_glb import ExportInspectionLimit, export_scene, prepare_export_scene
from plastis3d_scene.store import Store


def shape_scene(store):
    scene = store.create_scene("Inspect", scene_id="inspect")
    mutate.apply(scene["id"], 1, {"op": "add_node", "node": {"id": "n_box", "name": "Box", "kind": "mesh", "primitive": {"type": "box"}, "materialId": "m_default", "transform": {"t": [0, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]}}}, store=store)
    return store.get_scene(scene["id"])


def test_preparation_matches_saved_bytes_without_publishing_or_mutating(tmp_path, monkeypatch):
    store = Store(tmp_path)
    scene = shape_scene(store)
    saved = export_scene(scene, store)
    snapshot = lambda: {str(p.relative_to(store.exports_dir)): (p.read_bytes(), p.stat().st_mtime_ns) for p in store.exports_dir.rglob("*") if p.is_file()}
    before = snapshot()
    baseline = copy.deepcopy(store.get_scene(scene["id"]))
    def forbidden(*args, **kwargs):
        raise AssertionError("read-only preparation attempted publication/collection")
    monkeypatch.setattr(store, "delete_exports", forbidden)
    monkeypatch.setattr(store, "write_scene", forbidden)
    import tempfile
    original_mkstemp = tempfile.mkstemp
    def no_export_temp(*args, **kwargs):
        target = Path(kwargs.get("dir", "")).resolve()
        if target == store.exports_dir.resolve() or store.exports_dir.resolve() in target.parents:
            forbidden()
        return original_mkstemp(*args, **kwargs)
    monkeypatch.setattr("plastis3d_scene.export_glb.tempfile.mkstemp", no_export_temp)
    prepared = prepare_export_scene(scene, store)
    assert prepared["glb"] == Path(saved["path"]).read_bytes()
    assert prepared["output"]["bytes"] == saved["bytes"]
    assert prepared["output"]["nodeOwners"]["2"] == "n_box"
    assert "n_box" in prepared["output"]["materialOwners"]["0"]
    assert snapshot() == before
    assert store.get_scene(scene["id"]) == baseline


def test_bounded_preparation_does_not_limit_actual_export_or_touch_existing_file(tmp_path):
    store = Store(tmp_path)
    scene = shape_scene(store)
    saved = export_scene(scene, store)
    original = Path(saved["path"]).read_bytes()
    with pytest.raises(ExportInspectionLimit):
        prepare_export_scene(scene, store, max_bytes=64)
    assert Path(saved["path"]).read_bytes() == original
    assert export_scene(scene, store)["bytes"] == len(original)


def test_health_checks_the_prepared_bytes_without_touching_latest_export(tmp_path, monkeypatch):
    from plastis3d_scene import compat
    store = Store(tmp_path)
    scene = shape_scene(store)
    saved = export_scene(scene, store)
    previous = Path(saved["path"]).read_bytes()
    baseline = copy.deepcopy(store.get_scene(scene["id"]))
    monkeypatch.setattr(store, "delete_exports", lambda *args, **kwargs: pytest.fail("Health tried to delete an export"))
    report, _ = compat.inspect_scene(scene, store)
    assert report["output"]["bytes"] == len(previous)
    assert report["output"]["nodes"] == 3 and report["output"]["primitives"] == 1
    assert "nodeOwners" not in report["output"]  # Internal mapping is not an unbounded REST payload.
    assert Path(saved["path"]).read_bytes() == previous and store.get_scene(scene["id"]) == baseline


def test_health_names_inspection_budget_without_imposing_an_export_cap(tmp_path, monkeypatch):
    from plastis3d_scene import compat
    store = Store(tmp_path)
    scene = shape_scene(store)
    monkeypatch.setattr(compat, "MAX_PROSPECTIVE_BYTES", 64)
    report, _ = compat.inspect_scene(scene, store)
    assert "output" not in report
    assert any("bounded inspection" in item["reason"] for item in report["unchecked"])
    assert export_scene(scene, store)["bytes"] > 64


def test_output_only_export_failure_withholds_the_heuristic_score(tmp_path):
    from plastis3d_scene import analyze
    from test_splice import _model_node, _scene_with, _sha, _stats_for, _three_part_source
    store = Store(tmp_path)
    source, parts = _three_part_source(extra={"extensionsUsed": ["KHR_materials_unlit"], "extensionsRequired": ["KHR_materials_unlit"]})
    # The source checker permits unlit, but the writer's required-extension cut
    # refuses publication. Health must expose that actual output restriction.
    scene = _scene_with(store, "required", [_model_node(store, "required", _sha(source))], assets=[(source, _stats_for(parts))])
    report = analyze.analyze_scene(scene, store)
    assert report["ok"] is False and report["analysis"]["score"]["value"] is None
    assert any(issue["code"] == "EXPORT_FAILED" and issue["provenance"] == "output" for issue in report["issues"])
    assert list(store.exports_dir.iterdir()) == []
