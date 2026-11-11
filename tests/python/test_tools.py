import json
"""PR3 tool tests (Tier 1, stage-2 §5).

Hand-rolled mock Hermes ctx — no official fake ctx exists. Runs full
tool sequences (create scene -> add box -> set material -> undo ->
export) and asserts headless execution (zero GUI dependencies) and
that the 21 registered tools match plugin.yaml provides_tools
character-for-character (registration drift is also covered by
``doctor``, not by the mock).

Run: pytest tests/python
"""

import importlib.util
import sys
from pathlib import Path

import pytest

from plastis3d_scene.store import Store

REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def _load_root_package():
    """Load the root __init__.py the way the Hermes loader does (see
    test_health.py): a package module with submodule_search_locations
    set to the plugin directory."""
    spec = importlib.util.spec_from_file_location(
        "plastis3d_tools_probe_root",
        REPO_ROOT / "__init__.py",
        submodule_search_locations=[str(REPO_ROOT)],
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    module.__path__ = [str(REPO_ROOT)]
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class MockContext:
    """Hand-rolled stand-in for the Hermes PluginContext."""

    def __init__(self):
        self.tools = {}
        self.skills = {}

    def register_tool(self, name, toolset, schema, handler, **kwargs):
        assert name not in self.tools, "duplicate tool registration: %s" % name
        self.tools[name] = {
            "toolset": toolset,
            "schema": schema,
            "handler": handler,
            **kwargs,
        }

    def register_skill(self, name, path, description="", frontmatter=None):
        assert Path(path).is_file(), "SKILL.md missing at %s" % (path,)
        self.skills[name] = {"path": str(path), "description": description}


@pytest.fixture()
def ctx():
    root = _load_root_package()
    mock = MockContext()
    root.register(mock)
    return mock


@pytest.fixture()
def data_dir(tmp_path, monkeypatch):
    path = tmp_path / "data"
    monkeypatch.setenv("PLASTIS3D_DATA_DIR", str(path))
    return path


def _call(ctx, tool, **kwargs):
    return json.loads(ctx.tools[tool]["handler"](kwargs))


def _expect_error(ctx, tool, code, **kwargs):
    """Call a tool expecting a PlastisError with the given stable code.

    Matches on the exception's ``code`` attribute, not its class: the
    probe root loads the package as a second module instance, so the
    raised class is not the top-level ``plastis3d_scene.spec`` one
    (a test-only dual-instance effect; Hermes loads the package once).
    """
    with pytest.raises(Exception) as excinfo:
        _call(ctx, tool, **kwargs)
    error = excinfo.value
    assert type(error).__name__ == "PlastisError", type(error)
    assert getattr(error, "code", None) == code, error
    assert str(error).startswith(code), str(error)
    return error


BOX_KWARGS = {
    "name": "Box",
    "kind": "mesh",
    "transform": {"t": [0, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
    "primitive": {"type": "box"},
    "materialId": "m_default",
}


def test_all_seventeen_tools_registered_with_schemas(ctx):
    from plastis3d_scene.tools import TOOL_NAMES

    assert list(ctx.tools) == TOOL_NAMES
    assert len(ctx.tools) == 21
    for name, entry in ctx.tools.items():
        assert entry["toolset"] == "plastis3d"
        assert entry["schema"]["name"] == name
        assert entry["schema"]["parameters"]["type"] == "object"
        assert "description" in entry and entry["description"]
    assert list(ctx.skills) == ["plastis3d"]
    assert "create, change, view, import, or export" in ctx.skills["plastis3d"]["description"]


def test_provides_tools_matches_register_exactly(ctx):
    """Catalog rule 6, at test level (doctor checks it too)."""
    lines = (REPO_ROOT / "plugin.yaml").read_text(encoding="utf-8").splitlines()
    declared = []
    in_tools = False
    for line in lines:
        if line.startswith("provides_tools:"):
            in_tools = True
            continue
        if in_tools:
            stripped = line.strip()
            if stripped.startswith("- "):
                declared.append(stripped[2:].strip())
            elif stripped:
                break
    assert declared == list(ctx.tools)
    assert "plastis3d_ping" not in declared


def test_full_tool_sequence_create_add_material_undo_export(ctx, data_dir):
    env = _call(ctx, "plastis3d_new_scene", name="Snowman")
    assert env["ok"] is True
    scene_id = env["scene"]["id"]
    assert env["scene"]["revision"] == 1

    env = _call(
        ctx, "plastis3d_add_node", scene=scene_id, baseRevision=1, **BOX_KWARGS
    )
    assert env["scene"]["revision"] == 2
    box_id = [n["id"] for n in env["nodes"] if n["name"] == "Box"][0]

    env = _call(
        ctx,
        "plastis3d_set_material",
        scene=scene_id,
        baseRevision=2,
        id="m_red",
        color="#ff0000",
        assignTo=[box_id],
    )
    assert env["scene"]["revision"] == 3
    box = [n for n in env["nodes"] if n["id"] == box_id][0]
    assert box["materialId"] == "m_red"

    env = _call(ctx, "plastis3d_get_scene", scene=scene_id)
    assert env["scene"]["revision"] == 3
    assert env["feedback"]["canUndo"] is True

    env = _call(ctx, "plastis3d_undo", scene=scene_id, baseRevision=3)
    assert env["scene"]["revision"] == 4
    box = [n for n in env["nodes"] if n["id"] == box_id][0]
    assert box["materialId"] == "m_default"  # the set_material is undone

    env = _call(ctx, "plastis3d_redo", scene=scene_id, baseRevision=4)
    assert env["scene"]["revision"] == 5
    box = [n for n in env["nodes"] if n["id"] == box_id][0]
    assert box["materialId"] == "m_red"

    # Export: PR6 body landed — the scene has a box, so a GLB is
    # written under exports/ and the revision does not move.
    result = _call(ctx, "plastis3d_export_glb", scene=scene_id)
    assert result["ok"] is True
    assert result["revision"] == 5
    assert result["filename"] == "Snowman.glb"
    assert Path(result["path"]).is_file()
    assert result["bytes"] == Path(result["path"]).stat().st_size
    assert result["stats"]["tris"] == 12

    # Import: PR7 body landed — the two-primitive fixture (copied out
    # of the plugin root, which the import denylist refuses) explodes
    # into 3 parts and bumps the revision by 1.
    import shutil

    model_path = data_dir.parent / "model.glb"
    shutil.copyfile(REPO_ROOT / "tests" / "fixtures" / "two-primitive.glb", model_path)
    env = _call(
        ctx,
        "plastis3d_import_model",
        scene=scene_id,
        baseRevision=5,
        path=str(model_path),
    )
    assert env["scene"]["revision"] == 6
    assert len([n for n in env["nodes"] if n["kind"] == "part"]) == 3
    assert len(env["assets"]) == 1

    # open_in_desktop returns immediately with no ack, no mutation.
    result = _call(ctx, "plastis3d_open_in_desktop", scene=scene_id)
    assert result == {
        "ok": True,
        "broadcast": "plugin.plastis3d.editor.focus",
        "scene": scene_id,
    }
    assert Store(data_dir).get_scene(scene_id)["revision"] == 6


def test_build_duplicate_delete_sequence(ctx, data_dir):
    env = _call(ctx, "plastis3d_new_scene", name="Crate")
    scene_id = env["scene"]["id"]
    env = _call(
        ctx,
        "plastis3d_build_scene",
        scene=scene_id,
        baseRevision=1,
        nodes=[
            {
                "name": "Crate",
                "kind": "mesh",
                "transform": {"t": [0, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1]},
                "primitive": {"type": "box", "width": 1, "height": 1, "depth": 1},
                "materialId": "m_default",
            }
        ],
    )
    assert env["scene"]["revision"] == 2
    assert env["feedback"]["defaultsAdded"] == []
    crate_id = [n["id"] for n in env["nodes"] if n["name"] == "Crate"][0]

    env = _call(ctx, "plastis3d_duplicate_node", scene=scene_id, baseRevision=2, id=crate_id)
    assert env["scene"]["revision"] == 3
    assert len([n for n in env["nodes"] if n["name"] == "Crate copy"]) == 1

    env = _call(ctx, "plastis3d_delete_node", scene=scene_id, baseRevision=3, id=crate_id)
    assert env["scene"]["revision"] == 4
    assert crate_id not in {n["id"] for n in env["nodes"]}

    scenes = _call(ctx, "plastis3d_list_scenes")
    assert scenes == {
        "ok": True,
        "scenes": [
            {
                "id": scene_id,
                "name": "Crate",
                "revision": 4,
                "updatedAt": scenes["scenes"][0]["updatedAt"],
            }
        ],
    }


def test_tool_errors_start_with_stable_code(ctx, data_dir):
    env = _call(ctx, "plastis3d_new_scene", name="Errors")
    scene_id = env["scene"]["id"]
    _expect_error(ctx, "plastis3d_get_scene", "SCENE_NOT_FOUND", scene="missing-scene")

    error = _expect_error(
        ctx,
        "plastis3d_add_node",
        "REVISION_CONFLICT",
        scene=scene_id,
        baseRevision=99,
        **BOX_KWARGS,
    )
    assert error.current_revision == 1

    _expect_error(ctx, "plastis3d_open_in_desktop", "SCENE_NOT_FOUND", scene="missing-scene")
    _expect_error(ctx, "plastis3d_export_glb", "SCENE_NOT_FOUND", scene="missing-scene")
    _expect_error(ctx, "plastis3d_undo", "HISTORY_EMPTY", scene=scene_id, baseRevision=1)


def test_headless_no_gui_dependencies_and_no_blocking_calls(ctx):
    """Tools run with no Desktop: no GUI imports, no input(), no sleep."""
    import plastis3d_scene.mutate as mutate_mod
    import plastis3d_scene.tools as tools_mod

    for module in ("tkinter", "PyQt5", "PyQt6", "wx", "curses"):
        assert module not in sys.modules, "%s was imported" % module
    for mod in (mutate_mod, tools_mod):
        source = Path(mod.__file__).read_text(encoding="utf-8")
        assert "import tkinter" not in source
        assert "input(" not in source
        assert "time.sleep" not in source
    # tools.py / mutate.py import no GUI modules at all.
    assert "tkinter" not in Path(tools_mod.__file__).read_text(encoding="utf-8")
    assert "tkinter" not in Path(mutate_mod.__file__).read_text(encoding="utf-8")


def test_skill_file_is_scanner_clean(ctx):
    """The install scanner reads skills/** at full severity: no shell,
    no npx, no curl, no backticks that look like commands, no API keys,
    no base64, no instruction to enable or call any other plugin."""
    skill = Path(ctx.skills["plastis3d"]["path"])
    assert skill.name == "SKILL.md"
    text = skill.read_text(encoding="utf-8")
    assert "`" not in text, "SKILL.md must not contain backticks"
    lowered = text.lower()
    for banned in ("npx", "curl", "api key", "api_key", "base64"):
        assert banned not in lowered, "SKILL.md contains %r" % banned
    assert "enable" not in lowered or "another plugin" not in lowered
    assert "shell" not in lowered


def test_update_tool_renames_scene_without_node_id(ctx, data_dir):
    created = _call(ctx, "plastis3d_new_scene", name="Before rename")
    sid = created["scene"]["id"]
    renamed = _call(ctx, "plastis3d_update_node", scene=sid, baseRevision=1, sceneName="After rename")
    assert renamed["scene"]["revision"] == 2
    from plastis3d_scene.store import Store
    assert Store(data_dir).get_scene(sid)["name"] == "After rename"
    undone = _call(ctx, "plastis3d_undo", scene=sid, baseRevision=2)
    assert undone["scene"]["revision"] == 3
    assert Store(data_dir).get_scene(sid)["name"] == "Before rename"
