// src/viewport/stage.ts — the studio stage (UI/UX redesign §5, PR32).
//
// Everything here is VIEW-ONLY: nothing is written to the scene or the
// GLB, the agent sees none of it, export is unchanged. Each piece reuses
// the surface's own renderer (no new WebGL context, so the lease budget
// is untouched) and disposes every GPU resource it creates.
//
//   - InfiniteGrid: a shader grid on the floor plane (1 m minor, 5 m
//     major, X axis line in the theme red, Z axis line in the theme
//     blue) that fades with distance — no hard square edge.
//   - ContactShadow: the depth-from-below technique. Renders the scene's
//     depth from an orthographic camera under the floor into a 256²
//     target, blurs it twice, and shows it on a floor plane. Re-rendered
//     only when marked dirty (scene rebuild, a gizmo drag), never every
//     frame.
//   - SelectionOutline: a screen-space outline. Renders the selected /
//     hovered meshes into a mask target, then draws an edge pass over
//     the frame in the accent colour. Runs only while something is
//     selected or hovered.
//   - detectSoftwareRenderer: the Low-tier trigger.

import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { HorizontalBlurShader } from "three/addons/shaders/HorizontalBlurShader.js";
import { VerticalBlurShader } from "three/addons/shaders/VerticalBlurShader.js";

export type QualityTier = "high" | "low";

/** sRGB triple 0..1. */
export type Rgb = [number, number, number];

// --- infinite grid -----------------------------------------------------------------

const GRID_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const GRID_FRAG = /* glsl */ `
uniform vec3 uLine;
uniform vec3 uAxisX;
uniform vec3 uAxisZ;
uniform float uSpacing;
uniform float uFadeFar;
uniform float uOpacity;
uniform vec3 uCam;
varying vec3 vWorld;

float lineMask(vec2 p, float s, float width) {
  vec2 c = p / s;
  vec2 d = fwidth(c);
  vec2 g = abs(fract(c - 0.5) - 0.5) / max(d, vec2(1e-5));
  float l = min(g.x, g.y);
  float m = 1.0 - min(l / width, 1.0);
  // Fade a line family out before it turns into moire.
  float density = max(d.x, d.y);
  return m * (1.0 - smoothstep(0.18, 0.45, density));
}

void main() {
  vec2 p = vWorld.xz;
  float minor = lineMask(p, uSpacing, 1.0);
  float major = lineMask(p, uSpacing * 5.0, 1.25);
  float ax = 1.0 - min(abs(p.y) / max(fwidth(p.y), 1e-5) / 1.4, 1.0);
  float az = 1.0 - min(abs(p.x) / max(fwidth(p.x), 1e-5) / 1.4, 1.0);
  float dist = length(vWorld.xz - uCam.xz);
  float fade = 1.0 - smoothstep(uFadeFar * 0.25, uFadeFar, dist);
  // Lines at a grazing angle crowd together: fade with view elevation.
  vec3 toCam = normalize(uCam - vWorld);
  float grazing = smoothstep(0.02, 0.22, abs(toCam.y));
  float a = max(minor * 0.16, major * 0.32);
  vec3 col = uLine;
  if (ax > 0.0 && ax * 0.75 >= a) { col = uAxisX; a = ax * 0.75; }
  if (az > 0.0 && az * 0.75 >= a) { col = uAxisZ; a = az * 0.75; }
  a *= fade * grazing * uOpacity;
  if (a < 0.003) discard;
  gl_FragColor = vec4(col, a);
}
`;

export class InfiniteGrid {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;

  constructor() {
    const geometry = new THREE.PlaneGeometry(2000, 2000, 1, 1);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.ShaderMaterial({
      vertexShader: GRID_VERT,
      fragmentShader: GRID_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      uniforms: {
        uLine: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
        uAxisX: { value: new THREE.Vector3(0.9, 0.3, 0.3) },
        uAxisZ: { value: new THREE.Vector3(0.3, 0.5, 0.95) },
        uSpacing: { value: 1 },
        uFadeFar: { value: 40 },
        uOpacity: { value: 1 },
        uCam: { value: new THREE.Vector3() },
      },
    });
    // The extensions flag is not needed: fwidth is core in WebGL2.
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = "p3d-stage-grid";
    this.mesh.renderOrder = -2;
    this.mesh.frustumCulled = false;
    this.mesh.userData.viewOnly = true;
    this.mesh.raycast = () => {};
  }

