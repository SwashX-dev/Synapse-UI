/**
 * The complete renderer ↔ main IPC contract. Every request channel has a zod
 * schema for its argument tuple; the main process rejects anything that does
 * not validate, and rejects senders other than the app's own top-level frame.
 *
 * There is NO WebSocket or other network listener for terminal control
 * (the class of bug behind CVE-2023-30856 / GHSA-q8xc-f2wf-ffh9).
 */
import { z } from 'zod';

export const MONITOR_TOPICS = ['cpu', 'cpu.speed', 'cpu.temp', 'mem', 'net', 'net.connections', 'storage', 'disk.io', 'processes', 'gpu', 'battery', 'system'] as const;
export type MonitorTopic = (typeof MONITOR_TOPICS)[number];

const sessionId = z.string().regex(/^pty-[a-z0-9]{6,40}$/);
const shortStr = (n = 4096) => z.string().max(n);
const absPathish = z.string().min(1).max(4096).refine((s) => !s.includes('\u0000'), 'NUL in path');

export const Invoke = {
  // app
  'app:info': z.tuple([]),
  'app:quit': z.tuple([]),
  'app:relaunch': z.tuple([]),
  'app:set-fullscreen': z.tuple([z.boolean()]),
  'app:toggle-fullscreen': z.tuple([]),
  'app:devtools': z.tuple([]),
  'app:metrics': z.tuple([]),
  'app:gpu-info': z.tuple([]),
  'app:open-external': z.tuple([z.string().url().max(2048)]),
  'app:open-path': z.tuple([z.enum(['config', 'themes', 'layouts', 'modules', 'presets', 'backups', 'recordings'])]),
  'app:log': z.tuple([z.enum(['debug', 'info', 'warn', 'error']), shortStr(8192)]),

  // config
  'config:get': z.tuple([]),
  'config:set': z.tuple([z.record(z.string().max(128), z.unknown())]),
  'config:reset': z.tuple([z.array(z.string().max(128)).max(256).nullable()]),
  'config:themes': z.tuple([]),
  'config:save-theme': z.tuple([z.record(z.string(), z.unknown())]),
  'config:delete-theme': z.tuple([z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)]),
  'config:layouts': z.tuple([]),
  'config:save-layout': z.tuple([z.record(z.string(), z.unknown())]),
  'config:delete-layout': z.tuple([z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)]),
  'config:presets': z.tuple([]),
  'config:save-preset': z.tuple([z.record(z.string(), z.unknown())]),
  'config:delete-preset': z.tuple([z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)]),
  'config:keybindings': z.tuple([]),
  'config:save-keybindings': z.tuple([z.record(z.string().max(64), z.string().max(64))]),
  'config:export': z.tuple([]),
  'config:import': z.tuple([]),
  'config:backups': z.tuple([]),
  'config:backup-now': z.tuple([]),
  'config:restore-backup': z.tuple([z.string().regex(/^[0-9TZ:._-]{6,64}$/)]),
  'config:import-theme': z.tuple([]),
  'config:export-theme': z.tuple([z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)]),
  'config:import-preset': z.tuple([]),
  'config:export-preset': z.tuple([z.record(z.string(), z.unknown())]),
  'config:kb-layout': z.tuple([z.string().regex(/^[A-Za-z]{2}-[A-Za-z0-9-]{1,16}$/)]),
  'config:kb-layouts': z.tuple([]),

  // terminal
  'pty:shells': z.tuple([]),
  'pty:create': z.tuple([z.object({ shell: shortStr(1024).optional(), cwd: shortStr().optional(), cols: z.number().int().min(2).max(1000), rows: z.number().int().min(1).max(500) })]),
  'pty:write': z.tuple([sessionId, z.string().max(1 << 20)]),
  'pty:resize': z.tuple([sessionId, z.number().int().min(2).max(1000), z.number().int().min(1).max(500)]),
  'pty:kill': z.tuple([sessionId]),
  'pty:attach': z.tuple([sessionId]),
  'pty:info': z.tuple([sessionId]),
  'pty:list': z.tuple([]),
  'pty:reply': z.tuple([sessionId, z.string().max(1 << 16)]),

  // monitoring
  'monitor:subscribe': z.tuple([z.enum(MONITOR_TOPICS)]),
  'monitor:unsubscribe': z.tuple([z.enum(MONITOR_TOPICS)]),
  'monitor:static': z.tuple([]),
  'monitor:kill': z.tuple([z.number().int().min(2).max(2 ** 31), z.enum(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP'])]),

  // filesystem (read-only browsing)
  'fs:list': z.tuple([absPathish]),
  'fs:read-text': z.tuple([absPathish]),
  'fs:home': z.tuple([]),

  // dialogs & data files
  'dialog:open-data': z.tuple([z.enum(['json', 'csv', 'audio', 'xyz', 'any-data'])]),
  'dialog:choose-dir': z.tuple([z.string().max(256)]),

  // recording / capture
  'capture:save': z.tuple([z.object({ name: z.string().regex(/^[A-Za-z0-9._ -]{1,128}$/), kind: z.enum(['image', 'video']), data: z.instanceof(Uint8Array) })]),
  'capture:begin-sequence': z.tuple([z.object({ name: z.string().regex(/^[A-Za-z0-9._ -]{1,96}$/) })]),
  'capture:frame': z.tuple([z.string().regex(/^seq-[a-z0-9]{6,32}$/), z.number().int().min(0).max(1e6), z.instanceof(Uint8Array)]),
  'capture:end-sequence': z.tuple([z.string().regex(/^seq-[a-z0-9]{6,32}$/), z.object({ encode: z.enum(['none', 'mp4', 'webm']), fps: z.number().int().min(1).max(120), quality: z.number().min(0.1).max(1) })]),
  'capture:ffmpeg': z.tuple([]),

  // extensions
  'ext:list': z.tuple([]),
  'ext:set-enabled': z.tuple([z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/), z.boolean()]),
  'ext:approve': z.tuple([z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/), z.array(z.string().max(64)).max(16)]),
  'ext:import': z.tuple([]),
  'ext:remove': z.tuple([z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/)]),

  // audio
  'audio:allow-capture': z.tuple([z.enum(['microphone', 'system']), z.boolean()]),
} as const;

export type InvokeChannel = keyof typeof Invoke;

export { Events } from './events';

export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  v8: string;
  platform: string;
  arch: string;
  osRelease: string;
  sessionType: string;
  desktop: string;
  dev: boolean;
  configDir: string;
  gpuAccel: boolean;
  firstRun: boolean;
  legacyImported: string | null;
}

export interface ShellInfo { id: string; name: string; path: string; default: boolean }
export interface PtyCreated { id: string; pid: number; shell: string; cwd: string }
export interface FsEntry { name: string; path: string; type: 'file' | 'dir' | 'symlink' | 'other'; size: number; mtime: number; hidden: boolean }
export interface DataFile { name: string; path: string; kind: string; size: number; data: Uint8Array }

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
