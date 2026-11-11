import * as THREE from 'three';

/** Gaussian ellipsoids projected as instanced quads. Sorting publishes only complete passes. */
export function splatMesh(buffer: ArrayBuffer): THREE.Mesh {
  if (!buffer.byteLength || buffer.byteLength % 32 || buffer.byteLength / 32 > 2_000_000) throw new Error('Invalid splat payload');
  const count = buffer.byteLength / 32, view = new DataView(buffer);
  const positions = new Float32Array(count * 3), scales = new Float32Array(count * 3), colors = new Float32Array(count * 4), rotations = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    for (let j = 0; j < 3; j++) { positions[i*3+j] = view.getFloat32(i*32+j*4,true); scales[i*3+j] = view.getFloat32(i*32+12+j*4,true); }
    for (let j = 0; j < 4; j++) { colors[i*4+j] = view.getUint8(i*32+24+j)/255; rotations[i*4+j] = (view.getUint8(i*32+28+j)-128)/128; }
  }
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1,-1,0,1,-1,0,1,1,0,-1,1,0],3));
  geometry.setIndex([0,1,2,0,2,3]); geometry.instanceCount = count;
  const attrs = [new THREE.InstancedBufferAttribute(positions.slice(),3),new THREE.InstancedBufferAttribute(scales.slice(),3),new THREE.InstancedBufferAttribute(colors.slice(),4),new THREE.InstancedBufferAttribute(rotations.slice(),4)];
  ['center','extent','rgba','rotation'].forEach((key,i)=>geometry.setAttribute(key,attrs[i]));
  const material = new THREE.ShaderMaterial({transparent:true,depthWrite:false,side:THREE.DoubleSide,uniforms:{},vertexShader:`
  attribute vec3 center; attribute vec3 extent; attribute vec4 rgba; attribute vec4 rotation;
  varying vec2 uvGaussian; varying vec4 colorGaussian;
  void main(){
    vec4 q=normalize(vec4(rotation.yzw,rotation.x));
    mat3 R=mat3(1.-2.*(q.y*q.y+q.z*q.z),2.*(q.x*q.y+q.w*q.z),2.*(q.x*q.z-q.w*q.y),2.*(q.x*q.y-q.w*q.z),1.-2.*(q.x*q.x+q.z*q.z),2.*(q.y*q.z+q.w*q.x),2.*(q.x*q.z+q.w*q.y),2.*(q.y*q.z-q.w*q.x),1.-2.*(q.x*q.x+q.y*q.y));
    mat3 A=mat3(modelViewMatrix)*R*mat3(extent.x,0.,0.,0.,extent.y,0.,0.,0.,extent.z);
    vec4 p=modelViewMatrix*vec4(center,1.); float z=max(0.001,-p.z);
    vec3 jx=vec3(projectionMatrix[0][0]/z,0.,projectionMatrix[0][0]*p.x/(z*z));
    vec3 jy=vec3(0.,projectionMatrix[1][1]/z,projectionMatrix[1][1]*p.y/(z*z));
    vec3 ax=transpose(A)*jx, ay=transpose(A)*jy;
    float a=dot(ax,ax)+1e-8,b=dot(ax,ay),c=dot(ay,ay)+1e-8;
    float mid=(a+c)*0.5, d=sqrt(max(0.,(a-c)*(a-c)*0.25+b*b));
    vec2 e=abs(b)>1e-8?normalize(vec2(b,mid+d-a)):vec2(1.,0.);
    vec2 offset=3.*(position.x*sqrt(max(mid+d,1e-8))*e+position.y*sqrt(max(mid-d,1e-8))*vec2(-e.y,e.x));
    gl_Position=projectionMatrix*p; gl_Position.xy+=offset*gl_Position.w;
    if(p.z>=0.)gl_Position=vec4(2.,2.,2.,1.);
    uvGaussian=position.xy*3.; colorGaussian=rgba;
  }`,fragmentShader:`varying vec2 uvGaussian; varying vec4 colorGaussian; void main(){float r=dot(uvGaussian,uvGaussian);if(r>9.)discard;gl_FragColor=vec4(colorGaussian.rgb,colorGaussian.a*exp(-0.5*r));}`});
  const mesh = new THREE.Mesh(geometry,material); mesh.frustumCulled=false;
  let signature='', generator:Generator<void,void,unknown>|null=null;
  function* sort(camera:THREE.Camera):Generator<void,void,unknown>{
    const matrix=new THREE.Matrix4().multiplyMatrices(camera.matrixWorldInverse,mesh.matrixWorld);
    const e=matrix.elements, depths=new Float32Array(count), order=new Uint32Array(count), scratch=new Uint32Array(count);
    for(let i=0;i<count;i++){order[i]=i;depths[i]=e[2]*positions[i*3]+e[6]*positions[i*3+1]+e[10]*positions[i*3+2]+e[14];if(i%1024===0)yield;}
    for(let width=1;width<count;width*=2){for(let start=0;start<count;start+=width*2){let l=start,r=Math.min(start+width,count),end=Math.min(start+width*2,count),k=start,mid=r;while(l<mid||r<end){scratch[k++]=r>=end||(l<mid&&depths[order[l]]<=depths[order[r]])?order[l++]:order[r++];if(k%1024===0)yield;}}order.set(scratch);yield;}
    for(let i=0;i<count;i++){const source=order[i];for(let a=0;a<4;a++){const original=[positions,scales,colors,rotations][a],size=attrs[a].itemSize;for(let j=0;j<size;j++)attrs[a].array[i*size+j]=original[source*size+j];}if(i%1024===0)yield;}
    attrs.forEach(a=>a.needsUpdate=true);
  }
  mesh.onBeforeRender=(_r,_s,camera)=>{const key=camera.matrixWorld.elements.join(',')+mesh.matrixWorld.elements.join(',');if(key!==signature){signature=key;generator=sort(camera);}const end=performance.now()+8;while(generator&&performance.now()<end){if(generator.next().done)generator=null;}};
  mesh.userData.plastis3dOwned=true; geometry.userData.plastis3dOwned=true;material.userData.plastis3dOwned=true;
  return mesh;
}