  setColors(line: Rgb, axisX: Rgb, axisZ: Rgb): void {
    const u = this.mesh.material.uniforms;
    (u.uLine.value as THREE.Vector3).set(...line);
    (u.uAxisX.value as THREE.Vector3).set(...axisX);
    (u.uAxisZ.value as THREE.Vector3).set(...axisZ);
  }

  /** Per frame: the camera position and how far the grid reaches. */
  update(camera: THREE.Camera, target: THREE.Vector3): void {
    const u = this.mesh.material.uniforms;
    (u.uCam.value as THREE.Vector3).copy(camera.position);
    const reach = camera.position.distanceTo(target);
    u.uFadeFar.value = Math.max(18, reach * 5.5);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

// --- contact shadow ----------------------------------------------------------------

const SHADOW_SIZE = 256;

export class ContactShadow {
  readonly group = new THREE.Group();
  private readonly rt: THREE.WebGLRenderTarget;
  private readonly rtBlur: THREE.WebGLRenderTarget;
  private readonly plane: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly hBlur: THREE.ShaderMaterial;
  private readonly vBlur: THREE.ShaderMaterial;
  private readonly depthMaterial: THREE.MeshDepthMaterial;
  private readonly camera: THREE.OrthographicCamera;
  private dirty = true;
  /** Shadow strength 0..1 (lighter on dark themes). */
  darkness = 0.55;

  constructor() {
    this.group.name = "p3d-stage-shadow";
    this.group.userData.viewOnly = true;
    const opts = { depthBuffer: true } as const;
    this.rt = new THREE.WebGLRenderTarget(SHADOW_SIZE, SHADOW_SIZE, opts);
    this.rt.texture.generateMipmaps = false;
    this.rtBlur = new THREE.WebGLRenderTarget(SHADOW_SIZE, SHADOW_SIZE, opts);
    this.rtBlur.texture.generateMipmaps = false;

    const geometry = new THREE.PlaneGeometry(1, 1).rotateX(Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({
      map: this.rt.texture,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    this.plane = new THREE.Mesh(geometry, material);
    this.plane.renderOrder = -1;
    // The texture is rendered looking UP from below: flip to match.
    this.plane.scale.y = -1;
    this.plane.raycast = () => {};
    this.group.add(this.plane);

    this.hBlur = new THREE.ShaderMaterial(HorizontalBlurShader);
    this.hBlur.depthTest = false;
    this.vBlur = new THREE.ShaderMaterial(VerticalBlurShader);
    this.vBlur.depthTest = false;

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.camera.rotation.x = Math.PI / 2;
    this.group.add(this.camera);

    const depth = new THREE.MeshDepthMaterial();
    depth.userData.darkness = { value: this.darkness };
    depth.onBeforeCompile = (shader) => {
      shader.uniforms.darkness = depth.userData.darkness;
      shader.fragmentShader = /* glsl */ `
        uniform float darkness;
        ${shader.fragmentShader.replace(
          "gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );",
          "gl_FragColor = vec4( vec3( 0.0 ), ( 1.0 - fragCoordZ ) * darkness );",
        )}
      `;
    };
    depth.depthTest = false;
    depth.depthWrite = false;
    this.depthMaterial = depth;
  }

  markDirty(): void {
    this.dirty = true;
  }

  /**
   * Fit the shadow to the content's bounds (x/z footprint) and re-render
   * it if dirty. `content` is the built scene root; view-only objects
   * are hidden for the pass by the caller.
   */
  render(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    content: THREE.Object3D,
    hide: THREE.Object3D[],
  ): void {
    if (!this.dirty) return;
    this.dirty = false;
    const box = new THREE.Box3().setFromObject(content);
    if (box.isEmpty() || box.max.y < 0.0005) {
      this.plane.visible = false;
      return;
    }
    this.plane.visible = true;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const extent = Math.max(size.x, size.z, 0.5) * 1.6 + 0.6;
    const height = Math.max(box.max.y, 0.5) * 0.9;
    this.group.position.set(center.x, 0.002, center.z);
    this.plane.scale.set(extent, -1, extent);
    this.camera.left = -extent / 2;
    this.camera.right = extent / 2;
    this.camera.top = extent / 2;
    this.camera.bottom = -extent / 2;
    this.camera.far = height;
    this.camera.updateProjectionMatrix();
    this.group.updateMatrixWorld(true);
    (this.depthMaterial.userData.darkness as { value: number }).value = this.darkness;

    const prevBackground = scene.background;
    const prevOverride = scene.overrideMaterial;
    const prevTarget = renderer.getRenderTarget();
    const prevClearAlpha = renderer.getClearAlpha();
    const prevClearColor = renderer.getClearColor(new THREE.Color());
    const visibility = hide.map((o) => o.visible);
    for (const o of hide) o.visible = false;
    this.plane.visible = false;

    scene.background = null;
    scene.overrideMaterial = this.depthMaterial;
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    renderer.render(scene, this.camera);
    scene.overrideMaterial = prevOverride;

    this.blur(renderer, 1 / 256);
    this.blur(renderer, 0.4 / 256);

    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClearColor, prevClearAlpha);
    scene.background = prevBackground;
    hide.forEach((o, i) => (o.visible = visibility[i]));
    this.plane.visible = true;
  }

  private blur(renderer: THREE.WebGLRenderer, amount: number): void {
    const quad = new FullScreenQuad(this.hBlur);
    this.hBlur.uniforms.tDiffuse.value = this.rt.texture;
    this.hBlur.uniforms.h.value = amount;
    renderer.setRenderTarget(this.rtBlur);
    quad.render(renderer);
    quad.material = this.vBlur;
    this.vBlur.uniforms.tDiffuse.value = this.rtBlur.texture;
    this.vBlur.uniforms.v.value = amount;
    renderer.setRenderTarget(this.rt);
    quad.render(renderer);
    quad.dispose();
  }

  dispose(): void {
    this.rt.dispose();
    this.rtBlur.dispose();
    this.plane.geometry.dispose();
    this.plane.material.dispose();
    this.hBlur.dispose();
    this.vBlur.dispose();
    this.depthMaterial.dispose();
  }
}

// --- selection outline -------------------------------------------------------------

const OUTLINE_LAYER = 31;

const EDGE_FRAG = /* glsl */ `
uniform sampler2D tMask;
uniform vec2 uTexel;
uniform vec3 uColor;
uniform float uWidth;
varying vec2 vUv;
void main() {
  float c = texture2D(tMask, vUv).r;
  float m = 0.0;
  for (int i = 0; i < 16; i++) {
    float ang = float(i) * 0.39269908;
    vec2 dir = vec2(cos(ang), sin(ang));
    m = max(m, texture2D(tMask, vUv + dir * uTexel * uWidth).r);
    m = max(m, texture2D(tMask, vUv + dir * uTexel * uWidth * 0.5).r);
  }
  float edge = max(m - c, 0.0);
  if (edge < 0.004) discard;
  gl_FragColor = vec4(uColor, edge);
}
`;

const EDGE_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export interface OutlineGroup {
  objects: THREE.Object3D[];
  /** 0..1: primary 1, other selected 0.6, hover 0.35. */
  strength: number;
}

export class SelectionOutline {
  private readonly rt: THREE.WebGLRenderTarget;
  private readonly maskMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  private readonly edgeMaterial: THREE.ShaderMaterial;
  private readonly quad: FullScreenQuad;

  constructor() {
    this.rt = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
    this.rt.texture.generateMipmaps = false;
    this.maskMaterial.toneMapped = false;
    this.edgeMaterial = new THREE.ShaderMaterial({
      vertexShader: EDGE_VERT,
      fragmentShader: EDGE_FRAG,
      uniforms: {
        tMask: { value: this.rt.texture },
        uTexel: { value: new THREE.Vector2(1, 1) },
        uColor: { value: new THREE.Vector3(0, 0.33, 1) },
        uWidth: { value: 2 },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.quad = new FullScreenQuad(this.edgeMaterial);
  }

  setColor(rgb: Rgb): void {
    (this.edgeMaterial.uniforms.uColor.value as THREE.Vector3).set(...rgb);
  }

  /** Draw the outline over what is already on screen. */
  render(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    groups: OutlineGroup[],
  ): void {
    const live = groups.filter((g) => g.objects.length > 0 && g.strength > 0);
    if (live.length === 0) return;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    if (this.rt.width !== size.x || this.rt.height !== size.y) this.rt.setSize(size.x, size.y);
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevClearAlpha = renderer.getClearAlpha();
    const prevClearColor = renderer.getClearColor(new THREE.Color());
    const prevBackground = scene.background;
    const prevOverride = scene.overrideMaterial;
    const prevMask = camera.layers.mask;

    renderer.autoClear = false;
    renderer.setRenderTarget(this.rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    scene.background = null;
    scene.overrideMaterial = this.maskMaterial;
    camera.layers.set(OUTLINE_LAYER);
    // Weakest first, so the primary wins where they overlap.
    for (const group of [...live].sort((a, b) => a.strength - b.strength)) {
      const meshes: THREE.Object3D[] = [];
      for (const root of group.objects) {
        root.traverseVisible((o) => {
          if ((o as THREE.Mesh).isMesh && !o.userData.viewOnly && !o.name.startsWith("pick-proxy:")) meshes.push(o);
        });
      }
      if (meshes.length === 0) continue;
      this.maskMaterial.color.setRGB(group.strength, group.strength, group.strength);
      for (const m of meshes) m.layers.enable(OUTLINE_LAYER);
      renderer.render(scene, camera);
      for (const m of meshes) m.layers.disable(OUTLINE_LAYER);
    }
    camera.layers.mask = prevMask;
    scene.overrideMaterial = prevOverride;
    scene.background = prevBackground;

    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClearColor, prevClearAlpha);
    const dpr = renderer.getPixelRatio();
    (this.edgeMaterial.uniforms.uTexel.value as THREE.Vector2).set(1 / size.x, 1 / size.y);
    this.edgeMaterial.uniforms.uWidth.value = 2 * dpr;
    this.quad.render(renderer);
    renderer.autoClear = prevAutoClear;
  }

  dispose(): void {
    this.rt.dispose();
    this.maskMaterial.dispose();
    this.edgeMaterial.dispose();
    this.quad.dispose();
  }
}

// --- markers for lights and cameras ------------------------------------------------

/**
 * A small view-only marker drawn at a selected light or camera (its
 * object has no geometry, so the outline has nothing to trace). Replaces
 * the old BoxHelper cage, which became giant diagonal lines whenever the
 * orbit view sat inside the camera's own bounds (redesign §1.1 row 13).
 */
export function createNodeMarker(color: THREE.Color): THREE.Mesh {
  const geometry = new THREE.OctahedronGeometry(0.09, 0);
  const material = new THREE.MeshBasicMaterial({
    color,
    wireframe: true,
    depthTest: false,
    transparent: true,
    opacity: 0.95,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 10;
  mesh.userData.viewOnly = true;
  mesh.raycast = () => {};
  return mesh;
}

// --- quality -------------------------------------------------------------------------

/** True when WebGL names a software rasteriser (SwiftShader, llvmpipe…). */
export function detectSoftwareRenderer(renderer: THREE.WebGLRenderer): boolean {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const name = String(
      ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    );
    return /swiftshader|llvmpipe|software|basic render/i.test(name);
  } catch {
    return false;
  }
}

/** Median of the last N frame times (ms). */
export class FrameTimeGuard {
  private samples: number[] = [];
  private last = 0;
  constructor(private readonly window = 120, private readonly limitMs = 33) {}
  /** Feed a timestamp; returns true once when the median goes over. */
  tick(now: number): boolean {
    if (this.last > 0) {
      const dt = now - this.last;
      // Ignore stalls (tab hidden, debugger): they are not frame cost.
      if (dt < 250) this.samples.push(dt);
      if (this.samples.length > this.window) this.samples.shift();
    }
    this.last = now;
    if (this.samples.length < this.window) return false;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median > this.limitMs) {
      this.samples = [];
      return true;
    }
    return false;
  }
  reset(): void {
    this.samples = [];
    this.last = 0;
  }
}

// --- camera glide ---------------------------------------------------------------------

export interface Glide {
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  start: number;
  duration: number;
}

export function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Apply a glide at time `now`; returns false when finished. */
export function stepGlide(
  glide: Glide,
  now: number,
  camera: THREE.Camera,
  target: THREE.Vector3,
): boolean {
  const t = glide.duration <= 0 ? 1 : Math.min(1, (now - glide.start) / glide.duration);
  const e = easeInOut(t);
  camera.position.lerpVectors(glide.fromPos, glide.toPos, e);
  target.lerpVectors(glide.fromTarget, glide.toTarget, e);
  return t < 1;
}
