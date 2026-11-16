/**
 * SYNAPSE-UI renderer bootstrap.
 * Runs sandboxed with context isolation; the only privileged surface is the
 * typed `window.synapse` bridge exposed by the preload script.
 */
import '@xterm/xterm/css/xterm.css';
import './styles/base.css';
import './styles/ui.css';
import './styles/modules.css';

import { app } from './core/app';
import { bridge } from './core/bridge';
import { MonitorStore } from './core/monitor';
import { DataSources } from './core/datasources';
import { AudioEngine } from './core/audio';
import { Sounds } from './core/sounds';
import { PerformanceManager } from './core/perf';
import { Keybindings } from './core/keys';
import { CommandRegistry } from './core/commands';
import { GraphicsEngine } from './graphics/engine';
import { WorkspaceManager } from './workspace/manager';
import { WorkspaceEditor } from './workspace/editor';
import { Overlays } from './ui/overlays';
import { openSettings } from './ui/settings';
import { openPalette } from './ui/palette';
import { openThemeEditor } from './ui/theme-editor';
import { openAnimationEditor } from './ui/animation-editor';
import { openModuleManager, openModuleSettings } from './ui/modules-ui';
import { bootSequence, openFirstRun, toggleDiagnostics } from './ui/misc';
import { syncExtensionModules } from './modules/extension';
import { logEvent } from './modules/info';
import { terminals, type TerminalModule } from './modules/terminal';
import type { VisualizationModule } from './modules/visualization';
import './modules/visualization';
import './modules/monitoring';
import './modules/system';
import { CAMERA_MODES } from '../shared/commands';

declare global {
  interface Window { __SYNAPSE__?: unknown }
}

