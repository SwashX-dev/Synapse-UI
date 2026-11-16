/**
 * ENCOM Globe+ — a modern rebuild of eDEX-UI's ENCOM globe (encom-globe by
 * Rob Scanlon, MIT) as a reusable module. It keeps the recognizable pieces —
 * the 3,937 hexagonal land tiles from eDEX's grid.json, the 45-second day,
 * tilted view, rising intro lines, satellites with radio rings — and adds a
 * GPU-animated arc system whose spawn rate follows LIVE network throughput.
 *
 * Route endpoints are decorative (no IP geolocation is performed, so nothing
 * about your connections is looked up or transmitted).
 */
import * as THREE from 'three';
import type { EngineDef, EngineInstance, FrameInput, HudInfo, Params, VizColors } from '../types';
import { num } from '../types';
import { Rng } from '../../../shared/random';
import { POINT_FRAG } from '../glsl';
import { drawHudBlock, hudFont } from './hud';
import type { ConnData, NetData } from '../../core/monitor';

interface Tile { lat: number; lon: number; b: { x: number; y: number; z: number }[] }
let tileCache: Promise<Tile[]> | null = null;
function loadTiles(): Promise<Tile[]> {
  tileCache ??= fetch('/assets/misc/grid.json').then((r) => r.json()).then((d: { tiles: Tile[] }) => d.tiles).catch(() => []);
  return tileCache;
}

export function latLonToVec(lat: number, lon: number, r = 1): THREE.Vector3 {
  const la = (lat * Math.PI) / 180, lo = (lon * Math.PI) / 180;
  return new THREE.Vector3(Math.cos(la) * Math.cos(lo) * r, Math.sin(la) * r, Math.cos(la) * Math.sin(lo) * r);
}

const MAX_ARCS = 96;
const ARC_SEG = 40;

const TILE_VERT = /* glsl */ `
uniform float uTime, uIntro;
attribute float aLat;
attribute float aRand;
varying float vA;
void main() {
  float delay = (aLat + 90.0) / 180.0 * 0.6 + aRand * 0.4;
  float k = clamp((uIntro - delay) * 2.5, 0.0, 1.0);
  vec3 p = position * mix(0.85, 1.0, k) * (1.0 + 0.004 * sin(uTime * 0.8 + aRand * 40.0));
  vA = k * (0.55 + 0.45 * aRand);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const TILE_FRAG = /* glsl */ `
