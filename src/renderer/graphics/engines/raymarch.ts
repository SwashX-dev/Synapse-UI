/**
 * Full-screen shader scenes:
 *   mandelbulb  ray-marched power-n Mandelbulb distance estimator with orbit traps
 *   tunnel      endless procedural geometric tunnel (polar mapping)
 * The Mandelbulb follows the rig camera (orbit / zoom into the fractal).
 */
import * as THREE from 'three';
import type { EngineDef, EngineInstance, FrameInput, HudInfo, Params, VizColors } from '../types';
import { bool, num, str } from '../types';
import { titleBlock } from './hud';
import { HASH } from '../glsl';

const VERT = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const MANDELBULB = /* glsl */ `
uniform vec2 uRes;
uniform vec3 uCamPos;
uniform mat4 uCamWorld;
uniform mat4 uProjInv;
uniform float uTime, uPower, uSteps, uBright, uOpacity, uDetail, uAudio;
uniform vec3 uColA, uColB, uBg;
varying vec2 vUv;
vec4 trap;
float de(vec3 p) {
  vec3 z = p;
  float dr = 1.0, r = 0.0;
  float power = uPower + uAudio * 1.5;
  trap = vec4(1e9);
  for (int i = 0; i < 10; i++) {
    r = length(z);
    if (r > 2.0) break;
    float theta = acos(clamp(z.z / r, -1.0, 1.0));
    float phi = atan(z.y, z.x);
    dr = pow(r, power - 1.0) * power * dr + 1.0;
    float zr = pow(r, power);
    theta *= power; phi *= power;
    z = zr * vec3(sin(theta) * cos(phi), sin(phi) * sin(theta), cos(theta)) + p;
    trap = min(trap, vec4(abs(z), dot(z, z)));
  }
  return 0.5 * log(r) * r / dr;
}
void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 view = uProjInv * vec4(ndc, 1.0, 1.0);
  vec3 rd = normalize((uCamWorld * vec4(normalize(view.xyz / view.w), 0.0)).xyz);
  vec3 ro = uCamPos;
  float t = 0.0;
  float glow = 0.0;
  float minD = 1e9;
  bool hit = false;
  int steps = int(uSteps);
  int used = 0;
  float eps = 0.0008 * uDetail;
  // Bounding sphere.
  float b = dot(ro, rd), c = dot(ro, ro) - 1.44, disc = b * b - c;
  if (disc > 0.0) {
    t = max(0.0, -b - sqrt(disc));
    for (int i = 0; i < 400; i++) {
      if (i >= steps) break;
      vec3 p = ro + rd * t;
      float d = de(p);
      minD = min(minD, d);
      glow += 0.0016 / (0.01 + d * d * 900.0);
      used = i;
      if (d < eps * t) { hit = true; break; }
      t += d * 0.9;
      if (t > 6.0) break;
    }
  }
  vec3 col = uBg;
  if (hit) {
    vec3 p = ro + rd * t;
    vec2 e = vec2(eps * t, 0.0);
    vec3 n = normalize(vec3(de(p + e.xyy) - de(p - e.xyy), de(p + e.yxy) - de(p - e.yxy), de(p + e.yyx) - de(p - e.yyx)));
    float diff = clamp(dot(n, normalize(vec3(0.6, 0.8, 0.4))), 0.0, 1.0);
    float rim = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 3.0);
    float ao = clamp(1.0 - float(used) / float(steps) * 1.6, 0.08, 1.0);
    vec3 base = mix(uColA, uColB, clamp(trap.w * 0.6, 0.0, 1.0));
    float lines = smoothstep(0.92, 1.0, sin(trap.x * 60.0)) * 0.6;
    col = base * (0.04 + diff * 0.38 + rim * 0.45) * ao + lines * uColB * 0.25 * ao;
  }
  col += uColB * min(glow, 6.0) * 0.03;
  gl_FragColor = vec4(col * uBright * uOpacity, 1.0);
}`;

