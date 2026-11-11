"""W05 reference compaction: byte unions and opaque-extension safety."""
import copy
from plastis3d_scene.export_compact import compact


def document():
    return {"asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0}], "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "NORMAL": 1}}]}], "buffers": [{"byteLength": 64}], "bufferViews": [{"buffer": 0, "byteOffset": 17, "byteLength": 32}, {"buffer": 0, "byteOffset": 20, "byteLength": 16}, {"buffer": 0, "byteOffset": 52, "byteLength": 12}], "accessors": [{"bufferView": 0, "byteOffset": 3, "componentType": 5126, "type": "VEC3", "count": 1}, {"bufferView": 1, "componentType": 5126, "type": "VEC3", "count": 1}, {"bufferView": 2, "componentType": 5126, "type": "VEC3", "count": 1}]}


def test_overlapping_views_copy_once_and_preserve_alignment_and_every_live_byte():
    original = bytes(range(64))
    doc = document()
    before = copy.deepcopy(doc)
    result, data, reason = compact(doc, bytearray(original))
    assert reason is None
    assert len(data) == 33 and len(data) <= len(original)
    assert len(result["accessors"]) == len(result["bufferViews"]) == 2
    for index in (0, 1):
        old, new = before["bufferViews"][index], result["bufferViews"][index]
        assert data[new["byteOffset"]:new["byteOffset"] + new["byteLength"]] == original[old["byteOffset"]:old["byteOffset"] + old["byteLength"]]
        local = result["accessors"][index].get("byteOffset", 0)
        assert (new["byteOffset"] + local) % 4 == (old["byteOffset"] + local) % 4 == 0
    assert result["nodes"] == before["nodes"]


def test_unknown_extension_references_preserve_tables_and_bytes_instead_of_guessing():
    doc = document()
    doc["meshes"][0]["primitives"][0]["extensions"] = {"VENDOR_resource": {"accessor": 2}}
    doc["extensionsUsed"] = ["VENDOR_resource"]
    before = copy.deepcopy(doc)
    original = bytearray(range(64))
    result, data, reason = compact(doc, original)
    assert result == before and data is original
    assert "VENDOR_resource" in reason


def test_all_core_live_references_are_rebased_together_without_changing_node_bindings():
    doc = document()
    # Deliberately put each live record after an unused record. Attribute,
    # morph, skin, animation, texture/image, and sparse refs must all survive.
    doc["nodes"] = [{"mesh": 1, "skin": 1, "camera": 1}, {}]
    doc["meshes"].append({"primitives": [{"attributes": {"POSITION": 1, "TEXCOORD_0": 2, "COLOR_0": 3}, "indices": 4, "material": 1, "targets": [{"POSITION": 5}]}]})
    doc["materials"] = [{}, {"pbrMetallicRoughness": {"baseColorTexture": {"index": 1, "extensions": {"KHR_texture_transform": {"offset": [0.1, 0.2]}}}}, "normalTexture": {"index": 1}}]
    doc["textures"] = [{}, {"source": 1, "sampler": 1}]
    doc["images"] = [{"uri": "unused.png"}, {"bufferView": 9, "mimeType": "image/png"}]
    doc["samplers"] = [{}, {"wrapS": 33071}]
    doc["cameras"] = [{}, {"type": "perspective", "perspective": {"yfov": 1, "znear": 0.1}}]
    doc["skins"] = [{"joints": [1]}, {"joints": [1], "skeleton": 1, "inverseBindMatrices": 6}]
    doc["animations"] = [{"channels": [{"sampler": 1, "target": {"node": 1, "path": "translation"}}], "samplers": [{"input": 0, "output": 0}, {"input": 7, "output": 8}]}]
    doc["accessors"] = [{"bufferView": i, "componentType": 5126, "type": "SCALAR", "count": 1} for i in range(9)]
    doc["accessors"][5]["sparse"] = {"count": 1, "indices": {"bufferView": 10, "componentType": 5121}, "values": {"bufferView": 11}}
    doc["bufferViews"] = [{"buffer": 0, "byteOffset": 4 * i, "byteLength": 4} for i in range(12)]
    doc["extensionsUsed"] = ["KHR_texture_transform", "KHR_materials_unlit"]
    result, data, reason = compact(doc, bytearray(range(64)))
    assert reason is None and data == bytearray(range(4, 48))
    assert result["nodes"] == [{"mesh": 0, "skin": 0, "camera": 0}, {}]
    primitive = result["meshes"][0]["primitives"][0]
    assert primitive == {"attributes": {"POSITION": 0, "TEXCOORD_0": 1, "COLOR_0": 2}, "indices": 3, "material": 0, "targets": [{"POSITION": 4}]}
    assert result["skins"] == [{"joints": [1], "skeleton": 1, "inverseBindMatrices": 5}]
    animation = result["animations"][0]
    assert animation["channels"] == [{"sampler": 0, "target": {"node": 1, "path": "translation"}}]
    assert animation["samplers"] == [{"input": 6, "output": 7}]
    assert result["textures"] == [{"source": 0, "sampler": 0}]
    assert result["images"] == [{"bufferView": 8, "mimeType": "image/png"}]
    assert result["materials"][0]["normalTexture"]["index"] == 0
    assert result["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"] == {"index": 0, "extensions": {"KHR_texture_transform": {"offset": [0.1, 0.2]}}}
    assert result["accessors"][4]["sparse"] == {"count": 1, "indices": {"bufferView": 9, "componentType": 5121}, "values": {"bufferView": 10}}
    assert result["extensionsUsed"] == ["KHR_texture_transform"]
