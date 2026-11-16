/**
 * Cybernetic engines:
 *   matrix   GPU glyph streams (2D screen or 3D cylindrical volume), one instanced draw
 *   circuit  procedurally routed 45° traces with pads/vias and travelling signals
 */
import * as THREE from 'three';
import type { EngineDef, EngineInstance, FrameInput, HudInfo, Params, SharedResources, VizColors } from '../types';
import { num, str } from '../types';
import { Rng } from '../../../shared/random';
import { HASH, POINT_FRAG } from '../glsl';
import { titleBlock } from './hud';

// ───────────────────────────── glyph atlas ─────────────────────────────

const GLYPHS = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789ABCDEF<>/\\|=+-*:;#%$@&';
const ATLAS_COLS = 16;

function makeAtlas(): THREE.CanvasTexture {
  const cell = 64;
  const rows = Math.ceil(GLYPHS.length / ATLAS_COLS);
  const c = document.createElement('canvas');
  c.width = ATLAS_COLS * cell;
  c.height = rows * cell;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `${cell * 0.78}px "Fira Mono", monospace`;
  [...GLYPHS].forEach((ch, i) => {
    const x = (i % ATLAS_COLS) * cell + cell / 2;
    const y = Math.floor(i / ATLAS_COLS) * cell + cell / 2;
    g.save();
    g.translate(x, y);
    g.scale(-1, 1);
    g.fillText(ch, 0, 2);
    g.restore();
  });
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  return tex;
}

function atlas(shared: SharedResources): THREE.CanvasTexture {
  return shared.get('glyph-atlas', makeAtlas, (t) => t.dispose());
}

const MATRIX_VERT = /* glsl */ `
${HASH}
uniform float uTime, uSpeed, uRows, uCols, uMode, uTrail, uAudio;
attribute vec2 aCell;
attribute vec2 corner;
varying vec2 vUv;
varying float vB;
varying float vHead;
void main() {
  float col = aCell.x, row = aCell.y;
  float colSeed = hash11(col * 13.7 + 1.0);
  float speed = (0.35 + colSeed * 0.9) * uSpeed * (1.0 + uAudio);
  float period = uRows + uTrail * uRows;
  float head = mod(uTime * speed * 12.0 + colSeed * period, period);
  float d = head - row;
  float inTrail = step(0.0, d) * step(d, uTrail * uRows);
  vHead = smoothstep(1.5, 0.0, d) * step(0.0, d);
  vB = inTrail * pow(1.0 - d / max(uTrail * uRows, 1.0), 1.6);
  float flick = floor(uTime * (2.0 + colSeed * 8.0) + row * 0.37);
  float glyph = floor(hash13(vec3(col, row, flick)) * ${GLYPHS.length.toFixed(1)});
  vec2 gcell = vec2(mod(glyph, ${ATLAS_COLS.toFixed(1)}), floor(glyph / ${ATLAS_COLS.toFixed(1)}));
  vUv = (gcell + corner) / vec2(${ATLAS_COLS.toFixed(1)}, ${Math.ceil(GLYPHS.length / ATLAS_COLS).toFixed(1)});
  vUv.y = 1.0 - vUv.y;
  vec3 p;
  float cw = 2.0 / uCols;
  if (uMode < 0.5) {
    p = vec3(-1.0 + (col + corner.x) * cw, 1.0 - (row + corner.y) * (2.0 / uRows), 0.0);
    gl_Position = vec4(p.xy, 0.0, 1.0);
  } else {
    float layer = floor(hash11(col * 3.3) * 3.0);
    float radius = 0.7 + layer * 0.35;
    float ang = (col + corner.x) / uCols * 6.2831853 * 1.0;
    float h = 1.6 - (row + corner.y) * (3.2 / uRows);
    p = vec3(cos(ang) * radius, h, sin(ang) * radius);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    vB *= 0.6 + 0.4 * (1.0 - layer / 3.0);
  }
}`;
const MATRIX_FRAG = /* glsl */ `
uniform sampler2D uAtlas;
uniform vec3 uCol, uHeadCol;
uniform float uOpacity, uBright;
varying vec2 vUv;
varying float vB;
varying float vHead;
void main() {
  float g = texture2D(uAtlas, vUv).r;
  float a = g * max(vB, vHead) * uOpacity * uBright;
  if (a < 0.01) discard;
  gl_FragColor = vec4(mix(uCol, uHeadCol, vHead), a);
}`;