const TUNNEL = /* glsl */ `
${HASH}
uniform vec2 uRes;
uniform float uTime, uSpeed, uSegments, uBright, uOpacity, uTwist, uAudio;
uniform vec3 uColA, uColB, uBg;
varying vec2 vUv;
void main() {
  vec2 p = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0) * 2.0;
  p += vec2(sin(uTime * 0.3), cos(uTime * 0.23)) * 0.12;
  float r = length(p);
  float a = atan(p.y, p.x);
  float z = 1.0 / max(r, 1e-3);
  float travel = uTime * uSpeed * 1.5;
  float u = a / 6.2831853 * uSegments + z * uTwist * 0.2 + uTime * 0.05;
  float v = z + travel;
  // Polygonal cross-section rings and longitudinal ribs.
  float ring = smoothstep(0.035, 0.058, abs(fract(v * 0.5) - 0.5) - 0.44);
  float rib = smoothstep(0.022, 0.038, abs(fract(u) - 0.5) - 0.46);
  float cell = hash13(vec3(floor(u), floor(v * 0.5), 1.0));
  vec2 cuv = vec2(fract(u), fract(v * 0.5)) - 0.5;
  float dotMask = smoothstep(0.09, 0.05, max(abs(cuv.x), abs(cuv.y))) * step(0.72, cell);
  float frame = smoothstep(0.012, 0.0, abs(max(abs(cuv.x), abs(cuv.y)) - 0.3)) * step(0.9, cell);
  float panel = (dotMask + frame * 0.6) * (0.5 + 0.5 * sin(uTime * 3.0 + cell * 30.0));
  float fog = exp(-z * 0.12);
  float beat = uAudio * smoothstep(0.1, 0.0, abs(fract(v * 0.125 - uTime * 0.5) - 0.5));
  vec3 col = mix(uBg, uColA, clamp((ring + rib * 0.6) * fog, 0.0, 1.0)) + uColB * (panel * fog * 0.6 + beat * 0.5);
  col += uColB * smoothstep(0.25, 0.0, r) * 0.08;
  gl_FragColor = vec4(col * uBright * uOpacity, 1.0);
}`;

export const raymarch: EngineDef = {
  id: 'raymarch',
  name: 'Shader Scenes',
  description: 'Ray-marched Mandelbulb fractal and an infinite procedural tunnel.',
  artistic: true,
  science: 'Mandelbulb: standard triplex power-n iteration with the analytic distance estimator ½·log r·r/dr. The fractal itself is a mathematical object; shading is artistic.',
  cameraModes: ['orbital', 'interactive', 'macro', 'microscopic', 'cinematic'],
  defaultCamera: 'orbital',
  params: [
    { key: 'scene', label: 'Scene', type: 'select', default: 'mandelbulb', group: 'Scene', rebuild: true, options: [{ value: 'mandelbulb', label: 'Mandelbulb fractal' }, { value: 'tunnel', label: 'Infinite tunnel' }] },
    { key: 'power', label: 'Fractal power', type: 'number', default: 8, min: 2, max: 16, step: 0.01, group: 'Scene' },
    { key: 'animatePower', label: 'Animate power', type: 'bool', default: true, group: 'Scene' },
    { key: 'detail', label: 'Surface detail', type: 'number', default: 1, min: 0.2, max: 4, step: 0.05, group: 'Scene' },
    { key: 'tunnelSpeed', label: 'Tunnel speed', type: 'number', default: 1, min: 0, max: 5, step: 0.01, group: 'Scene' },
    { key: 'segments', label: 'Tunnel segments', type: 'int', default: 8, min: 3, max: 32, group: 'Scene' },
    { key: 'twist', label: 'Tunnel twist', type: 'number', default: 1, min: -5, max: 5, step: 0.01, group: 'Scene' },
    { key: 'brightness', label: 'Brightness', type: 'number', default: 1, min: 0, max: 3, step: 0.01, group: 'Look' },
    { key: 'audioReactive', label: 'Audio reactive', type: 'bool', default: false, group: 'Audio' },
    { key: 'bloom', label: 'Bloom', type: 'number', default: 0.6, min: 0, max: 3, step: 0.01, group: 'Rendering' },
  ],
  create(ctx) {
    return new ShaderScene(ctx.quality, ctx.params, ctx.colors);
  },
};

