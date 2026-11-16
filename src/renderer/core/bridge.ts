/** Typed view of the restricted preload bridge (window.synapse). */
import type { AppInfo, DataFile, FsEntry, PtyCreated, ShellInfo } from '../../shared/ipc';
import type { Config, ConfigIssue } from '../../shared/settings';
import type { Theme } from '../../shared/theme';
import type { Workspace } from '../../shared/workspace';
import type { ExtensionManifest, Preset } from '../../shared/manifest';

export interface ConfigSnapshot {
  config: Config;
  issues: ConfigIssue[];
  bindings: Record<string, string>;
  bindingIssues: string[];
  paths: Record<string, string>;
  firstRun: boolean;
}
export interface ConfigChange { snapshot: ConfigSnapshot; changed: string[]; source: 'gui' | 'file' }
export type SetResult = { ok: true; changed: string[] } | { ok: false; issues: ConfigIssue[] };
export interface Listing<T> { errors: { file: string; error: string }[]; builtin?: string[]; user?: string[]; themes?: T[]; layouts?: T[]; presets?: T[] }
export interface ExtensionInfo {
  id: string; dir: string; manifest: ExtensionManifest | null; errors: string[]; warnings: string[]; enabled: boolean; approved: string[]; pending: string[];
  themeFiles: { name: string; text: string }[];
}

export interface SynapseBridge {
  app: {
    info(): Promise<AppInfo>;
    quit(): Promise<void>;
    relaunch(): Promise<void>;
    setFullscreen(on: boolean): Promise<void>;
    toggleFullscreen(): Promise<boolean>;
    devtools(): Promise<boolean>;
    metrics(): Promise<{ pid: number; type: string; cpu: number; memoryKB: number; name: string | null }[]>;
    gpuInfo(): Promise<{ status: Record<string, string>; info: unknown }>;
    openExternal(url: string): Promise<boolean>;
    openPath(which: string): Promise<string>;
    log(level: 'debug' | 'info' | 'warn' | 'error', msg: string): Promise<void>;
    onFullscreen(fn: (on: boolean) => void): () => void;
  };
  config: {
    get(): Promise<ConfigSnapshot>;
    set(patch: Record<string, unknown>): Promise<SetResult>;
    reset(keys: string[] | null): Promise<string[]>;
    themes(): Promise<{ themes: Theme[]; builtin: string[]; user: string[]; errors: { file: string; error: string }[] }>;
    saveTheme(t: Theme): Promise<{ ok: true; theme: Theme } | { ok: false; error: string }>;
    deleteTheme(id: string): Promise<boolean>;
    importTheme(): Promise<{ ok: true; theme: Theme } | { ok: false; error: string } | null>;
    exportTheme(id: string): Promise<string | null>;
    layouts(): Promise<{ layouts: Workspace[]; builtin: string[]; user: string[]; errors: { file: string; error: string }[] }>;
    saveLayout(ws: Workspace): Promise<{ ok: true; ws: Workspace } | { ok: false; error: string }>;
    deleteLayout(id: string): Promise<boolean>;
    presets(): Promise<{ presets: Preset[]; errors: { file: string; error: string }[] }>;
    savePreset(p: Preset): Promise<{ ok: true; preset: Preset } | { ok: false; error: string }>;
    deletePreset(id: string): Promise<boolean>;
    importPreset(): Promise<{ ok: true; preset: Preset } | { ok: false; error: string } | null>;
    exportPreset(p: Preset): Promise<string | null>;
    keybindings(): Promise<{ bindings: Record<string, string>; issues: string[] }>;
    saveKeybindings(b: Record<string, string>): Promise<{ ok: boolean; issues: string[] }>;
    exportAll(): Promise<string | null>;
    importAll(): Promise<{ ok: boolean; summary: string[]; errors: string[] } | null>;
    backups(): Promise<{ name: string; size: number; mtime: number }[]>;
    backupNow(): Promise<string | null>;
    restoreBackup(name: string): Promise<{ ok: boolean; error?: string }>;
    kbLayouts(): Promise<string[]>;
    kbLayout(id: string): Promise<unknown>;
    onChange(fn: (ev: ConfigChange) => void): () => void;
    onIssues(fn: (issues: ConfigIssue[]) => void): () => void;
  };
  pty: {
    shells(): Promise<ShellInfo[]>;
    create(req: { shell?: string; cwd?: string; cols: number; rows: number }): Promise<PtyCreated & { token: string }>;
    write(id: string, data: string): Promise<void>;
    reply(id: string, data: string): Promise<void>;
    resize(id: string, cols: number, rows: number): Promise<void>;
    kill(id: string): Promise<void>;
    attach(id: string): Promise<{ replay: string; shell: string; token: string }>;
    info(id: string): Promise<{ cwd: string | null; process: string | null; pid: number }>;
    list(): Promise<{ id: string; pid: number; shell: string }[]>;
    onData(fn: (id: string, data: string) => void): () => void;
    onExit(fn: (id: string, code: number, signal: number) => void): () => void;
  };
  monitor: {
    subscribe(topic: string, fn: (data: unknown) => void): () => void;
    staticInfo(): Promise<StaticInfo>;
    kill(pid: number, signal: string): Promise<{ ok: boolean; error?: string }>;
  };
  fs: {
    home(): Promise<string>;
    list(dir: string): Promise<{ dir: string; parent: string; entries: FsEntry[] }>;
    readText(file: string): Promise<{ binary: boolean; text: string; truncated: boolean; size: number }>;
  };
  dialog: {
    openData(kind: 'json' | 'csv' | 'audio' | 'xyz' | 'any-data'): Promise<DataFile | null>;
    chooseDir(title: string): Promise<string | null>;
  };
  capture: {
    save(name: string, kind: 'image' | 'video', data: Uint8Array): Promise<string>;
    beginSequence(name: string): Promise<{ id: string; dir: string }>;
    frame(id: string, index: number, data: Uint8Array): Promise<void>;
    endSequence(id: string, opts: { encode: 'none' | 'mp4' | 'webm'; fps: number; quality: number }): Promise<{ dir: string; frames: number; video: string | null; error?: string }>;
    ffmpeg(): Promise<string | null>;
  };
  ext: {
    list(): Promise<ExtensionInfo[]>;
    setEnabled(id: string, on: boolean): Promise<ExtensionInfo | null>;
    approve(id: string, perms: string[]): Promise<ExtensionInfo | null>;
    importDir(): Promise<{ ok: true; info: ExtensionInfo } | { ok: false; error: string } | null>;
    remove(id: string): Promise<boolean>;
  };
  audio: {
    allowCapture(kind: 'microphone' | 'system', allow: boolean): Promise<{ ok: boolean; error?: string }>;
  };
  platform: string;
}

export interface StaticInfo {
  os: { platform: string; distro: string; release: string; codename: string; kernel: string; arch: string; hostname: string } | null;
  cpu: { manufacturer: string; brand: string; cores: number; physicalCores: number; speed: number; speedMax: number; socket: string } | null;
  system: { manufacturer: string; model: string; version: string } | null;
  chassis: { type: string; manufacturer: string } | null;
  gpus: { model: string; vendor: string; vram: number | null }[];
  displays: { model: string; resolutionX: number; resolutionY: number; refresh: number; main: boolean }[];
  interfaces: string[];
  user: string;
  totalMem: number;
  sessionType: string | null;
  desktop: string | null;
}

declare global {
  interface Window { synapse: SynapseBridge }
}

export const bridge: SynapseBridge = window.synapse;
