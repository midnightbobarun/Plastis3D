"""Bounded, observational recovery of legacy UV metadata. Stdlib only.

Never called under the profile/scene lock. Immutable source bytes are pinned while
scanning. Missing/unreadable sources stay unknown; neither reads nor cache writes
change a scene revision. A later ordinary mutation may retain the proven facts.
"""
from __future__ import annotations

import copy
import hashlib
import threading
import time
from collections import OrderedDict

from . import glb
from .asset_transactions import AssetOperation
from .import_model import IMPORT_TIMEOUT, MAX_IMPORT_BYTES
from .spec import PlastisError

# Cache small per-primitive stats only, per profile/content/file identity; never GLBs.
MAX_CACHED_FACTS = 4096
_cache = OrderedDict()
_guard = threading.Lock()


def enrich_legacy_uvs(scene: dict, store, *, deadline=None) -> dict:
    deadline = deadline if deadline is not None else time.monotonic() + IMPORT_TIMEOUT
    assets = {a["id"]: a for a in scene.get("assets", [])}
    wanted, part_indexes = {}, {}
    for node_index, node in enumerate(scene.get("nodes", [])):
        if node_index % 128 == 0 and time.monotonic() >= deadline:
            return scene
        asset = assets.get(node.get("modelAssetId"))
        if node.get("kind") != "part" or not asset or asset.get("format") != "glb":
            continue
        pair = (node.get("meshIndex", 0), node.get("primitiveIndex", 0))
        if asset["id"] not in part_indexes:
            index = {}
            for number, part in enumerate((asset.get("stats") or {}).get("parts") or []):
                if number % 1024 == 0 and time.monotonic() >= deadline:
                    return scene
                index.setdefault((part.get("meshIndex"), part.get("primitiveIndex")), part)
            part_indexes[asset["id"]] = index
        row = part_indexes[asset["id"]].get(pair)
        if row is None or "uv" not in row:
            wanted.setdefault(asset["id"], set()).add(pair)
    if not wanted:
        return scene
    found = {}
    try:
        with AssetOperation(store, assets=[assets[key] for key in wanted]):
            for aid, pairs in wanted.items():
                if time.monotonic() >= deadline:
                    break
                asset = assets[aid]
                path = store.assets_dir / (asset["sha256"] + ".glb")
                try:
                    stat = path.stat()
                    if stat.st_size > MAX_IMPORT_BYTES:
                        continue
                    identity = (stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
                    prefix = (str(store.data_dir.resolve()), asset["sha256"])
                    missing = set()
                    for pair in pairs:
                        key = prefix + pair
                        with _guard:
                            cached = _cache.get(key)
                            if cached is not None and cached[0] == identity:
                                _cache.move_to_end(key)
                                found[(aid, pair)] = cached[1]
                            else:
                                missing.add(pair)
                    if not missing:
                        continue
                    with path.open("rb") as handle:
                        data = handle.read(MAX_IMPORT_BYTES + 1)
                    if len(data) > MAX_IMPORT_BYTES or hashlib.sha256(data).hexdigest() != asset["sha256"]:
                        continue
                    scan = glb.scan(data, source_format="glb", deadline=deadline)
                    facts = {(p["meshIndex"], p["primitiveIndex"]): p for p in scan.stats.get("parts", [])}
                    for pair in missing:
                        value = facts.get(pair)
                        if isinstance(value, dict) and isinstance(value.get("uv"), bool):
                            found[(aid, pair)] = value
                            with _guard:
                                _cache[prefix + pair] = (identity, value)
                                _cache.move_to_end(prefix + pair)
                                while len(_cache) > MAX_CACHED_FACTS:
                                    _cache.popitem(last=False)
                except (OSError, PlastisError):
                    continue  # Unknown stays unknown; the validator refuses texture assignment.
    except PlastisError:
        return scene  # Contended admission is not evidence of UVs.
    if not found:
        return scene
    result = copy.deepcopy(scene)
    grouped = {}
    for (aid, pair), facts in found.items():
        grouped.setdefault(aid, []).append((pair, facts))
    for asset in result.get("assets", []):
        own = grouped.get(asset["id"], [])
        if not own:
            continue
        if not isinstance(asset.get("stats"), dict):
            asset["stats"] = {}
        if not isinstance(asset["stats"].get("parts"), list):
            asset["stats"]["parts"] = []
        parts = asset["stats"]["parts"]
        for pair, facts in own:
            row = next((p for p in parts if (p.get("meshIndex"), p.get("primitiveIndex")) == pair), None)
            if row is None:
                row = copy.deepcopy(facts)
                parts.append(row)
            row.setdefault("uv", facts["uv"])
    return result