export const matrix: EngineDef = {
  id: 'matrix',
  name: 'Digital Matrix',
  description: 'Cascading glyph streams, as a flat screen or a volumetric cylinder.',
  artistic: true,
  cameraModes: ['orbital', 'interactive', 'macro', 'cinematic'],
  defaultCamera: 'orbital',
  params: [
    { key: 'mode', label: 'Mode', type: 'select', default: '2d', group: 'Layout', rebuild: true, options: [{ value: '2d', label: 'Flat (2D)' }, { value: '3d', label: 'Volumetric (3D)' }] },
    { key: 'columns', label: 'Columns (0 = auto)', type: 'int', default: 0, min: 0, max: 400, group: 'Layout', rebuild: true },
    { key: 'speed', label: 'Fall speed', type: 'number', default: 1, min: 0, max: 5, step: 0.01, group: 'Animation' },
    { key: 'trail', label: 'Trail length', type: 'number', default: 0.45, min: 0.05, max: 1.5, step: 0.01, group: 'Animation' },
    { key: 'brightness', label: 'Brightness', type: 'number', default: 1, min: 0, max: 3, step: 0.01, group: 'Look' },
    { key: 'audioReactive', label: 'Audio reactive', type: 'bool', default: false, group: 'Audio' },
    { key: 'bloom', label: 'Bloom', type: 'number', default: 0.8, min: 0, max: 3, step: 0.01, group: 'Rendering' },
  ],
  create(ctx) {
    return new MatrixEngine(ctx.quality, ctx.params, ctx.colors, ctx.shared, ctx.width, ctx.height);
  },
};

class MatrixEngine implements EngineInstance {
  readonly scene = new THREE.Scene();
  readonly radius = 1.4;
  private u: Record<string, THREE.IUniform>;
  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  private cols: number;
  private rows: number;
  private mode: string;

