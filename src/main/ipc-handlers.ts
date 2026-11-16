/**
 * IPC handlers. Each request is (1) checked to come from the trusted app
 * frame, (2) validated against its zod schema in shared/ipc.ts, then handled.
 */
import { app, BrowserWindow, dialog, ipcMain, shell, systemPreferences, type IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { Invoke, type AppInfo, type FsEntry, type InvokeChannel } from '../shared/ipc';
import { ThemeFileSchema, convertLegacyEdexTheme, materializeTheme, themeToFile } from '../shared/theme';
import { PresetSchema } from '../shared/manifest';
import type { ConfigService } from './config-service';
import { themeToToml } from './config-service';
import type { PtyManager, Sink } from './pty-manager';
import type { MonitorHub } from './monitor-hub';
import type { ExtensionRegistry } from './extensions';
import type { CaptureService } from './capture';
import { detectShells } from './shells';
import { captureAllowed, isTrustedSender, senderDiagnostics } from './security';
import { logger } from './log';

const log = logger('ipc');
const rlog = logger('renderer');

export interface IpcDeps {
  window: () => BrowserWindow | null;
  config: ConfigService;
  pty: PtyManager;
  monitor: MonitorHub;
  extensions: ExtensionRegistry;
  capture: CaptureService;
  rendererRoot: string;
  binDir: string | null;
  info: () => AppInfo;
}

type ReturnTypeArgs<C extends InvokeChannel> = ReturnType<(typeof Invoke)[C]['parse']>;

function handle<C extends InvokeChannel>(channel: C, fn: (event: IpcMainInvokeEvent, ...args: ReturnTypeArgs<C>) => unknown): void {
  ipcMain.handle(channel, async (event, ...raw: unknown[]) => {
    if (!isTrustedSender(event)) {
      log.warn(`rejected ${channel} from untrusted sender (${senderDiagnostics(event)})`);
      throw new Error('untrusted sender');
    }
    const parsed = Invoke[channel].safeParse(raw);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).slice(0, 3).join('; ');
      log.warn(`rejected ${channel}: invalid arguments (${msg})`);
      throw new Error(`invalid arguments for ${channel}: ${msg}`);
    }
    return fn(event, ...(parsed.data as ReturnTypeArgs<C>));
  });
}

function sinkOf(event: IpcMainInvokeEvent): Sink {
  const wc = event.sender;
  return { id: wc.id, send: (ch, ...args) => wc.send(ch, ...args), isDestroyed: () => wc.isDestroyed() };
}

const DATA_FILTERS: Record<string, Electron.FileFilter[]> = {
  json: [{ name: 'JSON', extensions: ['json'] }],
  csv: [{ name: 'CSV / TSV', extensions: ['csv', 'tsv', 'txt'] }],
  audio: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'webm'] }],
  xyz: [{ name: 'Molecule (XYZ)', extensions: ['xyz'] }],
  'any-data': [{ name: 'Data', extensions: ['json', 'csv', 'tsv', 'txt'] }],
};
const DATA_LIMITS: Record<string, number> = { json: 64 << 20, csv: 64 << 20, audio: 256 << 20, xyz: 8 << 20, 'any-data': 64 << 20 };

