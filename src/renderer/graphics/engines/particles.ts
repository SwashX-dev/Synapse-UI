/**
 * GPU particle engine — positions are evaluated analytically in the vertex
 * shader from (seed, time), so hundreds of thousands of particles cost one
 * draw call and zero CPU work per frame.
 *   quantum      curl-noise advection (artistic "quantum field")
 *   singularity  decaying Keplerian orbits (ω ∝ r^-3/2) into a centre, with polar jets
 *   vortex       rising twisted columnar vortex
 *   ocean        superposed Gerstner waves
 *   reactor      counter-rotating rings, core and plasma emission
 */
import * as THREE from 'three';
import type { EngineDef, EngineInstance, FrameInput, HudInfo, Params, VizColors } from '../types';
import { bool, num, str } from '../types';
import { HASH, POINT_FRAG, SIMPLEX } from '../glsl';
import { Rng } from '../../../shared/random';
import { titleBlock } from './hud';

const COUNTS = [40000, 120000, 260000, 480000];
const MODES = { quantum: 0, singularity: 1, vortex: 2, ocean: 3, reactor: 4 } as const;
type Mode = keyof typeof MODES;

const VERT = /* glsl */ `
${HASH}
${SIMPLEX}
uniform float uTime, uSpeed, uSize, uScale, uFreq, uTurb, uBright, uOpacity, uAudio, uBass;
uniform int uMode;
attribute vec4 aSeed;
varying float vAlpha;
varying float vMix;
const float TAU = 6.2831853;

vec3 quantum(vec4 s, float t) {
  vec3 p = (s.xyz - 0.5) * 2.0;
  p *= pow(length(p) + 0.001, 0.3);
  float life = fract(t * 0.05 * uSpeed + s.w);
  vec3 q = p;
  for (int i = 0; i < 3; i++) q += curlNoise(q * uFreq + vec3(0.0, t * 0.04 * uSpeed, float(i) * 3.1)) * uTurb * 0.08 * (1.0 + uAudio);
  vMix = clamp(length(q - p) * 2.0, 0.0, 1.0);
  vAlpha = smoothstep(0.0, 0.1, life) * smoothstep(1.0, 0.8, life);
  return q;
}
vec3 singularity(vec4 s, float t) {
  float jet = step(0.92, s.w);
  float life = fract(t * (0.03 + s.y * 0.05) * uSpeed + s.z);
  if (jet > 0.5) {
    float side = s.x > 0.5 ? 1.0 : -1.0;
    float r = 0.02 + life * 0.08 * (1.0 + s.y);
    float a = s.z * TAU + t * 3.0;
    vMix = 1.0;
    vAlpha = (1.0 - life) * 0.8;
    return vec3(cos(a) * r, side * life * 2.2, sin(a) * r);
  }
  float r0 = 0.25 + pow(s.x, 0.7) * 1.2;
  float r = r0 * pow(1.0 - life, 0.8) + 0.03;
  float ang = s.y * TAU + (t * uSpeed * 0.6) / pow(r, 1.5) * 0.25;
  float tilt = (s.w - 0.46) * 0.35 * r;
  vMix = clamp(0.06 / r, 0.0, 1.0);
  vAlpha = smoothstep(0.0, 0.05, life) * (0.35 + vMix);
  return vec3(cos(ang) * r, tilt + snoise(vec3(ang, r * 4.0, t * 0.1)) * 0.02 * uTurb, sin(ang) * r);
}
vec3 vortex(vec4 s, float t) {
  float y = fract(s.z + t * 0.06 * uSpeed) * 2.0 - 1.0;
  float r = (0.08 + s.x * 0.9) * (0.25 + 0.75 * (1.0 - abs(y) * 0.8)) * (1.0 + 0.3 * sin(y * 4.0 + t));
  float ang = s.y * TAU + t * uSpeed * (0.4 + 0.8 / (r + 0.15)) + y * 3.0 * uFreq;
  vec3 p = vec3(cos(ang) * r, y * 1.2, sin(ang) * r);
  p += curlNoise(p * 2.0 + t * 0.05) * 0.02 * uTurb;
  vMix = 1.0 - clamp(r, 0.0, 1.0);
  vAlpha = smoothstep(1.0, 0.85, abs(y)) * (0.4 + vMix);
  return p;
}
vec3 gerstner(vec2 xz, vec2 dir, float steep, float wl, float t, inout vec3 sum) {
  float k = TAU / wl;
  float c = sqrt(9.8 / k) * 0.12;
  vec2 d = normalize(dir);
  float f = k * (dot(d, xz) - c * t);
  float a = steep / k;
  sum += vec3(d.x * a * cos(f), a * sin(f), d.y * a * cos(f));
  return sum;
}
vec3 ocean(vec4 s, float t) {
  vec2 xz = (s.xy - 0.5) * 4.0;
  vec3 sum = vec3(0.0);
  float tt = t * uSpeed;
  gerstner(xz, vec2(1.0, 0.3), 0.25, 1.6 / uFreq, tt, sum);
  gerstner(xz, vec2(-0.4, 1.0), 0.2, 0.9 / uFreq, tt, sum);
  gerstner(xz, vec2(0.7, -0.8), 0.15, 0.55 / uFreq, tt, sum);
  gerstner(xz, vec2(-0.9, -0.2), 0.12, 0.33 / uFreq, tt, sum);
  sum.y += snoise(vec3(xz * 1.5, tt * 0.2)) * 0.04 * uTurb + uBass * 0.15 * sin(length(xz) * 3.0 - tt * 4.0);
  vMix = clamp(sum.y * 3.0 + 0.5, 0.0, 1.0);
  vAlpha = (0.25 + vMix * 0.9) * smoothstep(2.0, 1.4, length(xz));
  return vec3(xz.x + sum.x, sum.y, xz.y + sum.z);
}
vec3 reactor(vec4 s, float t) {
  float sel = s.w;
  float tt = t * uSpeed;
  if (sel < 0.55) {
    float ring = floor(s.x * 5.0);
    float r = 0.35 + ring * 0.16;
    float ang = s.y * TAU + tt * (ring + 1.0) * 0.25 * (mod(ring, 2.0) > 0.5 ? -1.0 : 1.0);
    vec3 p = vec3(cos(ang) * r, (s.z - 0.5) * 0.015, sin(ang) * r);
    float tilt = ring * 0.45 + tt * 0.05;
    p.yz = mat2(cos(tilt), -sin(tilt), sin(tilt), cos(tilt)) * p.yz;
    vMix = 0.3;
    vAlpha = 0.5 + 0.5 * sin(ang * 6.0 + tt * 2.0);
    return p;
  }
  if (sel < 0.7) {
    vec3 d = normalize(s.xyz - 0.5);
    float pulse = 0.18 + 0.03 * sin(tt * 3.0) + uBass * 0.08;
    vMix = 1.0;
    vAlpha = 0.9;
    return d * pulse * pow(s.w, 0.3);
  }
  float life = fract(s.z + tt * 0.12);
  vec3 d = normalize(s.xyz - 0.5 + vec3(0.0, 0.0001, 0.0));
  vec3 p = d * (0.2 + life * 1.3);
  p += curlNoise(p * 1.5 + tt * 0.1) * 0.12 * life * uTurb;
  vMix = 1.0 - life;
  vAlpha = (1.0 - life) * 0.6;
  return p;
}

void main() {
  vec3 p;
  if (uMode == 0) p = quantum(aSeed, uTime);
  else if (uMode == 1) p = singularity(aSeed, uTime);
  else if (uMode == 2) p = vortex(aSeed, uTime);
  else if (uMode == 3) p = ocean(aSeed, uTime);
  else p = reactor(aSeed, uTime);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = clamp(uSize * (0.5 + aSeed.w) * uScale / max(-mv.z, 1e-3), 0.0, 8.0);
  vAlpha *= uBright * uOpacity * (1.0 + uAudio * 0.8);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
${POINT_FRAG}
uniform vec3 uColA, uColB;
varying float vAlpha;
varying float vMix;
void main() {
  float a = softPoint(gl_PointCoord) * vAlpha;
  if (a < 0.002) discard;
  gl_FragColor = vec4(mix(uColA, uColB, vMix), a);
}`;

