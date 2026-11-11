import copy
import struct
import pytest
from plastis3d_scene.splats import decode, MAX_SPLATS
from plastis3d_scene.spec import PlastisError
from plastis3d_scene.store import Store
from plastis3d_scene.import_model import import_bytes
from plastis3d_scene.upgrade import upgrade_scene
from plastis3d_scene.export_glb import export_scene
from plastis3d_scene import mutate


def record():
    return struct.pack('<6f8B', 0,0,0, .1,.2,.3, 255,128,64,255, 255,128,128,128)

def test_raw_validation_and_finite():
    assert decode(record(), 'splat') == record()
    for data in [b'', record()[:-1], struct.pack('<f',float('nan'))+record()[4:], record()[:12]+struct.pack('<f',-1)+record()[16:]]:
        with pytest.raises(PlastisError): decode(data,'splat')

def test_gaussian_ply():
    names=['x','y','z','scale_0','scale_1','scale_2','f_dc_0','f_dc_1','f_dc_2','opacity','rot_0','rot_1','rot_2','rot_3']
    header='ply\nformat binary_little_endian 1.0\nelement vertex 1\n'+''.join('property float '+n+'\n' for n in names)+'end_header\n'
    result=decode(header.encode()+struct.pack('<14f',0,0,0,0,0,0,0,0,0,0,1,0,0,0),'ply')
    assert len(result)==32
    assert struct.unpack_from('<6f',result)==(0,0,0,1,1,1)
    with pytest.raises(PlastisError):decode(header.replace('vertex 1',f'vertex {MAX_SPLATS+1}').encode(),'ply')

def test_upgrade_identity():
    for version in [1,2,3]:
        original={'schema':version,'nodes':[], 'keep':{'a':1}}
        assert upgrade_scene(copy.deepcopy(original))=={**original,'schema':3}
    assert upgrade_scene({'schema':4})=={'schema':4}

def test_import_undo_and_export(tmp_path):
    store=Store(tmp_path)
    scene=store.create_scene('Splats')
    env=import_bytes(scene['id'],store,record(),source_format='splat',original_name='test.splat',base_revision=1)
    node=next(n for n in env['nodes'] if n['kind']=='splat')
    assert node['splatAssetId']==env['assets'][0]['id']
    assert store.get_scene(scene['id'])['schema']==3
    undo=mutate.apply(scene['id'],2,{'op':'undo'},store=store)
    assert not any(n['kind']=='splat' for n in undo['nodes'])
    redo=mutate.apply(scene['id'],3,{'op':'redo'},store=store)
    assert any(n['kind']=='splat' for n in redo['nodes'])


def test_export_reports_ignored_splats(tmp_path):
    store=Store(tmp_path)
    scene=store.create_scene('Mixed')
    env=import_bytes(scene['id'],store,record(),source_format='splat',original_name='test.splat',base_revision=1)
    mutate.apply(scene['id'],2,{'op':'add_node','node':{'kind':'mesh','name':'Box','materialId':'m_default','primitive':{'type':'box'},'transform':{'t':[0,0,0],'r':[0,0,0],'s':[1,1,1]}}},store=store)
    result=export_scene(store.get_scene(scene['id']),store)
    assert any('Splat node' in item for item in result['stats']['ignored'])
    from plastis3d_scene.compat import check_scene
    report = check_scene(store.get_scene(scene['id']), store)
    omitted = next(i for i in report['issues'] if i['code'] == 'SPLAT_NOT_IN_GLB')
    splat = next(n for n in env['nodes'] if n['kind'] == 'splat')
    assert omitted['nodeIds'] == [splat['id']] and omitted['provenance'] == 'scene'
    assert report['output']['bytes'] == result['bytes']


def test_latest_render_replaces_and_delete_cleans(tmp_path):
    import zlib
    from plastis3d_scene.renders import save_render
    def png(color):
        def chunk(kind,payload):
            return struct.pack('>I',len(payload))+kind+payload+struct.pack('>I',zlib.crc32(kind+payload))
        return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',16,16,8,2,0,0,0))+chunk(b'IDAT',zlib.compress((b'\0'+bytes(color)*16)*16))+chunk(b'IEND',b'')
    store=Store(tmp_path);scene=store.create_scene('Rendered')
    result=save_render(store,scene['id'],1,png([255,0,0]))
    again=save_render(store,scene['id'],1,png([0,255,0]))
    assert result['path']==again['path']
    from pathlib import Path
    assert Path(result['path']).read_bytes()==png([0,255,0])
    with pytest.raises(PlastisError):save_render(store,scene['id'],0,png([0,0,0]))
    store.delete_scene(scene['id'],1)
    assert not Path(result['path']).exists()


def test_import_route_and_render_route(tmp_path, monkeypatch):
    import base64
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from test_import import _load_plugin_api_standalone
    monkeypatch.setenv('PLASTIS3D_DATA_DIR',str(tmp_path))
    api=_load_plugin_api_standalone();app=FastAPI();app.include_router(api.router,prefix='/api/plugins/plastis3d')
    store=Store(tmp_path);scene=store.create_scene('Route')
    with TestClient(app) as client:
        response=client.post('/api/plugins/plastis3d/scenes/'+scene['id']+'/imports',json={'baseRevision':1,'upload':{'filename':'tiny.splat','bytes':base64.b64encode(record()).decode()}})
        assert response.status_code==200,response.text
        row=response.json()['assets'][0]
        fetched=client.get('/api/plugins/plastis3d/assets/'+row['id'])
        assert fetched.status_code==200
        assert base64.b64decode(fetched.json()['bytes'])==record()
        response=client.post('/api/plugins/plastis3d/scenes/'+scene['id']+'/renders',json={'revision':2,'png':'not base64'})
        assert response.status_code==400
