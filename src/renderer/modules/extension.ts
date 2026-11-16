/**
 * Third-party module host.
 *  - kind "panel":  declarative widgets bound to data sources (no code runs)
 *  - kind "script": the module's HTML runs in a sandboxed iframe with an opaque
 *    origin, no Node, no preload, no network (CSP default-src 'none'); it only
 *    receives values for data sources its *approved* permissions cover.
 */
import { SynModule, registerModuleType, unregisterModuleType, moduleTypes, type ModuleContext } from '../workspace/module';
import type { App } from '../core/app';
import type { ExtensionInfo } from '../core/bridge';
import { sourcePermission } from '../../shared/manifest';
import { fmt, formatRate, h, Ring } from '../core/util';
import { tryCompile } from '../../shared/expression';
import { METRICS } from '../core/monitor';

function allowed(info: ExtensionInfo, source: string): boolean {
  const p = sourcePermission(source);
  return !!p && info.approved.includes(p);
}

class PanelExtension extends SynModule {
  private timer: ReturnType<typeof setInterval> | null = null;
  private releases: (() => void)[] = [];
  constructor(ctx: ModuleContext, private info: ExtensionInfo) {
    super(ctx);
  }
  mount(): void {
    const panel = this.info.manifest!.panel!;
    this.ctx.setTitle(panel.title);
    this.ctx.setStatus(`EXTENSION · ${this.info.manifest!.author}`);
    const rows = panel.widgets.map((w) => {
      const source = w.source && allowed(this.info, w.source) ? w.source : undefined;
      if (source) this.releases.push(this.ctx.app.data.acquire(source));
      const valEl = h('span.tv', '—');
      const barI = h('i');
      const ring = new Ring(120);
      const canvas = h('canvas.spark');
      const el = h('div.tcell', h('span.label', w.label.toUpperCase()), w.kind === 'label' ? '' : valEl, w.kind === 'bar' ? h('div.bar', barI) : '', w.kind === 'sparkline' ? canvas : '');
      return { w, source, valEl, barI, ring, canvas, el };
    });
    this.ctx.body.append(h('div.telemetry', ...rows.map((r) => r.el)));
    this.timer = setInterval(() => {
      if (!this.ctx.visible()) return;
      for (const r of rows) {
        let v: number | null = null;
        if (r.w.expression) {
          const c = tryCompile(r.w.expression);
          if (!('error' in c)) v = c.fn((n) => (n === 't' ? this.ctx.app.data.time : allowed(this.info, n) ? this.ctx.app.data.value(n) ?? undefined : undefined));
        } else if (r.source) v = this.ctx.app.data.value(r.source);
        if (v === null) { r.valEl.textContent = r.w.source && !r.source ? 'not permitted' : 'n/a'; continue; }
        const unit = r.w.unit ?? METRICS[r.source ?? '']?.unit ?? '';
        r.valEl.textContent = unit === 'B/s' ? formatRate(v) : `${fmt(v, 1)}${unit ? ' ' + unit : ''}`;
        const lo = r.w.min ?? 0, hi = r.w.max ?? 100;
        r.barI.style.width = `${Math.max(0, Math.min(100, ((v - lo) / (hi - lo || 1)) * 100))}%`;
        r.ring.push(v);
      }
    }, 500);
  }
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    for (const r of this.releases) r();
  }
}

class ScriptExtension extends SynModule {
  private frame: HTMLIFrameElement | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private wanted = new Set<string>();
  private releases: (() => void)[] = [];
  private onMsg = (e: MessageEvent) => {
    if (!this.frame || e.source !== this.frame.contentWindow) return;
    const msg = e.data as { type?: string; sources?: unknown };
    if (msg?.type === 'subscribe' && Array.isArray(msg.sources)) {
      for (const s of msg.sources.slice(0, 32)) {
        if (typeof s === 'string' && allowed(this.info, s) && !this.wanted.has(s)) {
          this.wanted.add(s);
          this.releases.push(this.ctx.app.data.acquire(s));
        }
      }
    }
  };
  constructor(ctx: ModuleContext, private info: ExtensionInfo) {
    super(ctx);
  }
  mount(): void {
    const app = this.ctx.app;
    this.ctx.body.classList.add('flush');
    if (!app.get<boolean>('security.allow_extension_scripts')) {
      this.ctx.body.append(h('div.na.pad', `"${this.info.manifest!.name}" runs JavaScript. Enable Settings → Modules → Allow extension scripts to use it (it will still run isolated in a sandbox without network access).`));
      return;
    }
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts');
    f.setAttribute('referrerpolicy', 'no-referrer');
    f.className = 'ext-frame';
    f.src = `app://synapse/ext/${this.info.id}/${this.info.manifest!.entry}`;
    this.frame = f;
    this.ctx.body.append(f);
    window.addEventListener('message', this.onMsg);
    this.ctx.setStatus(`SANDBOXED · ${this.info.approved.join(', ')}`);
    this.timer = setInterval(() => {
      if (!this.ctx.visible() || !f.contentWindow) return;
      const values: Record<string, number | null> = {};
      for (const s of this.wanted) values[s] = app.data.value(s);
      const t = app.activeTheme;
      f.contentWindow.postMessage({ type: 'data', values, theme: { fg: t.colors.foreground, bg: t.colors.background, accent: t.colors.accent, font: t.typography.mono_font } }, '*');
    }, 250);
  }
  dispose(): void {
    window.removeEventListener('message', this.onMsg);
    if (this.timer) clearInterval(this.timer);
    for (const r of this.releases) r();
  }
}

/** (Re)register module types for enabled panel/script extensions. */
export function syncExtensionModules(app: App): void {
  for (const t of moduleTypes()) if (t.manifest.id.startsWith('ext.')) unregisterModuleType(t.manifest.id);
  for (const info of app.extensionInfo) {
    const m = info.manifest;
    if (!info.enabled || !m || (m.kind !== 'panel' && m.kind !== 'script')) continue;
    registerModuleType({
      manifest: {
        id: `ext.${m.id}`.slice(0, 64),
        name: m.name,
        version: m.version,
        description: m.description,
        author: m.author,
        category: 'extension',
        permissions: info.approved,
        rendering: m.kind === 'script' ? 'iframe' : 'dom',
        defaultSize: m.defaultSize ?? { colSpan: 1, rowSpan: 1, w: 0.2, h: 0.18 },
        configSchema: m.configSchema ?? [],
        builtin: false,
      },
      create: (ctx) => (m.kind === 'panel' ? new PanelExtension(ctx, info) : new ScriptExtension(ctx, info)),
    });
  }
}