class ShaderScene implements EngineInstance {
  readonly scene = new THREE.Scene();
  readonly radius = 1;
  private u: Record<string, THREE.IUniform>;
  private mesh: THREE.Mesh;
  private kind: string;
  private steps: number;

  constructor(quality: number, params: Params, colors: VizColors) {
    this.kind = str(params, 'scene', 'mandelbulb');
    this.steps = [48, 80, 120, 180][quality] ?? 80;
    this.u = {
      uRes: { value: new THREE.Vector2(1, 1) }, uCamPos: { value: new THREE.Vector3() }, uCamWorld: { value: new THREE.Matrix4() }, uProjInv: { value: new THREE.Matrix4() },
      uTime: { value: 0 }, uPower: { value: 8 }, uSteps: { value: this.steps }, uBright: { value: 1 }, uOpacity: { value: 1 }, uDetail: { value: 1 }, uAudio: { value: 0 },
      uSpeed: { value: 1 }, uSegments: { value: 8 }, uTwist: { value: 1 },
      uColA: { value: new THREE.Color() }, uColB: { value: new THREE.Color() }, uBg: { value: new THREE.Color() },
    };
    const mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: this.kind === 'tunnel' ? TUNNEL : MANDELBULB, uniforms: this.u, depthTest: false, depthWrite: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    this.setColors(colors);
  }

  setParam(): boolean {
    return true;
  }

  setColors(c: VizColors): void {
    (this.u.uColA.value as THREE.Color).copy(c.neural).multiplyScalar(0.8);
    (this.u.uColB.value as THREE.Color).copy(c.pulse);
    (this.u.uBg.value as THREE.Color).copy(c.background);
  }

  update(_dt: number, t: number, p: Params, input: FrameInput, camera: THREE.Camera): void {
    const u = this.u;
    u.uTime.value = t;
    (u.uRes.value as THREE.Vector2).set(input.width, input.height);
    const cam = camera as THREE.PerspectiveCamera;
    cam.updateMatrixWorld();
    (u.uCamPos.value as THREE.Vector3).copy(cam.position);
    (u.uCamWorld.value as THREE.Matrix4).copy(cam.matrixWorld);
    (u.uProjInv.value as THREE.Matrix4).copy(cam.projectionMatrixInverse);
    u.uPower.value = num(p, 'power', 8) + (bool(p, 'animatePower', true) ? Math.sin(t * 0.08) * 1.5 : 0);
    u.uDetail.value = 1 / num(p, 'detail', 1);
    u.uBright.value = num(p, 'brightness', 1);
    u.uOpacity.value = num(p, 'layerOpacity', 1);
    u.uSpeed.value = num(p, 'tunnelSpeed', 1);
    u.uSegments.value = num(p, 'segments', 8);
    u.uTwist.value = num(p, 'twist', 1);
    u.uAudio.value = bool(p, 'audioReactive', false) && input.audio.active ? input.audio.bass : 0;
  }

  hud(g: CanvasRenderingContext2D, w: number, _h: number, info: HudInfo): void {
    if (this.kind === 'tunnel') titleBlock(g, info, 'INFINITE TUNNEL', [['SEGMENTS', String(this.u.uSegments.value)], ['MAPPING', 'POLAR 1/r']], [], w);
    else titleBlock(g, info, 'FRACTAL UNIVERSE · MANDELBULB', [['POWER', (this.u.uPower.value as number).toFixed(3)], ['STEPS', String(this.steps)], ['DE', '½·ln r·r/dr']], [], w);
  }

  stats() {
    return { scene: this.kind, steps: this.steps };
  }

  gpuBytes(): number {
    return 4096;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
