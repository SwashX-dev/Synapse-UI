/** Contracts between the graphics engine, visualization views and rendering engines. */
import type * as THREE from 'three';
import type { ParamSpec } from '../../shared/manifest';
import type { CameraMode } from '../../shared/commands';
import type { Quality } from '../core/perf';

export type ParamValue = number | boolean | string;
export type Params = Record<string, ParamValue>;

export interface VizColors {
  background: THREE.Color;
  foreground: THREE.Color;
  neural: THREE.Color;
  pulse: THREE.Color;
  particle: THREE.Color;
  accent: THREE.Color;
  glow: THREE.Color;
  graph: THREE.Color[];
  /** CSS strings for HUD drawing */
  css: { fg: string; dim: string; text: string; accent: string; bg: string; font: string; mono: string };
}

export interface FrameInput {
  audio: { level: number; bass: number; mid: number; treble: number; beat: boolean; beatPulse: number; spectrum: Float32Array; waveform: Float32Array; active: boolean };
  pointer: { x: number; y: number; inside: boolean; down: boolean };
  quality: Quality;
  /** Read any data source (cpu.load, net.rx, …). */
  data: (id: string) => number | null;
  /** Read raw monitoring topics (e.g. net.connections for topology). */
  topic: <T = unknown>(name: string) => T | undefined;
  width: number;
  height: number;
  /** Render pixels per CSS pixel (DPR × render scale). Line engines scale opacity by it so density looks constant. */
  pixelRatio: number;
}

export interface EngineContext {
  renderer: THREE.WebGLRenderer;
  quality: Quality;
  seed: number;
  params: Params;
  colors: VizColors;
  width: number;
  height: number;
  /** Shared, reference-counted GPU resources (e.g. glyph atlases, sprite textures). */
  shared: SharedResources;
}

export interface HudInfo {
  fps: number;
  camera: CameraMode;
  time: number;
  showFps: boolean;
  colors: VizColors['css'];
  project: (v: THREE.Vector3) => { x: number; y: number; visible: boolean };
}

export interface EngineInstance {
  scene: THREE.Scene;
  /** Scene radius used by the camera rig. */
  radius: number;
  /** Optional engine-owned camera (orthographic engines); otherwise the rig's perspective camera is used. */
  camera?: THREE.Camera;
  update(dt: number, t: number, params: Params, input: FrameInput, camera: THREE.Camera): void;
  /** Apply a live parameter change; return false if the engine must be rebuilt. */
  setParam?(key: string, value: ParamValue, params: Params): boolean;
  setColors(colors: VizColors): void;
  resize?(w: number, h: number): void;
  hud?(g: CanvasRenderingContext2D, w: number, h: number, info: HudInfo): void;
  /** Point the signal-tracking camera follows. */
  track?(): { position: THREE.Vector3; ahead: THREE.Vector3; up?: THREE.Vector3 } | null;
  /** Pointer hover in normalized device coordinates (for highlighting). */
  hover?(ndc: THREE.Vector2 | null, camera: THREE.Camera): void;
  stats(): Record<string, string | number>;
  /** Approximate GPU bytes held by this engine's buffers/textures. */
  gpuBytes(): number;
  dispose(): void;
}

export interface EngineDef {
  id: string;
  name: string;
  description: string;
  /** True when the visualization is an artistic interpretation rather than a faithful model. */
  artistic: boolean;
  /** What is scientifically modelled and its limitations (shown in the animation editor). */
  science?: string;
  params: (ParamSpec & { rebuild?: boolean })[];
  cameraModes: CameraMode[];
  defaultCamera: CameraMode;
  /** Engines with their own (e.g. orthographic) camera ignore the rig. */
  ownCamera?: boolean;
  create(ctx: EngineContext): EngineInstance | Promise<EngineInstance>;
}

export interface SharedResources {
  get<T>(key: string, make: () => T, dispose: (v: T) => void): T;
  release(key: string): void;
}

export function num(p: Params, k: string, d: number): number {
  const v = p[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}
export function bool(p: Params, k: string, d: boolean): boolean {
  const v = p[k];
  return typeof v === 'boolean' ? v : d;
}
export function str(p: Params, k: string, d: string): string {
  const v = p[k];
  return typeof v === 'string' ? v : d;
}
