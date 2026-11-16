/** Settings application: every category from the registry plus dedicated pages. */
import type { App } from '../core/app';
import { bridge } from '../core/bridge';
import { formatBytes, h } from '../core/util';
import { SETTINGS, SETTINGS_CATEGORIES, defaultConfig, type SettingDef, type SettingsCategory } from '../../shared/settings';
import { ACTIONS } from '../../shared/keybindings';
import { BUILTIN_WORKSPACES } from '../../shared/profiles';
import { field, settingInput } from './form';
import { moduleTypes } from '../workspace/module';

export function openSettings(app: App, initial?: string): void {
  const p = app.overlays.panel('settings', 'SETTINGS', { width: 'min(1180px, 94vw)', height: 'min(86vh, 940px)', className: 'settings', subtitle: app.snapshot.paths.configFile });
  const nav = h('nav.settings-nav', { role: 'tablist' });
  const content = h('div.settings-content.scroll');
  const search = h('input', { placeholder: 'search settings…', spellcheck: 'false', class: 'settings-search' });
  const adv = h('input', { type: 'checkbox' });
  let advanced = false;
  let current: SettingsCategory = (SETTINGS_CATEGORIES as readonly string[]).includes(initial ?? '') ? (initial as SettingsCategory) : 'GENERAL';
  adv.addEventListener('change', () => { advanced = adv.checked; render(); });
  search.addEventListener('input', () => render());
  p.body.append(h('div.settings-top', search, h('label.row', adv, h('span.label', 'SHOW ADVANCED'))), h('div.settings-main', nav, content));

  const dyn = { shells: [] as { value: string; label: string }[], kb: [] as { value: string; label: string }[], devices: [] as { value: string; label: string }[], ifaces: [] as { value: string; label: string }[] };
  void bridge.pty.shells().then((s) => { dyn.shells = [{ value: 'auto', label: 'Automatic ($SHELL)' }, ...s.map((x) => ({ value: x.path, label: `${x.name} — ${x.path}` }))]; render(); });
  void bridge.config.kbLayouts().then((l) => { dyn.kb = l.map((x) => ({ value: x, label: x })); render(); });
  void app.audio.inputDevices().then((d) => { dyn.devices = [{ value: 'default', label: 'Default input' }, ...d.filter((x) => x.id !== 'default').map((x) => ({ value: x.id, label: x.label }))]; });
  void bridge.monitor.staticInfo().then((s) => { dyn.ifaces = [{ value: 'auto', label: 'Automatic (default route)' }, ...s.interfaces.map((i) => ({ value: i, label: i }))]; });

  const dynamicFor = (def: SettingDef) => {
    if (def.type.kind !== 'string' || !def.type.options) return undefined;
    switch (def.type.options) {
      case 'themes': return app.themes.map((t) => ({ value: t.id, label: t.name }));
      case 'workspaces': return app.workspace.list().map((w) => ({ value: w.id, label: w.name }));
      case 'presets': return app.presets().map((pr) => ({ value: pr.id, label: pr.name }));
      case 'shells': return dyn.shells.length ? dyn.shells : undefined;
      case 'kb_layouts': return dyn.kb.length ? dyn.kb : undefined;
      case 'audio_devices': return dyn.devices.length ? dyn.devices : undefined;
      case 'net_ifaces': return dyn.ifaces.length ? dyn.ifaces : undefined;
    }
  };

  const defaults = defaultConfig();
  const settingRow = (def: SettingDef) => {
    const v = app.get(def.key);
    const modified = JSON.stringify(v) !== JSON.stringify(defaults[def.key]);
    const control = settingInput(def, v, (nv) => void app.set({ [def.key]: nv }).then((ok) => { if (ok && def.restart) app.overlays.toast(`${def.label}: restart SYNAPSE-UI to apply`, 'warn'); render(); }), { dynamic: dynamicFor(def) });
    return field(def.label, control, { description: `${def.description}  [${def.key}]`, badge: def.restart ? 'RESTART' : undefined, modified, onReset: modified ? () => void bridge.config.reset([def.key]).then(() => setTimeout(render, 80)) : undefined });
  };

  const visible = (def: SettingDef) => !def.hidden && (advanced || !def.advanced) && (!def.platforms || def.platforms.includes(app.info.platform as 'linux'));

  function render(): void {
    nav.replaceChildren(...SETTINGS_CATEGORIES.map((c) => {
      const b = h('button.ghost', { role: 'tab', class: c === current ? 'active' : '', 'aria-selected': String(c === current), onclick: () => { current = c; search.value = ''; render(); } }, c);
      b.addEventListener('keydown', (e) => {
        const i = SETTINGS_CATEGORIES.indexOf(current);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          current = SETTINGS_CATEGORIES[(i + (e.key === 'ArrowDown' ? 1 : SETTINGS_CATEGORIES.length - 1)) % SETTINGS_CATEGORIES.length];
          render();
          (nav.querySelector('.active') as HTMLElement | null)?.focus();
        }
      });
      return b;
    }));
    const q = search.value.trim().toLowerCase();
    if (q) {
      const hits = SETTINGS.filter((d) => !d.hidden && `${d.key} ${d.label} ${d.description}`.toLowerCase().includes(q));
      content.replaceChildren(h('h3', `RESULTS FOR "${q.toUpperCase()}"`), ...hits.map(settingRow), hits.length ? '' : h('div.na', 'No matching settings.'));
      return;
    }
    const rows = SETTINGS.filter((d) => d.category === current && visible(d)).map(settingRow);
    const pageEl = h('div.settings-page');
    content.replaceChildren(h('h3', current), pageEl);
    const extra = pages[current]?.(app, render);
    if (extra) pageEl.append(extra);
    if (rows.length) pageEl.append(h('div.settings-group', ...rows));
  }
  const offConfig = app.events.on('config', () => { if (!document.activeElement?.closest('.settings-content')) render(); });
  const offThemes = app.events.on('themes', render);
  p.onClose(() => { offConfig(); offThemes(); });
  render();
}

