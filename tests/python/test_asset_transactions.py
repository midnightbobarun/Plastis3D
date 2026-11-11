"""C-03 reservation, crash recovery and operation-lifetime acceptance cases."""
import hashlib
import json
import os
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from plastis3d_scene.asset_transactions import AssetOperation
from plastis3d_scene.spec import PlastisError
from plastis3d_scene.store import Store
from plastis3d_scene.sweep import sweep_files


def asset(data, suffix='glb'):
    sha = hashlib.sha256(data).hexdigest()
    return sha, sha + '.' + suffix


def test_batch_quota_reserves_base_and_result_before_any_publication(tmp_path):
    store = Store(tmp_path)
    _, first = asset(b'1234'); _, second = asset(b'5678')
    with pytest.raises(PlastisError) as error:
        with AssetOperation(store, files={first:b'1234', second:b'5678'}, quota=7):
            pytest.fail('over-quota batch admitted')
    assert error.value.code == 'IMPORT_TOO_LARGE'
    assert list(store.assets_dir.iterdir()) == []


def test_same_hash_is_charged_once_and_pins_prevent_zero_grace_gc(tmp_path):
    store = Store(tmp_path)
    data = b'unique object'; sha, name = asset(data)
    with AssetOperation(store, files={name:data}, quota=len(data)):
        with AssetOperation(store, files={name:data}, quota=len(data)):
            assert sweep_files(store, grace=0) == []
        assert sweep_files(store, grace=0) == []
    assert sweep_files(store, grace=0) == [name]


def test_export_pin_does_not_hold_profile_lock_or_block_other_publication(tmp_path):
    store = Store(tmp_path)
    data=b'original';sha,name=asset(data)
    with AssetOperation(store, files={name:data}, quota=100):
        pass
    with AssetOperation(store, assets=[{'sha256':sha}]):
        with store.asset_lock():
            pass
        with AssetOperation(store, files={asset(b'next')[1]:b'next'}, quota=100):
            assert name not in sweep_files(store, grace=0)
            assert (store.assets_dir/name).read_bytes()==data
    assert name in sweep_files(store, grace=0)


def test_reservations_count_while_slow_staging_is_outside_profile_lock(tmp_path, monkeypatch):
    store=Store(tmp_path);started=threading.Event();finish=threading.Event()
    first=b'123456';_,name=asset(first);original=Store._atomic_write
    def write(path,data):
        if Path(path).name==name:
            started.set();assert finish.wait(5)
        return original(path,data)
    monkeypatch.setattr(Store,'_atomic_write',staticmethod(write))
    def publish():
        with AssetOperation(store,files={name:first},quota=10):pass
    with ThreadPoolExecutor(max_workers=1) as executor:
        task=executor.submit(publish)
        try:
            assert started.wait(5)
            with pytest.raises(PlastisError) as error:
                with AssetOperation(store,files={asset(b'abcdef')[1]:b'abcdef'},quota=10):pass
            assert error.value.code=='IMPORT_TOO_LARGE'
            assert sweep_files(store,grace=0)==[]
        finally:
            finish.set()
        task.result(timeout=5)


def test_exception_after_publication_leaves_complete_collectable_object(tmp_path):
    store=Store(tmp_path);data=b'published';sha,name=asset(data)
    with pytest.raises(RuntimeError):
        with AssetOperation(store,files={name:data},quota=100):raise RuntimeError('commit refused')
    assert (store.assets_dir/name).read_bytes()==data
    assert sweep_files(store,grace=0)==[name]