export const particles: EngineDef = {
  id: 'particles',
  name: 'Particle Engine',
  description: 'Hundreds of thousands of GPU-evaluated particles: fields, orbits, vortices, waves and reactors.',
  artistic: true,
  science: 'Singularity uses Keplerian angular velocity (ω ∝ r^-3/2) with artistic orbital decay; Ocean uses Gerstner (trochoidal) waves with the deep-water dispersion relation c = √(g/k). Quantum Field is an artistic curl-noise flow, not a quantum simulation.',
  cameraModes: ['orbital', 'interactive', 'macro', 'microscopic', 'cinematic'],
  defaultCamera: 'orbital',
  params: [
    { key: 'mode', label: 'Mode', type: 'select', default: 'quantum', group: 'System', rebuild: true, options: [{ value: 'quantum', label: 'Quantum field' }, { value: 'singularity', label: 'Particle singularity' }, { value: 'vortex', label: 'Information vortex' }, { value: 'ocean', label: 'Particle ocean' }, { value: 'reactor', label: 'Energy reactor' }] },
    { key: 'count', label: 'Particles (0 = by quality)', type: 'int', default: 0, min: 0, max: 1000000, step: 10000, group: 'System', rebuild: true },
    { key: 'speed', label: 'Speed', type: 'number', default: 1, min: 0, max: 5, step: 0.01, group: 'System' },
    { key: 'frequency', label: 'Frequency', type: 'number', default: 1, min: 0.1, max: 4, step: 0.01, group: 'System' },
    { key: 'turbulence', label: 'Turbulence', type: 'number', default: 1, min: 0, max: 4, step: 0.01, group: 'System' },
    { key: 'size', label: 'Particle size', type: 'number', default: 1, min: 0.1, max: 5, step: 0.05, group: 'Look' },
    { key: 'brightness', label: 'Brightness', type: 'number', default: 1, min: 0, max: 4, step: 0.01, group: 'Look' },
    { key: 'colorA', label: 'Color A (empty = theme)', type: 'color', default: '', group: 'Look' },
    { key: 'colorB', label: 'Color B (empty = theme)', type: 'color', default: '', group: 'Look' },
    { key: 'rotation', label: 'Rotation', type: 'number', default: 0.3, min: 0, max: 3, step: 0.01, group: 'Look' },
    { key: 'audioReactive', label: 'Audio reactive', type: 'bool', default: false, group: 'Audio' },
    { key: 'bloom', label: 'Bloom', type: 'number', default: 0.9, min: 0, max: 3, step: 0.01, group: 'Rendering' },
    { key: 'motionBlur', label: 'Motion blur', type: 'bool', default: false, group: 'Rendering' },
  ],
  create(ctx) {
    return new ParticleEngine(ctx.quality, ctx.seed, ctx.params, ctx.colors);
  },
};

