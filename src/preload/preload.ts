/**
 * Restricted bridge between the sandboxed renderer and the main process.
 * Exposes named functions only — never ipcRenderer itself, never Node APIs.
 * Event listeners are multiplexed so each channel has one IPC listener.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { Events } from '../shared/events';
import type { InvokeChannel } from '../shared/ipc';

const invoke = (ch: InvokeChannel, ...args: unknown[]) => ipcRenderer.invoke(ch, ...args);

type Listener = (...args: unknown[]) => void;
const listeners = new Map<string, Set<Listener>>();
function on(channel: string, fn: Listener): () => void {
  let set = listeners.get(channel);
  if (!set) {
    set = new Set();
    listeners.set(channel, set);
    ipcRenderer.on(channel, (_e, ...args) => {
      for (const l of listeners.get(channel) ?? []) {
        try { l(...args); } catch (err) { console.error(err); }
      }
    });
  }
  set.add(fn);
  return () => set!.delete(fn);
}

// Monitor fan-out: one subscription to main per topic, many local listeners.
const monitorSubs = new Map<string, Set<Listener>>();
on(Events.monitorData, (topic, data) => {
  for (const l of monitorSubs.get(topic as string) ?? []) l(data);
});

const api = {
  app: {
    info: () => invoke('app:info'),
    quit: () => invoke('app:quit'),
    relaunch: () => invoke('app:relaunch'),
    setFullscreen: (on: boolean) => invoke('app:set-fullscreen', on),
    toggleFullscreen: () => invoke('app:toggle-fullscreen'),
    devtools: () => invoke('app:devtools'),
    metrics: () => invoke('app:metrics'),
    gpuInfo: () => invoke('app:gpu-info'),
    openExternal: (url: string) => invoke('app:open-external', url),
    openPath: (which: string) => invoke('app:open-path', which),
    log: (level: string, msg: string) => invoke('app:log', level, msg),
    onFullscreen: (fn: (on: boolean) => void) => on(Events.fullscreenChanged, fn as Listener),
    onNotify: (fn: (n: unknown) => void) => on(Events.notify, fn as Listener),
  },
  config: {
    get: () => invoke('config:get'),
    set: (patch: Record<string, unknown>) => invoke('config:set', patch),
    reset: (keys: string[] | null) => invoke('config:reset', keys),
    themes: () => invoke('config:themes'),
    saveTheme: (t: unknown) => invoke('config:save-theme', t),
    deleteTheme: (id: string) => invoke('config:delete-theme', id),
    importTheme: () => invoke('config:import-theme'),
    exportTheme: (id: string) => invoke('config:export-theme', id),
    layouts: () => invoke('config:layouts'),
    saveLayout: (ws: unknown) => invoke('config:save-layout', ws),
    deleteLayout: (id: string) => invoke('config:delete-layout', id),
    presets: () => invoke('config:presets'),
    savePreset: (p: unknown) => invoke('config:save-preset', p),
    deletePreset: (id: string) => invoke('config:delete-preset', id),
    importPreset: () => invoke('config:import-preset'),
    exportPreset: (p: unknown) => invoke('config:export-preset', p),
    keybindings: () => invoke('config:keybindings'),
    saveKeybindings: (b: Record<string, string>) => invoke('config:save-keybindings', b),
    exportAll: () => invoke('config:export'),
    importAll: () => invoke('config:import'),
    backups: () => invoke('config:backups'),
    backupNow: () => invoke('config:backup-now'),
    restoreBackup: (name: string) => invoke('config:restore-backup', name),
    kbLayouts: () => invoke('config:kb-layouts'),
    kbLayout: (id: string) => invoke('config:kb-layout', id),
    onChange: (fn: (ev: unknown) => void) => on(Events.configChanged, fn as Listener),
    onIssues: (fn: (issues: unknown) => void) => on(Events.configIssues, fn as Listener),
  },
  pty: {
    shells: () => invoke('pty:shells'),
    create: (req: { shell?: string; cwd?: string; cols: number; rows: number }) => invoke('pty:create', req),
    write: (id: string, data: string) => invoke('pty:write', id, data),
    reply: (id: string, data: string) => invoke('pty:reply', id, data),
    resize: (id: string, cols: number, rows: number) => invoke('pty:resize', id, cols, rows),
    kill: (id: string) => invoke('pty:kill', id),
    attach: (id: string) => invoke('pty:attach', id),
    info: (id: string) => invoke('pty:info', id),
    list: () => invoke('pty:list'),
    onData: (fn: (id: string, data: string) => void) => on(Events.ptyData, fn as Listener),
    onExit: (fn: (id: string, code: number, signal: number) => void) => on(Events.ptyExit, fn as Listener),
  },
  monitor: {
    subscribe: (topic: string, fn: (data: unknown) => void): (() => void) => {
      let set = monitorSubs.get(topic);
      if (!set) {
        set = new Set();
        monitorSubs.set(topic, set);
      }
      set.add(fn as Listener);
      if (set.size === 1) void invoke('monitor:subscribe', topic);
      return () => {
        const s = monitorSubs.get(topic);
        if (!s?.delete(fn as Listener)) return;
        if (s.size === 0) void invoke('monitor:unsubscribe', topic);
      };
    },
    staticInfo: () => invoke('monitor:static'),
    kill: (pid: number, signal: string) => invoke('monitor:kill', pid, signal),
  },
  fs: {
    home: () => invoke('fs:home'),
    list: (dir: string) => invoke('fs:list', dir),
    readText: (file: string) => invoke('fs:read-text', file),
  },
  dialog: {
    openData: (kind: string) => invoke('dialog:open-data', kind),
    chooseDir: (title: string) => invoke('dialog:choose-dir', title),
  },
  capture: {
    save: (name: string, kind: 'image' | 'video', data: Uint8Array) => invoke('capture:save', { name, kind, data }),
    beginSequence: (name: string) => invoke('capture:begin-sequence', { name }),
    frame: (id: string, index: number, data: Uint8Array) => invoke('capture:frame', id, index, data),
    endSequence: (id: string, opts: { encode: string; fps: number; quality: number }) => invoke('capture:end-sequence', id, opts),
    ffmpeg: () => invoke('capture:ffmpeg'),
  },
  ext: {
    list: () => invoke('ext:list'),
    setEnabled: (id: string, on: boolean) => invoke('ext:set-enabled', id, on),
    approve: (id: string, perms: string[]) => invoke('ext:approve', id, perms),
    importDir: () => invoke('ext:import'),
    remove: (id: string) => invoke('ext:remove', id),
  },
  audio: {
    allowCapture: (kind: 'microphone' | 'system', allow: boolean) => invoke('audio:allow-capture', kind, allow),
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld('synapse', api);
export type SynapseBridge = typeof api;
