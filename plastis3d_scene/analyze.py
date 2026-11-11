"""Plastis3D — the analyzer (PR17, correctness audit C-11).

The analyzer answers "how heavy is this, against a budget I can see?". It is
**the compatibility report plus measurements**, not a second checker and not a
second scene model: :func:`analyze_scene` calls
:func:`plastis3d_scene.compat.inspect_scene` and adds an ``analysis`` block to
that report.

Order of the result, per C-11:

1. **Named failures first.** The report's ``issues`` are sorted errors first;
   an error is a hard incompatibility and nothing below can excuse it.
2. **Unknowns.** ``unchecked`` lists what could not be checked or measured. The
   analyzer adds its own (an embedded image it could not size).
3. **Measured counts.** ``analysis.counts``: triangles, vertices, an estimate
   of draw calls, materials, textures and their decoded memory, asset bytes.
4. **An optional heuristic score**, ``analysis.score``. It is labelled a
   heuristic, uses published, versioned weights against a published,
   user-visible budget, and is **withheld when there is any hard error**
   (``value`` is ``null`` with the reason). It is never a conformance
   certificate and never overrides a failure.

Weights (version 1)::

    triangles 35 %   draw calls 25 %   materials 15 %   texture memory 25 %

A component earns its full weight at or under the budget, and loses points
linearly up to twice the budget, where it earns nothing. The budgets are
product numbers chosen here (not measured on hardware): ``mobile`` (a phone)
and ``desktop``.

Read-only: nothing is written. Stdlib only.
"""

from __future__ import annotations

from typing import Any, Optional

from . import compat
from .spec import IMAGE_ASSET_FORMATS, MATERIAL_MAP_FIELDS, PlastisError

ANALYZER_VERSION = 1
WEIGHTS_VERSION = 1
WEIGHTS = {"triangles": 0.35, "drawCalls": 0.25, "materials": 0.15, "textureMemory": 0.25}

BUDGETS = {
    "mobile": {
        "label": "Phone",
        "triangles": 100_000,
        "drawCalls": 100,
        "materials": 16,
        "textureMiB": 64,
    },
    "desktop": {
        "label": "Desktop",
        "triangles": 500_000,
        "drawCalls": 500,
        "materials": 64,
        "textureMiB": 512,
    },
}
DEFAULT_BUDGET = "mobile"

SCORE_LABEL = (
    "A heuristic guide against the budget shown, not a certificate that the scene is "
    "compatible. Problems come first and withhold the score."
)

_MIB = 1024 * 1024


def _texture_bytes(width: int, height: int) -> int:
    """Decoded RGBA with a full mip chain (4/3), the memory a GPU holds."""
    return int(width * height * 4 * 4 / 3)


def _credit(measured: float, target: float) -> float:
    """1 at or under the budget, falling linearly to 0 at twice the budget."""
    if target <= 0:
        return 1.0
    ratio = measured / target
    return 1.0 if ratio <= 1.0 else max(0.0, 2.0 - ratio)


def _count_scene(scene: dict, asset_facts: dict, unknowns: list) -> dict:
    from .health_costs import node_costs
    costs = node_costs(scene, asset_facts)
    nodes = scene.get("nodes", [])
    assets = {a.get("id"): a for a in scene.get("assets", [])}
    by_kind: dict = {}
    for node in nodes:
        by_kind[node.get("kind")] = by_kind.get(node.get("kind"), 0) + 1

    used_materials = set()
    used_assets: list = []
    for node in nodes:
        kind = node.get("kind")
        if kind == "mesh":
            used_materials.add(node.get("materialId"))
        elif kind == "part":
            if node.get("materialId"):
                used_materials.add(node["materialId"])
            if node.get("modelAssetId") not in used_assets:
                used_assets.append(node.get("modelAssetId"))
        elif kind == "model":
            if node.get("modelAssetId") not in used_assets:
                used_assets.append(node.get("modelAssetId"))

    materials_in_models = sum(
        asset_facts.get(a, {}).get("materials", 0) for a in used_assets if assets.get(a, {}).get("format") == "glb"
    )
    # A part reuses the model's mesh but draws with its own override or the imported material.
    materials = len({m for m in used_materials if m}) + materials_in_models

    # Textures: each distinct image once (instances share a texture on the GPU).
    spec_images = set()
    for material in scene.get("materials", []):
        if material.get("id") not in used_materials:
            continue
        for slot in MATERIAL_MAP_FIELDS:
            image = assets.get(material.get(slot))
            if image and image.get("format") in IMAGE_ASSET_FORMATS:
                spec_images.add(image["id"])
    sizes = []
    for image_id in sorted(spec_images):
        stat = assets[image_id].get("stats") or {}
        if isinstance(stat.get("width"), int) and isinstance(stat.get("height"), int):
            sizes.append((stat["width"], stat["height"]))
    for asset_id in used_assets:
        facts = asset_facts.get(asset_id)
        if facts:
            sizes.extend(facts.get("images", []))
            if facts.get("unreadable_images"):
                unknowns.append(
                    {
                        "what": "texture memory for %s" % facts.get("label"),
                        "reason": "%d embedded image(s) could not be sized, so the figure is a lower bound"
                        % facts["unreadable_images"],
                    }
                )
    def measured(key):
        values = [row[key] for row in costs]
        return sum(values) if all(value is not None for value in values) else None
    if any(row["triangles"] is None or row["drawCalls"] is None for row in costs):
        unknowns.append({"what": "per-object geometry/base-pass costs", "reason": "source/default-scene cost inspection was incomplete or exceeded its row/time budget; unknown counts are not zero"})
    clips = sum(asset_facts.get(a, {}).get("clips", 0) for a in used_assets)
    skins = sum(asset_facts.get(a, {}).get("skins", 0) for a in used_assets)
    return {
        "nodes": len(nodes),
        "meshNodes": by_kind.get("mesh", 0),
        "modelNodes": by_kind.get("model", 0),
        "partNodes": by_kind.get("part", 0),
        "lights": by_kind.get("light", 0),
        "cameras": by_kind.get("camera", 0),
        "triangles": measured("triangles"),
        "vertices": measured("vertices"),
        "drawCalls": measured("drawCalls"),
        "perNode": costs,
        "drawCallsScope": "Editor-visible content base-pass primitives if loaded, before batching; excludes editor bounds substitutes, culling, shadows and extra transparency passes. GLB still contains editor-hidden objects.",
        "geometryCountScope": "Triangle/vertex references for default-scene instances, including hidden objects; not unique GPU allocation.",
        "assetBytesScope": "Recorded bytes of this scene's asset rows, not total profile storage. Per-object sizes are shared references, not exclusive allocations.",
        "drawCallsIsEstimate": True,
        "materials": materials,
        "textures": len(sizes),
        "texturePixels": sum(w * h for w, h in sizes),
        "textureBytes": sum(_texture_bytes(w, h) for w, h in sizes),
        "assets": len([a for a in assets.values()]),
        "assetBytes": sum(int(a.get("bytes") or 0) for a in assets.values()),
        "clips": clips,
        "skins": skins,
    }


