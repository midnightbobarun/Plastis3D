"""Plastis3D — scene schema upgrades (PR24, D-EXT-02).

A scene file is upgraded in memory as it is read, one step at a time, to the
current ``SCHEMA_VERSION``. The next write persists the new version.

* 1 -> 2 is an identity: schema 2 only adds the optional node ``generator``
  field (how a baked ``part`` was made), so a schema-1 document is valid
  schema 2 once its ``schema`` number is raised. No other key changes.

A file with a newer schema than this build understands is not touched here:
the validator refuses it with ``SCHEMA_NEWER`` so a reader never strips
fields it does not know. Schema 2 -> 3 is also identity; PR31 adds splat
nodes under owner decision D-PR31-01.

Stdlib only. Python 3.11-compatible.
"""

from __future__ import annotations

from typing import Any

from .spec import SCHEMA_VERSION


def _one_to_two(scene: dict) -> dict:
    scene["schema"] = 2
    return scene


# from-version -> the step that produces from-version + 1
def _two_to_three(scene):
    scene["schema"] = 3
    return scene


_STEPS = {1: _one_to_two, 2: _two_to_three}


def upgrade_scene(scene: Any) -> Any:
    """Return ``scene`` raised to the current schema (in place for a dict).

    Anything that is not an object with an integer ``schema`` from 1 up to
    the current version is returned unchanged, for the validator to judge.
    """
    if not isinstance(scene, dict):
        return scene
    version = scene.get("schema")
    if not isinstance(version, int) or isinstance(version, bool):
        return scene
    while 1 <= version < SCHEMA_VERSION:
        scene = _STEPS[version](scene)
        version = scene["schema"]
    return scene
