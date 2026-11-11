"""Plastis3D — shared scene core (stdlib only).

* ``__init__.py`` (the agent half) loads this package as
  ``hermes_plugins.plastis3d.plastis3d_scene`` and imports it relatively.
* ``dashboard/plugin_api.py`` (the gateway half) is loaded standalone with no
  package context and no ``sys.path`` entry, so it makes the package
  importable itself from ``__file__``.

PR2 (Stage 1) landed the schema, validator, store, and primitives:
``spec`` (schema 1, designed once for the full entry scope), ``validate``
(strict validator), ``store`` (PID-locked atomic scene store), and
``primitives`` (analytic parametric meshes). PR3 (Stage 2) landed the
mutation core (``mutate.apply()`` / ``mutate.apply_patch()``) and the
14 v1 tools (``tools``).

This package must stay free of process-global mutable state: the store
is file-backed and the lock and revision live on disk.

Python 3.11-compatible by design (Hermes runs Python 3.14.9; do not use
3.12+/3.13+-only syntax or stdlib additions).
"""

from . import mutate, primitives, spec, store, tools, validate

__version__ = "0.1.0"

__all__ = [
    "__version__",
    "ping",
    "mutate",
    "primitives",
    "spec",
    "store",
    "tools",
    "validate",
]


def ping() -> dict:
    """Trivial probe: proves the package imported and is callable."""
    return {"ok": True, "package": "plastis3d_scene", "version": __version__}
