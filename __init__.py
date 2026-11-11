"""Plastis3D — agent-side entry point (PR3, Stage 2).

``register(ctx)`` binds the ``plastis3d_*`` tools and registers the
``plastis3d`` skill. ``plugin.yaml`` ``provides_tools`` lists exactly
these names, character-for-character (catalog rule 6).

The PR1 dummy tool ``plastis3d_ping`` is gone: it is not registered
here and it is not in ``plugin.yaml``.

The skill file ``skills/plastis3d/SKILL.md`` lands HERE (stage-2.md is
authoritative for PR3), not in PR9 — PR9 then owns the inline-card
wiring, not the skill file. ``ctx.register_skill`` raises
``FileNotFoundError`` when the file is missing, so the file must exist
before ``register()`` runs.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

# Decision 9, agent half: __init__.py is loaded as the package
# ``hermes_plugins.plastis3d`` with ``__path__`` set to the plugin
# directory, so the inner package is imported relatively.
from .plastis3d_scene import __version__, tools

__all__ = ["register"]

_SKILL_DESCRIPTION = (
    "use when the user asks to create, change, view, import, or export "
    "a 3D scene or model inside Hermes"
)


def _tool_adapter(handler):
    """Hermes dispatches the schema arguments as one positional object."""
    def invoke(arguments=None, **kwargs):
        token = tools.mutate.EVENT_ORIGIN.set("tool")
        try:
            return json.dumps(handler(**(arguments if arguments is not None else kwargs)), ensure_ascii=False)
        finally:
            tools.mutate.EVENT_ORIGIN.reset(token)
    return invoke


def register(ctx: Any) -> None:
    """Register the tools and the plastis3d skill."""
    for entry in tools.tool_schemas():
        ctx.register_tool(
            entry["name"],
            "plastis3d",
            entry["schema"],
            _tool_adapter(entry["handler"]),
            description=entry["description"],
        )
    skill_path = Path(__file__).resolve().parent / "skills" / "plastis3d" / "SKILL.md"
    ctx.register_skill("plastis3d", skill_path, description=_SKILL_DESCRIPTION)
