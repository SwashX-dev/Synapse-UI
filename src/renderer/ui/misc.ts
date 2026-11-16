/** First-run setup, rendering diagnostics overlay and the eDEX-style boot sequence. */
import type { App } from '../core/app';
import { bridge } from '../core/bridge';
import { formatBytes, h } from '../core/util';
import { field } from './form';

// ───────────────────────── first-run setup ─────────────────────────

export function openFirstRun(app: App): void {
  const p = app.overlays.panel('first-run', 'SYNAPSE-UI · INITIAL CONFIGURATION', { width: 'min(820px, 94vw)', className: 'first-run', subtitle: 'all choices can be changed later in Settings' });
  const state = {
    theme: app.get<string>('application.theme'),
    workspace: app.get<string>('application.workspace'),
    shell: app.get<string>('terminal.default_shell'),
    mode: app.get<string>('performance.mode'),
    quality: app.get<string>('visualization.quality'),
    animation: app.get<string>('visualization.default_animation'),
    fullscreen: app.get<boolean>('application.fullscreen'),
    sounds: app.get<boolean>('audio.ui_sounds'),
    intensity: app.get<number>('visualization.time_scale'),
  };
  const sel = (opts: { value: string; label: string }[], key: keyof typeof state, onChange?: () => void) => {
    const s = h('select', ...opts.map((o) => h('option', { value: o.value }, o.label)));
    s.value = String(state[key]);
    s.addEventListener('change', () => { (state as Record<string, unknown>)[key] = s.value; onChange?.(); });
    return s;
  };
  const shellSel = h('select', h('option', { value: 'auto' }, 'Automatic ($SHELL)'));
  void bridge.pty.shells().then((list) => { for (const s of list) shellSel.append(h('option', { value: s.path }, `${s.name} — ${s.path}`)); shellSel.value = state.shell; });
  shellSel.addEventListener('change', () => (state.shell = shellSel.value));
  const fs = h('input', { type: 'checkbox' });
  fs.checked = state.fullscreen;
  fs.addEventListener('change', () => (state.fullscreen = fs.checked));
  const snd = h('input', { type: 'checkbox' });
  snd.checked = state.sounds;
  snd.addEventListener('change', () => (state.sounds = snd.checked));
  const intensity = h('input', { type: 'range', min: '0.2', max: '2', step: '0.05', value: String(state.intensity) });
  intensity.addEventListener('input', () => (state.intensity = Number(intensity.value)));
  const previewTheme = () => { const t = app.theme(state.theme); if (t) app.applyTheme(t); };
  const swatch = h('div.fr-preview');
  const renderPreview = () => {
    const t = app.theme(state.theme);
    const ws = app.workspace.find(state.workspace);
    swatch.replaceChildren(
      h('div.swatches', ...(t ? [t.colors.background, t.colors.surface, t.colors.foreground, t.colors.accent, t.colors.neural] : []).map((c) => h('i', { style: `background:${c}` }))),
      h('div.mono.dim', `${t?.name ?? state.theme} · ${ws?.name ?? state.workspace} (${ws?.mode ?? ''}, ${ws?.modules.length ?? 0} modules) · ${state.mode} · ${state.animation}`),
    );
  };
  const finish = async (apply: boolean) => {
    if (apply) {
      await app.set({
        'application.theme': state.theme, 'application.workspace': state.workspace, 'terminal.default_shell': state.shell, 'performance.mode': state.mode, 'visualization.quality': state.quality,
        'visualization.default_animation': state.animation, 'application.fullscreen': state.fullscreen, 'audio.ui_sounds': state.sounds, 'visualization.time_scale': state.intensity,
      });
      await app.workspace.switchTo(state.workspace);
    }
    await app.set({ 'application.first_run_complete': true });
    app.applyTheme();
    p.close();
  };
  p.body.append(
    h('p', 'Welcome. SYNAPSE-UI is a fork of eDEX-UI: a fullscreen terminal workstation with GPU neural visualizations. Choose a starting configuration — or skip.'),
    h('div.settings-group',
      field('THEME', sel(app.themes.map((t) => ({ value: t.id, label: t.name })), 'theme', () => { previewTheme(); renderPreview(); })),
      field('WORKSPACE', sel(app.workspace.list().map((w) => ({ value: w.id, label: `${w.name} — ${w.description.slice(0, 60)}` })), 'workspace', renderPreview)),
      field('SHELL', shellSel),
      field('PERFORMANCE', sel(['adaptive', 'eco', 'balanced', 'high', 'cinematic'].map((v) => ({ value: v, label: v.toUpperCase() })), 'mode', renderPreview)),
      field('ANIMATION QUALITY', sel(['auto', 'low', 'medium', 'high', 'ultra'].map((v) => ({ value: v, label: v.toUpperCase() })), 'quality')),
      field('STARTING VISUALIZATION', sel(app.presets().map((pr) => ({ value: pr.id, label: pr.name })), 'animation', renderPreview)),
      field('FULLSCREEN', h('label.switch', fs, h('span.track'))),
      field('SOUND EFFECTS', h('label.switch', snd, h('span.track'))),
      field('ANIMATION INTENSITY', intensity, { description: 'Global simulation speed multiplier.' }),
    ),
    swatch,
    h('div.row.end', h('button', { onclick: () => void finish(false) }, 'SKIP'), h('button.primary', { onclick: () => void finish(true) }, 'APPLY & START')),
  );
  renderPreview();
  p.onClose(() => app.applyTheme());
}