def test_process_crash_releases_pin_and_reservation(tmp_path):
    store=Store(tmp_path);root=Path(__file__).resolve().parents[2]
    source='''import sys,time,hashlib
from plastis3d_scene.store import Store
from plastis3d_scene.asset_transactions import AssetOperation
store=Store(sys.argv[1]);data=b'crashed';sha=hashlib.sha256(data).hexdigest()
with AssetOperation(store,files={sha+'.glb':data},quota=7):
 print('ready',flush=True)
 time.sleep(60)
'''
    child=subprocess.Popen([sys.executable,'-c',source,str(tmp_path)],cwd=root,stdout=subprocess.PIPE,text=True)
    try:
        assert child.stdout.readline().strip()=='ready'
        assert sweep_files(store,grace=0)==[]
        child.kill();child.wait(timeout=5)
        assert len(sweep_files(store,grace=0))==1
        assert list((store.data_dir/'asset-operations').glob('*.json'))==[]
        with AssetOperation(store,files={asset(b'another')[1]:b'another'},quota=7):pass
    finally:
        if child.poll() is None:child.kill();child.wait(timeout=5)


def test_profiles_do_not_share_reservations(tmp_path):
    first=Store(tmp_path/'a');second=Store(tmp_path/'b');data=b'1234';sha,name=asset(data)
    with AssetOperation(first,files={name:data},quota=4):
        with AssetOperation(second,files={name:data},quota=4):
            assert sweep_files(first,grace=0)==[]
            assert sweep_files(second,grace=0)==[]


@pytest.mark.parametrize('kind',['model','image','splat'])
def test_import_admission_rejects_before_storing_and_reuses_shared_hash(tmp_path,monkeypatch,kind):
    from plastis3d_scene import import_model,images
    from test_textures import _png
    import struct
    store=Store(tmp_path)
    scenes=[store.create_scene('Import '+str(i)) for i in range(3)]
    if kind=='model':
        data=(Path(__file__).parent.parent/'fixtures/two-primitive.glb').read_bytes()
        def run(i):return import_model.import_bytes(scenes[i]['id'],store,data,source_format='glb',original_name='file.glb',base_revision=1)
        module=import_model
    elif kind=='image':
        data=_png()
        def run(i):return images.import_image_bytes(scenes[i]['id'],store,data,original_name='file.png',base_revision=1,material_id='m_default',slot='baseColorMap')
        module=images
    else:
        data=struct.pack('<6f8B',0,0,0,.1,.1,.1,255,0,0,255,255,128,128,128)
        def run(i):return import_model.import_bytes(scenes[i]['id'],store,data,source_format='splat',original_name='file.splat',base_revision=1)
        module=import_model
    monkeypatch.setattr(module,'MAX_ASSET_QUOTA_BYTES',len(data)-1)
    with pytest.raises(PlastisError) as error:run(0)
    assert error.value.code=='IMPORT_TOO_LARGE'
    assert list(store.assets_dir.iterdir())==[]
    monkeypatch.setattr(module,'MAX_ASSET_QUOTA_BYTES',len(data))
    assert run(1)['ok'] and run(2)['ok']
    assert sum(p.stat().st_size for p in store.assets_dir.iterdir())==len(data)


def test_sweep_contention_does_not_report_committed_bake_failed(tmp_path,monkeypatch):
    from plastis3d_scene import bake,sweep
    from test_bake import scene_with_box,bake_body
    monkeypatch.setenv('PLASTIS3D_DATA_DIR',str(tmp_path))
    store=Store(tmp_path);sid,rev,node=scene_with_box()
    def busy(*args,**kwargs):raise PlastisError('STORE_BUSY','simulated collection contention')
    monkeypatch.setattr(sweep,'sweep_files',busy)
    result=bake.bake_mesh(sid,store,bake_body(rev,node))
    assert result['scene']['revision']==rev+1
    assert store.get_scene(sid)['revision']==rev+1


