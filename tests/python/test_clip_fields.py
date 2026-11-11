"""Strict primitive clip validation (C-06)."""
import copy
import pytest
from plastis3d_scene.validate import validate_scene
from plastis3d_scene.spec import PlastisError
from test_validate import base_scene, mesh_node


def scene_with(channel, duration=2):
    scene = base_scene()
    node = mesh_node()
    node['clips'] = [{'name': 'clip', 'duration': duration, 'channels': [channel]}]
    scene['nodes'].append(node)
    return scene


def test_strict_times_and_duration():
    valid = {'target': 'translation', 'times': [0, 1], 'values': [[0, 0, 0], [1, 0, 0]]}
    validate_scene(scene_with(valid))
    for times, duration in [([0, 0], 2), ([0, 1], .5), ([], 2), ([-1, 0], 2)]:
        channel = dict(valid, times=times, values=[[0, 0, 0]] * len(times))
        with pytest.raises(PlastisError): validate_scene(scene_with(channel, duration))


def test_duplicate_targets_and_rotation_ambiguity():
    channel = {'target': 'rotation', 'times': [0, 1], 'values': [[0, 0, 0], [0, 180, 0]]}
    with pytest.raises(PlastisError): validate_scene(scene_with(channel))
    channel['values'][1] = [90, 90, 90]
    with pytest.raises(PlastisError): validate_scene(scene_with(channel))
    channel['values'][1] = [0, 90, 0]
    scene = scene_with(channel)
    scene['nodes'][-1]['clips'][0]['channels'].append(copy.deepcopy(channel))
    with pytest.raises(PlastisError): validate_scene(scene)


def test_single_key_and_full_turn_with_intermediate_keys():
    channel = {'target': 'rotation', 'times': [0], 'values': [[0, 0, 0]]}
    validate_scene(scene_with(channel))
    channel['times'] = [0, .5, 1, 1.5, 2]
    channel['values'] = [[0, 0, angle] for angle in [0, 90, 180, 270, 360]]
    validate_scene(scene_with(channel))


def test_invalid_kind_and_unsupported_interpolation():
    channel = {'target': 'translation', 'times': [0], 'values': [[0, 0, 0]]}
    scene = scene_with(channel)
    scene['nodes'][-1]['kind'] = 'group'
    scene['nodes'][-1].pop('primitive')
    scene['nodes'][-1].pop('materialId')
    with pytest.raises(PlastisError): validate_scene(scene)
    channel['interpolation'] = 'CUBICSPLINE'
    with pytest.raises(PlastisError): validate_scene(scene_with(channel))


def test_export_writes_primitive_animation_and_held_duration(tmp_path):
    import json, struct
    from plastis3d_scene import mutate
    from plastis3d_scene.store import Store
    from plastis3d_scene.export_glb import export_scene
    store = Store(tmp_path / 'data')
    scene = store.create_scene('clip test')
    clip = {'name': 'move', 'duration': 2, 'channels': [{'target': 'translation', 'times': [0, 1], 'values': [[0, 0, 0], [1, 0, 0]]}]}
    node = mesh_node()
    node['clips'] = [clip]
    mutate.apply(scene['id'], scene['revision'], {'op': 'add_node', 'node': node}, store=store)
    scene = store.get_scene(scene['id'])
    path = export_scene(scene, store)['path']
    data = open(path, 'rb').read()
    json_len = struct.unpack_from('<I', data, 12)[0]
    document = json.loads(data[20:20+json_len])
    animation = document['animations'][0]
    assert animation['name'] == '[2:0] Box / move'
    assert animation['channels'][0]['target']['path'] == 'translation'
    accessor = document['accessors'][animation['samplers'][0]['input']]
    assert accessor['count'] == 3
    assert accessor['max'] == [2]


def test_tool_updates_clip_and_preserves_atomicity(tmp_path, monkeypatch):
    from plastis3d_scene import tools
    monkeypatch.setenv('PLASTIS3D_DATA_DIR', str(tmp_path / 'data'))
    initial = tools.new_scene(name='clip tools')
    sid = initial['scene']['id']
    added = tools.add_node(scene=sid, baseRevision=1, name='Box', kind='mesh', transform={'t': [0,0,0], 'r':[0,0,0], 's':[1,1,1]}, primitive={'type':'box'}, materialId='m_default')
    node_id = next(node['id'] for node in added['nodes'] if node['name'] == 'Box')
    clip = {'channels': [{'target':'translation', 'times':[0, 1], 'values': [[0,0,0], [1,0,0]]}]}
    updated = tools.update_node(scene=sid, baseRevision=2, id=node_id, clips=[clip])
    assert updated['scene']['revision'] == 3
    assert next(node for node in updated['nodes'] if node['id'] == node_id)['clips'] == [clip]
    clip['channels'][0]['times'] = [0,0]
    with pytest.raises(PlastisError): tools.update_node(scene=sid, baseRevision=3, id=node_id, clips=[clip])
    assert tools.get_scene(scene=sid)['scene']['revision'] == 3


def test_clip_schema_published_on_update_and_build():
    from plastis3d_scene.tools import _NODE, _CLIPS, TOOL_DEFINITIONS
    assert _NODE['properties']['clips'] is _CLIPS


def test_export_refuses_float32_collapsed_times_without_file(tmp_path):
    from plastis3d_scene import mutate
    from plastis3d_scene.store import Store
    from plastis3d_scene.export_glb import export_scene
    store = Store(tmp_path / 'data')
    scene = store.create_scene('float keys')
    node = mesh_node()
    node['clips'] = [{'channels': [{'target': 'translation', 'times': [1, 1.00000001], 'values': [[0,0,0], [1,0,0]]}]}]
    mutate.apply(scene['id'], scene['revision'], {'op': 'add_node', 'node': node}, store=store)
    with pytest.raises(PlastisError) as error:
        export_scene(store.get_scene(scene['id']), store)
    assert error.value.code == 'EXPORT_FAILED'
    assert not list(store.exports_dir.iterdir())