def _count_asset(asset: dict, facts: dict, unknowns: list) -> dict:
    sizes = facts.get("images", [])
    if facts.get("unreadable_images"):
        unknowns.append(
            {
                "what": "texture memory for %s" % facts.get("label"),
                "reason": "%d embedded image(s) could not be sized, so the figure is a lower bound" % facts["unreadable_images"],
            }
        )
    stats = asset.get("stats") or {}
    return {
        "triangles": facts.get("tris"),
        "vertices": stats.get("verts"),
        "drawCalls": facts.get("primitives"),
        "drawCallsIsEstimate": True,
        "materials": facts.get("materials"),
        "textures": len(sizes),
        "texturePixels": sum(w * h for w, h in sizes),
        "textureBytes": sum(_texture_bytes(w, h) for w, h in sizes),
        "assetBytes": int(asset.get("bytes") or 0),
        "clips": facts.get("clips"),
        "skins": facts.get("skins"),
    }


def _score(counts: dict, budget: dict, report: dict) -> dict:
    base = {
        "label": SCORE_LABEL,
        "heuristic": True,
        "weightsVersion": WEIGHTS_VERSION,
        "weights": dict(WEIGHTS),
        "basedOnPartialChecks": bool(report["unchecked"]),
    }
    if report["summary"]["errors"] > 0:
        return dict(
            base,
            value=None,
            reason="There are hard problems. Fix them first; a score would hide them.",
            components=[],
        )
    measured = {
        "triangles": counts.get("triangles"),
        "drawCalls": counts.get("drawCalls"),
        "materials": counts.get("materials"),
        "textureMemory": (counts.get("textureBytes") or 0) / _MIB,
    }
    targets = {
        "triangles": budget["triangles"],
        "drawCalls": budget["drawCalls"],
        "materials": budget["materials"],
        "textureMemory": budget["textureMiB"],
    }
    if any(measured[k] is None for k in ("triangles", "drawCalls", "materials")):
        return dict(base, value=None, reason="A count is unknown, so there is no score.", components=[])
    components = []
    total = 0.0
    for name, weight in WEIGHTS.items():
        credit = _credit(measured[name], targets[name])
        points = weight * 100.0 * credit
        total += points
        components.append(
            {
                "name": name,
                "weight": weight,
                "measured": round(measured[name], 2),
                "budget": targets[name],
                "ratio": round(measured[name] / targets[name], 3) if targets[name] else 0,
                "points": round(points, 1),
            }
        )
    return dict(base, value=int(round(total)), reason=None, components=components)


def analyze_scene(
    scene: dict,
    store: Any,
    *,
    asset_id: Optional[str] = None,
    budget: str = DEFAULT_BUDGET,
    timeout: float = compat.REPORT_TIMEOUT,
) -> dict:
    """The compatibility report for ``scene`` (or one asset) with an ``analysis``
    block: measured counts, the budget, and the heuristic score.

    ``budget`` is ``mobile`` or ``desktop``. Raises :class:`PlastisError`
    ``SPEC_INVALID`` for another name, ``ASSET_NOT_FOUND`` for an unknown asset.
    """
    if budget not in BUDGETS:
        raise PlastisError(
            "SPEC_INVALID",
            "SPEC_INVALID: budget must be one of %s" % (sorted(BUDGETS),),
            path="/budget",
        )
    report, asset_facts = compat.inspect_scene(scene, store, asset_id=asset_id, timeout=timeout)
    unknowns: list = []
    if asset_id is not None:
        asset = next(a for a in scene.get("assets", []) if a.get("id") == asset_id)
        counts = _count_asset(asset, asset_facts.get(asset_id, {}), unknowns)
    else:
        counts = _count_scene(scene, asset_facts, unknowns)
    report["unchecked"] = list(report["unchecked"]) + unknowns
    chosen = dict(BUDGETS[budget], name=budget)
    report["analysis"] = {
        "version": ANALYZER_VERSION,
        "budget": chosen,
        "counts": counts,
        "score": _score(counts, chosen, report),
    }
    return report
