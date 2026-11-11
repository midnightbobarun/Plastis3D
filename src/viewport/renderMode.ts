import * as THREE from 'three';
import { WebGLPathTracer, GradientEquirectTexture } from 'three-gpu-pathtracer';
import { splatMesh } from '../scene/splats';

export const SAMPLE_CAP = 256;
export interface GpuSupport { tracer: boolean; splats: boolean; reason: string }
export function hardwareReason(renderer: THREE.WebGLRenderer): string {
  const gl=renderer.getContext(), extension=gl.getExtension('WEBGL_debug_renderer_info');
  const name=extension?String(gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)):'';
  if (/swiftshader|llvmpipe|basic render|softpipe|software/i.test(name)) return 'software';
  if (!renderer.capabilities.isWebGL2 || !gl.getExtension('EXT_color_buffer_float')) return 'float';
  return '';
}
function pixelsPass(renderer:THREE.WebGLRenderer,target:THREE.WebGLRenderTarget):boolean {
  const pixels=new Float32Array(64*64*4);renderer.readRenderTargetPixels(target,0,0,64,64,pixels);
  return pixels.every(Number.isFinite)&&pixels.some((v,i)=>i%4!==3&&v>0.001);
}
/** Actual tiny draws on the leased surface; no benchmark or GPU-name-only approval. */
const probes = new WeakMap<THREE.WebGLRenderer, Promise<GpuSupport>>();
export function probeGpu(renderer:THREE.WebGLRenderer):Promise<GpuSupport> {
  let result = probes.get(renderer); if (!result) { result = runProbe(renderer); probes.set(renderer, result); } return result;
}
async function runProbe(renderer:THREE.WebGLRenderer):Promise<GpuSupport> {
  const reason=hardwareReason(renderer);if(reason)return {tracer:false,splats:false,reason};
  const size=renderer.getSize(new THREE.Vector2()), ratio=renderer.getPixelRatio(), target=renderer.getRenderTarget();
  const camera=new THREE.PerspectiveCamera(45,1,0.1,10);camera.position.z=3;camera.updateMatrixWorld();
  const scene=new THREE.Scene();scene.background=new THREE.Color(0.3,0.3,0.3);
  const geometry=new THREE.SphereGeometry(0.5,8,8),material=new THREE.MeshStandardMaterial({color:'white',emissive:0x666666});scene.add(new THREE.Mesh(geometry,material));
  let tracer:WebGLPathTracer|undefined;let tracerOk=false,splatsOk=false;
  const start=performance.now();
  try { renderer.setPixelRatio(1);renderer.setSize(64,64,false);tracer=new WebGLPathTracer(renderer);tracer.renderDelay=0;tracer.minSamples=1;tracer.fadeDuration=0;tracer.rasterizeScene=false;tracer.renderToCanvas=false;tracer.setScene(scene,camera);tracer.renderSample();tracer.synchronizeRenderSize=false;renderer.setPixelRatio(ratio);renderer.setSize(size.x,size.y,false);while(tracer.samples<1&&performance.now()-start<5000){await new Promise<void>(resolve=>setTimeout(resolve,16));tracer.renderSample();}tracerOk=pixelsPass(renderer,tracer.target)&&performance.now()-start<5000; }catch {tracerOk=false;}finally{tracer?.dispose();geometry.dispose();material.dispose();}
  const output=new THREE.WebGLRenderTarget(64,64,{type:THREE.FloatType});
  let mesh:THREE.Mesh|undefined;
  try {const data=new ArrayBuffer(3200),v=new DataView(data);for(let i=0;i<100;i++){for(let j=0;j<3;j++){v.setFloat32(i*32+j*4,0,true);v.setFloat32(i*32+12+j*4,0.05,true);}for(let j=0;j<8;j++)v.setUint8(i*32+24+j,j<4?255:128);v.setUint8(i*32+28,255);}mesh=splatMesh(data);scene.clear();scene.background=new THREE.Color(0);scene.add(mesh);renderer.setRenderTarget(output);renderer.render(scene,camera);splatsOk=pixelsPass(renderer,output)&&performance.now()-start<6000;}catch{splatsOk=false;}finally{mesh?.geometry.dispose();if(mesh)(mesh.material as THREE.Material).dispose();output.dispose();renderer.setRenderTarget(target);renderer.setPixelRatio(ratio);renderer.setSize(size.x,size.y,false);}
  return {tracer:tracerOk,splats:splatsOk,reason:tracerOk&&splatsOk?'':'probe'};
}

export class ProgressiveRender {
  private tracer:WebGLPathTracer;
  private signature='';
  private environment:GradientEquirectTexture;
  constructor(private renderer:THREE.WebGLRenderer,scene:THREE.Scene,camera:THREE.Camera){
    let triangles=0;scene.traverse(o=>{if(o instanceof THREE.Mesh&&!o.geometry.isInstancedBufferGeometry)triangles+=(o.geometry.index?.count??o.geometry.getAttribute('position')?.count??0)/3;});
    if(triangles>200_000)throw new Error('Render supports at most 200,000 triangles.');
    this.environment=new GradientEquirectTexture(64);this.environment.topColor.set(0xffffff);this.environment.bottomColor.set(0x303030);this.environment.update();scene.environment=this.environment;
    this.tracer=new WebGLPathTracer(renderer);this.tracer.renderDelay=0;this.tracer.minSamples=1;this.tracer.fadeDuration=0;this.tracer.bounces=4;this.tracer.rasterizeScene=false;this.tracer.setScene(scene,camera);
  }
  get samples(){return this.tracer.samples;}
  draw(camera:THREE.Camera,revision:number){camera.updateMatrixWorld();const size=this.renderer.getDrawingBufferSize(new THREE.Vector2());this.tracer.renderScale=Math.min(1,2048/Math.max(size.x,size.y));const key=camera.matrixWorld.elements.join(',')+camera.projectionMatrix.elements.join(',')+revision+size.toArray().join(',');if(key!==this.signature){this.signature=key;this.tracer.updateCamera();this.tracer.reset();}if(this.samples<SAMPLE_CAP)this.tracer.renderSample();}
  dispose(){this.tracer.dispose();this.environment.dispose();}
}
