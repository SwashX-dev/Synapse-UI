/** Module manager (installed modules, permissions, third-party import) and per-instance module settings. */
import type { App } from '../core/app';
import { bridge } from '../core/bridge';
import { h } from '../core/util';
import { moduleType, moduleTypes } from '../workspace/module';
import { PERMISSIONS } from '../../shared/manifest';
import { addModule, clone } from '../../shared/workspace';
import { colorInput, field, paramInput } from './form';
import { syncExtensionModules } from '../modules/extension';
import type { ThemeOverride } from '../../shared/theme';

const perm = (p: string) => {
  const info = PERMISSIONS[p];
  return h('span.perm', { class: info?.risk ?? 'low', title: info?.description ?? p }, info?.label ?? p);
};

export function openModuleManager(app: App): void {
  const p = app.overlays.panel('modules', 'MODULE MANAGER', { width: 'min(1040px, 94vw)', height: 'min(86vh, 900px)', subtitle: `${moduleTypes().length} module types` });
  const body = h('div.scroll.mm-body');
  p.body.append(body);
  const render = () => {
    const ws = app.workspace.current;
    const used = new Map<string, number>();
    for (const m of ws?.modules ?? []) used.set(m.type, (used.get(m.type) ?? 0) + 1);
    const builtin = moduleTypes().filter((t) => t.manifest.builtin !== false).sort((a, b) => a.manifest.category.localeCompare(b.manifest.category) || a.manifest.name.localeCompare(b.manifest.name));
    body.replaceChildren(
      h('h4', 'BUILT-IN MODULES'),
      h('div.card-list', ...builtin.map((t) => h('div.card',
        h('div.grow', h('div', t.manifest.name, h('span.dim', ` v${t.manifest.version} · ${t.manifest.category} · ${t.manifest.rendering}`)), h('small.dim', t.manifest.description), h('div.perms', ...t.manifest.permissions.map(perm))),
        h('span.dim', used.get(t.manifest.id) ? `${used.get(t.manifest.id)} in workspace` : ''),
        h('button', { onclick: () => { if (!ws) return; const r = addModule(ws, t.manifest.id, { defaultSize: t.manifest.defaultSize, config: t.manifest.id === 'visualization' ? { preset: app.get<string>('visualization.default_animation') } : {} }); app.workspace.apply(r.ws); app.overlays.toast(`Added ${t.manifest.name}`, 'ok'); render(); } }, 'ADD'),
        used.get(t.manifest.id) ? h('button.danger', { onclick: async () => { if (!ws) return; if (!(await app.overlays.confirm({ title: 'Remove modules', message: `Remove all ${used.get(t.manifest.id)} "${t.manifest.name}" module(s) from this workspace?`, danger: true, confirm: 'Remove' }))) return; app.workspace.apply({ ...clone(ws), modules: ws.modules.filter((m) => m.type !== t.manifest.id) }); render(); } }, 'REMOVE ALL') : '',
      ))),
      h('h4', 'THIRD-PARTY MODULES'),
      h('p.dim', 'Third-party modules live in <config>/modules/<id>/manifest.json. Declarative modules (presets, themes, panels) never run code. Script modules run in an isolated, network-less sandbox and only after you allow extension scripts and approve their permissions.'),
      h('div.row.wrap',
        h('button.primary', { onclick: async () => { const r = await bridge.ext.importDir(); if (!r) return; if (r.ok) { app.overlays.toast(`Imported ${r.info.id} (disabled until you approve it)`, 'ok'); await app.reloadExtensions(); syncExtensionModules(app); render(); } else app.overlays.toast(`Import failed: ${r.error}`, 'error', 8000); } }, 'IMPORT MODULE FOLDER…'),
        h('button', { onclick: () => void bridge.app.openPath('modules') }, 'OPEN MODULES FOLDER'),
        h('button', { onclick: async () => { await app.reloadExtensions(); syncExtensionModules(app); render(); } }, 'RESCAN'),
        h('label.row', (() => { const cb = h('input', { type: 'checkbox' }); cb.checked = app.get<boolean>('security.allow_extension_scripts'); cb.addEventListener('change', async () => { if (cb.checked && !(await app.overlays.confirm({ title: 'Allow extension scripts', message: 'Allow approved third-party modules to run their own JavaScript inside an isolated sandbox (no Node.js, no network, no access to SYNAPSE-UI)? Only enable this for modules you trust.', confirm: 'Allow', danger: true }))) { cb.checked = false; return; } await app.set({ 'security.allow_extension_scripts': cb.checked }); render(); }); return cb; })(), h('span.label', 'ALLOW EXTENSION SCRIPTS')),
      ),
      h('div.card-list', ...(app.extensionInfo.length ? app.extensionInfo.map((e) => {
        const m = e.manifest;
        return h('div.card', { class: e.errors.length ? 'error' : '' },
          h('div.grow',
            h('div', m?.name ?? e.id, h('span.dim', m ? ` v${m.version} · ${m.kind} · by ${m.author}` : ' (invalid manifest)')),
            m ? h('small.dim', m.description) : '',
            h('div.perms', ...(m?.permissions ?? []).map((pp) => h('span', { class: e.approved.includes(pp) ? 'approved' : 'pending' }, perm(pp)))),
            ...e.errors.map((x) => h('div.form-error', x)), ...e.warnings.map((x) => h('div.dim', `⚠ ${x}`)),
          ),
          m && !e.errors.length && e.pending.length ? h('button', { onclick: async () => {
            const list = m.permissions.map((pp) => `• ${PERMISSIONS[pp]?.label ?? pp} (${PERMISSIONS[pp]?.risk ?? '?'} risk): ${PERMISSIONS[pp]?.description ?? ''}`).join('\n');
            if (!(await app.overlays.confirm({ title: `Approve ${m.name}`, message: `${m.name} requests:\n${list}`, confirm: 'Approve', danger: m.permissions.some((pp) => PERMISSIONS[pp]?.risk === 'high') }))) return;
            await bridge.ext.approve(e.id, m.permissions);
            await app.reloadExtensions(); syncExtensionModules(app); render();
          } }, 'APPROVE…') : '',
          m && !e.errors.length && !e.pending.length ? h('button', { onclick: async () => { try { await bridge.ext.setEnabled(e.id, !e.enabled); } catch (err) { app.overlays.toast((err as Error).message, 'error'); } await app.reloadExtensions(); syncExtensionModules(app); render(); } }, e.enabled ? 'DISABLE' : 'ENABLE') : '',
          m && e.approved.length ? h('button', { onclick: async () => { await bridge.ext.approve(e.id, []); await app.reloadExtensions(); syncExtensionModules(app); render(); } }, 'REVOKE') : '',
          h('button.danger', { onclick: async () => { if (await app.overlays.confirm({ title: 'Remove module', message: `Delete ${e.id} from the modules folder?`, danger: true, confirm: 'Delete' })) { await bridge.ext.remove(e.id); await app.reloadExtensions(); syncExtensionModules(app); render(); } } }, 'DELETE'),
        );
      }) : [h('div.na', 'No third-party modules installed. See docs/MODULE_API.md and examples/ for samples.')])),
      h('h4', 'RESTORE'),
      h('div.row', h('button', { onclick: async () => {
        if (!ws || !(await app.overlays.confirm({ title: 'Restore default modules', message: `Reset "${ws.name}" to its default module set?`, confirm: 'Restore', danger: true }))) return;
        await app.workspace.resetToDefault(); render();
      } }, 'RESTORE DEFAULT MODULES FOR THIS WORKSPACE')),
    );
  };
  render();
}

