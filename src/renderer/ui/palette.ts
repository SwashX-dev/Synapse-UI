/**
 * Command palette (Ctrl+Shift+P): fuzzy access to actions, workspaces, themes,
 * presets, modules and settings — and, with ">" or "synapse", the full
 * application command language with completion and output.
 */
import type { App } from '../core/app';
import { fuzzyScore, h } from '../core/util';
import { moduleTypes } from '../workspace/module';
import { SETTINGS_CATEGORIES } from '../../shared/settings';

interface Item { label: string; detail: string; kind: string; run: () => void | Promise<void> }

export function openPalette(app: App, initial = ''): void {
  if (app.overlays.isOpen('palette')) { app.overlays.closePanel('palette'); return; }
  const p = app.overlays.panel('palette', 'COMMAND PALETTE', { width: 'min(720px, 92vw)', className: 'palette', subtitle: 'type > for synapse commands' });
  const input = h('input.palette-input', { placeholder: 'Search actions, workspaces, themes, animations… or type > for commands', spellcheck: 'false', value: initial });
  const list = h('div.palette-list.scroll', { role: 'listbox' });
  const out = h('pre.palette-out');
  out.hidden = true;
  p.body.append(input, list, out);
  let sel = 0;
  let items: Item[] = [];

  const base = (): Item[] => [
    ...app.commands.list().map((a) => ({ label: a.label, detail: `${a.category}${app.keys.accelFor(a.id) ? ' · ' + app.keys.accelFor(a.id) : ''}`, kind: 'ACTION', run: a.run })),
    ...app.workspace.list().map((w) => ({ label: `Workspace: ${w.name}`, detail: w.description, kind: 'WORKSPACE', run: () => void app.workspace.switchTo(w.id) })),
    ...app.themes.map((t) => ({ label: `Theme: ${t.name}`, detail: t.description, kind: 'THEME', run: () => void app.commands.execute(['theme', 'set', t.id]) })),
    ...app.presets().map((pr) => ({ label: `Animation: ${pr.name}`, detail: pr.description, kind: 'ANIMATION', run: () => void app.commands.execute(['animation', 'load', pr.id]).then((r) => !r.ok && app.overlays.toast(r.output, 'warn')) })),
    ...moduleTypes().map((t) => ({ label: `Add module: ${t.manifest.name}`, detail: t.manifest.description, kind: 'MODULE', run: () => void app.commands.execute(['module', 'add', t.manifest.id]) })),
    ...SETTINGS_CATEGORIES.map((c) => ({ label: `Settings: ${c}`, detail: 'Open settings', kind: 'SETTINGS', run: () => app.overlays.openSettings(c) })),
  ];

  const commandMode = () => input.value.startsWith('>') || input.value.startsWith('synapse ');
  const commandText = () => input.value.replace(/^>\s*/, '').replace(/^synapse\s+/, '');

  function render(): void {
    if (commandMode()) {
      const text = commandText();
      items = app.commands.completions(text).filter((c) => !text || c.startsWith(text.split(' ').slice(0, -1).join(' ')) || fuzzyScore(text, c) > 0).sort((a, b) => fuzzyScore(text, b) - fuzzyScore(text, a)).slice(0, 40)
        .map((c) => ({ label: `synapse ${c}`, detail: 'Tab to complete · Enter to run', kind: 'COMMAND', run: () => { input.value = `> ${c} `; render(); } }));
    } else {
      const q = input.value.trim();
      items = base().map((it) => ({ it, s: fuzzyScore(q, `${it.label} ${it.kind}`) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 60).map((x) => x.it);
    }
    sel = Math.min(sel, Math.max(0, items.length - 1));
    list.replaceChildren(...items.map((it, i) => {
      const row = h('div.palette-item', { role: 'option', class: i === sel ? 'sel' : '', 'aria-selected': String(i === sel) }, h('span.kind', it.kind), h('span.lbl', it.label), h('span.det', it.detail));
      row.addEventListener('mousedown', (e) => { e.preventDefault(); sel = i; choose(); });
      return row;
    }));
    (list.children[sel] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  }

  async function choose(): Promise<void> {
    if (commandMode()) {
      const text = commandText().trim();
      if (!text) return;
      const r = await app.commands.execute(text);
      out.hidden = false;
      out.textContent = r.output;
      out.classList.toggle('error', !r.ok);
      app.sounds.play(r.ok ? 'granted' : 'denied', 0.5);
      return;
    }
    const it = items[sel];
    if (!it) return;
    p.close();
    await it.run();
  }

  input.addEventListener('input', () => { sel = 0; out.hidden = true; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render(); }
    else if (e.key === 'Tab' && commandMode() && items[sel]) { e.preventDefault(); input.value = `> ${items[sel].label.replace(/^synapse /, '')} `; render(); }
    else if (e.key === 'Enter') { e.preventDefault(); void choose(); }
  });
  render();
  setTimeout(() => input.focus(), 20);
}
