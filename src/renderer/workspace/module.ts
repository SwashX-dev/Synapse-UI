/**
 * Module API. Every interface component — terminals, monitors, visualizations,
 * third-party panels — is a module with a manifest and a common lifecycle:
 *
 *   constructor (initialize) → mount() → update()/resize()/pause()/resume()
 *   → serialize()/restore() across workspace switches → dispose(reason)
 */
import type { App } from '../core/app';
import type { ModuleCategory, ParamSpec } from '../../shared/manifest';
import type { ModuleInstance } from '../../shared/workspace';
import type { Theme } from '../../shared/theme';

export interface ModuleManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  category: ModuleCategory;
  /** Capabilities the module uses (shown in the module manager). */
  permissions: string[];
  /** Rendering requirement. */
  rendering: 'dom' | 'canvas2d' | 'webgl2' | 'iframe';
  defaultSize: { colSpan: number; rowSpan: number; w: number; h: number };
  configSchema: ParamSpec[];
  /** Displays genuine measurements (LIVE badge) rather than simulation. */
  liveData?: boolean;
  icon?: string;
  builtin?: boolean;
}

export type DisposeReason = 'remove' | 'switch' | 'reload' | 'shutdown';

export interface ModuleContext {
  readonly app: App;
  readonly id: string;
  readonly type: string;
  readonly frame: HTMLElement;
  readonly body: HTMLElement;
  instance(): ModuleInstance;
  /** Read a config value, falling back to the manifest schema default. */
  config<T = unknown>(key: string, fallback?: T): T;
  /** Persist config changes into the workspace (debounced save). */
  updateConfig(patch: Record<string, unknown>): void;
  setTitle(title: string): void;
  setStatus(text: string): void;
  setBadge(kind: 'live' | 'sim' | 'off' | null, text?: string): void;
  theme(): Theme;
  /** Whether the module is currently visible (workspace active, not hidden/occluded). */
  visible(): boolean;
  focus(): void;
  onDispose(fn: () => void): void;
}

export abstract class SynModule {
  constructor(protected readonly ctx: ModuleContext) {}
  abstract mount(): void | Promise<void>;
  /** Instance configuration changed (keys of instance.config). */
  update(_changed: string[]): void {}
  resize(_w: number, _h: number): void {}
  pause(): void {}
  resume(): void {}
  onTheme(_t: Theme): void {}
  /** Global application settings changed. */
  onConfig(_changed: string[]): void {}
  /** Runtime state carried across workspace switches (not written to disk). */
  serialize(): Record<string, unknown> | undefined {
    return undefined;
  }
  restore(_state: Record<string, unknown>): void {}
  focus(): void {}
  dispose(_reason: DisposeReason): void {}
}

export interface ModuleType {
  manifest: ModuleManifest;
  create(ctx: ModuleContext): SynModule;
}

const types = new Map<string, ModuleType>();

export function registerModuleType(t: ModuleType): void {
  types.set(t.manifest.id, { ...t, manifest: { builtin: true, ...t.manifest } });
}

export function moduleType(id: string): ModuleType | undefined {
  return types.get(id);
}

export function moduleTypes(): ModuleType[] {
  return [...types.values()];
}

export function unregisterModuleType(id: string): void {
  types.delete(id);
}
