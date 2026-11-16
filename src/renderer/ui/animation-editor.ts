/**
 * Animation editor: preset selection, live parameter editing, playback and
 * timeline scrubbing, camera control, seeds, data bindings, mathematical
 * parameter expressions, keyframe tracks (parameter automation), layering,
 * recording/export, and preset create / duplicate / delete / import / export.
 */
import type { App } from '../core/app';
import { bridge } from '../core/bridge';
import { h } from '../core/util';
import { ENGINES } from '../graphics/engines';
import { VizView } from '../graphics/engine';
import type { VisualizationModule } from '../modules/visualization';
import { PresetSchema, type Preset } from '../../shared/manifest';
import { CAMERA_MODES, type CameraMode } from '../../shared/commands';
import { SETTINGS_BY_KEY } from '../../shared/settings';
import { tryCompile } from '../../shared/expression';
import { field, groupParams, paramInput, settingInput } from './form';
import type { Binding } from '../core/datasources';
import { clone } from '../../shared/workspace';

type Track = NonNullable<Preset['timeline']>['tracks'][number];

export function openAnimationEditor(app: App, moduleId?: string): void {
  const p = app.overlays.panel('animation-editor', 'ANIMATION EDITOR', { className: 'side-panel anim-editor', subtitle: 'changes apply live' });
  const body = h('div.scroll.ae-body');
  p.body.append(body);
  let preview: VizView | null = null;
  const previewBox = h('div.ae-preview');
  p.onClose(() => preview?.dispose());

  const targets = () => app.workspace.modulesOfType<VisualizationModule>('visualization');
  let targetId = moduleId ?? app.workspace.preferred<VisualizationModule>('visualization')?.id ?? '';
  const view = (): VizView | null => {
    const t = targets().find((x) => x.id === targetId);
    if (t?.module.view) return t.module.view;
    if (!preview) {
      preview = new VizView(app.graphics, previewBox, { preset: app.preset(app.get<string>('visualization.default_animation')) ?? app.presets()[0] }, () => app.overlays.isOpen('animation-editor'));
      preview.events.on('built', () => render());
    }
    return preview;
  };
  const mod = (): VisualizationModule | null => targets().find((x) => x.id === targetId)?.module ?? null;
  const setParam = (k: string, v: number | boolean | string) => { const m = mod(); if (m) m.setParam(k, v); else view()?.setParam(k, v); };
  const persist = () => {
    const m = mod();
    const v = view();
    if (!m || !v) return;
    app.workspace.patchModuleConfig(targetId, { bindings: v.bindings, expressions: v.expressions });
  };

  let scrub: HTMLInputElement | null = null;
  const offFrame = app.graphics.events.on('frame', () => {
    const v = view();
    if (!scrub || !v || document.activeElement === scrub) return;
    const d = v.preset.timeline?.duration ?? 60;
    scrub.value = String((v.time % d) / d);
  });
  p.onClose(offFrame);

  function render(): void {
    const v = view();
    if (!v) return;
    const def = ENGINES[v.preset.engine];
    const presets = app.presets();
    const sec = (title: string, ...rows: (HTMLElement | string)[]) => h('section.ae-section', h('h4', title), ...rows);

    // Target + preset
    const tSel = h('select', ...targets().map((t) => h('option', { value: t.id }, `${app.workspace.current?.modules.find((m) => m.id === t.id)?.title || t.module.view?.preset.name || t.id}`)), h('option', { value: '' }, 'Editor preview'));
    tSel.value = targets().some((t) => t.id === targetId) ? targetId : '';
    tSel.addEventListener('change', () => { targetId = tSel.value; render(); });
    const pSel = h('select', ...['neural', 'scientific', 'cybernetic', 'abstract', 'custom'].map((c) => h('optgroup', { label: c.toUpperCase() }, ...presets.filter((x) => x.category === c).map((x) => h('option', { value: x.id }, x.name)))));
    pSel.value = v.preset.id;
    pSel.addEventListener('change', () => { const m = mod(); if (m) m.loadPreset(pSel.value); else v.loadPreset(app.preset(pSel.value)!); setTimeout(render, 50); });
    const userPreset = !v.preset.builtin;
    const presetSection = sec('PRESET',
      field('TARGET', tSel), tSel.value === '' ? previewBox : '',
      field('PRESET', pSel),
      h('p.dim', `${def?.name ?? v.preset.engine} — ${v.preset.description}`),
      def ? h('p', { class: def.artistic ? 'note artistic' : 'note science' }, def.artistic ? `ARTISTIC SIMULATION. ${def.science ?? ''}` : `MODEL: ${def.science ?? ''}`) : '',
      h('div.row.wrap',
        h('button.primary', { onclick: () => void savePreset(false) }, userPreset ? 'SAVE PRESET' : 'SAVE AS NEW PRESET'),
        h('button', { onclick: () => void savePreset(true) }, 'DUPLICATE'),
        userPreset ? h('button.danger', { onclick: async () => { if (await app.overlays.confirm({ title: 'Delete preset', message: `Delete preset "${v.preset.name}"?`, danger: true, confirm: 'Delete' })) { await bridge.config.deletePreset(v.preset.id); await app.reloadPresets(); render(); } } }, 'DELETE') : '',
        h('button', { onclick: async () => { const r = await bridge.config.importPreset(); if (r) { app.overlays.toast(r.ok ? `Imported preset "${r.preset.name}"` : `Import failed: ${r.error}`, r.ok ? 'ok' : 'error'); await app.reloadPresets(); render(); } } }, 'IMPORT'),
        h('button', { onclick: () => void bridge.config.exportPreset(currentPreset(v, v.preset.id, v.preset.name)).then((pth) => pth && app.overlays.toast(`Exported ${pth}`, 'ok')) }, 'EXPORT'),
        h('button', { onclick: () => { v.resetParams(); app.workspace.patchModuleConfig(targetId, { params: {} }); setTimeout(render, 80); } }, 'RESET PARAMETERS'),
      ),
    );

    // Playback / camera / seed
    scrub = h('input', { type: 'range', min: '0', max: '1', step: '0.001', value: '0' });
    scrub.addEventListener('input', () => { const d = v.preset.timeline?.duration ?? 60; v.time = Number(scrub!.value) * d; v.markDirty(); });
    const speed = paramInput({ key: 'speed', label: '', type: 'number', default: 1, min: 0, max: 4, step: 0.05 }, v.speed, (x) => (v.speed = Number(x)));
    const cam = h('select', ...(def?.cameraModes ?? CAMERA_MODES).map((c) => h('option', { value: c }, c.toUpperCase())));
    cam.value = v.rig.mode;
    cam.addEventListener('change', () => { const m = mod(); if (m) m.setCamera(cam.value as CameraMode); else v.setCamera(cam.value as CameraMode); });
    const seed = h('input', { type: 'number', value: String(v.seed), class: 'num' });
    seed.addEventListener('change', () => { const s = Math.abs(Math.floor(Number(seed.value) || 0)); const m = mod(); if (m) m.setSeed(s); else v.setSeed(s); });
    const playback = sec('PLAYBACK & CAMERA',
      h('div.row.wrap',
        h('button', { onclick: () => { v.playing = !v.playing; v.markDirty(); render(); } }, v.playing ? '❚❚ PAUSE' : '▶ RESUME'),
        h('button', { onclick: () => v.restart() }, '⟲ RESTART'),
        h('button', { onclick: () => { v.time = 0; v.markDirty(); } }, '⏮ t=0'),
      ),
      field('TIMELINE', scrub, { description: v.preset.timeline ? `${v.preset.timeline.duration}s ${v.preset.timeline.loop ? 'loop' : 'once'} — scrubbing moves simulation time; fully shader-driven engines are exactly scrubbable, event-driven simulations continue from the new time.` : 'Scrubs simulation time (0–60 s).' }),
      field('SPEED', speed), field('CAMERA', cam),
      field('SEED', h('span.row', seed, h('button.ghost', { title: 'Randomize', onclick: () => { const s = Math.floor(Math.random() * 2147483647); seed.value = String(s); const m = mod(); if (m) m.setSeed(s); else v.setSeed(s); } }, '🎲'))),
    );

    // Parameters
    const paramSections = def ? groupParams(def.params).map(([group, specs]) => sec(`PARAMETERS · ${group.toUpperCase()}`, ...specs.map((s) => {
      const expr = v.expressions[s.key];
      const control = expr ? h('code.expr', `= ${expr}`) : paramInput(s, v.params[s.key], (x) => setParam(s.key, x));
      const exprBtn = s.type === 'number' || s.type === 'int' ? h('button.ghost', { title: 'Drive with an expression of time and data sources', onclick: async () => {
        const val = await app.overlays.prompt({ title: `Expression for ${s.label}`, label: 'Expression (variables: t, cpu.load, mem.used, audio.bass, …). Empty removes it.', value: expr ?? '', validate: (x) => { if (!x.trim()) return null; const c = tryCompile(x); return 'error' in c ? c.error : null; } });
        if (val === null) return;
        const next = { ...v.expressions };
        if (val.trim()) next[s.key] = val.trim(); else delete next[s.key];
        const m = mod();
        if (m) m.setExpressions(next); else { v.expressions = next; v.rebuild(true); }
        setTimeout(render, 60);
      } }, 'ƒ') : '';
      return field(s.label, h('span.row', control, exprBtn), { description: s.description, badge: s.rebuild ? 'REBUILD' : undefined });
    }))) : [];

    // Bindings
    const sources = app.data.list();
    const bindingRows = v.bindings.map((b, i) => {
      const src = h('select', ...sources.map((s) => h('option', { value: s.id }, `${s.kind === 'live' ? '● ' : s.kind === 'sim' ? '○ ' : '◆ '}${s.label}`)));
      src.value = b.source;
      const parSel = h('select', ...(def?.params ?? []).filter((x) => (x.type === 'number' || x.type === 'int') && !x.rebuild).map((x) => h('option', { value: x.key }, x.label)));
      parSel.value = b.param;
      const nums = (['inMin', 'inMax', 'outMin', 'outMax'] as const).map((k) => { const inp = h('input', { type: 'number', value: String(b[k]), class: 'num', title: k, step: 'any' }); inp.addEventListener('change', () => update(i, { [k]: Number(inp.value) })); return inp; });
      src.addEventListener('change', () => update(i, { source: src.value }));
      parSel.addEventListener('change', () => update(i, { param: parSel.value }));
      return h('div.binding', parSel, h('span.dim', '←'), src, ...nums, h('button.ghost', { onclick: () => setBindings(v.bindings.filter((_, j) => j !== i)) }, '✕'));
    });
    const update = (i: number, patch: Partial<Binding>) => setBindings(v.bindings.map((b, j) => (j === i ? { ...b, ...patch } : b)));
    const setBindings = (next: Binding[]) => { const m = mod(); if (m) m.setBindings(next); else { v.bindings = next; v.rebuild(true); } setTimeout(render, 60); };
    const bindings = sec('DATA BINDINGS', h('p.dim', '● live measurement  ○ simulated  ◆ file/function. Maps a source range onto a parameter range with smoothing.'), ...bindingRows,
      h('button', { onclick: () => { const first = def?.params.find((x) => (x.type === 'number' || x.type === 'int') && !x.rebuild); if (first) setBindings([...v.bindings, { param: first.key, source: 'cpu.load', inMin: 0, inMax: 100, outMin: first.min ?? 0, outMax: first.max ?? 1, smoothing: 0.85 }]); } }, '+ ADD BINDING'));

    // Timeline (keyframes)
    const tl = v.preset.timeline ?? { duration: 30, loop: true, tracks: [] as Track[] };
    const setTimeline = (next: NonNullable<Preset['timeline']>) => {
      v.preset = { ...v.preset, timeline: next };
      v.markDirty();
      render();
    };
    const dur = h('input', { type: 'number', min: '0.5', max: '3600', value: String(tl.duration), class: 'num' });
    dur.addEventListener('change', () => setTimeline({ ...tl, duration: Math.max(0.5, Number(dur.value) || 30) }));
    const loop = h('input', { type: 'checkbox' });
    loop.checked = tl.loop;
    loop.addEventListener('change', () => setTimeline({ ...tl, loop: loop.checked }));
    const enabled = h('input', { type: 'checkbox' });
    enabled.checked = v.timelineEnabled;
    enabled.addEventListener('change', () => (v.timelineEnabled = enabled.checked));
    const trackEls = tl.tracks.map((tr, ti) => {
      const bar = h('div.tl-bar', ...tr.keys.map((k) => h('i', { style: `left:${(k.t / tl.duration) * 100}%`, title: `t=${k.t}s v=${k.v}` })));
      return h('div.tl-track',
        h('div.row', h('span.mono.grow', tr.param), h('button.ghost', { title: 'Add keyframe at current time with current value', onclick: () => {
          const t = Math.round((v.time % tl.duration) * 100) / 100;
          const value = Number(v.params[tr.param] ?? 0);
          const keys = [...tr.keys.filter((k) => Math.abs(k.t - t) > 0.01), { t, v: value, ease: 'smooth' as const }].sort((a, b) => a.t - b.t);
          setTimeline({ ...tl, tracks: tl.tracks.map((x, j) => (j === ti ? { ...x, keys } : x)) });
        } }, '◆+'), h('button.ghost', { onclick: () => setTimeline({ ...tl, tracks: tl.tracks.filter((_, j) => j !== ti) }) }, '✕')),
        bar,
        ...tr.keys.map((k, ki) => {
          const tIn = h('input', { type: 'number', value: String(k.t), class: 'num', step: '0.1' });
          const vIn = h('input', { type: 'number', value: String(k.v), class: 'num', step: 'any' });
          const ease = h('select', ...['linear', 'smooth', 'step', 'in', 'out'].map((e) => h('option', { value: e }, e)));
          ease.value = k.ease;
          const write = () => setTimeline({ ...tl, tracks: tl.tracks.map((x, j) => (j === ti ? { ...x, keys: x.keys.map((kk, kj) => (kj === ki ? { t: Math.max(0, Number(tIn.value) || 0), v: Number(vIn.value) || 0, ease: ease.value as Track['keys'][number]['ease'] } : kk)).sort((a, b) => a.t - b.t) } : x)) });
          [tIn, vIn, ease].forEach((e) => e.addEventListener('change', write));
          return h('div.row.kf', h('span.dim', 't'), tIn, h('span.dim', 'v'), vIn, ease, h('button.ghost', { onclick: () => setTimeline({ ...tl, tracks: tl.tracks.map((x, j) => (j === ti ? { ...x, keys: x.keys.filter((_, kj) => kj !== ki) } : x)) }) }, '✕'));
        }),
      );
    });
    const addTrackSel = h('select', ...(def?.params ?? []).filter((x) => (x.type === 'number' || x.type === 'int') && !x.rebuild).map((x) => h('option', { value: x.key }, x.label)));
    const timeline = sec('TIMELINE · KEYFRAMES',
      h('div.row.wrap', h('span.label', 'DURATION'), dur, h('label.row', loop, h('span.label', 'LOOP')), h('label.row', enabled, h('span.label', 'ENABLED'))),
      ...trackEls,
      h('div.row', addTrackSel, h('button', { onclick: () => setTimeline({ ...tl, tracks: [...tl.tracks, { param: addTrackSel.value, keys: [{ t: 0, v: Number(v.params[addTrackSel.value] ?? 0), ease: 'smooth' }] }] }) }, '+ TRACK')),
      h('p.dim', 'Camera animation: use the cinematic camera mode or keyframe cameraSpeed. Keyframes are saved with the preset.'),
    );

    // Layers
    const m = mod();
    const layers = (app.workspace.current?.modules.find((x) => x.id === targetId)?.config.layers as { preset: string; opacity: number }[] | undefined) ?? [];
    const layerSection = m ? sec('LAYERS', h('p.dim', 'Composite up to three additional presets additively in the same view.'),
      ...layers.map((l, i) => {
        const s = h('select', ...presets.map((x) => h('option', { value: x.id }, x.name)));
        s.value = l.preset;
        const o = paramInput({ key: 'o', label: '', type: 'number', default: 0.5, min: 0, max: 1, step: 0.01 }, l.opacity, (val) => m.setLayers(layers.map((x, j) => (j === i ? { ...x, opacity: Number(val) } : x))));
        s.addEventListener('change', () => m.setLayers(layers.map((x, j) => (j === i ? { ...x, preset: s.value } : x))));
        return h('div.row', s, o, h('button.ghost', { onclick: () => { m.setLayers(layers.filter((_, j) => j !== i)); setTimeout(render, 80); } }, '✕'));
      }),
      layers.length < 3 ? h('button', { onclick: () => { m.setLayers([...layers, { preset: 'particle-ocean', opacity: 0.5 }]); setTimeout(render, 80); } }, '+ LAYER') : '',
    ) : '';

    // Recording
    const rec = sec('RECORDING & EXPORT',
      ...['recording.format', 'recording.width', 'recording.height', 'recording.fps', 'recording.duration', 'recording.quality'].map((k) => {
        const d = SETTINGS_BY_KEY.get(k)!;
        return field(d.label, settingInput(d, app.get(k), (val) => void app.set({ [k]: val })));
      }),
      h('div.row.wrap',
        m ? h('button.primary', { onclick: () => void m.toggleRecording().then((msg) => app.overlays.toast(msg, 'info')) }, m.recording ? '■ STOP' : '⏺ RECORD') : '',
        m ? h('button', { onclick: () => void m.screenshot().then((pth) => app.overlays.toast(`Saved ${pth}`, 'ok')) }, 'PNG SCREENSHOT') : h('span.dim', 'Recording is available for visualization modules in the workspace.'),
        m && v.preset.engine === 'molecule' ? h('button', { onclick: () => void m.loadXyzFile() }, 'LOAD XYZ…') : '',
      ),
    );

    body.replaceChildren(presetSection, playback, ...paramSections, bindings, timeline, layerSection, rec);
    void persist;
  }

  function currentPreset(v: VizView, id: string, name: string): Preset {
    return PresetSchema.parse({
      id, name, engine: v.preset.engine, category: 'custom', description: v.preset.description,
      params: { ...v.preset.params, ...v.userParams }, camera: v.rig.mode,
      timeline: v.preset.timeline, bindings: v.bindings.length ? v.bindings : undefined, expressions: Object.keys(v.expressions).length ? v.expressions : undefined,
    });
  }

  async function savePreset(asNew: boolean): Promise<void> {
    const v = view();
    if (!v) return;
    let id = v.preset.id, name = v.preset.name;
    if (asNew || v.preset.builtin) {
      const nm = await app.overlays.prompt({ title: 'Save preset', label: 'Preset name', value: `${v.preset.name} (custom)` });
      if (!nm) return;
      name = nm.trim().slice(0, 64);
      id = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'preset';
      if (app.presets().some((x) => x.id === id && x.builtin)) id = `${id}-custom`;
    }
    const r = await bridge.config.savePreset(currentPreset(v, id, name));
    if (!r.ok) return app.overlays.toast(`Preset not saved: ${r.error}`, 'error');
    await app.reloadPresets();
    const m = mod();
    if (m) m.loadPreset(r.preset.id);
    else v.loadPreset(clone(r.preset), true);
    app.overlays.toast(`Saved preset "${r.preset.name}"`, 'ok');
    setTimeout(render, 80);
  }

  render();
}
