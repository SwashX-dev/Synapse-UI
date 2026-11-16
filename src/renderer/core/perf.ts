/**
 * Performance profiles and adaptive quality. The effective profile can come
 * from config, a workspace override, or battery saver; reduced-motion halves
 * simulation speed and disables UI motion.
 */
import type { App } from './app';
import type { BatteryLike } from './perf-types';
import { Emitter } from './util';

export type Profile = 'eco' | 'balanced' | 'high' | 'cinematic' | 'adaptive';
export type Quality = 0 | 1 | 2 | 3;
export const QUALITY_NAMES = ['low', 'medium', 'high', 'ultra'] as const;

export interface ProfileSpec { fps: number; quality: Quality; pixelRatio: number; bloom: boolean; msaa: boolean }

export const PROFILES: Record<Exclude<Profile, 'adaptive'>, ProfileSpec> = {
  eco: { fps: 30, quality: 0, pixelRatio: 0.6, bloom: false, msaa: false },
  balanced: { fps: 60, quality: 1, pixelRatio: 0.85, bloom: true, msaa: false },
  high: { fps: 120, quality: 2, pixelRatio: 1, bloom: true, msaa: true },
  cinematic: { fps: 144, quality: 3, pixelRatio: 1.25, bloom: true, msaa: true },
};

export class PerformanceManager {
  readonly events = new Emitter<{ change: [] }>();
  onBattery = false;
  reducedMotion = false;
  /** Adaptive state */
  adaptiveQuality: Quality = 2;
  dynamicScale = 1;
  private slowFrames = 0;
  private fastFrames = 0;
  private frameEma = 16.7;

  constructor(private app: App) {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => this.updateReducedMotion(mq.matches);
    mq.addEventListener('change', apply);
    apply();
    app.events.on('config', (changed) => {
      if (changed.some((k) => k.startsWith('performance.') || k.startsWith('graphics.') || k.startsWith('visualization.') || k === 'interface.reduced_motion')) {
        apply();
        this.events.emit('change');
      }
    });
  }

  private updateReducedMotion(systemPrefers: boolean): void {
    const pref = this.app.get<string>('interface.reduced_motion');
    this.reducedMotion = pref === 'on' || (pref === 'system' && systemPrefers);
    document.body.classList.toggle('reduce-motion', this.reducedMotion);
  }

  setBattery(b: BatteryLike | null): void {
    const was = this.onBattery;
    this.onBattery = !!b && b.hasBattery && !b.acConnected && !b.isCharging;
    if (was !== this.onBattery) this.events.emit('change');
  }

  get profile(): Profile {
    if (this.onBattery && this.app.get<boolean>('performance.battery_saver')) return 'eco';
    const ws = this.app.workspace?.current?.performance;
    return (ws ?? this.app.get<Profile>('performance.mode')) as Profile;
  }

  get spec(): ProfileSpec {
    const p = this.profile;
    if (p === 'adaptive') return { fps: 144, quality: this.adaptiveQuality, pixelRatio: 1, bloom: true, msaa: true };
    return PROFILES[p];
  }

  get targetFps(): number {
    return Math.min(this.app.get<number>('performance.target_fps'), this.spec.fps);
  }

  get quality(): Quality {
    const q = this.app.get<string>('visualization.quality');
    if (q !== 'auto') return QUALITY_NAMES.indexOf(q as (typeof QUALITY_NAMES)[number]) as Quality;
    return this.spec.quality;
  }

  /** Effective render scale: config × profile × adaptive dynamic scale. */
  get renderScale(): number {
    return this.app.get<number>('graphics.resolution_scale') * this.spec.pixelRatio * this.dynamicScale;
  }

  get timeScale(): number {
    return this.app.get<number>('visualization.time_scale') * (this.reducedMotion ? 0.5 : 1);
  }

  /**
   * Feed measured frame intervals (ms). Adjusts the dynamic resolution scale
   * (any profile, if adaptive_quality is on) and the quality tier (adaptive profile).
   */
  reportFrame(intervalMs: number, workMs: number): void {
    this.frameEma = this.frameEma * 0.95 + intervalMs * 0.05;
    const budget = 1000 / this.targetFps;
    const load = Math.max(this.frameEma, workMs);
    if (load > budget * 1.2) { this.slowFrames++; this.fastFrames = 0; }
    else if (load < budget * 0.7) { this.fastFrames++; this.slowFrames = 0; }
    else { this.slowFrames = Math.max(0, this.slowFrames - 1); this.fastFrames = Math.max(0, this.fastFrames - 1); }
    let changed = false;
    if (this.slowFrames > 45) {
      this.slowFrames = 0;
      if (this.app.get<boolean>('performance.adaptive_quality') && this.dynamicScale > 0.5) { this.dynamicScale = Math.max(0.5, this.dynamicScale - 0.1); changed = true; }
      else if (this.profile === 'adaptive' && this.adaptiveQuality > 0) { this.adaptiveQuality = (this.adaptiveQuality - 1) as Quality; this.dynamicScale = 1; changed = true; }
    } else if (this.fastFrames > 180) {
      this.fastFrames = 0;
      if (this.dynamicScale < 1) { this.dynamicScale = Math.min(1, this.dynamicScale + 0.1); changed = true; }
      else if (this.profile === 'adaptive' && this.adaptiveQuality < 3) { this.adaptiveQuality = (this.adaptiveQuality + 1) as Quality; changed = true; }
    }
    if (changed) this.events.emit('change');
  }

  get averageFrameMs(): number {
    return this.frameEma;
  }
}