export function registerIpc(d: IpcDeps): void {
  const win = () => d.window();
  const owner = (e: IpcMainInvokeEvent) => sinkOf(e);

  // ───────── app ─────────
  handle('app:info', () => d.info());
  handle('app:quit', () => app.quit());
  handle('app:relaunch', () => { app.relaunch(); app.quit(); });
  handle('app:set-fullscreen', (_e, on) => win()?.setFullScreen(on));
  handle('app:toggle-fullscreen', () => { const w = win(); if (w) w.setFullScreen(!w.isFullScreen()); return w?.isFullScreen() ?? false; });
  handle('app:devtools', () => {
    if (!d.config.get<boolean>('security.devtools') && !d.info().dev) return false;
    win()?.webContents.toggleDevTools();
    return true;
  });
  handle('app:metrics', () =>
    app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, cpu: Math.round(m.cpu.percentCPUUsage * 10) / 10, memoryKB: m.memory.workingSetSize, name: m.name ?? null })),
  );
  handle('app:gpu-info', async () => ({ status: app.getGPUFeatureStatus(), info: await app.getGPUInfo('basic').catch(() => null) }));
  handle('app:open-external', async (_e, url) => {
    if (!/^https?:\/\//i.test(url)) return false;
    if (d.config.get('security.external_links') === 'deny') return false;
    await shell.openExternal(url);
    return true;
  });
  handle('app:open-path', async (_e, which) => {
    const p = d.config.paths;
    const map = { config: p.config, themes: p.themes, layouts: p.layouts, modules: p.modules, presets: p.presets, backups: p.backups, recordings: recordingDirs(d.config).videos };
    fs.mkdirSync(map[which], { recursive: true });
    return shell.openPath(map[which]);
  });
  handle('app:log', (_e, level, msg) => rlog[level](msg));

  // ───────── config ─────────
  handle('config:get', () => d.config.snapshot());
  handle('config:set', (_e, patch) => d.config.set(patch));
  handle('config:reset', (_e, keys) => d.config.reset(keys));
  handle('config:themes', () => d.config.listThemes());
  handle('config:save-theme', (_e, theme) => d.config.saveTheme(theme));
  handle('config:delete-theme', (_e, id) => d.config.deleteTheme(id));
  handle('config:layouts', () => d.config.listLayouts());
  handle('config:save-layout', (_e, ws) => d.config.saveLayout(ws));
  handle('config:delete-layout', (_e, id) => d.config.deleteLayout(id));
  handle('config:presets', () => d.config.listPresets());
  handle('config:save-preset', (_e, p) => d.config.savePreset(p));
  handle('config:delete-preset', (_e, id) => d.config.deletePreset(id));
  handle('config:keybindings', () => ({ bindings: d.config.bindings, issues: d.config.bindingIssues }));
  handle('config:save-keybindings', (_e, b) => d.config.saveKeybindings(b));
  handle('config:backups', () => d.config.listBackups());
  handle('config:backup-now', () => d.config.backup('manual'));
  handle('config:restore-backup', (_e, name) => d.config.restoreBackup(name));
  handle('config:export', async () => {
    const w = win();
    if (!w) return null;
    const r = await dialog.showSaveDialog(w, { title: 'Export SYNAPSE-UI configuration', defaultPath: path.join(os.homedir(), `synapse-ui-config-${new Date().toISOString().slice(0, 10)}.json`), filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, JSON.stringify(d.config.exportBundle(), null, 2));
    return r.filePath;
  });
  handle('config:import', async () => {
    const w = win();
    if (!w) return null;
    const r = await dialog.showOpenDialog(w, { title: 'Import SYNAPSE-UI configuration', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    const st = fs.statSync(r.filePaths[0]);
    if (st.size > 16 << 20) return { ok: false, summary: [], errors: ['file larger than 16 MiB'] };
    try {
      return d.config.importBundle(JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')));
    } catch (e) {
      return { ok: false, summary: [], errors: [(e as Error).message] };
    }
  });
  handle('config:import-theme', async () => {
    const w = win();
    if (!w) return null;
    const r = await dialog.showOpenDialog(w, { title: 'Import theme', properties: ['openFile'], filters: [{ name: 'Themes', extensions: ['toml', 'json'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    const file = r.filePaths[0];
    if (fs.statSync(file).size > 1 << 20) return { ok: false, error: 'theme file larger than 1 MiB' };
    try {
      const text = fs.readFileSync(file, 'utf8');
      const base = path.basename(file).replace(/\.(toml|json)$/i, '').toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/^[^a-z0-9]+/, '') || 'imported';
      const all = d.config.listThemes().themes;
      let theme;
      if (file.toLowerCase().endsWith('.json')) {
        const raw = JSON.parse(text);
        // Original eDEX-UI theme JSON, or a SYNAPSE theme in JSON form.
        theme = raw && typeof raw === 'object' && 'colors' in raw && typeof raw.colors?.r === 'number' ? convertLegacyEdexTheme(`edex-${base}`.slice(0, 64), `eDEX: ${base}`, raw) : materializeTheme(ThemeFileSchema.parse(raw), (id) => all.find((t) => t.id === id));
      } else {
        theme = materializeTheme(ThemeFileSchema.parse(parseToml(text)), (id) => all.find((t) => t.id === id));
      }
      return d.config.saveTheme(theme);
    } catch (e) {
      return { ok: false, error: (e as Error).message.slice(0, 500) };
    }
  });
  handle('config:export-theme', async (_e, id) => {
    const w = win();
    const theme = d.config.listThemes().themes.find((t) => t.id === id);
    if (!w || !theme) return null;
    const r = await dialog.showSaveDialog(w, { title: `Export theme "${theme.name}"`, defaultPath: path.join(os.homedir(), `${theme.id}.toml`), filters: [{ name: 'TOML', extensions: ['toml'] }] });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, themeToToml(theme));
    void themeToFile;
    return r.filePath;
  });
  handle('config:import-preset', async () => {
    const w = win();
    if (!w) return null;
    const r = await dialog.showOpenDialog(w, { title: 'Import animation preset', properties: ['openFile'], filters: [{ name: 'Preset', extensions: ['json'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    try {
      if (fs.statSync(r.filePaths[0]).size > 1 << 20) return { ok: false, error: 'preset larger than 1 MiB' };
      return d.config.savePreset(JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')));
    } catch (e) {
      return { ok: false, error: (e as Error).message.slice(0, 500) };
    }
  });
  handle('config:export-preset', async (_e, preset) => {
    const w = win();
    const p = PresetSchema.safeParse(preset);
    if (!w || !p.success) return null;
    const r = await dialog.showSaveDialog(w, { title: `Export preset "${p.data.name}"`, defaultPath: path.join(os.homedir(), `${p.data.id}.json`), filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, JSON.stringify({ ...p.data, builtin: undefined }, null, 2));
    return r.filePath;
  });
  const kbDir = path.join(d.rendererRoot, 'assets', 'kb_layouts');
  handle('config:kb-layouts', () => {
    try { return fs.readdirSync(kbDir).filter((f) => f.endsWith('.json') && f !== 'index.json').map((f) => f.slice(0, -5)).sort(); } catch { return []; }
  });
  handle('config:kb-layout', (_e, id) => {
    try { return JSON.parse(fs.readFileSync(path.join(kbDir, `${id}.json`), 'utf8')); } catch { return null; }
  });

  // ───────── terminal ─────────
  handle('pty:shells', () => detectShells());
  handle('pty:create', (e, req) => {
    const c = d.config;
    const sessionsBefore = d.pty.size;
    const created = d.pty.create(owner(e), req, {
      shell: c.get<string>('terminal.default_shell'),
      args: c.get<string[]>('terminal.shell_args'),
      login: c.get<boolean>('terminal.login_shell'),
      cwd: c.get<string>('terminal.cwd'),
      env: c.get<Record<string, string>>('terminal.env'),
      appCommands: c.get<boolean>('terminal.app_commands'),
      binDir: d.binDir,
      scrollbackBytes: Math.min(4 << 20, Math.max(64 << 10, c.get<number>('terminal.scrollback') * 200)),
    });
    log.debug(`pty sessions: ${sessionsBefore} → ${d.pty.size}`);
    return created;
  });
  handle('pty:write', (e, id, data) => d.pty.write(owner(e), id, data));
  handle('pty:reply', (e, id, data) => d.pty.write(owner(e), id, data));
  handle('pty:resize', (e, id, cols, rows) => d.pty.resize(owner(e), id, cols, rows));
  handle('pty:kill', (e, id) => d.pty.kill(owner(e), id));
  handle('pty:attach', (e, id) => d.pty.attach(owner(e), id));
  handle('pty:info', (e, id) => d.pty.info(owner(e), id));
  handle('pty:list', (e) => d.pty.list(owner(e)));

  // ───────── monitoring ─────────
  handle('monitor:subscribe', (e, topic) => d.monitor.subscribe(owner(e), topic));
  handle('monitor:unsubscribe', (e, topic) => d.monitor.unsubscribe(owner(e), topic));
  handle('monitor:static', () => d.monitor.getStatic());
  handle('monitor:kill', (_e, pid, signal) => {
    if (pid === process.pid || app.getAppMetrics().some((m) => m.pid === pid)) return { ok: false, error: 'refusing to signal a SYNAPSE-UI process' };
    try {
      process.kill(pid, signal);
      log.info(`sent ${signal} to pid ${pid} (user confirmed)`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // ───────── filesystem (read-only) ─────────
  handle('fs:home', () => os.homedir());
  handle('fs:list', (_e, dir) => {
    if (!path.isAbsolute(dir)) throw new Error('path must be absolute');
    const entries: FsEntry[] = [];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).slice(0, 5000)) {
      const full = path.join(dir, ent.name);
      let size = 0, mtime = 0;
      let type: FsEntry['type'] = ent.isDirectory() ? 'dir' : ent.isFile() ? 'file' : ent.isSymbolicLink() ? 'symlink' : 'other';
      try {
        const st = fs.statSync(full);
        size = st.size;
        mtime = st.mtimeMs;
        if (type === 'symlink' && st.isDirectory()) type = 'dir';
      } catch { /* broken link / no permission */ }
      entries.push({ name: ent.name, path: full, type, size, mtime, hidden: ent.name.startsWith('.') });
    }
    return { dir: path.resolve(dir), parent: path.dirname(path.resolve(dir)), entries };
  });
  handle('fs:read-text', (_e, file) => {
    if (!path.isAbsolute(file)) throw new Error('path must be absolute');
    const st = fs.statSync(file);
    if (!st.isFile()) throw new Error('not a file');
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(st.size, 512 * 1024));
      fs.readSync(fd, buf, 0, buf.length, 0);
      if (buf.includes(0)) return { binary: true, text: '', truncated: false, size: st.size };
      return { binary: false, text: buf.toString('utf8'), truncated: st.size > buf.length, size: st.size };
    } finally {
      fs.closeSync(fd);
    }
  });

  // ───────── dialogs / data ─────────
  handle('dialog:open-data', async (_e, kind) => {
    const w = win();
    if (!w) return null;
    const r = await dialog.showOpenDialog(w, { title: 'Open data file', properties: ['openFile'], filters: DATA_FILTERS[kind] });
    if (r.canceled || !r.filePaths[0]) return null;
    const file = r.filePaths[0];
    const st = fs.statSync(file);
    if (st.size > DATA_LIMITS[kind]) throw new Error(`file is larger than ${DATA_LIMITS[kind] >> 20} MiB`);
    return { name: path.basename(file), path: file, kind, size: st.size, data: new Uint8Array(fs.readFileSync(file)) };
  });
  handle('dialog:choose-dir', async (_e, title) => {
    const w = win();
    if (!w) return null;
    const r = await dialog.showOpenDialog(w, { title: title || 'Choose folder', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0] ?? null;
  });

  // ───────── capture ─────────
  handle('capture:save', (_e, req) => d.capture.save(req.name, req.kind, req.data));
  handle('capture:begin-sequence', (_e, req) => d.capture.beginSequence(req.name));
  handle('capture:frame', (_e, id, index, data) => d.capture.frame(id, index, data));
  handle('capture:end-sequence', (_e, id, opts) => d.capture.endSequence(id, opts));
  handle('capture:ffmpeg', () => d.capture.ffmpegPath());

  // ───────── extensions ─────────
  handle('ext:list', () => d.extensions.list().map(({ dir, ...rest }) => ({ ...rest, dir })));
  handle('ext:set-enabled', (_e, id, on) => d.extensions.setEnabled(id, on));
  handle('ext:approve', (_e, id, perms) => d.extensions.approve(id, perms));
  handle('ext:remove', (_e, id) => d.extensions.remove(id));
  handle('ext:import', async () => {
    const w = win();
    if (!w) return null;
    const r = await dialog.showOpenDialog(w, { title: 'Import SYNAPSE-UI module folder', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    try {
      return { ok: true, info: d.extensions.importFrom(r.filePaths[0]) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  // ───────── audio capture permission (explicit, per session) ─────────
  handle('audio:allow-capture', async (_e, kind, allow) => {
    if (kind === 'microphone') {
      if (allow && process.platform === 'darwin') {
        const granted = await systemPreferences.askForMediaAccess('microphone');
        if (!granted) return { ok: false, error: 'macOS denied microphone access (System Settings → Privacy & Security → Microphone)' };
      }
      captureAllowed.microphone = allow;
      return { ok: true };
    }
    if (allow && process.platform === 'linux') {
      return { ok: false, error: 'Electron cannot capture system audio directly on Linux. Choose a PipeWire/PulseAudio "Monitor of …" input device with the microphone source instead.' };
    }
    captureAllowed.system = allow;
    return { ok: true };
  });
}

export function recordingDirs(config: ConfigService): { images: string; videos: string } {
  const custom = config.get<string>('recording.output_dir');
  if (custom && path.isAbsolute(custom)) return { images: custom, videos: custom };
  let videos: string, pictures: string;
  try { videos = app.getPath('videos'); } catch { videos = path.join(os.homedir(), 'Videos'); }
  try { pictures = app.getPath('pictures'); } catch { pictures = path.join(os.homedir(), 'Pictures'); }
  return { images: path.join(pictures, 'SYNAPSE-UI'), videos: path.join(videos, 'SYNAPSE-UI') };
}