type Page = (app: App, rerender: () => void) => HTMLElement | null;

const pages: Partial<Record<SettingsCategory, Page>> = {
  GENERAL: (app) => h('div.row.wrap', h('button', { onclick: () => app.overlays.openFirstRun() }, 'Run first-run setup'), h('button', { onclick: () => app.overlays.openPalette() }, 'Command palette'), h('button', { onclick: () => void bridge.app.toggleFullscreen() }, 'Toggle fullscreen')),
  THEMES: (app, rerender) => {
    const list = h('div.card-list');
    for (const t of app.themes) {
      const isUser = app.userThemes.includes(t.id);
      const active = app.get<string>('application.theme') === t.id;
      const sw = h('div.swatches', ...[t.colors.background, t.colors.surface, t.colors.foreground, t.colors.accent, t.colors.neural, t.colors.border].map((c) => h('i', { style: `background:${c}` })));
      list.append(h('div.card', { class: active ? 'active' : '' },
        sw, h('div.grow', h('div', t.name), h('small.dim', t.description || t.id)),
        h('button', { onclick: () => void app.commands.execute(['theme', 'set', t.id]).then(rerender) }, active ? 'ACTIVE' : 'USE'),
        h('button', { onclick: () => void bridge.config.exportTheme(t.id).then((pth) => pth && app.overlays.toast(`Exported to ${pth}`, 'ok')) }, 'EXPORT'),
        isUser && t.id !== 'custom' ? h('button.danger', { onclick: async () => { if (await app.overlays.confirm({ title: 'Delete theme', message: `Delete theme file "${t.id}.toml"? A backup is kept.`, danger: true, confirm: 'Delete' })) { await bridge.config.deleteTheme(t.id); await app.reloadThemes(); rerender(); } } }, 'DELETE') : '',
      ));
    }
    return h('div', h('div.row.wrap', h('button.primary', { onclick: () => app.overlays.openThemeEditor() }, 'Open theme editor'), h('button', { onclick: async () => { const r = await bridge.config.importTheme(); if (r) { app.overlays.toast(r.ok ? `Imported "${r.theme.name}"` : `Import failed: ${r.error}`, r.ok ? 'ok' : 'error'); await app.reloadThemes(); rerender(); } } }, 'Import theme (TOML or eDEX JSON)'), h('button', { onclick: () => void bridge.app.openPath('themes') }, 'Open themes folder')), list);
  },
  WORKSPACES: (app, rerender) => {
    const list = h('div.card-list');
    for (const w of app.workspace.list()) {
      const isBuiltin = BUILTIN_WORKSPACES.some((b) => b.id === w.id);
      const modified = isBuiltin && app.userLayouts.includes(w.id);
      const active = app.workspace.current?.id === w.id;
      list.append(h('div.card', { class: active ? 'active' : '' },
        h('div.grow', h('div', w.name, h('span.dim', ` [${w.mode}] ${w.modules.length} modules${modified ? ' · modified' : ''}`)), h('small.dim', w.description)),
        h('button', { onclick: () => void app.workspace.switchTo(w.id).then(rerender) }, active ? 'ACTIVE' : 'SWITCH'),
        !isBuiltin ? h('button.danger', { onclick: async () => { if (await app.overlays.confirm({ title: 'Delete workspace', message: `Delete workspace "${w.name}"? A backup is kept.`, danger: true, confirm: 'Delete' })) { await bridge.config.deleteLayout(w.id); await app.reloadLayouts(); rerender(); } } }, 'DELETE') : '',
      ));
    }
    return h('div', h('div.row.wrap', h('button.primary', { onclick: () => { app.overlays.closePanel('settings'); app.overlays.toggleEditor(); } }, 'Edit current workspace (Ctrl+Shift+E)'), h('button', { onclick: () => void bridge.app.openPath('layouts') }, 'Open layouts folder')), list);
  },
  MODULES: (app) => h('div.row.wrap', h('button.primary', { onclick: () => app.overlays.openModuleManager() }, 'Open module manager'), h('span.dim', `${moduleTypes().length} module types installed`)),
  ANIMATIONS: (app) => h('div.row.wrap', h('button.primary', { onclick: () => app.overlays.openAnimationEditor() }, 'Open animation editor'), h('span.dim', `${app.presets().length} presets available`), h('button', { onclick: async () => { const dir = await bridge.dialog.chooseDir('Recording folder'); if (dir) await app.set({ 'recording.output_dir': dir }); } }, 'Choose recording folder…'), h('button', { onclick: () => void bridge.app.openPath('recordings') }, 'Open recordings')),
  GRAPHICS: (app) => {
    const box = h('div.kv');
    void bridge.app.gpuInfo().then((g) => {
      const info = g.info as { gpuDevice?: { vendorId: number; deviceId: number; active: boolean }[]; auxAttributes?: Record<string, unknown> } | null;
      box.replaceChildren(...Object.entries(g.status).flatMap(([k, v]) => [h('span.k', k), h('span.v', String(v))]), ...(info?.auxAttributes?.glRenderer ? [h('span.k', 'GL RENDERER'), h('span.v', String(info.auxAttributes.glRenderer))] : []));
    });
    return h('div', h('p.dim', `Shared WebGL2 renderer: ${app.graphics.supported ? 'available' : `unavailable (${app.graphics.error})`}.`), h('div.row', h('button', { onclick: () => { const ok = app.graphics.testContextLoss(); app.overlays.toast(ok ? 'Simulating GPU context loss…' : 'WEBGL_lose_context unsupported', ok ? 'warn' : 'error'); } }, 'Test context-loss recovery')), h('h4', 'CHROMIUM GPU FEATURE STATUS'), box);
  },
  PERFORMANCE: (app) => h('div.row.wrap', h('button', { onclick: () => app.overlays.toggleDiagnostics() }, 'Toggle diagnostics overlay (Ctrl+Shift+D)'), h('span.dim', `Effective profile: ${app.perf.profile} · quality ${['low', 'medium', 'high', 'ultra'][app.perf.quality]}${app.perf.onBattery ? ' · ON BATTERY' : ''}`)),
  AUDIO: () => h('p.dim', 'Capture never starts implicitly. Add an "Audio Analyzer" module to start a microphone/input device, a file, or (Windows/macOS) system audio. On Linux, choose a PipeWire/PulseAudio "Monitor of …" input device to analyse system output.'),
  KEYBINDINGS: (app, rerender) => {
    const box = h('div.settings-group');
    const bindings = { ...app.snapshot.bindings };
    const conflicts = app.snapshot.bindingIssues;
    let cat = '';
    for (const a of ACTIONS) {
      if (a.category !== cat) { cat = a.category; box.append(h('h4', cat.toUpperCase())); }
      const btn = h('button.kbd', { title: 'Click, then press the new shortcut (Esc clears)' }, bindings[a.id] || '—');
      btn.addEventListener('click', () => {
        btn.textContent = 'PRESS KEYS…';
        app.keys.capture = (accel) => {
          app.keys.capture = null;
          bindings[a.id] = accel;
          void bridge.config.saveKeybindings(bindings).then((r) => {
            if (!r.ok) app.overlays.toast(r.issues.join('; '), 'error');
            setTimeout(rerender, 120);
          });
        };
      });
      box.append(field(a.label, h('span.row', btn, a.default !== bindings[a.id] ? h('button.ghost', { title: `Reset to ${a.default}`, onclick: () => { bindings[a.id] = a.default; void bridge.config.saveKeybindings(bindings).then(() => setTimeout(rerender, 120)); } }, '↺') : ''), { description: `${a.id}  (default ${a.default || 'none'})` }));
    }
    return h('div', conflicts.length ? h('div.issues', ...conflicts.map((c) => h('div', c))) : '', h('button', { onclick: () => void bridge.app.openPath('config') }, 'Open keybindings.toml folder'), box);
  },
  'IMPORT / EXPORT': (app, rerender) => {
    const backups = h('div.card-list');
    void bridge.config.backups().then((list) => backups.replaceChildren(...list.slice(0, 40).map((b) => h('div.card', h('div.grow.mono', b.name), h('span.dim', formatBytes(b.size)), /_config/.test(b.name) ? h('button', { onclick: async () => { if (await app.overlays.confirm({ title: 'Restore backup', message: `Replace config.toml with ${b.name}? The current file is backed up first.`, confirm: 'Restore' })) { const r = await bridge.config.restoreBackup(b.name); app.overlays.toast(r.ok ? 'Backup restored' : `Restore failed: ${r.error}`, r.ok ? 'ok' : 'error'); rerender(); } } }, 'RESTORE') : ''))));
    return h('div',
      h('div.row.wrap',
        h('button.primary', { onclick: () => void bridge.config.exportAll().then((pth) => pth && app.overlays.toast(`Exported to ${pth}`, 'ok')) }, 'Export everything…'),
        h('button', { onclick: async () => { const r = await bridge.config.importAll(); if (r) app.overlays.toast(r.ok ? `Imported ${r.summary.join(', ')}` : `Import finished with errors: ${r.errors.slice(0, 3).join('; ')}`, r.ok ? 'ok' : 'warn', 8000); await Promise.all([app.reloadThemes(), app.reloadLayouts(), app.reloadPresets()]); rerender(); } }, 'Import…'),
        h('button', { onclick: () => void bridge.config.backupNow().then(() => rerender()) }, 'Back up now'),
        h('button', { onclick: () => void bridge.app.openPath('config') }, 'Open config folder'),
      ),
      h('h4', 'BACKUPS'), backups);
  },
  ADVANCED: (app, rerender) => {
    const issues = [...app.snapshot.issues.map((i) => `${i.severity.toUpperCase()} ${i.key || 'config.toml'}: ${i.message}`), ...app.assetErrors.map((e) => `ERROR ${e.file}: ${e.error}`)];
    return h('div',
      issues.length ? h('div.issues', h('h4', 'CONFIGURATION ISSUES'), ...issues.map((i) => h('div.mono', i))) : h('p.dim', 'No configuration issues.'),
      h('div.row.wrap',
        h('button', { onclick: () => void bridge.app.devtools().then((ok) => !ok && app.overlays.toast('Enable "Developer tools" (advanced) first', 'warn')) }, 'Developer tools'),
        h('button', { onclick: () => location.reload() }, 'Reload interface'),
        h('button', { onclick: () => void bridge.app.relaunch() }, 'Restart SYNAPSE-UI'),
        h('button.danger', { onclick: async () => { if (await app.overlays.confirm({ title: 'Restore defaults', message: 'Reset ALL settings to their defaults? Themes, workspaces and presets are kept. A backup of config.toml is written first.', danger: true, confirm: 'Reset everything' })) { await bridge.config.reset(null); app.overlays.toast('All settings restored to defaults', 'ok'); setTimeout(rerender, 150); } } }, 'Restore all defaults'),
      ));
  },
  ABOUT: (app) => {
    const i = app.info;
    return h('div.about',
      h('div.about-logo', 'SYNAPSE-UI'),
      h('p', 'A modular, GPU-accelerated neural visualization and futuristic terminal environment built upon eDEX-UI.'),
      h('div.kv', ...[
        ['VERSION', i.version], ['ELECTRON', i.electron], ['CHROMIUM', i.chrome], ['NODE', i.node], ['V8', i.v8], ['PLATFORM', `${i.platform} ${i.arch} (${i.osRelease})`],
        ['SESSION', [i.sessionType, i.desktop].filter(Boolean).join(' · ') || '—'], ['CONFIG', i.configDir], ['MODULE TYPES', String(moduleTypes().length)], ['PRESETS', String(app.presets().length)],
      ].flatMap(([k, v]) => [h('span.k', k), h('span.v', v)])),
      h('h4', 'ATTRIBUTION'),
      h('p.dim', 'SYNAPSE-UI is a fork of eDEX-UI by Gabriel “Squared” Saillard and contributors (github.com/GitSquared/edex-ui), licensed under the GNU General Public License v3.0. The ENCOM globe is derived from encom-globe by Rob Scanlon (MIT). Fonts: United Sans (eDEX-UI assets), Fira Mono / Fira Code (SIL OFL). Built with Electron, three.js, xterm.js, node-pty and systeminformation.'),
      h('p.dim', 'This program comes with ABSOLUTELY NO WARRANTY. It is free software: you can redistribute it and/or modify it under the terms of the GNU GPL v3.'),
      h('div.row', h('button', { onclick: () => void bridge.app.openExternal('https://github.com/SwashX-dev/Synapse-UI') }, 'Project page'), h('button', { onclick: () => void bridge.app.openExternal('https://github.com/GitSquared/edex-ui') }, 'Original eDEX-UI')),
    );
  },
};