def test_cross_process_import_quota_is_serialized(tmp_path):
    store=Store(tmp_path)
    for i in range(2):store.create_scene('Worker '+str(i),scene_id='worker-'+str(i))
    source='''import sys,time,struct,json
from pathlib import Path
from plastis3d_scene.store import Store
from plastis3d_scene import import_model
from plastis3d_scene.spec import PlastisError
root=Path(sys.argv[1]);i=int(sys.argv[2]);store=Store(root)
(root/('ready-'+str(i))).touch()
while not (root/'go').exists():time.sleep(.005)
import_model.MAX_ASSET_QUOTA_BYTES=60
try:
 import_model.import_bytes('worker-'+str(i),store,struct.pack('<6f8B',i,0,0,.1,.1,.1,255,0,0,255,255,128,128,128),source_format='splat',original_name='file.splat',base_revision=1)
 print('ok')
except PlastisError as e:print(e.code)
'''
    root=Path(__file__).resolve().parents[2]
    children=[subprocess.Popen([sys.executable,'-c',source,str(tmp_path),str(i)],cwd=root,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True) for i in range(2)]
    try:
        deadline=time.monotonic()+10
        while not all((tmp_path/('ready-'+str(i))).exists() for i in range(2)):
            assert time.monotonic()<deadline;time.sleep(.01)
        (tmp_path/'go').touch()
        results=[child.communicate(timeout=10) for child in children]
        assert all(child.returncode==0 for child in children),results
        assert sorted(out.strip() for out,err in results)==['IMPORT_TOO_LARGE','ok']
        assert sum(p.stat().st_size for p in store.assets_dir.iterdir())==32
    finally:
        for child in children:
            if child.poll() is None:child.kill();child.wait(timeout=5)


def test_operation_thread_lock_registry_and_markers_do_not_grow(tmp_path):
    from plastis3d_scene.store import _thread_locks
    store=Store(tmp_path)
    for _ in range(50):
        with AssetOperation(store):pass
    prefix=str(store.data_dir/'asset-operations')
    assert not [key for key in _thread_locks if key.startswith(prefix)]
    assert list((store.data_dir/'asset-operations').iterdir())==[]


def test_weld_output_obeys_quota_and_refusal_preserves_scene(tmp_path,monkeypatch):
    from plastis3d_scene import cleanup,import_model
    from test_weld import _stl,_cube_triangles
    store=Store(tmp_path);scene=store.create_scene('Weld quota')
    env=import_model.import_bytes(scene['id'],store,_stl(_cube_triangles()),source_format='stl',original_name='cube.stl',base_revision=1,explode=False)
    used=sum(p.stat().st_size for p in store.assets_dir.iterdir())
    monkeypatch.setattr(import_model,'MAX_ASSET_QUOTA_BYTES',used)
    with pytest.raises(PlastisError) as error:cleanup.run(scene['id'],store,env['scene']['revision'],['weld'])
    assert error.value.code=='IMPORT_TOO_LARGE'
    assert sum(p.stat().st_size for p in store.assets_dir.iterdir())==used
    assert store.get_scene(scene['id'])['revision']==env['scene']['revision']


def test_same_hash_concurrent_reservations_wait_and_charge_once(tmp_path,monkeypatch):
    store=Store(tmp_path);data=b'deduplicated';sha,name=asset(data)
    started=threading.Event();original=Store._atomic_write
    def write(path,payload):
        if Path(path).name==name:
            started.set();time.sleep(.2)
        original(path,payload)
    monkeypatch.setattr(Store,'_atomic_write',staticmethod(write))
    def publish():
        with AssetOperation(store,files={name:data},quota=len(data)):return True
    with ThreadPoolExecutor(max_workers=2) as executor:
        first=executor.submit(publish);assert started.wait(5)
        second=executor.submit(publish)
        assert first.result(timeout=5) and second.result(timeout=5)
    assert sum(p.stat().st_size for p in store.assets_dir.iterdir())==len(data)