class ParticleEngine implements EngineInstance {
  readonly scene = new THREE.Scene();
  readonly radius = 1.1;
  private u: Record<string, THREE.IUniform>;
  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private points: THREE.Points;
  private count: number;
  private mode: Mode;
  private colors: VizColors;
  private params: Params;

  constructor(quality: number, seed: number, params: Params, colors: VizColors) {
    this.mode = (str(params, 'mode', 'quantum') as Mode) in MODES ? (str(params, 'mode', 'quantum') as Mode) : 'quantum';
    this.colors = colors;
    this.params = params;
    this.count = num(params, 'count', 0) || COUNTS[quality] || COUNTS[1];
    const rng = new Rng(seed);
    const s = new Float32Array(this.count * 4);
    for (let i = 0; i < s.length; i++) s[i] = rng.next();
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.count * 3), 3));
    this.geo.setAttribute('aSeed', new THREE.BufferAttribute(s, 4));
    this.u = {
      uTime: { value: 0 }, uSpeed: { value: 1 }, uSize: { value: 0.006 }, uScale: { value: 400 }, uFreq: { value: 1 }, uTurb: { value: 1 }, uBright: { value: 1 }, uOpacity: { value: 1 }, uAudio: { value: 0 }, uBass: { value: 0 },
      uMode: { value: MODES[this.mode] }, uColA: { value: new THREE.Color() }, uColB: { value: new THREE.Color() },
    };
    this.mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: this.u, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.scene.add(this.points);
    this.setColors(colors);
    this.apply(params);
  }

  private apply(p: Params): void {
    this.u.uSpeed.value = num(p, 'speed', 1);
    this.u.uFreq.value = num(p, 'frequency', 1);
    this.u.uTurb.value = num(p, 'turbulence', 1);
    const density = Math.sqrt(120000 / this.count);
    this.u.uSize.value = 0.006 * num(p, 'size', 1) * Math.max(0.6, density);
    this.u.uBright.value = num(p, 'brightness', 1) * density * 0.16 * ({ quantum: 2.4, singularity: 1.5, vortex: 1.8, ocean: 1.6, reactor: 1.3 } as Record<Mode, number>)[this.mode];
  }

  setParam(key: string, _v: unknown, p: Params): boolean {
    this.params = p;
    this.apply(p);
    if (key === 'colorA' || key === 'colorB') this.setColors(this.colors);
    return true;
  }

  setColors(c: VizColors): void {
    this.colors = c;
    const a = str(this.params, 'colorA', ''), b2 = str(this.params, 'colorB', '');
    (this.u.uColA.value as THREE.Color).copy(a ? new THREE.Color().setStyle(a) : c.particle.clone().multiplyScalar(0.8));
    (this.u.uColB.value as THREE.Color).copy(b2 ? new THREE.Color().setStyle(b2) : c.pulse);
  }

  update(dt: number, t: number, p: Params, input: FrameInput, camera: THREE.Camera): void {
    this.u.uTime.value = t;
    const audio = bool(p, 'audioReactive', false) && input.audio.active;
    this.u.uAudio.value = audio ? input.audio.level : 0;
    this.u.uBass.value = audio ? input.audio.bass : 0;
    this.u.uOpacity.value = num(p, 'layerOpacity', 1);
    this.u.uScale.value = input.height / (2 * Math.tan((((camera as THREE.PerspectiveCamera).fov ?? 50) * Math.PI) / 360));
    if (this.mode !== 'ocean') this.points.rotation.y += dt * 0.05 * num(p, 'rotation', 0.3);
  }

  hud(g: CanvasRenderingContext2D, w: number, _h: number, info: HudInfo): void {
    const names: Record<Mode, string> = { quantum: 'QUANTUM FIELD', singularity: 'PARTICLE SINGULARITY', vortex: 'INFORMATION VORTEX', ocean: 'PARTICLE OCEAN', reactor: 'ENERGY REACTOR' };
    const rows: [string, string][] = [['PARTICLES', this.count.toLocaleString('en-US')], ['FREQ', num(this.params, 'frequency', 1).toFixed(2)], ['TURB', num(this.params, 'turbulence', 1).toFixed(2)]];
    if (this.mode === 'quantum') rows.push(['NOTE', 'ARTISTIC']);
    if (this.mode === 'singularity') rows.push(['ω(r)', '∝ r^-3/2']);
    if (this.mode === 'ocean') rows.push(['WAVES', '4 × GERSTNER']);
    titleBlock(g, info, names[this.mode], rows, [], w);
  }

  stats() {
    return { mode: this.mode, particles: this.count };
  }

  gpuBytes(): number {
    return this.count * 28;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
