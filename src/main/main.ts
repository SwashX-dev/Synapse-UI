/**
 * SYNAPSE-UI main process — composition root.
 * Fork of eDEX-UI (GPL-3.0); see README for attribution.
 */
import { app, BrowserWindow, Menu, nativeImage, screen } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigService } from './config-service';
import { legacyEdexSettingsPath, resolvePaths } from './paths';
import { PtyManager } from './pty-manager';
import { MonitorHub } from './monitor-hub';
import { ExtensionRegistry } from './extensions';
import { CaptureService } from './capture';
import { registerIpc, recordingDirs } from './ipc-handlers';
import { APP_URL, installAppProtocol, registerAppScheme } from './protocol';
import { hardenApp, hardenSession, setTrustedContents } from './security';
import { logger, openLogFile, setLogLevel, type LogLevel } from './log';
import { Events, type AppInfo } from '../shared/ipc';

const log = logger('main');
const DEV = process.argv.includes('--dev') || process.env.SYNAPSE_DEV === '1';

// ───────── before ready: scheme, paths, config, Chromium flags ─────────
registerAppScheme();
app.setName('SYNAPSE-UI');
const paths = resolvePaths();
fs.mkdirSync(paths.state, { recursive: true });
app.setPath('userData', paths.state);
const logFile = openLogFile(paths.logs);

const config = new ConfigService(paths, process.env.SYNAPSE_CONFIG_DIR ? undefined : legacyEdexSettingsPath());
try {
  config.init();
} catch (e) {
  log.error('configuration init failed; continuing with defaults', e);
}
setLogLevel(DEV ? 'debug' : config.get<LogLevel>('advanced.log_level'));
log.info(`SYNAPSE-UI ${app.getVersion()} — Electron ${process.versions.electron}, Chromium ${process.versions.chrome}, Node ${process.versions.node}`);
log.info(`config: ${paths.config}${logFile ? `  log: ${logFile}` : ''}`);
for (const i of config.issues) log.warn(`config ${i.key || '(file)'}: ${i.message}`);

if (!config.get<boolean>('graphics.hardware_acceleration')) {
  app.disableHardwareAcceleration();
  log.warn('hardware acceleration disabled by configuration');
}
if (config.get<boolean>('graphics.ignore_gpu_blocklist')) app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (process.platform === 'linux') {
  const oz = config.get<string>('graphics.ozone_platform');
  if (oz === 'wayland' || oz === 'x11') app.commandLine.appendSwitch('ozone-platform', oz);
  else app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  if (process.env.XDG_SESSION_TYPE === 'wayland') app.commandLine.appendSwitch('enable-features', 'WaylandWindowDecorations');
}

if (!app.requestSingleInstanceLock()) {
  log.warn('another instance is already running; focusing it');
  app.quit();
}

// ───────── services ─────────
const pty = new PtyManager();
const monitor = new MonitorHub({
  enabled: config.get('monitoring.enabled'),
  intervalScale: config.get('monitoring.interval_scale'),
  networkInterface: config.get('monitoring.network_interface'),
  processLimit: config.get('monitoring.process_limit'),
  gpu: config.get('monitoring.gpu'),
});
const extensions = new ExtensionRegistry(paths.modules);
const capture = new CaptureService(() => recordingDirs(config));
const rendererRoot = path.join(__dirname, '..', 'renderer');
const binDir = (() => {
  const candidates = [path.join(process.resourcesPath ?? '', 'bin'), path.join(app.getAppPath(), 'resources', 'bin')];
  return candidates.find((c) => fs.existsSync(path.join(c, process.platform === 'win32' ? 'synapse.cmd' : 'synapse'))) ?? null;
})();

let mainWindow: BrowserWindow | null = null;

function appInfo(): AppInfo {
  return {
    name: 'SYNAPSE-UI',
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    sessionType: process.env.XDG_SESSION_TYPE ?? '',
    desktop: process.env.XDG_CURRENT_DESKTOP ?? '',
    dev: DEV,
    configDir: paths.config,
    gpuAccel: config.get<boolean>('graphics.hardware_acceleration'),
    firstRun: config.firstRun,
    legacyImported: config.legacyImported,
  };
}