const STYLE_COLORS = ['background', 'surface', 'foreground', 'text', 'border', 'accent', 'glow', 'neural', 'particle'] as const;

export function openModuleSettings(app: App, id: string): void {
  const ws = app.workspace.current;
  const inst = ws?.modules.find((m) => m.id === id);
  if (!ws || !inst) return;
  const t = moduleType(inst.type);
  const p = app.overlays.panel(`module-${id}`, `${(inst.title || t?.manifest.name || inst.type).toUpperCase()} · SETTINGS`, { width: 'min(640px, 92vw)', height: 'min(80vh, 820px)', subtitle: id });
  const body = h('div.scroll');
  p.body.append(body);
  const patchStyle = (fn: (s: ThemeOverride) => void) => {
    const cur = app.workspace.current!;
    const next = clone(cur);
    const m = next.modules.find((x) => x.id === id)!;
    const s: ThemeOverride = clone(m.style ?? {});
    fn(s);
    m.style = s;
    app.workspace.apply(next);
  };
  const render = () => {
    const m = app.workspace.current?.modules.find((x) => x.id === id);
    if (!m) { p.close(); return; }
    const theme = app.moduleTheme(m.type, m.style);
    const schema = t?.manifest.configSchema ?? [];
    body.replaceChildren(
      t ? h('p.dim', t.manifest.description) : h('div.form-error', 'Module type not installed.'),
      t ? h('div.perms', ...t.manifest.permissions.map(perm)) : '',
      h('h4', 'MODULE'),
      ...schema.map((s) => field(s.label, paramInput(s, m.config[s.key] ?? s.default, (v) => app.workspace.patchModuleConfig(id, { [s.key]: v })), { description: s.description })),
      m.type === 'visualization' ? h('div.row', h('button.primary', { onclick: () => { p.close(); app.overlays.openAnimationEditor(id); } }, 'OPEN ANIMATION EDITOR')) : '',
      h('h4', 'APPEARANCE (THIS MODULE ONLY)'),
      ...STYLE_COLORS.map((k) => field(k.toUpperCase(), colorInput(m.style?.colors?.[k] ?? '', (v) => patchStyle((s) => { s.colors = { ...s.colors, [k]: v || undefined }; }), true), { onReset: m.style?.colors?.[k] ? () => { patchStyle((s) => { if (s.colors) delete s.colors[k]; }); render(); } : undefined })),
      field('BORDER THICKNESS', paramInput({ key: 'bw', label: '', type: 'number', default: theme.effects.border_width, min: 0, max: 6, step: 0.5 }, theme.effects.border_width, (v) => patchStyle((s) => { s.effects = { ...s.effects, border_width: Number(v) }; }))),
      field('BORDER TRANSPARENCY', paramInput({ key: 'ba', label: '', type: 'number', default: theme.effects.border_alpha, min: 0, max: 1, step: 0.01 }, theme.effects.border_alpha, (v) => patchStyle((s) => { s.effects = { ...s.effects, border_alpha: Number(v) }; }))),
      field('GLOW INTENSITY', paramInput({ key: 'gi', label: '', type: 'number', default: theme.effects.glow_intensity, min: 0, max: 2, step: 0.01 }, theme.effects.glow_intensity, (v) => patchStyle((s) => { s.effects = { ...s.effects, glow_intensity: Number(v) }; }))),
      field('SHADOW INTENSITY', paramInput({ key: 'si', label: '', type: 'number', default: theme.effects.shadow_intensity, min: 0, max: 1, step: 0.01 }, theme.effects.shadow_intensity, (v) => patchStyle((s) => { s.effects = { ...s.effects, shadow_intensity: Number(v) }; }))),
      field('PANEL OPACITY', paramInput({ key: 'pa', label: '', type: 'number', default: theme.effects.panel_alpha, min: 0, max: 1, step: 0.01 }, theme.effects.panel_alpha, (v) => patchStyle((s) => { s.effects = { ...s.effects, panel_alpha: Number(v) }; }))),
      field('FONT SIZE', paramInput({ key: 'fs', label: '', type: 'number', default: theme.typography.font_size, min: 8, max: 24, step: 0.5 }, theme.typography.font_size, (v) => patchStyle((s) => { s.typography = { ...s.typography, font_size: Number(v) }; }))),
      field('PADDING', paramInput({ key: 'pp', label: '', type: 'number', default: theme.spacing.panel_padding, min: 0, max: 64, step: 1 }, theme.spacing.panel_padding, (v) => patchStyle((s) => { s.spacing = { ...s.spacing, panel_padding: Number(v) }; }))),
      h('div.row', h('button', { onclick: () => { patchStyle((s) => { for (const k of Object.keys(s)) delete (s as Record<string, unknown>)[k]; }); render(); } }, 'RESET APPEARANCE')),
    );
  };
  render();
}