async function main(): Promise<void> {
  await app.init();
  document.title = app.get<string>('application.name');

  // ───────── services ─────────
  app.monitor = new MonitorStore();
  app.audio = new AudioEngine();
  app.data = new DataSources(app.monitor, () => app.audio);
  app.sounds = new Sounds();
  app.overlays = new Overlays(app);
  app.perf = new PerformanceManager(app);
  app.keys = new Keybindings(app);
  app.commands = new CommandRegistry(app);
  app.graphics = new GraphicsEngine(app);
  app.workspace = new WorkspaceManager(app, document.getElementById('workspace')!);
  const editor = new WorkspaceEditor(app);
  app.keys.editorActive = () => editor.active;

  const applyLocalSettings = () => {
    app.sounds.enabled = app.get<boolean>('audio.ui_sounds');
    app.sounds.feedback = app.get<boolean>('audio.feedback_sounds');
    app.sounds.volume = app.get<number>('audio.volume');
    app.audio.configure({ gain: app.get<number>('audio.gain'), smoothing: app.get<number>('audio.smoothing'), sensitivity: app.get<number>('audio.beat_sensitivity'), monitorFile: app.get<boolean>('audio.monitor_file') });
    document.body.classList.toggle('no-cursor', !app.get<boolean>('interface.cursor_visible'));
    document.body.classList.toggle('no-ui-anim', !app.get<boolean>('interface.animations_enabled'));
    document.body.classList.toggle('no-titles', !app.get<boolean>('interface.show_titles'));
    document.title = app.get<string>('application.name');
  };
  applyLocalSettings();
  app.applyTheme();

  app.events.on('config', (changed, source) => {
    applyLocalSettings();
    if (changed.includes('interface.panel_transparency')) app.applyTheme();
    if (source === 'file') {
      app.overlays.toast(`config.toml reloaded (${changed.length} change${changed.length === 1 ? '' : 's'})`, 'info');
      logEvent('sys', `Configuration file edited externally: ${changed.slice(0, 6).join(', ')}${changed.length > 6 ? '…' : ''}`);
    }
  });
  app.events.on('issues', (issues) => {
    const errors = issues.filter((i) => i.severity === 'error');
    if (errors.length) app.overlays.toast(`Configuration: ${errors.slice(0, 2).map((i) => `${i.key || 'config.toml'} — ${i.message}`).join(' · ')}`, 'error', 9000);
  });
  app.events.on('theme', (t) => logEvent('info', `Theme: ${t.name}`));
  app.events.on('extensions', () => syncExtensionModules(app));
  app.workspace.events.on('switched', (ws) => logEvent('info', `Workspace: ${ws.name} [${ws.mode}]`));
  app.graphics.events.on('lost', () => logEvent('alert', 'WebGL context lost — recovering'));
  app.graphics.events.on('restored', () => logEvent('info', 'WebGL context restored'));
  bridge.app.onFullscreen((on) => logEvent('info', on ? 'Entered fullscreen' : 'Left fullscreen'));

  // Battery saver.
  app.monitor.subscribe('battery', (b) => app.perf.setBattery(b as never));
  app.perf.events.on('change', () => logEvent('sys', `Performance: ${app.perf.profile} · quality ${['low', 'medium', 'high', 'ultra'][app.perf.quality]} · scale ${app.perf.renderScale.toFixed(2)}`));

  // ───────── tools ─────────
  const o = app.overlays;
  o.tools = {
    settings: (c) => openSettings(app, c),
    palette: (i) => openPalette(app, i),
    themeEditor: () => openThemeEditor(app),
    animationEditor: (id) => openAnimationEditor(app, id),
    moduleManager: () => openModuleManager(app),
    moduleSettings: (id) => openModuleSettings(app, id),
    diagnostics: () => toggleDiagnostics(app),
    firstRun: () => openFirstRun(app),
    editor: () => editor.toggle(),
  };

  // ───────── actions (palette + keybindings) ─────────
  const term = (): TerminalModule | null => terminals.active ?? app.workspace.preferred<TerminalModule>('terminal')?.module ?? null;
  const viz = (): VisualizationModule | null => app.workspace.preferred<VisualizationModule>('visualization')?.module ?? null;
  const reg = (id: string, label: string, category: string, run: () => void | Promise<void>) => app.commands.register({ id, label, category, run });
  reg('palette.open', 'Command palette', 'General', () => o.openPalette());
  reg('settings.open', 'Open settings', 'General', () => o.openSettings());
  reg('modules.manager', 'Module manager', 'General', () => o.openModuleManager());
  reg('workspace.editor', 'Toggle workspace editor', 'Workspace', () => editor.toggle());
  reg('workspace.next', 'Next workspace', 'Workspace', () => app.workspace.cycle(1));
  reg('workspace.prev', 'Previous workspace', 'Workspace', () => app.workspace.cycle(-1));
  reg('workspace.save', 'Save workspace', 'Workspace', () => void app.workspace.saveNow().then((ok) => ok && o.toast('Workspace saved', 'ok')));
  reg('editor.undo', 'Undo layout change', 'Workspace', () => editor.undo());
  reg('editor.redo', 'Redo layout change', 'Workspace', () => editor.redo());
  reg('editor.duplicate', 'Duplicate selected modules', 'Workspace', () => editor.duplicateSelection());
  reg('editor.delete', 'Remove selected modules', 'Workspace', () => void editor.removeSelection());
  reg('theme.editor', 'Theme editor', 'Appearance', () => o.openThemeEditor());
  reg('animation.editor', 'Animation editor', 'Visualization', () => o.openAnimationEditor());
  reg('animation.toggle', 'Pause / resume visualizations', 'Visualization', () => { app.graphics.setPaused(!app.graphics.paused); o.toast(app.graphics.paused ? 'Visualizations paused' : 'Visualizations resumed', 'info', 1500); });
  reg('camera.cycle', 'Cycle camera mode', 'Visualization', () => viz()?.cycleCamera());
  reg('capture.screenshot', 'Screenshot focused visualization', 'Visualization', async () => { const v = viz(); if (v) o.toast(`Saved ${await v.screenshot()}`, 'ok'); });
  reg('capture.record', 'Start / stop recording', 'Visualization', async () => { const v = viz(); if (v) o.toast(await v.toggleRecording(), 'info'); });
  reg('diagnostics.toggle', 'Rendering diagnostics', 'Visualization', () => o.toggleDiagnostics());
  reg('terminal.newTab', 'New terminal tab', 'Terminal', () => void term()?.addTab());
  reg('terminal.closeTab', 'Close terminal tab', 'Terminal', () => term()?.closeActiveTab());
  reg('terminal.nextTab', 'Next terminal tab', 'Terminal', () => term()?.cycleTab(1));
  reg('terminal.prevTab', 'Previous terminal tab', 'Terminal', () => term()?.cycleTab(-1));
  reg('terminal.splitH', 'Split terminal horizontally', 'Terminal', () => void term()?.split('row'));
  reg('terminal.splitV', 'Split terminal vertically', 'Terminal', () => void term()?.split('column'));
  reg('terminal.copy', 'Copy', 'Terminal', () => term()?.copy());
  reg('terminal.paste', 'Paste', 'Terminal', () => void term()?.paste());
  reg('terminal.search', 'Search terminal', 'Terminal', () => term()?.toggleSearch());
  reg('terminal.focusNext', 'Focus next terminal pane', 'Terminal', () => term()?.focusNextPane());
  reg('terminal.fontUp', 'Increase terminal font', 'Terminal', () => term()?.fontStep(1));
  reg('terminal.fontDown', 'Decrease terminal font', 'Terminal', () => term()?.fontStep(-1));
  reg('app.fullscreen', 'Toggle fullscreen', 'General', () => void bridge.app.toggleFullscreen());
  reg('app.devtools', 'Developer tools', 'General', () => void bridge.app.devtools().then((ok) => !ok && o.toast('Developer tools are disabled (Settings → Advanced)', 'warn')));
  reg('app.reload', 'Reload interface', 'General', () => location.reload());
  reg('app.quit', 'Quit', 'General', () => void bridge.app.quit());
  for (const mode of CAMERA_MODES) reg(`camera.${mode}`, `Camera: ${mode}`, 'Visualization', () => viz()?.setCamera(mode));
  reg('setup.firstRun', 'First-run setup', 'General', () => o.openFirstRun());

  // ───────── workspace ─────────
  syncExtensionModules(app);
  const boot = bootSequence(app);
  const wanted = app.get<string>('application.workspace');
  const ok = await app.workspace.switchTo(app.workspace.find(wanted) ? wanted : 'neural-lab', false);
  if (!ok) await app.workspace.switchTo('custom', false);
  await boot;
  document.body.classList.remove('booting');
  logEvent('sys', `SYNAPSE-UI ${app.info.version} · Electron ${app.info.electron} · ${app.info.platform}/${app.info.arch}${app.info.sessionType ? ` · ${app.info.sessionType}` : ''}`);
  if (app.info.legacyImported) o.toast(`Imported settings from your eDEX-UI configuration (${app.info.legacyImported})`, 'ok', 8000);
  if (!app.graphics.supported) o.toast(`WebGL2 unavailable: ${app.graphics.error}. Visualizations are disabled.`, 'error', 12000);
  for (const i of app.snapshot.issues.filter((x) => x.severity === 'error').slice(0, 3)) o.toast(`Config ${i.key}: ${i.message}`, 'error', 9000);
  if (app.snapshot.firstRun && !app.get<boolean>('application.first_run_complete')) o.openFirstRun();

  window.__SYNAPSE__ = app;
}

window.addEventListener('error', (e) => void bridge.app.log('error', `renderer: ${e.message} @ ${e.filename}:${e.lineno}`).catch(() => {}));
window.addEventListener('unhandledrejection', (e) => void bridge.app.log('error', `renderer promise: ${String((e.reason as Error)?.stack ?? e.reason).slice(0, 4000)}`).catch(() => {}));

main().catch((e) => {
  console.error(e);
  document.body.innerHTML = '';
  const pre = document.createElement('pre');
  pre.className = 'fatal';
  pre.textContent = `SYNAPSE-UI failed to start\n\n${(e as Error)?.stack ?? e}`;
  document.body.append(pre);
  void bridge.app.log('error', `fatal: ${(e as Error)?.stack ?? e}`);
});
