/**
 * NEURAL SPHERE — flagship visualization.
 *
 * Tens of thousands of fine curved strands over a spherical shell, impulses
 * propagating through an event-driven cascade, bright outward streaks from
 * firing surface nodes, particle emission, depth-cued linework and a dense
 * scientific HUD. Artistic: inspired by spiking neural networks and
 * connectome imagery; not a biophysical model.
 */
import * as THREE from 'three';
import type { EngineDef, EngineInstance, FrameInput, HudInfo, Params, VizColors } from '../types';
import { bool, num, str } from '../types';
import { generateAsync, type Algorithm, type Layout, type Network } from '../netgen';
import { NetworkMesh, NetworkSim, type SimParams } from '../network';
import { HASH, POINT_FRAG } from '../glsl';
import { Rng } from '../../../shared/random';
import { Ring } from '../../core/util';
import { drawHudBlock, drawSparkline, hudFont } from './hud';

const AUTO_NODES = [3500, 9000, 18000, 32000];
const AUTO_SEGMENTS = [4, 6, 8, 12];

const STREAK_VERT = /* glsl */ `
uniform sampler2D uFire;
uniform float uTime, uStreaks, uStreakLen, uOpacity, uAudio, uFogNear, uFogFar;
uniform vec3 uCol;
attribute float t;
attribute vec3 aOrigin;
attribute vec2 aData;
varying float vAlpha;
float fireAt(float idx) { int i = int(idx + 0.5); return texelFetch(uFire, ivec2(i % 512, i / 512), 0).r; }
void main() {
  float since = uTime - fireAt(aData.x);
  float burst = since >= 0.0 ? exp(-since * 1.1) : 0.0;
  float longStreak = step(0.95, aData.y);
  float len = uStreakLen * mix((0.05 + 0.22 * aData.y) * (0.25 + burst * 2.4 + uAudio * 1.5), 0.7 + aData.y * 1.2, longStreak);
  vec3 dir = normalize(aOrigin);
  vec3 p = aOrigin + dir * len * t;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float fog = clamp(1.0 - (-mv.z - uFogNear) / max(uFogFar - uFogNear, 1e-3), 0.2, 1.0);
  vAlpha = pow(1.0 - t, 1.6) * mix(0.05 + burst * 1.1 + uAudio * 0.3, 0.05, longStreak) * uStreaks * uOpacity * fog;
  gl_Position = projectionMatrix * mv;
}`;
const STREAK_FRAG = /* glsl */ `
uniform vec3 uCol;
varying float vAlpha;
void main() { if (vAlpha < 0.002) discard; gl_FragColor = vec4(uCol, vAlpha); }`;

const PARTICLE_VERT = /* glsl */ `
${HASH}
uniform sampler2D uFire;
uniform float uTime, uParticles, uOpacity, uScale, uSize;
attribute vec3 aOrigin;
attribute vec4 aSeed;
varying float vAlpha;
float fireAt(float idx) { int i = int(idx + 0.5); return texelFetch(uFire, ivec2(i % 512, i / 512), 0).r; }
void main() {
  float speed = 0.05 + aSeed.y * 0.18;
  float life = fract(uTime * speed + aSeed.z);
  float since = uTime - fireAt(aSeed.x);
  float glow = since >= 0.0 ? exp(-since * 1.4) : 0.0;
  vec3 dir = normalize(aOrigin);
  vec3 jitter = (hash33(aOrigin * 91.7 + aSeed.w) - 0.5) * 0.35;
  vec3 p = aOrigin + (dir * (0.08 + aSeed.w * 0.55) + jitter * 0.6) * life;
  p += vec3(sin(uTime * 0.7 + aSeed.w * 30.0), cos(uTime * 0.5 + aSeed.z * 20.0), sin(uTime * 0.9 + aSeed.y * 10.0)) * 0.006;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = clamp(uSize * (0.6 + aSeed.y) * uScale / max(-mv.z, 1e-3), 0.0, 6.0);
  vAlpha = pow(1.0 - life, 2.0) * smoothstep(0.0, 0.06, life) * uParticles * (0.08 + glow * 1.3) * uOpacity;
  gl_Position = projectionMatrix * mv;
}`;
const PARTICLE_FRAG = /* glsl */ `
${POINT_FRAG}
uniform vec3 uCol;
varying float vAlpha;
void main() { float a = softPoint(gl_PointCoord) * vAlpha; if (a < 0.003) discard; gl_FragColor = vec4(uCol, a); }`;

