"""PR1 Python health tests (Tier 1: basic health only).

Covers the Decision 9 probe from both import paths and the gateway health
route. Plain pytest needs no Hermes; the Python half is stdlib-only by
design (the dashboard API file additionally uses FastAPI, as the host does).

Run: pytest tests/python
"""

import importlib.util
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

REPO_ROOT = Path(__file__).resolve().parent.parent.parent


# --- Decision 9, path 1: relative import in __init__.py ---------------------
# Loads the root __init__.py the way the validate probe (and the Hermes
# loader) does: as a package module with submodule_search_locations set to
# the plugin directory, so `from .plastis3d_scene import ...` resolves.
def _load_root_package():
    spec = importlib.util.spec_from_file_location(
        "plastis3d_probe_root",
        REPO_ROOT / "__init__.py",
        submodule_search_locations=[str(REPO_ROOT)],
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    module.__path__ = [str(REPO_ROOT)]
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class RecordingContext:
    """Minimal stand-in for the Hermes PluginContext (register_tool +
    register_skill)."""

    def __init__(self):
        self.tools = {}
        self.skills = {}

    def register_tool(self, name, toolset, schema, handler, **kwargs):
        self.tools[name] = {"toolset": toolset, "schema": schema, "handler": handler, **kwargs}

    def register_skill(self, name, path, description="", frontmatter=None):
        from pathlib import Path as _Path

        if not _Path(path).is_file():
            raise FileNotFoundError("SKILL.md not found at %s" % (path,))
        self.skills[name] = {"path": str(path), "description": description}


def test_scene_package_ping():
    from plastis3d_scene import __version__, ping

    result = ping()
    assert result == {"ok": True, "package": "plastis3d_scene", "version": __version__}
    assert __version__ == "0.1.0"


def test_root_register_registers_fourteen_tools_and_skill():
    """PR3: the PR1 dummy tool is gone; register() binds the 21 tools
    and the plastis3d skill."""
    root = _load_root_package()
    ctx = RecordingContext()
    root.register(ctx)
    from plastis3d_scene.tools import TOOL_NAMES

    assert list(ctx.tools) == TOOL_NAMES
    assert len(ctx.tools) == 21
    assert "plastis3d_ping" not in ctx.tools
    for name, entry in ctx.tools.items():
        assert entry["toolset"] == "plastis3d"
        assert entry["schema"]["name"] == name
    assert list(ctx.skills) == ["plastis3d"]
    assert "create, change, view, import, or export" in ctx.skills["plastis3d"]["description"]


# --- Decision 9, path 2: standalone import in dashboard/plugin_api.py -------
# Loads plugin_api.py the way the dashboard host does: spec_from_file_location
# with NO package context and NO sys.path entry for the plugin directory.
# The module must make plastis3d_scene importable itself (from __file__).
def _load_plugin_api_standalone():
    api_path = REPO_ROOT / "dashboard" / "plugin_api.py"
    saved_path = list(sys.path)
    saved_modules = {k: v for k, v in sys.modules.items() if k in ("plastis3d_scene", "hermes_dashboard_plugin_plastis3d")}
    for key in saved_modules:
        del sys.modules[key]
    # Remove the repo root so the import can only succeed via the module's
    # own sys.path insertion (mirrors the host, which never puts the plugin
    # directory on sys.path).
    sys.path = [p for p in sys.path if p != str(REPO_ROOT)]
    try:
        spec = importlib.util.spec_from_file_location(
            "hermes_dashboard_plugin_plastis3d", api_path
        )
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path = saved_path
        for key, mod in saved_modules.items():
            sys.modules[key] = mod


@pytest.fixture(scope="module")
def api_client():
    api = _load_plugin_api_standalone()
    # The standalone import must have worked (probe ran at import time).
    assert api._SCENE_PROBE == {"ok": True, "package": "plastis3d_scene", "version": "0.1.0"}
    app = FastAPI()
    app.include_router(api.router, prefix="/api/plugins/plastis3d")
    with TestClient(app) as client:
        yield client


def test_health_route(api_client):
    response = api_client.get("/api/plugins/plastis3d/health")
    assert response.status_code == 200
    assert response.json() == {"ok": True, "schema": 3}


def test_pr1_spike_routes_are_gone(api_client):
    """The PR1 spike's temporary routes must not ship (stage-0 §4.8).

    ``POST /echo-bytes``, ``POST /spike-broadcast`` and ``GET /spike-file``
    existed only for the spike measurements and were deleted at the end of
    the spike; the router must not answer them any more.
    """
    assert api_client.post("/api/plugins/plastis3d/echo-bytes", content=b"x").status_code in (404, 405)
    assert api_client.post("/api/plugins/plastis3d/spike-broadcast").status_code in (404, 405)
    assert api_client.get("/api/plugins/plastis3d/spike-file").status_code in (404, 405)
