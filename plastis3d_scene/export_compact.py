"""Reference-proven compaction of a writer-owned core glTF document/BIN.

Opaque extension semantics preserve the original tables and bytes. Nodes retain
indices (and hence animation bindings/owner association); only resource tables
with known core references are rebased. No source document or file is mutated.
"""
from bisect import bisect_right
from .spec import PlastisError

_SAFE_EXTENSIONS = {"KHR_lights_punctual", "KHR_materials_unlit", "KHR_texture_transform"}


def _extensions(value):
    names = set()
    stack = [value]
    while stack:
        row = stack.pop()
        if isinstance(row, dict):
            extension = row.get("extensions")
            if isinstance(extension, dict):
                names.update(extension)
            stack.extend(row.values())
        elif isinstance(row, list):
            stack.extend(row)
    return names


def _fail(what):
    raise PlastisError("EXPORT_FAILED", "index: export compaction cannot rebase %s" % what)


def _mapping(rows, used, kind):
    if any(isinstance(i, bool) or not isinstance(i, int) or not 0 <= i < len(rows) for i in used):
        _fail(kind)
    ordered = sorted(used)
    return {old: new for new, old in enumerate(ordered)}, [rows[i] for i in ordered]


def _mapped(mapping, index, kind):
    if isinstance(index, bool) or not isinstance(index, int) or index not in mapping:
        _fail(kind)
    return mapping[index]


def _texture_refs(material):
    for key in ("baseColorTexture", "metallicRoughnessTexture"):
        ref = material.get("pbrMetallicRoughness", {}).get(key)
        if isinstance(ref, dict):
            yield ref
    for key in ("normalTexture", "occlusionTexture", "emissiveTexture"):
        ref = material.get(key)
        if isinstance(ref, dict):
            yield ref