function createWindow(): BrowserWindow {
  const displays = screen.getAllDisplays();
  const idx = config.get<number>('application.display');
  const display = (idx >= 0 && displays[idx]) || screen.getPrimaryDisplay();
  const wa = display.workArea;
  const width = Math.round(Math.min(wa.width, Math.max(1280, wa.width * 0.86)));
  const height = Math.round(Math.min(wa.height, Math.max(800, wa.height * 0.86)));
  const iconPath = path.join(rendererRoot, 'assets', 'icons', 'icon-512.png');
  const win = new BrowserWindow({
    title: config.get<string>('application.name'),
    x: wa.x + Math.round((wa.width - width) / 2),
    y: wa.y + Math.round((wa.height - height) / 2),
    width,
    height,
    minWidth: 640,
    minHeight: 400,
    show: false,
    backgroundColor: '#000000',
    fullscreen: config.get<boolean>('application.fullscreen'),
    frame: !config.get<boolean>('application.frameless'),
    autoHideMenuBar: true,
    icon: fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      backgroundThrottling: false,
      devTools: true, // gated at runtime by security.devtools (see security.ts)
    },
  });
  setTrustedContents(win.webContents);
  win.webContents.setZoomFactor(config.get<number>('interface.scale'));
  win.once('ready-to-show', () => {
    win.show();
    win.webContents.setZoomFactor(config.get<number>('interface.scale'));
  });
  const syncFullscreen = () => {
    const fs2 = win.isFullScreen();
    win.webContents.send(Events.fullscreenChanged, fs2);
    if (config.get<boolean>('application.fullscreen') !== fs2) config.set({ 'application.fullscreen': fs2 });
  };
  win.on('enter-full-screen', syncFullscreen);
  win.on('leave-full-screen', syncFullscreen);
  const wcId = win.webContents.id;
  win.webContents.on('render-process-gone', (_e, details) => {
    log.error(`renderer gone: ${details.reason} (exit ${details.exitCode})`);
    pty.disposeOwner(wcId);
    monitor.removeSink(wcId);
  });
  win.webContents.on('did-start-navigation', (details) => {
    // A reload creates a fresh renderer state: release its old sessions/subscriptions.
    if (details.isMainFrame && !details.isSameDocument) {
      pty.disposeOwner(wcId);
      monitor.removeSink(wcId);
    }
  });
  win.on('closed', () => {
    pty.disposeOwner(wcId);
    monitor.removeSink(wcId);
    mainWindow = null;
  });
  void win.loadURL(APP_URL);
  return win;
}

// Forward config changes, applying main-process side effects first.
config.on('changed', (ev: { changed: string[]; source: 'gui' | 'file' }) => {
  const w = mainWindow;
  const has = (k: string) => ev.changed.includes(k);
  if (w && !w.isDestroyed()) {
    if (has('application.fullscreen') && w.isFullScreen() !== config.get<boolean>('application.fullscreen')) w.setFullScreen(config.get<boolean>('application.fullscreen'));
    if (has('application.name')) w.setTitle(config.get<string>('application.name'));
    if (has('interface.scale')) w.webContents.setZoomFactor(config.get<number>('interface.scale'));
  }
  if (ev.changed.some((k) => k.startsWith('monitoring.'))) {
    monitor.configure({
      enabled: config.get('monitoring.enabled'),
      intervalScale: config.get('monitoring.interval_scale'),
      networkInterface: config.get('monitoring.network_interface'),
      processLimit: config.get('monitoring.process_limit'),
      gpu: config.get('monitoring.gpu'),
    });
  }
  if (has('advanced.log_level') && !DEV) setLogLevel(config.get<LogLevel>('advanced.log_level'));
  if (has('advanced.watch_config')) config.startWatching();
  if (ev.source === 'file') log.info(`applied external config edit: ${ev.changed.join(', ')}`);
  w?.webContents.send(Events.configChanged, { snapshot: config.snapshot(), changed: ev.changed, source: ev.source });
});
config.on('issues', (issues) => mainWindow?.webContents.send(Events.configIssues, issues));
config.on('assets', (kind: string) => mainWindow?.webContents.send(Events.configChanged, { snapshot: config.snapshot(), changed: [`assets:${kind}`], source: 'file' }));

hardenApp(
  () => DEV || config.get<boolean>('security.devtools'),
  () => config.get<'ask' | 'allow' | 'deny'>('security.external_links'),
);

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
  } else {
    Menu.setApplicationMenu(null);
  }
  hardenSession();
  installAppProtocol(rendererRoot, (id) => extensions.scriptDir(id, config.get<boolean>('security.allow_extension_scripts')));
  registerIpc({ window: () => mainWindow, config, pty, monitor, extensions, capture, rendererRoot, binDir, info: appInfo });
  config.startWatching();
  mainWindow = createWindow();
  log.info(`window created (${binDir ? `synapse command at ${binDir}` : 'synapse command helper not found'})`);
  app.on('activate', () => {
    if (!mainWindow) mainWindow = createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  log.info(`shutting down: ${pty.size} terminal session(s)`);
  config.stopWatching();
  monitor.stop();
  pty.disposeAll();
});

process.on('uncaughtException', (e) => log.error('uncaught exception', e));
process.on('unhandledRejection', (e) => log.error('unhandled rejection', e));