uniform vec3 uCol;
uniform float uOpacity;
varying float vA;
void main() { gl_FragColor = vec4(uCol, vA * uOpacity); }`;

const ARC_VERT = /* glsl */ `
uniform float uTime;
attribute float aT;
attribute vec2 aArc;
varying float vA;
void main() {
  float age = (uTime - aArc.x) / aArc.y;
  float head = clamp(age * 1.6, 0.0, 1.0);
  float tail = clamp(age * 1.6 - 0.6, 0.0, 1.0);
  float vis = step(tail, aT) * step(aT, head) * step(0.0, age) * step(age, 1.0);
  vA = vis * (0.35 + 0.65 * smoothstep(head - 0.15, head, aT));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const ARC_FRAG = /* glsl */ `
uniform vec3 uCol;
uniform float uOpacity;
varying float vA;
void main() { if (vA < 0.01) discard; gl_FragColor = vec4(uCol, vA * uOpacity); }`;

const SAT_FRAG = /* glsl */ `
${POINT_FRAG}
uniform vec3 uCol;
uniform float uTime;
varying float vPhase;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d) * 2.0;
  float core = smoothstep(0.18, 0.0, r);
  float wave = 0.0;
  for (int i = 0; i < 3; i++) {
    float w = fract(uTime * 0.5 + vPhase + float(i) / 3.0);
    wave += smoothstep(0.04, 0.0, abs(r - w)) * (1.0 - w);
  }
  float a = core + wave * 0.7;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uCol, a);
}`;

export const encomGlobe: EngineDef = {
  id: 'encom-globe',
  name: 'ENCOM Globe+',
  description: 'The eDEX-UI ENCOM globe rebuilt: hexagonal land tiles, satellites, pins and traffic arcs.',
  artistic: true,
  science: 'Land tiles come from eDEX-UI’s grid.json. Arc spawn rate tracks your real network throughput and connection count; arc endpoints are decorative because no IP geolocation is performed.',
  cameraModes: ['orbital', 'interactive', 'macro', 'cinematic'],
  defaultCamera: 'orbital',
  params: [
    { key: 'dayLength', label: 'Day length (s)', type: 'number', default: 45, min: 5, max: 600, step: 1, group: 'Globe' },
    { key: 'tilt', label: 'View tilt', type: 'number', default: 0.63, min: 0, max: 1.5, step: 0.01, group: 'Globe' },
    { key: 'satellites', label: 'Satellites', type: 'int', default: 6, min: 0, max: 24, group: 'Globe', rebuild: true },
    { key: 'arcRate', label: 'Arc rate multiplier', type: 'number', default: 1, min: 0, max: 10, step: 0.05, group: 'Traffic' },
    { key: 'liveTraffic', label: 'Drive arcs from live traffic', type: 'bool', default: true, group: 'Traffic' },
    { key: 'pins', label: 'Pins', type: 'int', default: 5, min: 0, max: 30, group: 'Globe', rebuild: true },
    { key: 'atmosphere', label: 'Atmosphere', type: 'number', default: 0.6, min: 0, max: 2, step: 0.01, group: 'Look' },
    { key: 'brightness', label: 'Brightness', type: 'number', default: 1, min: 0, max: 3, step: 0.01, group: 'Look' },
    { key: 'bloom', label: 'Bloom', type: 'number', default: 0.7, min: 0, max: 3, step: 0.01, group: 'Rendering' },
  ],
  async create(ctx) {
    const tiles = await loadTiles();
    return new EncomGlobe(tiles, ctx.seed, ctx.params, ctx.colors);
  },
};

class EncomGlobe implements EngineInstance {
  readonly scene = new THREE.Scene();
  readonly radius = 1.25;
  private globe = new THREE.Group();
  private tileU: Record<string, THREE.IUniform>;
  private arcU: Record<string, THREE.IUniform>;
  private satU: Record<string, THREE.IUniform>;
  private atmoU: Record<string, THREE.IUniform>;
  private arcPos: THREE.BufferAttribute;
  private arcInfo: THREE.BufferAttribute;
  private arcNext = 0;
  private spawnAcc = 0;
  private sats: { obj: THREE.Object3D; speed: number }[] = [];
  private satPoints: THREE.Points;
  private pins: { pos: THREE.Vector3; label: string }[] = [];
  private landCenters: THREE.Vector3[] = [];
  private rng: Rng;
  private introT = 0;
  private liveRate = 0;
  private conns = 0;
  private disp: { dispose(): void }[] = [];
  private outline: THREE.LineSegments;

  constructor(private tiles: Tile[], seed: number, params: Params, colors: VizColors) {
    this.rng = new Rng(seed);
    // Tiles: triangle fans of each hex/pentagon (normalised from radius 500, y flipped so north is up).
    const pos: number[] = [], lat: number[] = [], rnd: number[] = [], out: number[] = [];
    for (const t of tiles) {
      const pts = t.b.map((p) => new THREE.Vector3(p.x, -p.y, p.z).divideScalar(500));
      const r = this.rng.next();
      for (let i = 1; i < pts.length - 1; i++) {
        for (const p of [pts[0], pts[i], pts[i + 1]]) { pos.push(p.x, p.y, p.z); lat.push(t.lat); rnd.push(r); }
      }
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i].clone().multiplyScalar(1.001), b2 = pts[(i + 1) % pts.length].clone().multiplyScalar(1.001);
        out.push(a.x, a.y, a.z, b2.x, b2.y, b2.z);
      }
      this.landCenters.push(latLonToVec(t.lat, t.lon));
    }
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    tg.setAttribute('aLat', new THREE.Float32BufferAttribute(lat, 1));
    tg.setAttribute('aRand', new THREE.Float32BufferAttribute(rnd, 1));
    this.tileU = { uTime: { value: 0 }, uIntro: { value: 0 }, uCol: { value: colors.neural.clone() }, uOpacity: { value: 0.55 } };
    const tilesMesh = new THREE.Mesh(tg, new THREE.ShaderMaterial({ vertexShader: TILE_VERT, fragmentShader: TILE_FRAG, uniforms: this.tileU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    const og = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
    this.outline = new THREE.LineSegments(og, new THREE.LineBasicMaterial({ color: colors.foreground, transparent: true, opacity: 0.08, blending: THREE.AdditiveBlending, depthWrite: false }));
    // Dark occluding core so the far side is hidden (as in the original).
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.985, 64, 48), new THREE.MeshBasicMaterial({ color: colors.background }));
    this.globe.add(core, tilesMesh, this.outline);
    this.disp.push(tg, tilesMesh.material as THREE.Material, og, this.outline.material as THREE.Material, core.geometry, core.material as THREE.Material);

    // Atmosphere rim.
    this.atmoU = { uCol: { value: colors.glow.clone() }, uStrength: { value: 0.6 } };
    const atmo = new THREE.Mesh(new THREE.SphereGeometry(1.06, 64, 48), new THREE.ShaderMaterial({
      vertexShader: 'varying vec3 vN; varying vec3 vV; void main(){ vN = normalize(normalMatrix*normal); vec4 mv = modelViewMatrix*vec4(position,1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }',
      fragmentShader: 'uniform vec3 uCol; uniform float uStrength; varying vec3 vN; varying vec3 vV; void main(){ float f = pow(1.0 - abs(dot(vN, vV)), 3.0); gl_FragColor = vec4(uCol, f * uStrength * 0.22); }',
      uniforms: this.atmoU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.BackSide,
    }));
    this.scene.add(atmo);
    this.disp.push(atmo.geometry, atmo.material as THREE.Material);

    // Arc pool (GPU animated).
    const ap = new Float32Array(MAX_ARCS * ARC_SEG * 2 * 3), at = new Float32Array(MAX_ARCS * ARC_SEG * 2), ai = new Float32Array(MAX_ARCS * ARC_SEG * 2 * 2).fill(-100);
    for (let a = 0; a < MAX_ARCS; a++) for (let s = 0; s < ARC_SEG; s++) { at[(a * ARC_SEG + s) * 2] = s / ARC_SEG; at[(a * ARC_SEG + s) * 2 + 1] = (s + 1) / ARC_SEG; }
    const ag = new THREE.BufferGeometry();
    this.arcPos = new THREE.BufferAttribute(ap, 3);
    this.arcPos.setUsage(THREE.DynamicDrawUsage);
    this.arcInfo = new THREE.BufferAttribute(ai, 2);
    this.arcInfo.setUsage(THREE.DynamicDrawUsage);
    ag.setAttribute('position', this.arcPos);
    ag.setAttribute('aT', new THREE.BufferAttribute(at, 1));
    ag.setAttribute('aArc', this.arcInfo);
    this.arcU = { uTime: { value: 0 }, uCol: { value: colors.pulse.clone() }, uOpacity: { value: 1 } };
    const arcs = new THREE.LineSegments(ag, new THREE.ShaderMaterial({ vertexShader: ARC_VERT, fragmentShader: ARC_FRAG, uniforms: this.arcU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    arcs.frustumCulled = false;
    this.globe.add(arcs);
    this.disp.push(ag, arcs.material as THREE.Material);

    // Satellites: the original 2 × 3 constellation layout, extended to N.
    const nSat = num(params, 'satellites', 6);
    const sp = new Float32Array(nSat * 3), sPh = new Float32Array(nSat);
    for (let i = 0; i < nSat; i++) {
      const row = Math.floor(i / 3) % 2, colI = i % 3;
      const la = 50 * row - 30 + 15 * this.rng.next(), lo = 120 * colI - 120 + 30 * row + Math.floor(i / 6) * 17;
      const alt = 1.3 + this.rng.next() * 0.4;
      const holder = new THREE.Object3D();
      const v = latLonToVec(la, lo, alt);
      sp.set([v.x, v.y, v.z], i * 3);
      sPh[i] = this.rng.next();
      holder.rotation.y = this.rng.next() * Math.PI;
      this.sats.push({ obj: holder, speed: 0.04 + this.rng.next() * 0.06 });
      // faint orbit ring
      const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 96 }, (_, k) => latLonToVec(la, (k / 96) * 360, alt))), new THREE.LineBasicMaterial({ color: colors.foreground, transparent: true, opacity: 0.05, depthWrite: false }));
      this.globe.add(ring);
      this.disp.push(ring.geometry, ring.material as THREE.Material);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    sg.setAttribute('aPhase', new THREE.BufferAttribute(sPh, 1));
    this.satU = { uCol: { value: colors.pulse.clone() }, uTime: { value: 0 }, uScale: { value: 400 } };
    this.satPoints = new THREE.Points(sg, new THREE.ShaderMaterial({
      vertexShader: 'attribute float aPhase; uniform float uScale; varying float vPhase; void main(){ vPhase = aPhase; vec4 mv = modelViewMatrix*vec4(position,1.0); gl_PointSize = clamp(0.16*uScale/max(-mv.z,0.01), 4.0, 64.0); gl_Position = projectionMatrix*mv; }',
      fragmentShader: SAT_FRAG, uniforms: this.satU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.satPoints.frustumCulled = false;
    this.globe.add(this.satPoints);
    this.disp.push(sg, this.satPoints.material as THREE.Material);

    // Pins on land tiles.
    const nPins = Math.min(num(params, 'pins', 5), this.landCenters.length);
    for (let i = 0; i < nPins; i++) {
      const t = tiles[this.rng.int(0, tiles.length)];
      this.pins.push({ pos: latLonToVec(t.lat, t.lon, 1.0), label: `${t.lat.toFixed(2)}, ${t.lon.toFixed(2)}` });
    }
    const pinPts: number[] = [];
    for (const p of this.pins) { const top = p.pos.clone().multiplyScalar(1.09); pinPts.push(p.pos.x, p.pos.y, p.pos.z, top.x, top.y, top.z); }
    const pg = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pinPts, 3));
    const pins = new THREE.LineSegments(pg, new THREE.LineBasicMaterial({ color: colors.pulse, transparent: true, opacity: 0.8, depthWrite: false }));
    this.globe.add(pins);
    this.disp.push(pg, pins.material as THREE.Material);

    this.globe.rotation.x = num(params, 'tilt', 0.63) * 0.5;
    this.scene.add(this.globe);
  }

  private spawnArc(t: number): void {
    if (!this.landCenters.length) return;
    const a = this.landCenters[this.rng.int(0, this.landCenters.length)];
    const b2 = this.landCenters[this.rng.int(0, this.landCenters.length)];
    const ang = a.angleTo(b2);
    if (ang < 0.15) return;
    const idx = this.arcNext++ % MAX_ARCS;
    const pos = this.arcPos.array as Float32Array;
    const info = this.arcInfo.array as Float32Array;
    const h = 0.08 + ang * 0.22;
    const pt = (s: number) => {
      const p = new THREE.Vector3().copy(a).lerp(b2, s).normalize();
      return p.multiplyScalar(1.005 + Math.sin(Math.PI * s) * h);
    };
    const dur = 2.2 + ang * 1.2;
    for (let s = 0; s < ARC_SEG; s++) {
      const p0 = pt(s / ARC_SEG), p1 = pt((s + 1) / ARC_SEG);
      const v = (idx * ARC_SEG + s) * 2;
      pos.set([p0.x, p0.y, p0.z, p1.x, p1.y, p1.z], v * 3);
      info.set([t, dur, t, dur], v * 2);
    }
    this.arcPos.needsUpdate = true;
    this.arcInfo.needsUpdate = true;
  }

  setParam(): boolean {
    return true;
  }

  setColors(c: VizColors): void {
    (this.tileU.uCol.value as THREE.Color).copy(c.neural);
    (this.arcU.uCol.value as THREE.Color).copy(c.pulse);
    (this.satU.uCol.value as THREE.Color).copy(c.pulse);
    (this.atmoU.uCol.value as THREE.Color).copy(c.glow);
    (this.outline.material as THREE.LineBasicMaterial).color.copy(c.foreground);
  }

  update(dt: number, t: number, p: Params, input: FrameInput): void {
    this.introT += dt;
    this.tileU.uIntro.value = Math.min(1.2, this.introT / 2.5);
    this.tileU.uTime.value = t;
    this.arcU.uTime.value = t;
    this.satU.uTime.value = t;
    this.satU.uScale.value = input.height;
    const b2 = num(p, 'brightness', 1) * num(p, 'layerOpacity', 1);
    this.tileU.uOpacity.value = 0.55 * b2;
    this.arcU.uOpacity.value = b2;
    this.atmoU.uStrength.value = num(p, 'atmosphere', 0.6) * b2;
    this.globe.rotation.y += (dt * Math.PI * 2) / num(p, 'dayLength', 45);
    this.globe.rotation.x = num(p, 'tilt', 0.63) * 0.5;
    this.satPoints.rotation.y += dt * 0.05;
    const net = input.topic<NetData>('net');
    const conns = input.topic<ConnData>('net.connections');
    this.liveRate = ((net?.rxPerSec ?? 0) + (net?.txPerSec ?? 0)) / 1024;
    this.conns = conns?.established ?? 0;
    const live = p.liveTraffic !== false;
    const rate = (live ? 0.4 + Math.log2(1 + this.liveRate) * 0.55 + this.conns * 0.03 : 1.2) * num(p, 'arcRate', 1);
    this.spawnAcc += dt * rate;
    while (this.spawnAcc > 1) {
      this.spawnAcc -= 1;
      this.spawnArc(t);
    }
  }

  hud(g: CanvasRenderingContext2D, w: number, h: number, info: HudInfo): void {
    hudFont(g, 10, info.colors.mono);
    if (w > 220) {
      drawHudBlock(g, 12, 18, [['WORLD VIEW', ''], ['MAP', 'GLOBAL NETWORK'], ['TRAFFIC', `${this.liveRate.toFixed(1)} KiB/s · LIVE`], ['CONNS', `${this.conns} · LIVE`], ['ROUTES', 'DECORATIVE']], info.colors, 'left');
    }
    g.save();
    g.font = `9px "${info.colors.mono}", monospace`;
    for (const pin of this.pins) {
      const wp = pin.pos.clone().multiplyScalar(1.1).applyMatrix4(this.globe.matrixWorld);
      const n = pin.pos.clone().applyMatrix4(new THREE.Matrix4().extractRotation(this.globe.matrixWorld));
      const pr = info.project(wp);
      if (!pr.visible || n.z < 0.15) continue;
      g.fillStyle = info.colors.fg;
      g.globalAlpha = 0.75;
      g.fillText(pin.label, pr.x + 4, pr.y - 2);
    }
    g.restore();
    void h;
  }

  stats() {
    return { tiles: this.tiles.length, arcs: Math.min(this.arcNext, MAX_ARCS), traffic: `${this.liveRate.toFixed(1)} KiB/s` };
  }

  gpuBytes(): number {
    return this.tiles.length * 4 * 3 * 12 * 2 + MAX_ARCS * ARC_SEG * 48;
  }

  dispose(): void {
    for (const d of this.disp) d.dispose();
  }
}