def test_crash_before_publication_releases_reserved_capacity(tmp_path):
    store=Store(tmp_path);root=Path(__file__).resolve().parents[2]
    source='''import sys,time,hashlib
from pathlib import Path
from plastis3d_scene.store import Store
from plastis3d_scene.asset_transactions import AssetOperation
original=Store._atomic_write

def write(path,data):
 if Path(path).suffix=='.glb':
  Path(path).write_bytes(data[:3])
  print('reserved',flush=True)
  time.sleep(60)
 original(path,data)
Store._atomic_write=staticmethod(write)
data=b'reserve';sha=hashlib.sha256(data).hexdigest()
with AssetOperation(Store(sys.argv[1]),files={sha+'.glb':data},quota=7):pass
'''
    child=subprocess.Popen([sys.executable,'-c',source,str(tmp_path)],cwd=root,stdout=subprocess.PIPE,text=True)
    try:
        assert child.stdout.readline().strip()=='reserved'
        assert list(store.assets_dir.iterdir())==[]
        child.kill();child.wait(timeout=5)
        with AssetOperation(store,files={asset(b'newdata')[1]:b'newdata'},quota=7):pass
        assert len(list(store.assets_dir.iterdir()))==1
        assert not list((store.data_dir/'asset-operations').glob('*.json'))
        assert not list((store.data_dir/'asset-operations').glob('stage-*'))
    finally:
        if child.poll() is None:child.kill();child.wait(timeout=5)


def test_actual_displacement_bake_reserves_base_and_result_together(tmp_path,monkeypatch):
    from plastis3d_scene import bake,generators,mutate
    def setup(store):
        scene=store.create_scene('Displace batch')
        env=mutate.apply(scene['id'],1,{'op':'add_node','node':{'kind':'mesh','name':'Box','materialId':'m_default','primitive':{'type':'box'},'transform':{'t':[0,0,0],'r':[0,0,0],'s':[1,1,1]}}},store=store)
        return scene['id'],env['scene']['revision'],next(n['id'] for n in env['nodes'] if n['kind']=='mesh')
    first=Store(tmp_path/'measure');sid,rev,node=setup(first)
    generators.make_displace(first,sid,rev,node,{'amplitude':.2})
    lengths=[p.stat().st_size for p in first.assets_dir.iterdir()]
    assert len(lengths)==2
    second=Store(tmp_path/'limited');sid,rev,node=setup(second)
    monkeypatch.setattr(bake,'MAX_ASSET_QUOTA_BYTES',sum(lengths)-1)
    with pytest.raises(PlastisError) as error:generators.make_displace(second,sid,rev,node,{'amplitude':.2})
    assert error.value.code=='IMPORT_TOO_LARGE'
    assert list(second.assets_dir.iterdir())==[]
    assert second.get_scene(sid)['revision']==rev


def test_actual_export_pin_preserves_reader_until_revision_conflict(tmp_path,monkeypatch):
    from plastis3d_scene import import_model
    from plastis3d_scene.export_glb import export_scene
    store=Store(tmp_path);scene=store.create_scene('Export reader')
    data=(Path(__file__).parent.parent/'fixtures/two-primitive.glb').read_bytes()
    env=import_model.import_bytes(scene['id'],store,data,source_format='glb',original_name='model.glb',base_revision=1,explode=False)
    snapshot=store.get_scene(scene['id']);original=Path.read_bytes;triggered=[]
    def read(path):
        if path.parent==store.assets_dir and not triggered:
            triggered.append(True)
            changed=store.get_scene(scene['id'])
            changed['nodes']=[n for n in changed['nodes'] if n['kind'] not in ('model','part','group')]
            changed['assets']=[]
            store.write_scene(scene['id'],changed,changed['revision'],history_override={'undo':[],'redo':[]})
            assert sweep_files(store,grace=0)==[]
        return original(path)
    monkeypatch.setattr(Path,'read_bytes',read)
    with pytest.raises(PlastisError) as error:
        export_scene(snapshot,store)
    assert triggered and error.value.code=='REVISION_CONFLICT'
    assert list(store.exports_dir.iterdir())==[]
    assert len(sweep_files(store,grace=0))==1
