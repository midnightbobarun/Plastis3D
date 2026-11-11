import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { hardwareReason, probeGpu, SAMPLE_CAP } from '../../src/viewport/renderMode';
import { splatMesh } from '../../src/scene/splats';
function renderer(name:string,float=true,webgl2=true){ return {capabilities:{isWebGL2:webgl2},getContext:()=>({getExtension:(key:string)=>key==='WEBGL_debug_renderer_info'?{UNMASKED_RENDERER_WEBGL:1}:float?{}:null,getParameter:()=>name})} as unknown as THREE.WebGLRenderer; }
describe('PR31 GPU gate',()=>{
 it('refuses software despite float support',async()=>{for(const name of ['SwiftShader','llvmpipe','Microsoft Basic Render Driver']){const r=renderer(name);expect(hardwareReason(r)).toBe('software');expect((await probeGpu(r)).tracer).toBe(false);}});
 it('requires float render targets and WebGL2',()=>{expect(hardwareReason(renderer('Apple',false))).toBe('float');expect(hardwareReason(renderer('Apple',true,false))).toBe('float');expect(hardwareReason(renderer('Apple'))).toBe('');});
 it('caps sampling',()=>expect(SAMPLE_CAP).toBe(256));
});
it('builds instanced Gaussian quads and rejects incomplete records',()=>{expect(()=>splatMesh(new ArrayBuffer(31))).toThrow();const data=new ArrayBuffer(32),v=new DataView(data);for(let j=0;j<3;j++)v.setFloat32(12+j*4,.1,true);const mesh=splatMesh(data);expect((mesh.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(1);expect(mesh.material).toHaveProperty('depthWrite',false);mesh.geometry.dispose();(mesh.material as THREE.Material).dispose();});