def compact(gltf, data):
    unknown = (_extensions(gltf) | set(gltf.get("extensionsUsed", []))) - _SAFE_EXTENSIONS
    if unknown:
        return gltf, data, "resource-table compaction retained opaque extension references: %s" % ", ".join(sorted(unknown))
    nodes = gltf.get("nodes", [])
    mesh_map, meshes = _mapping(gltf.get("meshes", []), {n["mesh"] for n in nodes if "mesh" in n}, "mesh")
    skin_map, skins = _mapping(gltf.get("skins", []), {n["skin"] for n in nodes if "skin" in n}, "skin")
    camera_map, cameras = _mapping(gltf.get("cameras", []), {n["camera"] for n in nodes if "camera" in n}, "camera")
    primitives = [p for m in meshes for p in m.get("primitives", [])]
    material_map, materials = _mapping(gltf.get("materials", []), {p["material"] for p in primitives if "material" in p}, "material")
    texture_refs = [ref for m in materials for ref in _texture_refs(m)]
    texture_map, textures = _mapping(gltf.get("textures", []), {r["index"] for r in texture_refs}, "texture")
    image_map, images = _mapping(gltf.get("images", []), {t["source"] for t in textures if "source" in t}, "image")
    sampler_map, samplers = _mapping(gltf.get("samplers", []), {t["sampler"] for t in textures if "sampler" in t}, "sampler")
    animations = gltf.get("animations", [])
    for animation in animations:
        mapping, used = _mapping(animation.get("samplers", []), {c["sampler"] for c in animation.get("channels", [])}, "animation sampler")
        animation["samplers"] = used
        for channel in animation.get("channels", []):
            channel["sampler"] = _mapped(mapping, channel["sampler"], "animation sampler")
    accessor_ids = set()
    for primitive in primitives:
        accessor_ids.update(primitive.get("attributes", {}).values())
        if "indices" in primitive:
            accessor_ids.add(primitive["indices"])
        for target in primitive.get("targets", []):
            accessor_ids.update(target.values())
    accessor_ids.update(s["inverseBindMatrices"] for s in skins if "inverseBindMatrices" in s)
    for animation in animations:
        for sampler in animation["samplers"]:
            accessor_ids.update((sampler["input"], sampler["output"]))
    accessor_map, accessors = _mapping(gltf.get("accessors", []), accessor_ids, "accessor")
    view_ids = {a["bufferView"] for a in accessors if "bufferView" in a} | {i["bufferView"] for i in images if "bufferView" in i}
    for accessor in accessors:
        if "sparse" in accessor:
            view_ids.update((accessor["sparse"]["indices"]["bufferView"], accessor["sparse"]["values"]["bufferView"]))
    view_map, views = _mapping(gltf.get("bufferViews", []), view_ids, "bufferView")

    # Copy the UNION of live byte ranges, preserving original modulo-4 alignment.
    # Overlapping/shared views must never multiply the working set or change data.
    ranges = []
    for view in views:
        offset, length = view.get("byteOffset", 0), view.get("byteLength")
        if view.get("buffer", 0) != 0 or any(isinstance(v, bool) or not isinstance(v, int) or v < 0 for v in (offset, length)) or offset + length > len(data):
            _fail("bufferView byte range")
        ranges.append((offset, offset + length))
    segments = []
    for start, end in sorted(set(ranges)):
        if segments and start <= segments[-1][1]:
            segments[-1][1] = max(segments[-1][1], end)
        else:
            segments.append([start, end])
    packed = bytearray()
    translated = []
    for start, end in segments:
        packed.extend(b"\0" * ((start - len(packed)) % 4))
        translated.append((start, end, len(packed)))
        packed.extend(memoryview(data)[start:end])
    starts = [s[0] for s in translated]
    for view in views:
        old = view.get("byteOffset", 0)
        segment = translated[bisect_right(starts, old) - 1]
        if not segment[0] <= old or old + view["byteLength"] > segment[1]:
            _fail("bufferView union")
        view["buffer"] = 0
        view["byteOffset"] = segment[2] + old - segment[0]
    for node in nodes:
        for field, mapping in (("mesh", mesh_map), ("skin", skin_map), ("camera", camera_map)):
            if field in node:
                node[field] = _mapped(mapping, node[field], field)
    for primitive in primitives:
        primitive["attributes"] = {key: _mapped(accessor_map, value, "attribute") for key, value in primitive.get("attributes", {}).items()}
        if "indices" in primitive:
            primitive["indices"] = _mapped(accessor_map, primitive["indices"], "indices")
        for target in primitive.get("targets", []):
            for key, value in list(target.items()):
                target[key] = _mapped(accessor_map, value, "morph target")
        if "material" in primitive:
            primitive["material"] = _mapped(material_map, primitive["material"], "material")
    for skin in skins:
        if "inverseBindMatrices" in skin:
            skin["inverseBindMatrices"] = _mapped(accessor_map, skin["inverseBindMatrices"], "inverse bind matrices")
    for animation in animations:
        for sampler in animation["samplers"]:
            for field in ("input", "output"):
                sampler[field] = _mapped(accessor_map, sampler[field], "animation accessor")
    for ref in texture_refs:
        ref["index"] = _mapped(texture_map, ref["index"], "texture")
    for texture in textures:
        for field, mapping in (("source", image_map), ("sampler", sampler_map)):
            if field in texture:
                texture[field] = _mapped(mapping, texture[field], field)
    for row in accessors + images:
        if "bufferView" in row:
            row["bufferView"] = _mapped(view_map, row["bufferView"], "bufferView")
        if "sparse" in row:
            for field in ("indices", "values"):
                row["sparse"][field]["bufferView"] = _mapped(view_map, row["sparse"][field]["bufferView"], "sparse bufferView")
    for field, rows in (("meshes", meshes), ("skins", skins), ("cameras", cameras), ("materials", materials), ("textures", textures), ("images", images), ("samplers", samplers), ("accessors", accessors), ("bufferViews", views)):
        if rows:
            gltf[field][:] = rows
        else:
            gltf.pop(field, None)
    gltf["buffers"] = [{"byteLength": len(packed)}]
    if "extensionsUsed" in gltf:
        used = _extensions(gltf)
        gltf["extensionsUsed"] = [name for name in gltf["extensionsUsed"] if name in used]
        if not gltf["extensionsUsed"]:
            gltf.pop("extensionsUsed")
    return gltf, packed, None
