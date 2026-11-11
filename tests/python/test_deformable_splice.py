"""PR13 tests (Tier 1): skins, animations and morph targets survive export.

The fixture is built by tests/fixtures/make_skin_clip_morph_glb.py: one
two-bone skin, one clip (a bone rotation and a morph-weights channel) and
one morph target. Deformation reaches export only through a locked
``model`` node (C-05); parts of deformable meshes, and any reference that
leaves the copied subtree, fail closed with ``EXPORT_FAILED``.
"""

import copy
import importlib.util
import struct
import time
from pathlib import Path

import pytest

from plastis3d_scene import glb as glb_mod
from plastis3d_scene import tools
from plastis3d_scene.export_glb import export_scene
from plastis3d_scene.spec import PlastisError
from plastis3d_scene.store import Store

from test_splice import (
    _expect_failed,
    _model_node,
    _parse_glb,
    _part_node,
    _scene_with,
    _sha,
)

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
FIXTURES = REPO_ROOT / "tests" / "fixtures"


def _generator():
    spec = importlib.util.spec_from_file_location(
        "make_skin_clip_morph_glb", FIXTURES / "make_skin_clip_morph_glb.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GEN = _generator()


@pytest.fixture()
def store(tmp_path):
    return Store(tmp_path / "data")


def _scan(glb_bytes):
    return glb_mod.scan(glb_bytes, source_format="glb", deadline=time.monotonic() + 30)


def _scene_for(store, glb_bytes, nodes=None, scene_id="deform"):
    sha = _sha(glb_bytes)
    nodes = nodes if nodes is not None else [_model_node(store, scene_id, sha)]
    return _scene_with(store, scene_id, nodes, assets=[(glb_bytes, _scan(glb_bytes).stats)])


def _export(store, glb_bytes, nodes=None):
    scene = _scene_for(store, glb_bytes, nodes)
    result = export_scene(scene, store)
    return _parse_glb(result["path"]), result


def _by_name(gltf, name):
    return [i for i, n in enumerate(gltf["nodes"]) if n.get("name") == name]


def _mutated(change):
    """The source asset with ``change(gltf)`` applied to its JSON."""
    gltf, blob = GEN.build_source_gltf()
    change(gltf)
    return glb_mod.build_glb(gltf, [blob])


# --- Accepted: one locked instance ------------------------------------------------


def test_source_fixture_has_one_skin_one_clip_one_morph():
    scan = _scan(GEN.build_source_glb())
    assert scan.stats["skins"] == 1
    assert scan.stats["clips"] == 1
    gltf = scan.gltf
    assert len(gltf["meshes"][1]["primitives"][0]["targets"]) == 1


def test_export_keeps_skin_clip_and_morph(store):
    (gltf, blob), result = _export(store, GEN.build_source_glb())
    assert result["ok"] is True
    # The exported file is a GLB our own scan accepts, ranges proven.
    _scan((Path(result["path"])).read_bytes())

    assert len(gltf["skins"]) == 1 and len(gltf["animations"]) == 1
    skin = gltf["skins"][0]
    bone0, bone1 = _by_name(gltf, "bone0")[0], _by_name(gltf, "bone1")[0]
    assert skin["joints"] == [bone0, bone1]
    assert skin["skeleton"] == bone0
    assert gltf["nodes"][bone0]["children"] == [bone1]  # hierarchy rebased
    # The inverse bind matrices are the source bytes: bone1 is lifted by -1.
    accessor = gltf["accessors"][skin["inverseBindMatrices"]]
    assert accessor["type"] == "MAT4" and accessor["count"] == 2
    view = gltf["bufferViews"][accessor["bufferView"]]
    matrices = struct.unpack_from("<32f", blob, view["byteOffset"])
    assert matrices[16 + 13] == -1.0 and matrices[0] == 1.0

    skinned = gltf["nodes"][_by_name(gltf, "SkinnedMesh")[0]]
    assert skinned["skin"] == 0 and "mesh" in skinned
    attributes = gltf["meshes"][skinned["mesh"]]["primitives"][0]["attributes"]
    assert {"JOINTS_0", "WEIGHTS_0"} <= set(attributes)

    morph_index = _by_name(gltf, "Morpher")[0]
    morph_node = gltf["nodes"][morph_index]
    assert morph_node["weights"] == [0.5]
    morph_mesh = gltf["meshes"][morph_node["mesh"]]
    assert morph_mesh["weights"] == [0.5]
    target = morph_mesh["primitives"][0]["targets"][0]["POSITION"]
    assert gltf["accessors"][target]["count"] == 3
    delta_view = gltf["bufferViews"][gltf["accessors"][target]["bufferView"]]
    assert struct.unpack_from("<9f", blob, delta_view["byteOffset"]) == (0, 0, 1) * 3

    animation = gltf["animations"][0]
    targets = {(c["target"]["node"], c["target"]["path"]) for c in animation["channels"]}
    assert targets == {(bone1, "rotation"), (morph_index, "weights")}
    for sampler in animation["samplers"]:
        assert gltf["accessors"][sampler["input"]]["count"] == 2
        assert sampler["interpolation"] == "LINEAR"
    times_view = gltf["bufferViews"][gltf["accessors"][animation["samplers"][0]["input"]]["bufferView"]]
    assert struct.unpack_from("<2f", blob, times_view["byteOffset"]) == (0.0, 1.0)


def test_model_node_transform_places_the_rig(store):
    sha = _sha(GEN.build_source_glb())
    node = _model_node(store, "deform", sha, name="Rig",
                       transform={"t": [3, 0, 0], "r": [0, 0, 0], "s": [2, 2, 2]})
    (gltf, _blob), _result = _export(store, GEN.build_source_glb(), [node])
    rig = gltf["nodes"][_by_name(gltf, "Rig")[0]]
    assert rig["translation"] == [3.0, 0.0, 0.0] and rig["scale"] == [2.0, 2.0, 2.0]
    assert len(rig["children"]) == 3  # Armature, SkinnedMesh and Morpher roots


# --- Accepted: two instances own their own skin and clip -----------------------------


def test_two_instances_get_independent_skins_and_animations(store):
    sha = _sha(GEN.build_source_glb())
    nodes = [
        _model_node(store, "deform", sha, name="Rig A", node_id="n_a"),
        _model_node(store, "deform", sha, name="Rig B", node_id="n_b",
                    transform={"t": [5, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]}),
    ]
    (gltf, _blob), _result = _export(store, GEN.build_source_glb(), nodes)
    assert len(gltf["skins"]) == 2 and len(gltf["animations"]) == 2
    first, second = gltf["skins"]
    assert set(first["joints"]).isdisjoint(second["joints"])
    # Each skinned node points at its own instance's skin.
    skinned = [n for n in gltf["nodes"] if n.get("name") == "SkinnedMesh"]
    assert sorted(n["skin"] for n in skinned) == [0, 1]
    # Each clip animates only its own instance's bones and morph node.
    owned = [set(s["joints"]) for s in gltf["skins"]]
    for animation, joints in zip(gltf["animations"], owned):
        bone_targets = {c["target"]["node"] for c in animation["channels"]
                        if c["target"]["path"] == "rotation"}
        assert bone_targets <= joints
    morphers = _by_name(gltf, "Morpher")
    weight_targets = [
        {c["target"]["node"] for c in a["channels"] if c["target"]["path"] == "weights"}
        for a in gltf["animations"]
    ]
    assert weight_targets[0] != weight_targets[1]
    assert set().union(*weight_targets) == set(morphers)
    # The accessors (inputs, outputs, matrices, targets) stay shared: one copy.
    assert gltf["animations"][0]["samplers"] == gltf["animations"][1]["samplers"]
    assert first["inverseBindMatrices"] == second["inverseBindMatrices"]


def test_spec_child_of_a_deformable_model_sits_beside_the_rig(store):
    sha = _sha(GEN.build_source_glb())
    nodes = [
        _model_node(store, "deform", sha, name="Rig", node_id="n_rig"),
        {"id": "n_box", "name": "Hat", "kind": "group", "parent": "n_rig",
         "transform": {"t": [0, 3, 0], "r": [0, 0, 0], "s": [1, 1, 1]}},
    ]
    (gltf, _blob), _result = _export(store, GEN.build_source_glb(), nodes)
    rig = gltf["nodes"][_by_name(gltf, "Rig")[0]]
    assert len(rig["children"]) == 4
    assert len(gltf["skins"]) == 1


def test_asset_without_deformation_exports_no_skins_or_animations(store):
    gltf_src, blob = GEN.build_source_gltf()
    for key in ("skins", "animations"):
        del gltf_src[key]
    for node in gltf_src["nodes"]:
        node.pop("skin", None)
    for mesh in gltf_src["meshes"]:
        for primitive in mesh["primitives"]:
            primitive.pop("targets", None)
        mesh.pop("weights", None)
    del gltf_src["nodes"][GEN.N_MORPHER]["weights"]
    (gltf, _blob), _result = _export(store, glb_mod.build_glb(gltf_src, [blob]))
    assert "skins" not in gltf and "animations" not in gltf


# --- Refusals: every reference that leaves the copy, and C-05 -------------------------


def _outside_node(gltf):
    """Add a node the default scene does not reach; returns its index."""
    gltf["nodes"].append({"name": "Orphan"})
    return len(gltf["nodes"]) - 1


def _skin_joint_outside(gltf):
    gltf["skins"][0]["joints"][1] = _outside_node(gltf)


def _skeleton_outside(gltf):
    gltf["skins"][0]["skeleton"] = _outside_node(gltf)


def _channel_target_outside(gltf):
    gltf["animations"][0]["channels"][0]["target"]["node"] = _outside_node(gltf)


def _channel_missing_node(gltf):
    del gltf["animations"][0]["channels"][0]["target"]["node"]


def _channel_pointer_path(gltf):
    gltf["animations"][0]["channels"][0]["target"]["path"] = "pointer"


def _channel_sampler_out_of_range(gltf):
    gltf["animations"][0]["channels"][0]["sampler"] = 9


def _sampler_accessor_out_of_range(gltf):
    gltf["animations"][0]["samplers"][0]["output"] = 999


def _sampler_bad_interpolation(gltf):
    gltf["animations"][0]["samplers"][0]["interpolation"] = "SPLINE"


def _animation_extension(gltf):
    gltf["animations"][0]["extensions"] = {"X_vendor": {}}


def _target_extension(gltf):
    gltf["animations"][0]["channels"][0]["target"]["extensions"] = {"KHR_animation_pointer": {}}


def _skin_extension(gltf):
    gltf["skins"][0]["extensions"] = {"X_vendor": {}}


def _ibm_not_mat4(gltf):
    gltf["skins"][0]["inverseBindMatrices"] = 0  # a VEC3 accessor


def _ibm_out_of_range(gltf):
    gltf["skins"][0]["inverseBindMatrices"] = 999


def _joint_twice(gltf):
    gltf["skins"][0]["joints"] = [1, 1]


def _morph_weights_mismatch(gltf):
    gltf["meshes"][1]["weights"] = [0.1, 0.2]


def _node_weights_mismatch(gltf):
    gltf["nodes"][GEN.N_MORPHER]["weights"] = [0.1, 0.2]


def _morph_target_accessor_out_of_range(gltf):
    gltf["meshes"][1]["primitives"][0]["targets"] = [{"POSITION": 999}]


def _mixed_target_counts(gltf):
    gltf["meshes"][1]["primitives"].append(copy.deepcopy(gltf["meshes"][1]["primitives"][0]))
    del gltf["meshes"][1]["primitives"][1]["targets"]


@pytest.mark.parametrize(
    "change, word",
    [
        (_skin_joint_outside, "index"),
        (_skeleton_outside, "index"),
        (_channel_target_outside, "index"),
        (_channel_missing_node, "index"),
        (_channel_pointer_path, "animation"),
        (_channel_sampler_out_of_range, "index"),
        (_sampler_accessor_out_of_range, "index"),
        (_sampler_bad_interpolation, "animation"),
        (_animation_extension, "extension"),
        (_target_extension, "extension"),
        (_skin_extension, "extension"),
        (_ibm_not_mat4, "skin"),
        (_ibm_out_of_range, "index"),
        (_joint_twice, "skin"),
        (_morph_weights_mismatch, "morph"),
        (_node_weights_mismatch, "morph"),
        (_morph_target_accessor_out_of_range, "index"),
        (_mixed_target_counts, "morph"),
    ],
    ids=lambda v: getattr(v, "__name__", v),
)
def test_export_fails_closed_when_a_reference_leaves_the_copy(store, change, word):
    glb_bytes = _mutated(change)
    scene = _scene_for(store, glb_bytes)
    before = sorted(p.name for p in store.exports_dir.iterdir())
    with pytest.raises(PlastisError) as excinfo:
        export_scene(scene, store)
    assert excinfo.value.code == "EXPORT_FAILED"
    assert ("%s:" % word) in str(excinfo.value), str(excinfo.value)
    assert sorted(p.name for p in store.exports_dir.iterdir()) == before


def test_part_of_a_skinned_primitive_is_refused(store):
    glb_bytes = GEN.build_source_glb()
    sha = _sha(glb_bytes)
    nodes = [_part_node("n_p", "Skinned part", sha, 0, 0)]
    scene = _scene_for(store, glb_bytes, nodes)
    with pytest.raises(PlastisError) as excinfo:
        export_scene(scene, store)
    assert excinfo.value.code == "EXPORT_FAILED"
    assert "skin:" in str(excinfo.value) and "explode: false" in str(excinfo.value)


def test_part_of_a_morph_primitive_is_refused(store):
    glb_bytes = GEN.build_source_glb()
    sha = _sha(glb_bytes)
    scene = _scene_for(store, glb_bytes, [_part_node("n_p", "Morph part", sha, 1, 0)])
    with pytest.raises(PlastisError) as excinfo:
        export_scene(scene, store)
    assert "morph:" in str(excinfo.value)


# --- Through the real import engine ---------------------------------------------------


@pytest.fixture()
def data_dir(tmp_path, monkeypatch):
    path = tmp_path / "data"
    monkeypatch.setenv("PLASTIS3D_DATA_DIR", str(path))
    return path


def test_import_locked_then_export_keeps_the_clip(data_dir, tmp_path):
    source = tmp_path / "rig.glb"
    source.write_bytes(GEN.build_source_glb())
    scene_id = tools.new_scene(name="Rig")["scene"]["id"]
    envelope = tools.import_model(scene=scene_id, baseRevision=1, path=str(source), explode=False)
    assert envelope["assets"][0]["stats"]["clips"] == 1
    assert envelope["assets"][0]["stats"]["skins"] == 1
    exported = tools.export_glb(scene=scene_id)
    gltf, _blob = _parse_glb(exported["path"])
    assert len(gltf["skins"]) == 1 and len(gltf["animations"]) == 1


def test_exploding_a_deformable_import_is_still_refused(data_dir, tmp_path):
    """PR13 does not relax C-05: the editable explosion stays refused."""
    source = tmp_path / "rig.glb"
    source.write_bytes(GEN.build_source_glb())
    scene_id = tools.new_scene(name="Rig")["scene"]["id"]
    with pytest.raises(PlastisError) as excinfo:
        tools.import_model(scene=scene_id, baseRevision=1, path=str(source), explode=True)
    assert "explode: false" in str(excinfo.value)
    assert tools.get_scene(scene=scene_id)["scene"]["revision"] == 1


def test_duplicate_of_a_locked_rig_exports_two_clips(data_dir, tmp_path):
    source = tmp_path / "rig.glb"
    source.write_bytes(GEN.build_source_glb())
    scene_id = tools.new_scene(name="Rig")["scene"]["id"]
    envelope = tools.import_model(scene=scene_id, baseRevision=1, path=str(source), explode=False)
    model = [n for n in envelope["nodes"] if n["kind"] == "model"][0]
    duplicated = tools.duplicate_node(
        scene=scene_id, baseRevision=envelope["scene"]["revision"], id=model["id"]
    )
    assert len([n for n in duplicated["nodes"] if n["kind"] == "model"]) == 2
    gltf, _blob = _parse_glb(tools.export_glb(scene=scene_id)["path"])
    assert len(gltf["skins"]) == 2 and len(gltf["animations"]) == 2


# --- Fixtures cannot drift --------------------------------------------------------------


def _glb_chunks(data):
    import json as _json
    length = struct.unpack("<I", data[12:16])[0]
    doc = _json.loads(data[20:20 + length].decode("utf-8"))
    return doc, data[20 + length:]


def _assert_json_close(expected, actual, where="$"):
    if isinstance(expected, dict):
        assert isinstance(actual, dict) and expected.keys() == actual.keys(), where
        for key in expected:
            _assert_json_close(expected[key], actual[key], "%s.%s" % (where, key))
    elif isinstance(expected, list):
        assert isinstance(actual, list) and len(expected) == len(actual), where
        for index, (e, a) in enumerate(zip(expected, actual)):
            _assert_json_close(e, a, "%s[%d]" % (where, index))
    elif isinstance(expected, float) or isinstance(actual, float):
        assert actual == pytest.approx(expected, rel=1e-12, abs=1e-12), where
    else:
        assert expected == actual, where


def _assert_glb_close(expected, actual):
    """Same GLB up to last-digit float noise (libm differs between platforms)."""
    exp_doc, exp_bin = _glb_chunks(expected)
    act_doc, act_bin = _glb_chunks(actual)
    _assert_json_close(exp_doc, act_doc)
    assert len(act_bin) == len(exp_bin)
    if act_bin != exp_bin:
        count = len(exp_bin) // 4
        exp_f = struct.unpack("<%df" % count, exp_bin[: count * 4])
        act_f = struct.unpack("<%df" % count, act_bin[: count * 4])
        assert act_f == pytest.approx(exp_f, rel=1e-6, abs=1e-6)


def test_checked_in_fixtures_match_the_generator(tmp_path):
    assert (FIXTURES / "skin-clip-morph.glb").read_bytes() == GEN.build_source_glb()
    fresh = GEN.export_fixture(tmp_path / "data")
    _assert_glb_close((FIXTURES / "deformable-export.glb").read_bytes(), fresh)


def test_proven_unreachable_skins_and_clips_are_omitted_but_used_refs_remain_closed(store):
    def add_unused(gltf):
        gltf["nodes"].extend([{"name": "OtherBone0"}, {"name": "OtherBone1"}])
        skin = copy.deepcopy(gltf["skins"][0]); skin["joints"] = [5, 6]; skin["skeleton"] = 5
        gltf["skins"].append(skin)
        animation = copy.deepcopy(gltf["animations"][0]); animation["channels"] = [animation["channels"][0]]; animation["channels"][0]["target"]["node"] = 5
        gltf["animations"].append(animation)
    source = _mutated(add_unused)
    (doc, _), result = _export(store, source)
    assert len(doc["skins"]) == len(doc["animations"]) == 1
    assert any("1 unused skins and 1 unused clips" in text for text in result["stats"]["ignored"])
    assert doc["animations"][0]["name"].startswith("[") and "bend" in doc["animations"][0]["name"]


def test_two_animated_instances_have_unique_deterministic_clip_names(store):
    source = GEN.build_source_glb()
    sha = _sha(source)
    scene = _scene_for(store, source, [_model_node(store, "deform", sha, node_id="n_a", name="Same"), _model_node(store, "deform", sha, node_id="n_b", name="Same")])
    result = export_scene(scene, store)
    doc, _ = _parse_glb(result["path"])
    names = [a["name"] for a in doc["animations"]]
    assert len(set(names)) == 2 and all("Same / bend" in name for name in names)
    assert _parse_glb(export_scene(scene, store)["path"])[0]["animations"] == doc["animations"]