const DUST_VERT = /* glsl */ `
uniform float uScale, uTime, uOpacity;
attribute float aB;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(1.4 * uScale / max(-mv.z, 1e-3), 0.6, 2.5);
  vAlpha = (0.05 + 0.22 * aB) * (0.75 + 0.25 * sin(uTime * (0.3 + aB) + aB * 40.0)) * uOpacity;
  gl_Position = projectionMatrix * mv;
}`;
const DUST_FRAG = /* glsl */ `
${POINT_FRAG}
uniform vec3 uCol;
varying float vAlpha;
void main() { float a = softPoint(gl_PointCoord) * vAlpha; if (a < 0.003) discard; gl_FragColor = vec4(uCol, a); }`;

export const neuralSphere: EngineDef = {
  id: 'neural-sphere',
  name: 'Neural Sphere',
  description: 'An enormous spherical network of fine interconnected strands with propagating impulses, outward streaks and particle emission.',
  artistic: true,
  science: 'Artistic. Graph topologies (k-nearest-neighbour, Watts–Strogatz small-world, Barabási–Albert scale-free, modular, random geometric) are generated faithfully; the impulse cascade is an event-driven integrate-and-fire style model with conduction delay and refractoriness, not a biophysical neuron simulation.',
  cameraModes: ['orbital', 'interactive', 'macro', 'microscopic', 'cinematic', 'tracking'],
  defaultCamera: 'orbital',
  params: [
    { key: 'nodes', label: 'Nodes (0 = by quality)', type: 'int', default: 0, min: 0, max: 80000, step: 500, group: 'Structure', rebuild: true },
    { key: 'degree', label: 'Connection density (k)', type: 'int', default: 6, min: 2, max: 16, group: 'Structure', rebuild: true },
    { key: 'algorithm', label: 'Generation algorithm', type: 'select', default: 'small-world', group: 'Structure', rebuild: true, options: [
      { value: 'small-world', label: 'Small-world (Watts–Strogatz)' }, { value: 'knn', label: 'k-nearest neighbours' }, { value: 'scale-free', label: 'Scale-free (Barabási–Albert)' },
      { value: 'modular', label: 'Modular communities' }, { value: 'geometric', label: 'Random geometric' }, { value: 'great-circle', label: 'Great-circle arcs' }] },
    { key: 'shell', label: 'Shell depth', type: 'number', default: 0.18, min: 0, max: 1, step: 0.01, group: 'Structure', rebuild: true },
    { key: 'clustering', label: 'Clustering', type: 'number', default: 0.55, min: 0, max: 1, step: 0.01, group: 'Structure', rebuild: true },
    { key: 'segments', label: 'Curve segments (0 = auto)', type: 'int', default: 0, min: 0, max: 16, group: 'Structure', rebuild: true },
    { key: 'curvature', label: 'Strand curvature', type: 'number', default: 0.55, min: 0, max: 1.5, step: 0.01, group: 'Structure' },
    { key: 'activity', label: 'Activity', type: 'number', default: 1, min: 0, max: 4, step: 0.01, group: 'Signals', description: 'Multiplier on spontaneous firing (a good target for data bindings).' },
    { key: 'rate', label: 'Spontaneous rate', type: 'number', default: 0.01, min: 0, max: 0.2, step: 0.001, group: 'Signals' },
    { key: 'propagation', label: 'Propagation', type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Signals' },
    { key: 'pulseSpeed', label: 'Impulse speed', type: 'number', default: 0.55, min: 0.05, max: 3, step: 0.01, group: 'Signals' },
    { key: 'pulseWidth', label: 'Impulse width', type: 'number', default: 0.028, min: 0.005, max: 0.2, step: 0.001, group: 'Signals' },
    { key: 'trails', label: 'Impulse trails', type: 'number', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Signals' },
    { key: 'refractory', label: 'Refractory period (s)', type: 'number', default: 1.6, min: 0.1, max: 6, step: 0.05, group: 'Signals' },
    { key: 'bursts', label: 'Cluster bursts / s', type: 'number', default: 0.6, min: 0, max: 4, step: 0.05, group: 'Signals' },
    { key: 'wave', label: 'Synchronised waves', type: 'number', default: 0, min: 0, max: 1, step: 0.01, group: 'Signals' },
    { key: 'lineAlpha', label: 'Strand brightness', type: 'number', default: 0.055, min: 0, max: 0.4, step: 0.001, group: 'Look' },
    { key: 'brightness', label: 'Overall brightness', type: 'number', default: 1, min: 0, max: 3, step: 0.01, group: 'Look' },
    { key: 'nodeSize', label: 'Node size', type: 'number', default: 1, min: 0, max: 4, step: 0.05, group: 'Look' },
    { key: 'nodeAlpha', label: 'Node brightness', type: 'number', default: 0.3, min: 0, max: 1.5, step: 0.01, group: 'Look' },
    { key: 'streaks', label: 'Outward streaks', type: 'number', default: 0.65, min: 0, max: 1.5, step: 0.01, group: 'Look' },
    { key: 'streakLength', label: 'Streak length', type: 'number', default: 0.6, min: 0, max: 2, step: 0.01, group: 'Look' },
    { key: 'particles', label: 'Particle emission', type: 'number', default: 0.55, min: 0, max: 1.5, step: 0.01, group: 'Look' },
    { key: 'dust', label: 'Background dust', type: 'number', default: 0.6, min: 0, max: 1.5, step: 0.01, group: 'Look' },
    { key: 'graticule', label: 'Graticule', type: 'number', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Look' },
    { key: 'breathing', label: 'Connection turnover', type: 'number', default: 0.35, min: 0, max: 1, step: 0.01, group: 'Look', description: 'Fraction of strands that slowly form and dissolve.' },
    { key: 'growth', label: 'Network growth', type: 'number', default: 1, min: 0, max: 1, step: 0.001, group: 'Look' },
    { key: 'growthAnim', label: 'Animate growth on build', type: 'bool', default: true, group: 'Look' },
    { key: 'rotation', label: 'Self-rotation', type: 'number', default: 0.35, min: 0, max: 3, step: 0.01, group: 'Look' },
    { key: 'colorLine', label: 'Strand color (empty = theme)', type: 'color', default: '', group: 'Look' },
    { key: 'colorPulse', label: 'Impulse color (empty = theme)', type: 'color', default: '', group: 'Look' },
    { key: 'audioReactive', label: 'Audio reactive', type: 'bool', default: false, group: 'Audio' },
    { key: 'audioGain', label: 'Audio gain', type: 'number', default: 1.5, min: 0, max: 5, step: 0.05, group: 'Audio' },
    { key: 'bloom', label: 'Bloom', type: 'number', default: 0.9, min: 0, max: 3, step: 0.01, group: 'Rendering' },
    { key: 'bloomRadius', label: 'Bloom radius', type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Rendering' },
    { key: 'bloomThreshold', label: 'Bloom threshold', type: 'number', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Rendering' },
    { key: 'motionBlur', label: 'Motion blur', type: 'bool', default: false, group: 'Rendering' },
    { key: 'motionBlurAmount', label: 'Motion blur amount', type: 'number', default: 0.7, min: 0, max: 0.97, step: 0.01, group: 'Rendering' },
    { key: 'speed', label: 'Animation speed', type: 'number', default: 1, min: 0, max: 4, step: 0.01, group: 'Rendering' },
    { key: 'cameraSpeed', label: 'Camera speed', type: 'number', default: 1, min: 0, max: 4, step: 0.01, group: 'Rendering' },
  ],
  async create(ctx) {
    return NeuralSphere.create(ctx.quality, ctx.seed, ctx.params, ctx.colors, 'sphere');
  },
};

export class NeuralSphere implements EngineInstance {
  readonly scene = new THREE.Scene();
  readonly radius = 1;
  private root = new THREE.Group();
  private mesh: NetworkMesh;
  private sim: NetworkSim;
  private streakU: Record<string, THREE.IUniform>;
  private partU: Record<string, THREE.IUniform>;
  private dustU: Record<string, THREE.IUniform>;
  private gratMat: THREE.LineBasicMaterial;
  private disposables: { dispose(): void }[] = [];
  private growth = 1;
  private growthTarget = 1;
  private rateHistory = new Ring(120);
  private rateAcc = 0;
  private hovered = -1;
  private track$: { from: number; to: number; start: number; len: number } | null = null;
  private colors: VizColors;
  private params: Params;
  private bytes = 0;
  private trackPos = new THREE.Vector3();
  private trackAhead = new THREE.Vector3();

  static async create(quality: number, seed: number, params: Params, colors: VizColors, layout: Layout): Promise<NeuralSphere> {
    const nodes = num(params, 'nodes', 0) || AUTO_NODES[quality] || AUTO_NODES[1];
    const net = await generateAsync({ nodes, degree: num(params, 'degree', 6), algorithm: str(params, 'algorithm', 'small-world') as Algorithm, layout, shell: num(params, 'shell', 0.18), clustering: num(params, 'clustering', 0.55), seed });
    return new NeuralSphere(net, quality, seed, params, colors);
  }

  constructor(readonly net: Network, quality: number, seed: number, params: Params, colors: VizColors) {
    this.params = params;
    this.colors = colors;
    this.scene.add(this.root);
    const segs = num(params, 'segments', 0) || AUTO_SEGMENTS[quality] || 6;
    this.mesh = new NetworkMesh(net, { segments: segs, colors: this.meshColors() });
    this.root.add(this.mesh.group);
    this.sim = new NetworkSim(net, this.mesh, seed);
    this.bytes += this.mesh.bytes;
    const rng = new Rng(seed + 99);

    // Outward streaks from outer-shell nodes.
    const outer: number[] = [];
    for (let i = 0; i < net.n; i++) {
      const p = net.positions;
      if (Math.hypot(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]) > 0.9) outer.push(i);
    }
    const nStreak = Math.min(outer.length, [900, 2200, 4500, 8000][quality] ?? 2200);
    const sg = new THREE.InstancedBufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    sg.setAttribute('t', new THREE.BufferAttribute(new Float32Array([0, 1]), 1));
    const sOrigin = new Float32Array(nStreak * 3), sData = new Float32Array(nStreak * 2);
    for (let i = 0; i < nStreak; i++) {
      const node = outer[rng.int(0, outer.length)];
      sOrigin.set(net.positions.subarray(node * 3, node * 3 + 3), i * 3);
      sData[i * 2] = node;
      sData[i * 2 + 1] = rng.next();
    }
    sg.setAttribute('aOrigin', new THREE.InstancedBufferAttribute(sOrigin, 3));
    sg.setAttribute('aData', new THREE.InstancedBufferAttribute(sData, 2));
    sg.instanceCount = nStreak;
    this.streakU = { uFire: { value: this.mesh.fireTex }, uTime: this.mesh.edgeUniforms.uTime, uStreaks: { value: 0.6 }, uStreakLen: { value: 0.6 }, uOpacity: this.mesh.edgeUniforms.uOpacity, uAudio: { value: 0 }, uFogNear: this.mesh.edgeUniforms.uFogNear, uFogFar: this.mesh.edgeUniforms.uFogFar, uCol: { value: colors.pulse.clone() } };
    const streaks = new THREE.LineSegments(sg, new THREE.ShaderMaterial({ vertexShader: STREAK_VERT, fragmentShader: STREAK_FRAG, uniforms: this.streakU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    streaks.frustumCulled = false;
    this.root.add(streaks);
    this.disposables.push(sg, streaks.material as THREE.Material);
    this.bytes += sOrigin.byteLength + sData.byteLength;

    // Emitted particles.
    const nPart = [2500, 7000, 15000, 30000][quality] ?? 7000;
    const pg = new THREE.BufferGeometry();
    const pOrigin = new Float32Array(nPart * 3), pSeed = new Float32Array(nPart * 4);
    for (let i = 0; i < nPart; i++) {
      const node = rng.int(0, net.n);
      pOrigin.set(net.positions.subarray(node * 3, node * 3 + 3), i * 3);
      pSeed[i * 4] = node; pSeed[i * 4 + 1] = rng.next(); pSeed[i * 4 + 2] = rng.next(); pSeed[i * 4 + 3] = rng.next();
    }
    pg.setAttribute('position', new THREE.BufferAttribute(pOrigin, 3));
    pg.setAttribute('aOrigin', new THREE.BufferAttribute(pOrigin, 3));
    pg.setAttribute('aSeed', new THREE.BufferAttribute(pSeed, 4));
    this.partU = { uFire: { value: this.mesh.fireTex }, uTime: this.mesh.edgeUniforms.uTime, uParticles: { value: 0.5 }, uOpacity: this.mesh.edgeUniforms.uOpacity, uScale: this.mesh.nodeUniforms.uScale, uSize: { value: 0.004 }, uCol: { value: colors.particle.clone() } };
    const parts = new THREE.Points(pg, new THREE.ShaderMaterial({ vertexShader: PARTICLE_VERT, fragmentShader: PARTICLE_FRAG, uniforms: this.partU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    parts.frustumCulled = false;
    this.root.add(parts);
    this.disposables.push(pg, parts.material as THREE.Material);
    this.bytes += pOrigin.byteLength + pSeed.byteLength;

    // Background dust (not rotating with the sphere).
    const nDust = [1500, 3000, 5000, 8000][quality] ?? 3000;
    const dg = new THREE.BufferGeometry();
    const dPos = new Float32Array(nDust * 3), dB = new Float32Array(nDust);
    const v: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < nDust; i++) {
      rng.onSphere(v);
      const r = 2.2 + Math.pow(rng.next(), 0.6) * 14;
      dPos[i * 3] = v[0] * r; dPos[i * 3 + 1] = v[1] * r; dPos[i * 3 + 2] = v[2] * r;
      dB[i] = Math.pow(rng.next(), 3);
    }
    dg.setAttribute('position', new THREE.BufferAttribute(dPos, 3));
    dg.setAttribute('aB', new THREE.BufferAttribute(dB, 1));
    this.dustU = { uScale: this.mesh.nodeUniforms.uScale, uTime: this.mesh.edgeUniforms.uTime, uOpacity: { value: 0.6 }, uCol: { value: colors.particle.clone() } };
    const dust = new THREE.Points(dg, new THREE.ShaderMaterial({ vertexShader: DUST_VERT, fragmentShader: DUST_FRAG, uniforms: this.dustU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    dust.frustumCulled = false;
    this.scene.add(dust);
    this.disposables.push(dg, dust.material as THREE.Material);

    // Graticule: faint latitude/longitude rings framing the sphere.
    const gPts: number[] = [];
    const R = 1.12;
    for (let lat = -60; lat <= 60; lat += 30) {
      const y = Math.sin((lat * Math.PI) / 180) * R, rr = Math.cos((lat * Math.PI) / 180) * R;
      for (let a = 0; a < 128; a++) {
        const a0 = (a / 128) * Math.PI * 2, a1 = ((a + 1) / 128) * Math.PI * 2;
        gPts.push(Math.cos(a0) * rr, y, Math.sin(a0) * rr, Math.cos(a1) * rr, y, Math.sin(a1) * rr);
      }
    }
    for (let lon = 0; lon < 180; lon += 30) {
      const c = Math.cos((lon * Math.PI) / 180), s = Math.sin((lon * Math.PI) / 180);
      for (let a = 0; a < 128; a++) {
        const a0 = (a / 128) * Math.PI * 2, a1 = ((a + 1) / 128) * Math.PI * 2;
        gPts.push(Math.cos(a0) * R * c, Math.sin(a0) * R, Math.cos(a0) * R * s, Math.cos(a1) * R * c, Math.sin(a1) * R, Math.cos(a1) * R * s);
      }
    }
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.Float32BufferAttribute(gPts, 3));
    this.gratMat = new THREE.LineBasicMaterial({ color: colors.foreground.clone(), transparent: true, opacity: 0.03, depthWrite: false, blending: THREE.AdditiveBlending });
    const grat = new THREE.LineSegments(gg, this.gratMat);
    this.root.add(grat);
    this.disposables.push(gg, this.gratMat);

    if (bool(params, 'growthAnim', true)) this.growth = 0;
    this.applyParams(params);
  }

  private meshColors() {
    const lineCss = str(this.params, 'colorLine', '');
    const pulseCss = str(this.params, 'colorPulse', '');
    const line = lineCss ? new THREE.Color().setStyle(lineCss) : this.colors.neural.clone();
    const pulse = pulseCss ? new THREE.Color().setStyle(pulseCss) : this.colors.pulse.clone();
    return { line, pulse, node: line.clone().lerp(new THREE.Color(1, 1, 1), 0.3), highlight: this.colors.accent.clone().lerp(new THREE.Color(1, 1, 1), 0.5) };
  }

  private applyParams(p: Params): void {
    const eu = this.mesh.edgeUniforms;
    eu.uPulseSpeed.value = num(p, 'pulseSpeed', 0.55);
    eu.uPulseWidth.value = num(p, 'pulseWidth', 0.028);
    eu.uTrail.value = num(p, 'trails', 0.45);
    eu.uLineAlpha.value = num(p, 'lineAlpha', 0.055);
    eu.uCurv.value = num(p, 'curvature', 0.55);
    eu.uBreath.value = num(p, 'breathing', 0.35);
    eu.uPulseGain.value = 1.1 * num(p, 'brightness', 1);
    this.mesh.nodeUniforms.uNodeSize.value = num(p, 'nodeSize', 1) * 0.012;
    this.mesh.nodeUniforms.uNodeAlpha.value = num(p, 'nodeAlpha', 0.3);
    this.streakU.uStreaks.value = num(p, 'streaks', 0.65);
    this.streakU.uStreakLen.value = num(p, 'streakLength', 0.6);
    this.partU.uParticles.value = num(p, 'particles', 0.55);
    this.dustU.uOpacity.value = num(p, 'dust', 0.6);
    this.gratMat.opacity = 0.05 * num(p, 'graticule', 0.35);
    this.growthTarget = num(p, 'growth', 1);
  }

  setParam(key: string, _value: unknown, params: Params): boolean {
    this.params = params;
    if (key === 'colorLine' || key === 'colorPulse') this.mesh.setColors(this.meshColors());
    this.applyParams(params);
    return true;
  }

  setColors(c: VizColors): void {
    this.colors = c;
    this.mesh.setColors(this.meshColors());
    (this.streakU.uCol.value as THREE.Color).copy(str(this.params, 'colorPulse', '') ? new THREE.Color().setStyle(str(this.params, 'colorPulse', '')) : c.pulse);
    (this.partU.uCol.value as THREE.Color).copy(c.particle);
    (this.dustU.uCol.value as THREE.Color).copy(c.particle);
    this.gratMat.color.copy(c.foreground);
  }

  update(dt: number, t: number, p: Params, input: FrameInput, camera: THREE.Camera): void {
    this.params = p;
    const audio = bool(p, 'audioReactive', false) && input.audio.active;
    const ag = num(p, 'audioGain', 1.5);
    const activity = num(p, 'activity', 1) * (audio ? 1 + input.audio.bass * ag * 2.5 : 1);
    const sp: SimParams = {
      rate: num(p, 'rate', 0.01) * activity,
      propagation: Math.min(0.98, num(p, 'propagation', 0.5) * (audio ? 1 + input.audio.mid * ag * 0.4 : 1)),
      speed: num(p, 'pulseSpeed', 0.55) * (audio ? 1 + input.audio.treble * ag : 1),
      refractory: num(p, 'refractory', 1.6),
      burst: num(p, 'bursts', 0.6) * Math.max(0.2, activity),
      wave: num(p, 'wave', 0),
    };
    if (audio && input.audio.beat) {
      const hub = this.net.hubs[Math.floor(Math.random() * this.net.hubs.length)];
      this.sim.fire(hub, t, sp);
      for (const x of this.sim.neighbors(hub)) this.sim.fire(x.node, t + 0.01, sp);
    }
    this.sim.step(t, dt, sp);
    if (this.growth < this.growthTarget) this.growth = Math.min(this.growthTarget, this.growth + dt / 7);
    else this.growth = this.growthTarget;
    this.mesh.edgeUniforms.uGrowth.value = this.growth;
    this.mesh.edgeUniforms.uOpacity.value = num(p, 'layerOpacity', 1) * Math.min(1.6, num(p, 'brightness', 1));
    this.streakU.uAudio.value = audio ? input.audio.level * ag * 0.6 : 0;
    this.root.rotation.y += dt * 0.05 * num(p, 'rotation', 0.35);
    this.root.updateMatrixWorld();
    const camDist = camera.position.length();
    this.mesh.edgeUniforms.uFogNear.value = Math.max(0.01, camDist - 1.1);
    this.mesh.edgeUniforms.uFogFar.value = camDist + 1.2;
    this.mesh.upload(t, input.height, (camera as THREE.PerspectiveCamera).fov ?? 50, input.pixelRatio);
    this.rateAcc += dt;
    if (this.rateAcc > 0.25) {
      this.rateAcc = 0;
      this.rateHistory.push(this.sim.firesPerSec);
    }
    this.updateTrack(t, sp);
  }

  private updateTrack(t: number, sp: SimParams): void {
    const net = this.net;
    if (this.track$) {
      const tr = this.track$;
      const u = ((t - tr.start) * sp.speed) / tr.len;
      if (u > 1) {
        // Continue along the strongest outgoing path if the target fired, else pick a fresh impulse.
        const nb = this.sim.neighbors(tr.to).filter((x) => x.node !== tr.from);
        if (nb.length && Math.abs(this.sim.lastFireTime(tr.to) - t) < 2.5) {
          const next = nb[Math.floor(Math.random() * nb.length)];
          this.track$ = { from: tr.to, to: next.node, start: t, len: next.len };
        } else this.track$ = null;
      }
    }
    if (!this.track$) {
      const r = this.sim.recent[this.sim.recent.length - 1];
      if (r) {
        const nb = this.sim.neighbors(r.node);
        if (nb.length) {
          const next = nb[Math.floor(Math.random() * nb.length)];
          this.track$ = { from: r.node, to: next.node, start: Math.max(r.time, t - 0.05), len: next.len };
        }
      }
    }
    if (this.track$) {
      const tr = this.track$;
      const u = Math.max(0, Math.min(1, ((t - tr.start) * sp.speed) / tr.len));
      const pos = net.positions;
      const a = new THREE.Vector3(pos[tr.from * 3], pos[tr.from * 3 + 1], pos[tr.from * 3 + 2]);
      const b2 = new THREE.Vector3(pos[tr.to * 3], pos[tr.to * 3 + 1], pos[tr.to * 3 + 2]);
      this.trackPos.lerpVectors(a, b2, u).applyMatrix4(this.root.matrixWorld);
      this.trackAhead.lerpVectors(a, b2, Math.min(1, u + 0.35)).applyMatrix4(this.root.matrixWorld);
      if (this.trackAhead.distanceTo(this.trackPos) < 1e-4) this.trackAhead.copy(b2).applyMatrix4(this.root.matrixWorld).multiplyScalar(1.02);
    }
  }

  track() {
    return this.track$ ? { position: this.trackPos, ahead: this.trackAhead } : null;
  }

  hover(ndc: THREE.Vector2 | null, camera: THREE.Camera): void {
    if (!ndc) {
      if (this.hovered !== -1) { this.hovered = -1; this.mesh.edgeUniforms.uHighlight.value = -1; }
      return;
    }
    // Nearest projected hub-ish node within a small screen radius (sampled for speed).
    const pos = this.net.positions;
    const v = new THREE.Vector3();
    let best = -1, bestD = 0.0012;
    const step = Math.max(1, Math.floor(this.net.n / 6000));
    for (let i = 0; i < this.net.n; i += step) {
      v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).applyMatrix4(this.root.matrixWorld).project(camera);
      if (v.z < -1 || v.z > 1) continue;
      const d = (v.x - ndc.x) ** 2 + (v.y - ndc.y) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    this.hovered = best;
    this.mesh.edgeUniforms.uHighlight.value = best;
  }

  hud(g: CanvasRenderingContext2D, w: number, h: number, info: HudInfo): void {
    const c = info.colors;
    const net = this.net;
    const E = this.mesh.edgeCount;
    hudFont(g, 10, c.mono);
    const algo = str(this.params, 'algorithm', 'small-world').toUpperCase();
    drawHudBlock(g, 12, 18, [
      ['NEURAL SPHERE', ''],
      ['TOPOLOGY', algo],
      ['NODES', net.n.toLocaleString('en-US')],
      ['STRANDS', E.toLocaleString('en-US')],
      ['⟨k⟩', ((2 * E) / net.n).toFixed(2)],
      ['GEN', `${net.ms.toFixed(0)} ms`],
    ], c, 'left');
    drawHudBlock(g, w - 12, 18, [
      ['FIRING', `${(this.sim.firesPerSec / 1000).toFixed(2)} kHz`],
      ['IN FLIGHT', this.sim.pending.toLocaleString('en-US')],
      ['GROWTH', `${(this.growth * 100).toFixed(0)} %`],
      ['CAMERA', info.camera.toUpperCase()],
      ...(info.showFps ? [['FPS', info.fps.toFixed(0)] as [string, string]] : []),
    ], c, 'right');
    // Firing-rate sparkline.
    drawSparkline(g, 12, h - 46, Math.min(180, w * 0.25), 28, this.rateHistory, c, 'ACTIVITY');
    // Projected outline ring with degree ticks.
    const centre = info.project(new THREE.Vector3(0, 0, 0));
    const edge = info.project(new THREE.Vector3(0, 1.06, 0).applyAxisAngle(new THREE.Vector3(1, 0, 0), 0));
    const R = Math.hypot(edge.x - centre.x, edge.y - centre.y);
    if (centre.visible && R > 30 && R < Math.max(w, h)) {
      g.save();
      g.strokeStyle = c.dim;
      g.globalAlpha = 0.35;
      g.lineWidth = 1;
      g.beginPath();
      g.arc(centre.x, centre.y, R * 1.08, 0, Math.PI * 2);
      g.stroke();
      for (let a = 0; a < 360; a += 5) {
        const rad = (a * Math.PI) / 180;
        const len = a % 30 === 0 ? 8 : a % 10 === 0 ? 5 : 2;
        g.beginPath();
        g.moveTo(centre.x + Math.cos(rad) * R * 1.08, centre.y + Math.sin(rad) * R * 1.08);
        g.lineTo(centre.x + Math.cos(rad) * (R * 1.08 + len), centre.y + Math.sin(rad) * (R * 1.08 + len));
        g.stroke();
        if (a % 30 === 0) {
          g.globalAlpha = 0.5;
          g.fillStyle = c.dim;
          g.fillText(String(a).padStart(3, '0'), centre.x + Math.cos(rad) * (R * 1.08 + 18) - 8, centre.y + Math.sin(rad) * (R * 1.08 + 18) + 3);
          g.globalAlpha = 0.35;
        }
      }
      g.restore();
    }
    // Hub callouts.
    const pos = net.positions;
    let k = 0;
    for (const hub of net.hubs) {
      if (k >= 5) break;
      const wp = new THREE.Vector3(pos[hub * 3], pos[hub * 3 + 1], pos[hub * 3 + 2]).applyMatrix4(this.root.matrixWorld);
      const p = info.project(wp);
      if (!p.visible || p.x < 40 || p.x > w - 40 || p.y < 60 || p.y > h - 60) continue;
      const side = p.x > w / 2 ? 1 : -1;
      const lx = p.x + side * 46, ly = p.y - 22;
      const theta = (Math.atan2(pos[hub * 3 + 2], pos[hub * 3]) * 180) / Math.PI;
      const phi = (Math.asin(Math.max(-1, Math.min(1, pos[hub * 3 + 1] / (Math.hypot(pos[hub * 3], pos[hub * 3 + 1], pos[hub * 3 + 2]) || 1)))) * 180) / Math.PI;
      const act = Math.max(0, 1 - (info.time - this.sim.lastFireTime(hub)) / 2);
      g.save();
      g.strokeStyle = c.dim;
      g.globalAlpha = 0.65;
      g.beginPath();
      g.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
      g.moveTo(p.x + side * 3.5, p.y);
      g.lineTo(lx, ly);
      g.lineTo(lx + side * 62, ly);
      g.stroke();
      g.fillStyle = c.fg;
      g.globalAlpha = 0.85;
      g.textAlign = side > 0 ? 'left' : 'right';
      g.fillText(`HUB-${String(hub).padStart(5, '0')}`, lx, ly - 4);
      g.fillStyle = c.dim;
      g.fillText(`k ${net.degree[hub]}  θ ${theta.toFixed(1)}  φ ${phi.toFixed(1)}  A ${act.toFixed(2)}`, lx, ly + 10);
      g.restore();
      k++;
    }
    if (this.hovered >= 0) {
      const i = this.hovered;
      const wp = new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).applyMatrix4(this.root.matrixWorld);
      const p = info.project(wp);
      g.save();
      g.strokeStyle = c.accent;
      g.fillStyle = c.fg;
      g.beginPath();
      g.arc(p.x, p.y, 6, 0, Math.PI * 2);
      g.stroke();
      g.fillText(`ND-${String(i).padStart(5, '0')}  k=${net.degree[i]}  C${net.cluster[i]}`, p.x + 10, p.y - 8);
      g.restore();
    }
  }

  stats() {
    return { nodes: this.net.n, edges: this.mesh.edgeCount, firing: `${this.sim.firesPerSec}/s`, pending: this.sim.pending, genMs: this.net.ms.toFixed(0) };
  }

  gpuBytes(): number {
    return this.bytes;
  }

  dispose(): void {
    this.mesh.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