  constructor(quality: number, params: Params, colors: VizColors, private shared: SharedResources, w: number, h: number) {
    this.mode = str(params, 'mode', '2d');
    const auto = this.mode === '2d' ? Math.round(Math.max(40, Math.min(260, (w / Math.max(1, h)) * [40, 60, 80, 110][quality]))) : [70, 110, 160, 220][quality];
    this.cols = num(params, 'columns', 0) || auto;
    this.rows = this.mode === '2d' ? Math.round(this.cols * (h / Math.max(1, w)) * 1.65) || 40 : Math.round(this.cols * 0.55);
    const count = this.cols * this.rows;
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    geo.setAttribute('corner', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const cell = new Float32Array(count * 2);
    for (let c = 0, i = 0; c < this.cols; c++) for (let r = 0; r < this.rows; r++, i++) { cell[i * 2] = c; cell[i * 2 + 1] = r; }
    geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(cell, 2));
    geo.instanceCount = count;
    this.geo = geo;
    this.u = {
      uTime: { value: 0 }, uSpeed: { value: 1 }, uRows: { value: this.rows }, uCols: { value: this.cols }, uMode: { value: this.mode === '2d' ? 0 : 1 }, uTrail: { value: 0.45 }, uAudio: { value: 0 },
      uAtlas: { value: atlas(shared) }, uCol: { value: colors.neural.clone() }, uHeadCol: { value: colors.pulse.clone() }, uOpacity: { value: 1 }, uBright: { value: 1 },
    };
    this.mat = new THREE.ShaderMaterial({ vertexShader: MATRIX_VERT, fragmentShader: MATRIX_FRAG, uniforms: this.u, transparent: true, depthWrite: false, depthTest: this.mode !== '2d', blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, this.mat);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
  }

  setParam(): boolean {
    return true;
  }

  setColors(c: VizColors): void {
    (this.u.uCol.value as THREE.Color).copy(c.neural);
    (this.u.uHeadCol.value as THREE.Color).copy(c.pulse);
  }

  update(_dt: number, t: number, p: Params, input: FrameInput): void {
    this.u.uTime.value = t;
    this.u.uSpeed.value = num(p, 'speed', 1);
    this.u.uTrail.value = num(p, 'trail', 0.45);
    this.u.uBright.value = num(p, 'brightness', 1);
    this.u.uOpacity.value = num(p, 'layerOpacity', 1);
    this.u.uAudio.value = p.audioReactive && input.audio.active ? input.audio.bass * 2 : 0;
    if (this.mode !== '2d') this.scene.rotation.y = t * 0.04;
  }

  hud(g: CanvasRenderingContext2D, w: number, _h: number, info: HudInfo): void {
    if (this.mode === '3d') titleBlock(g, info, 'DIGITAL MATRIX · VOLUMETRIC', [['STREAMS', String(this.cols)], ['GLYPHS', (this.cols * this.rows).toLocaleString('en-US')]], [], w);
  }

  stats() {
    return { mode: this.mode, glyphs: this.cols * this.rows };
  }

  gpuBytes(): number {
    return this.cols * this.rows * 8 + 1024 * 384 * 4;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
    this.shared.release('glyph-atlas');
  }
}

// ───────────────────────────── circuit ─────────────────────────────

const TRACE_VERT = /* glsl */ `
uniform float uTime, uSpeed, uOpacity, uBase, uPulse;
attribute float aS;
attribute vec3 aTrace;
varying float vA;
varying float vP;
void main() {
  float len = aTrace.x;
  float phase = aTrace.y;
  float head = fract(uTime * uSpeed * (0.3 + aTrace.z * 0.7) / max(len, 0.05) + phase);
  float d = aS / max(len, 1e-3) - head;
  float pulse = d < 0.0 ? exp(d * len * 18.0) : exp(-d * d * len * len * 4000.0);
  pulse *= step(aTrace.z, uPulse);
  vP = pulse;
  vA = (uBase + pulse * 1.4) * uOpacity;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const TRACE_FRAG = /* glsl */ `
uniform vec3 uCol, uPulseCol;
varying float vA;
varying float vP;
void main() { if (vA < 0.003) discard; gl_FragColor = vec4(mix(uCol, uPulseCol, clamp(vP, 0.0, 1.0)), vA); }`;

export const circuit: EngineDef = {
  id: 'circuit',
  name: 'Cybernetic Circuit',
  description: 'Procedurally routed circuit-board traces with pads, vias and signal pulses.',
  artistic: true,
  cameraModes: ['orbital', 'interactive', 'macro', 'microscopic', 'cinematic'],
  defaultCamera: 'orbital',
  params: [
    { key: 'traces', label: 'Traces (0 = by quality)', type: 'int', default: 0, min: 0, max: 4000, step: 50, group: 'Layout', rebuild: true },
    { key: 'gridSize', label: 'Routing grid', type: 'int', default: 0, min: 0, max: 400, group: 'Layout', rebuild: true },
    { key: 'speed', label: 'Signal speed', type: 'number', default: 1, min: 0, max: 5, step: 0.01, group: 'Signals' },
    { key: 'activity', label: 'Active traces', type: 'number', default: 0.6, min: 0, max: 1, step: 0.01, group: 'Signals' },
    { key: 'brightness', label: 'Base brightness', type: 'number', default: 1, min: 0, max: 3, step: 0.01, group: 'Look' },
    { key: 'bloom', label: 'Bloom', type: 'number', default: 1, min: 0, max: 3, step: 0.01, group: 'Rendering' },
  ],
  create(ctx) {
    return new CircuitEngine(ctx.quality, ctx.seed, ctx.params, ctx.colors);
  },
};

class CircuitEngine implements EngineInstance {
  readonly scene = new THREE.Scene();
  readonly radius = 1.1;
  private u: Record<string, THREE.IUniform>;
  private padU: Record<string, THREE.IUniform>;
  private count = 0;
  private disp: { dispose(): void }[] = [];

  constructor(quality: number, seed: number, params: Params, colors: VizColors) {
    const rng = new Rng(seed);
    const G = num(params, 'gridSize', 0) || [90, 130, 180, 240][quality];
    const want = num(params, 'traces', 0) || [300, 700, 1300, 2200][quality];
    const occ = new Uint8Array(G * G);
    const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
    const pos: number[] = [], sArr: number[] = [], tr: number[] = [], pads: number[] = [];
    const toW = (x: number, y: number) => [(x / G) * 2.4 - 1.2, 0, (y / G) * 2.4 - 1.2];
    for (let k = 0; k < want; k++) {
      let x = rng.int(2, G - 2), y = rng.int(2, G - 2);
      if (occ[y * G + x]) continue;
      let d = rng.int(0, 8);
      const path: [number, number][] = [[x, y]];
      const maxLen = rng.int(8, Math.round(G * 0.6));
      for (let step = 0; step < maxLen; step++) {
        if (rng.next() < 0.15) d = (d + (rng.next() < 0.5 ? 1 : 7)) % 8;
        const nx = x + DIRS[d][0], ny = y + DIRS[d][1];
        if (nx < 1 || ny < 1 || nx >= G - 1 || ny >= G - 1 || occ[ny * G + nx]) {
          const alt = (d + (rng.next() < 0.5 ? 2 : 6)) % 8;
          const ax = x + DIRS[alt][0], ay = y + DIRS[alt][1];
          if (ax < 1 || ay < 1 || ax >= G - 1 || ay >= G - 1 || occ[ay * G + ax]) break;
          d = alt; x = ax; y = ay;
        } else { x = nx; y = ny; }
        path.push([x, y]);
      }
      if (path.length < 4) continue;
      for (const [px, py] of path) occ[py * G + px] = 1;
      const pts = path.map(([px, py]) => toW(px, py));
      let L = 0;
      const sAcc = [0];
      for (let i = 1; i < pts.length; i++) { L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]); sAcc.push(L); }
      const phase = rng.next(), act = rng.next();
      for (let i = 0; i < pts.length - 1; i++) {
        pos.push(...pts[i], ...pts[i + 1]);
        sArr.push(sAcc[i], sAcc[i + 1]);
        tr.push(L, phase, act, L, phase, act);
      }
      pads.push(...pts[0], ...pts[pts.length - 1]);
      this.count++;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aS', new THREE.Float32BufferAttribute(sArr, 1));
    g.setAttribute('aTrace', new THREE.Float32BufferAttribute(tr, 3));
    this.u = { uTime: { value: 0 }, uSpeed: { value: 1 }, uOpacity: { value: 1 }, uBase: { value: 0.12 }, uPulse: { value: 0.6 }, uCol: { value: colors.neural.clone() }, uPulseCol: { value: colors.pulse.clone() } };
    const lines = new THREE.LineSegments(g, new THREE.ShaderMaterial({ vertexShader: TRACE_VERT, fragmentShader: TRACE_FRAG, uniforms: this.u, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    lines.frustumCulled = false;
    const pg = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pads, 3));
    this.padU = { uCol: { value: colors.foreground.clone() }, uScale: { value: 400 } };
    const padPts = new THREE.Points(pg, new THREE.ShaderMaterial({
      vertexShader: 'uniform float uScale; void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); gl_PointSize = clamp(0.012*uScale/max(-mv.z,0.01), 1.5, 10.0); gl_Position = projectionMatrix*mv; }',
      fragmentShader: `${POINT_FRAG}\nuniform vec3 uCol; void main(){ vec2 d = gl_PointCoord-0.5; float r = length(d)*2.0; float ring = smoothstep(0.15,0.0,abs(r-0.7)); float a = ring*0.8 + softPoint(gl_PointCoord)*0.3; if (a<0.01) discard; gl_FragColor = vec4(uCol, a*0.7); }`,
      uniforms: this.padU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    padPts.frustumCulled = false;
    // Board outline + fine dot grid.
    const og = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([-1.25, 0, -1.25, 1.25, 0, -1.25, 1.25, 0, -1.25, 1.25, 0, 1.25, 1.25, 0, 1.25, -1.25, 0, 1.25, -1.25, 0, 1.25, -1.25, 0, -1.25], 3));
    const om = new THREE.LineBasicMaterial({ color: colors.foreground, transparent: true, opacity: 0.25 });
    const board = new THREE.Group();
    board.add(lines, padPts, new THREE.LineSegments(og, om));
    board.rotation.x = 1.05;
    this.scene.add(board);
    this.disp.push(g, lines.material as THREE.Material, pg, padPts.material as THREE.Material, og, om);
  }

  setParam(): boolean {
    return true;
  }

  setColors(c: VizColors): void {
    (this.u.uCol.value as THREE.Color).copy(c.neural);
    (this.u.uPulseCol.value as THREE.Color).copy(c.pulse);
    (this.padU.uCol.value as THREE.Color).copy(c.foreground);
  }

  update(dt: number, t: number, p: Params, input: FrameInput): void {
    this.u.uTime.value = t;
    this.u.uSpeed.value = num(p, 'speed', 1);
    this.u.uPulse.value = num(p, 'activity', 0.6);
    this.u.uBase.value = 0.07 * num(p, 'brightness', 1);
    this.u.uOpacity.value = num(p, 'layerOpacity', 1);
    this.padU.uScale.value = input.height;
    this.scene.rotation.y += dt * 0.02;
  }

  hud(g: CanvasRenderingContext2D, w: number, _h: number, info: HudInfo): void {
    titleBlock(g, info, 'CYBERNETIC CIRCUIT', [['TRACES', String(this.count)], ['ROUTING', '8-DIR / 45°']], [], w);
  }

  stats() {
    return { traces: this.count };
  }

  gpuBytes(): number {
    return this.count * 600;
  }

  dispose(): void {
    for (const d of this.disp) d.dispose();
  }
}