// ───────────────────────── diagnostics overlay ─────────────────────────

let diag: { el: HTMLElement; timer: ReturnType<typeof setInterval> } | null = null;
export function toggleDiagnostics(app: App): void {
  if (diag) {
    clearInterval(diag.timer);
    diag.el.remove();
    diag = null;
    app.overlays.diagnosticsOpen = false;
    return;
  }
  const el = h('div.diagnostics.mono');
  document.getElementById('overlays')!.append(el);
  app.overlays.diagnosticsOpen = true;
  const tick = async () => {
    const g = app.graphics;
    const m = g.memoryEstimate();
    const perf = app.perf;
    const metrics = await bridge.app.metrics().catch(() => []);
    const views = [...g.views].map((v) => {
      const s = v.stats();
      return `${String(s.preset).padEnd(28).slice(0, 28)} ${String(s.size).padStart(10)} ${String(s.fps).padStart(5)}fps ${String(s.renderMs).padStart(6)}ms ${v.visible() ? (v.overLimit ? 'LIMIT' : 'ON   ') : 'HIDDEN'}${Number(s.throttle) > 1 ? ` ÷${s.throttle}` : ''}`;
    });
    el.textContent = [
      `SYNAPSE-UI DIAGNOSTICS   (Ctrl+Shift+D to close)`,
      `profile ${perf.profile}  quality ${['low', 'medium', 'high', 'ultra'][perf.quality]}  target ${perf.targetFps}fps  scale ${perf.renderScale.toFixed(2)}  reduced-motion ${perf.reducedMotion}${perf.onBattery ? '  ON BATTERY' : ''}`,
      `loop ${g.fps.toFixed(1)}fps  frame ${perf.averageFrameMs.toFixed(2)}ms  work ${g.workMs.toFixed(2)}ms  ${g.lost ? 'CONTEXT LOST' : 'context ok'}`,
      `gpu (est.) ${formatBytes(m.bytes)}  geometries ${m.geometries}  textures ${m.textures}  programs ${m.programs}  calls ${m.drawCalls}  tris ${m.triangles}  lines ${m.lines}  points ${m.points}`,
      `monitor topics: ${app.monitor.activeTopics().join(', ') || 'none'}`,
      '',
      'VIEWS',
      ...views,
      '',
      'PROCESSES',
      ...metrics.map((p) => `${p.type.padEnd(14)} pid ${String(p.pid).padEnd(8)} cpu ${p.cpu.toFixed(1).padStart(5)}%  mem ${formatBytes(p.memoryKB * 1024)}`),
    ].join('\n');
  };
  void tick();
  diag = { el, timer: setInterval(() => void tick(), 500) };
}

// ───────────────────────── boot sequence ─────────────────────────

/** eDEX-UI boot log + logo. Resolves when finished (or immediately when disabled / reduced motion). */
export async function bootSequence(app: App): Promise<void> {
  if (!app.get<boolean>('application.boot_animation') || app.perf.reducedMotion) return;
  const el = h('div.boot');
  const log = h('pre.boot-log');
  el.append(log);
  document.body.append(el);
  let lines: string[] = [];
  try {
    lines = (await (await fetch('/assets/misc/boot_log.txt')).text()).split('\n').map((l) => l.replace(/eDEX-UI/g, 'SYNAPSE-UI').replace(/eDEX/g, 'SYNAPSE'));
  } catch { /* skip */ }
  const skip = new Promise<void>((r) => { el.addEventListener('pointerdown', () => r(), { once: true }); window.addEventListener('keydown', () => r(), { once: true }); });
  let skipped = false;
  void skip.then(() => (skipped = true));
  const start = performance.now();
  for (let i = 0; i < lines.length && !skipped; i++) {
    log.textContent += lines[i] + '\n';
    if (log.textContent.length > 6000) log.textContent = log.textContent.slice(-5000);
    log.scrollTop = log.scrollHeight;
    if (i % 3 === 0) app.sounds.play('stdout', 0.3);
    await new Promise((r) => setTimeout(r, i < 4 ? 160 : Math.max(2, 18 - i / 8)));
    if (performance.now() - start > 4200) break;
  }
  log.remove();
  const logo = h('div.boot-logo', h('h1', 'SYNAPSE', h('span', '-UI')), h('h3', `NEURAL VISUALIZATION WORKSTATION · v${app.info.version}`), h('h4', 'BUILT UPON eDEX-UI'));
  el.append(logo);
  app.sounds.play('theme');
  if (!skipped) await Promise.race([new Promise((r) => setTimeout(r, 1500)), skip]);
  el.classList.add('out');
  setTimeout(() => el.remove(), 500);
}
