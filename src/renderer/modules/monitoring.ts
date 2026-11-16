/**
 * System monitoring modules (eDEX-UI lineage, rebuilt on the unified
 * monitoring API). Values the OS does not expose are shown as "n/a".
 */
import { SynModule, registerModuleType, type ModuleContext, type ModuleManifest } from '../workspace/module';
import { bridge, type StaticInfo } from '../core/bridge';
import { fmt, formatBytes, formatDuration, formatRate, h } from '../core/util';
import { Graph } from '../ui/graph';
import type { MonitorTopic } from '../../shared/ipc';
import type { ConnData, CpuData, GpuController, MemData, NetData, ProcData, StorageItem } from '../core/monitor';

let staticInfo: Promise<StaticInfo> | null = null;
export function getStatic(): Promise<StaticInfo> {
  staticInfo ??= bridge.monitor.staticInfo();
  return staticInfo;
}

/** Base class: topic subscriptions + rAF-coalesced rendering only while visible. */
export abstract class MonitorModule extends SynModule {
  protected topics: MonitorTopic[] = [];
  private scheduled = false;
  private subs: (() => void)[] = [];

  mount(): void {
    this.build();
    if (this.ctx.app.get<boolean>('monitoring.enabled')) this.subscribeAll();
    else this.ctx.setBadge('off', 'MONITORING OFF');
  }

  private subscribeAll(): void {
    for (const t of this.topics) this.subs.push(this.ctx.app.monitor.subscribe(t, () => this.schedule()));
    this.ctx.setBadge('live');
  }

  onConfig(changed: string[]): void {
    if (changed.includes('monitoring.enabled')) {
      for (const s of this.subs) s();
      this.subs = [];
      if (this.ctx.app.get<boolean>('monitoring.enabled')) this.subscribeAll();
      else this.ctx.setBadge('off', 'MONITORING OFF');
    }
    if (changed.some((k) => k.startsWith('monitoring.'))) this.schedule();
  }

  protected schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      if (!this.ctx.visible()) return;
      try { this.render(); } catch (e) { console.error(e); }
    });
  }

  resume(): void { this.schedule(); }
  resize(): void { this.schedule(); }
  onTheme(): void { this.schedule(); }

  protected abstract build(): void;
  protected abstract render(): void;

  protected get<T>(t: MonitorTopic): T | undefined {
    return this.ctx.app.monitor.get<T>(t);
  }

  protected temp(c: number | null | undefined): string {
    if (c === null || c === undefined) return 'n/a';
    return this.ctx.app.get<string>('monitoring.temperature_unit') === 'f' ? `${(c * 9 / 5 + 32).toFixed(0)}°F` : `${c.toFixed(0)}°C`;
  }

  dispose(): void {
    for (const s of this.subs) s();
    this.subs = [];
  }
}

const kv = (rows: [string, HTMLElement | string][]) => h('div.kv', ...rows.flatMap(([k, v]) => [h('span.k', k), typeof v === 'string' ? h('span.v', v) : v]));
const val = () => h('span.v', '—');
function manifest(id: string, name: string, description: string, size: ModuleManifest['defaultSize'], permissions: string[], extra: Partial<ModuleManifest> = {}): ModuleManifest {
  return { id, name, version: '1.0.0', description, author: 'SYNAPSE-UI (eDEX-UI lineage)', category: 'monitoring', permissions, rendering: 'dom', defaultSize: size, configSchema: [], liveData: true, ...extra };
}

// ───────────────────────── clock ─────────────────────────

class ClockModule extends MonitorModule {
  protected override topics: MonitorTopic[] = ['system'];
  private time = h('div.clock-time');
  private date = h('div.clock-date.mono');
  private timer: ReturnType<typeof setInterval> | null = null;
  protected build(): void {
    this.ctx.body.classList.add('clock-body');
    if (this.ctx.config<boolean>('compact', false)) this.ctx.body.classList.add('compact');
    this.ctx.body.append(this.time, this.date);
    this.timer = setInterval(() => this.render(), 1000);
    this.render();
  }
  protected render(): void {
    const now = new Date();
    const h24 = this.ctx.app.get<boolean>('monitoring.clock_24h');
    let hh = now.getHours();
    const suffix = h24 ? '' : hh >= 12 ? ' PM' : ' AM';
    if (!h24) hh = hh % 12 || 12;
    const parts = [hh, now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, '0'));
    this.time.replaceChildren(...parts.flatMap((p, i) => (i ? [h('em', ':'), p] : [p])), suffix);
    const sys = this.get<{ uptime: number; timezone: string }>('system');
    this.date.textContent = `${now.toISOString().slice(0, 10)}  ${sys?.timezone ?? ''}  UP ${sys ? formatDuration(sys.uptime) : '—'}`;
    this.ctx.setStatus(now.toLocaleDateString(undefined, { weekday: 'long' }).toUpperCase());
  }
  dispose(): void {
    super.dispose();
    if (this.timer) clearInterval(this.timer);
  }
}
registerModuleType({ manifest: { ...manifest('clock', 'Clock', 'eDEX-style digital clock with date, timezone and uptime.', { colSpan: 1, rowSpan: 1, w: 0.16, h: 0.09 }, []), category: 'information', configSchema: [{ key: 'compact', label: 'Compact', type: 'bool', default: false }] }, create: (c) => new ClockModule(c) });

// ───────────────────────── system info ─────────────────────────

class SysinfoModule extends MonitorModule {
  protected override topics: MonitorTopic[] = ['system', 'battery'];
  private cells = { year: val(), date: val(), uptime: val(), type: val(), power: val() };
  protected build(): void {
    this.ctx.body.append(h('div.sysinfo', ...Object.entries({ YEAR: this.cells.year, 'MON/DAY': this.cells.date, UPTIME: this.cells.uptime, TYPE: this.cells.type, POWER: this.cells.power }).map(([k, v]) => h('div.cell', h('span.label', k), v))));
    void getStatic().then((s) => { this.cells.type.textContent = (s.os?.platform ?? '—').toUpperCase(); this.ctx.setStatus(s.os?.hostname ?? ''); });
  }
  protected render(): void {
    const now = new Date();
    this.cells.year.textContent = String(now.getFullYear());
    this.cells.date.textContent = `${now.toLocaleString('en-US', { month: 'short' }).toUpperCase()} ${now.getDate()}`;
    const sys = this.get<{ uptime: number }>('system');
    if (sys) this.cells.uptime.textContent = formatDuration(sys.uptime).replace(/:\d\d$/, '');
    const b = this.get<{ hasBattery: boolean; percent: number | null; isCharging: boolean; acConnected: boolean }>('battery');
    this.cells.power.textContent = !b ? '—' : !b.hasBattery ? 'WIRED' : `${b.percent ?? '?'}%${b.isCharging ? ' CHG' : b.acConnected ? ' AC' : ''}`;
    this.ctx.app.perf.setBattery(b ?? null);
  }
}
registerModuleType({ manifest: manifest('sysinfo', 'System Info', 'Date, uptime, OS type and power status.', { colSpan: 1, rowSpan: 1, w: 0.16, h: 0.08 }, ['monitor.cpu']), create: (c) => new SysinfoModule(c) });

// ───────────────────────── hardware ─────────────────────────

class HardwareModule extends MonitorModule {
  private grid = h('div');
  protected build(): void {
    this.ctx.body.append(this.grid);
    void getStatic().then((s) => {
      this.grid.replaceChildren(kv([
        ['MANUFACTURER', s.system?.manufacturer || 'n/a'],
        ['MODEL', s.system?.model || 'n/a'],
        ['CHASSIS', s.chassis?.type || 'n/a'],
        ['CPU', `${s.cpu?.manufacturer ?? ''} ${s.cpu?.brand ?? ''}`.trim() || 'n/a'],
        ['GPU', s.gpus.map((g) => g.model).join(' / ') || 'n/a'],
        ['DISPLAY', s.displays.map((d) => `${d.resolutionX}×${d.resolutionY}${d.refresh ? `@${d.refresh}` : ''}`).join(' ') || 'n/a'],
        ['SESSION', [s.sessionType, s.desktop].filter(Boolean).join(' · ') || 'n/a'],
      ]));
    });
  }
  protected render(): void {}
}
registerModuleType({ manifest: manifest('hardware', 'Hardware Inspector', 'Machine manufacturer, model, chassis, CPU, GPU and display.', { colSpan: 1, rowSpan: 1, w: 0.18, h: 0.14 }, []), create: (c) => new HardwareModule(c) });

// ───────────────────────── CPU ─────────────────────────

class CpuModule extends MonitorModule {
  protected override topics: MonitorTopic[] = ['cpu', 'cpu.speed', 'cpu.temp'];
  private graphs: Graph[] = [];
  private avg: HTMLElement[] = [];
  private coresEl = h('div.cores');
  private stats = { temp: val(), speed: val(), max: val(), load: val() };
  private cores = 0;
  protected build(): void {
    const b = this.ctx.body;
    b.classList.add('cpu-body');
    const top = h('div.cpu-graphs');
    for (let i = 0; i < 2; i++) {
      const avg = h('i', 'AVG —%');
      const cell = h('div.cpu-graph', h('div.label.cpu-range', h('span', `# —`), avg));
      this.avg.push(avg);
      this.graphs.push(new Graph(cell, { min: 0, max: 100, stroke: 1 }));
      top.append(cell);
    }
    b.append(top, this.coresEl, h('div.cpu-stats', ...Object.entries({ TEMP: this.stats.temp, SPD: this.stats.speed, MAX: this.stats.max, LOAD: this.stats.load }).map(([k, v]) => h('div.cell', h('span.label', k), v))));
    void getStatic().then((s) => {
      this.ctx.setStatus(`${s.cpu?.manufacturer ?? ''} ${s.cpu?.brand ?? ''}`.trim().toUpperCase());
      this.stats.max.textContent = s.cpu?.speedMax ? `${s.cpu.speedMax.toFixed(2)}GHz` : 'n/a';
    });
  }
  protected render(): void {
    const d = this.get<CpuData>('cpu');
    if (!d) return;
    const n = d.cores.length;
    if (n !== this.cores) {
      this.cores = n;
      this.coresEl.replaceChildren(...d.cores.map((_, i) => h('div.core', { title: `core ${i}` }, h('i'))));
      const half = Math.ceil(n / 2);
      this.graphs.forEach((g, gi) => {
        const lbl = g.canvas.parentElement!.querySelector('.cpu-range span')!;
        lbl.textContent = gi === 0 ? `# 1 – ${half}` : `# ${half + 1} – ${n}`;
      });
    }
    const half = Math.ceil(n / 2);
    const mon = this.ctx.app.monitor;
    const groups = [Array.from({ length: half }, (_, i) => i), Array.from({ length: n - half }, (_, i) => half + i)];
    groups.forEach((idx, gi) => {
      this.graphs[gi].draw(idx.map((i) => mon.coreHistory(i)));
      const a = idx.reduce((s, i) => s + (d.cores[i] ?? 0), 0) / Math.max(1, idx.length);
      this.avg[gi].textContent = `AVG ${a.toFixed(0)}%`;
    });
    [...this.coresEl.children].forEach((c, i) => ((c.firstElementChild as HTMLElement).style.height = `${Math.min(100, d.cores[i] ?? 0)}%`));
    const t = this.get<{ main: number | null }>('cpu.temp');
    this.stats.temp.textContent = this.temp(t?.main);
    const s = this.get<{ avg: number | null }>('cpu.speed');
    this.stats.speed.textContent = s?.avg ? `${s.avg.toFixed(2)}GHz` : 'n/a';
    this.stats.load.textContent = d.loadavg[0] !== undefined ? d.loadavg.map((x) => x.toFixed(2)).join(' ') : `${d.load.toFixed(0)}%`;
  }
}
registerModuleType({ manifest: manifest('cpu', 'CPU Monitor', 'Utilisation per core with history, model, clock speed, temperature and load average.', { colSpan: 1, rowSpan: 2, w: 0.18, h: 0.2 }, ['monitor.cpu']), create: (c) => new CpuModule(c) });

// ───────────────────────── GPU ─────────────────────────

class GpuModule extends MonitorModule {
  protected override topics: MonitorTopic[] = ['gpu'];
  private list = h('div.stack');
  private graph!: Graph;
  private render$ = h('div.kv');
  protected build(): void {
    const g = h('div.gpu-graph');
    this.graph = new Graph(g, { min: 0, max: 100, fill: true });
    this.ctx.body.append(this.list, g, h('div.rule'), this.render$);
    const off = this.ctx.app.graphics.events.on('frame', () => { if (Math.random() < 0.05) this.schedule(); });
    this.ctx.onDispose(off);
  }
  protected render(): void {
    const d = this.get<{ controllers: GpuController[] }>('gpu');
    if (d) {
      this.list.replaceChildren(...d.controllers.map((c) => {
        const mem = c.memoryUsed !== null && c.memoryTotal ? (c.memoryUsed / c.memoryTotal) * 100 : null;
        return h('div.gpu-card',
          h('div.row', h('span.grow.mono', c.model), h('span.dim', c.source === 'static' ? 'NO LIVE DATA' : c.source.toUpperCase())),
          kv([
            ['UTIL', c.utilization !== null ? `${c.utilization}%` : 'n/a'],
            ['VRAM', c.memoryUsed !== null ? `${formatBytes(c.memoryUsed * 1048576)} / ${formatBytes((c.memoryTotal ?? c.vram ?? 0) * 1048576)}` : c.vram ? `${formatBytes(c.vram * 1048576)} total` : 'n/a'],
            ['TEMP', this.temp(c.temperature)],
            ['POWER', c.power !== null ? `${c.power.toFixed(1)} W${c.powerLimit ? ` / ${c.powerLimit.toFixed(0)} W` : ''}` : 'n/a'],
            ['CLOCK', c.clockCore !== null ? `${c.clockCore} MHz` : 'n/a'],
          ]),
          bar(c.utilization), bar(mem),
        );
      }));
      if (!d.controllers.length) this.list.replaceChildren(h('div.na', 'No GPU reported by the operating system.'));
    }
    this.graph.draw([this.ctx.app.monitor.history('gpu.util')]);
    const g = this.ctx.app.graphics;
    const m = g.memoryEstimate();
    this.render$.replaceChildren(...[
      ['RENDER FPS', g.fps.toFixed(0)], ['VIEWS', String(g.views.size)], ['DRAW CALLS', String(m.drawCalls)], ['GPU MEM (EST.)', formatBytes(m.bytes)],
    ].flatMap(([k, v]) => [h('span.k', k), h('span.v', v)]));
  }
}
function bar(pct: number | null): HTMLElement {
  const i = h('i');
  i.style.width = `${Math.max(0, Math.min(100, pct ?? 0))}%`;
  return h('div.bar', { class: pct !== null && pct > 90 ? 'danger' : pct !== null && pct > 75 ? 'warn' : '' }, i);
}
registerModuleType({ manifest: manifest('gpu', 'GPU Monitor', 'GPU model, utilisation, VRAM, temperature, power (NVIDIA via nvidia-smi, AMD via sysfs) plus SYNAPSE rendering activity.', { colSpan: 1, rowSpan: 2, w: 0.18, h: 0.22 }, ['monitor.gpu']), create: (c) => new GpuModule(c) });

// ───────────────────────── memory ─────────────────────────

class MemoryModule extends MonitorModule {
  protected override topics: MonitorTopic[] = ['mem'];
  private points: HTMLElement[] = [];
  private order: number[] = [];
  private info = h('span');
  private swap = h('div');
  private graph: Graph | null = null;
  private style = 'pointmap';
  protected build(): void {
    this.style = this.ctx.config<string>('style', 'pointmap');
    const b = this.ctx.body;
    if (this.style === 'pointmap') {
      const map = h('div.mem-pointmap');
      for (let i = 0; i < 440; i++) {
        const p = h('div.pt');
        this.points.push(p);
        map.append(p);
      }
      this.order = this.points.map((_, i) => i).sort(() => Math.random() - 0.5);
      b.append(map);
    } else {
      const g = h('div.mem-graph');
      this.graph = new Graph(g, { min: 0, max: 100, fill: true });
      b.append(g);
    }
    b.append(h('div.row', this.info), this.swap);
  }
  protected render(): void {
    const m = this.get<MemData>('mem');
    if (!m) return;
    const usedPct = ((m.total - m.available) / m.total) * 100;
    if (this.points.length) {
      const active = Math.round((440 * m.active) / m.total);
      const avail = Math.round((440 * (m.available - m.free)) / m.total);
      this.order.forEach((idx, k) => (this.points[idx].className = k < active ? 'pt active' : k < active + avail ? 'pt available' : 'pt'));
    }
    this.graph?.draw([this.ctx.app.monitor.history('mem.used')]);
    this.ctx.setStatus(`USING ${formatBytes(m.total - m.available)} OUT OF ${formatBytes(m.total)}`);
    this.info.replaceChildren(h('span.label', 'USED '), `${usedPct.toFixed(1)}%  `, h('span.label', 'AVAIL '), formatBytes(m.available), '  ', h('span.label', 'CACHE '), formatBytes(m.buffcache));
    const sp = m.swaptotal ? (m.swapused / m.swaptotal) * 100 : null;
    this.swap.replaceChildren(h('div.row', h('span.label', 'SWAP'), h('span.grow'), h('span.mono', m.swaptotal ? `${formatBytes(m.swapused)} / ${formatBytes(m.swaptotal)}` : 'none')), bar(sp));
  }
}
registerModuleType({ manifest: { ...manifest('memory', 'Memory Monitor', 'Total, used and available RAM, swap, and history (eDEX point-map or graph).', { colSpan: 1, rowSpan: 2, w: 0.18, h: 0.18 }, ['monitor.memory']), configSchema: [{ key: 'style', label: 'Style', type: 'select', default: 'pointmap', options: [{ value: 'pointmap', label: 'eDEX point map' }, { value: 'bars', label: 'History graph' }] }] }, create: (c) => new MemoryModule(c) });

// ───────────────────────── network ─────────────────────────

class NetworkModule extends MonitorModule {
  protected override topics: MonitorTopic[] = ['net'];
  private graph!: Graph;
  private cells = { state: val(), ip: val(), rx: val(), tx: val(), total: val() };
  protected build(): void {
    const g = h('div.net-graph');
    this.graph = new Graph(g, { min: 0, max: 'auto', fill: true });
    this.ctx.body.append(kv([['STATE', this.cells.state], ['IPv4', this.cells.ip], ['RX', this.cells.rx], ['TX', this.cells.tx], ['TOTAL', this.cells.total]]), g);
  }
  protected render(): void {
    const n = this.get<NetData>('net');
    if (!n) return;
    this.ctx.setStatus(`INTERFACE: ${n.iface ?? 'none'}`);
    this.cells.state.textContent = `${n.operstate.toUpperCase()}${n.speed ? ` · ${n.speed} Mb/s` : ''}`;
    this.cells.ip.textContent = n.ip4 ?? 'n/a';
    this.cells.rx.textContent = formatRate(n.rxPerSec);
    this.cells.tx.textContent = formatRate(n.txPerSec);
    this.cells.total.textContent = `↓ ${formatBytes(n.rxTotal)} ↑ ${formatBytes(n.txTotal)}`;
    const mon = this.ctx.app.monitor;
    this.graph.draw([mon.history('net.rx'), mon.history('net.tx')]);
  }
}
registerModuleType({ manifest: manifest('network', 'Network Monitor', 'Interface state, address, live transfer rates and history. Nothing is sent over the network.', { colSpan: 1, rowSpan: 2, w: 0.18, h: 0.16 }, ['monitor.network']), create: (c) => new NetworkModule(c) });

// ───────────────────────── connections ─────────────────────────

class ConnectionsModule extends MonitorModule {
  protected override topics: MonitorTopic[] = ['net.connections', 'net'];
  private graph!: Graph;
  private summary = h('div.row.mono');
  private table = h('div.conn-list.scroll');
  protected build(): void {
    const g = h('div.conn-graph');
    this.graph = new Graph(g, { min: 0, max: 'auto' });
    this.ctx.body.append(this.summary, g, this.table);
    this.table.hidden = !this.ctx.config<boolean>('showList', true);
  }
  protected render(): void {
    const c = this.get<ConnData>('net.connections');
    const mon = this.ctx.app.monitor;
    this.graph.draw([mon.history('net.total')]);
    if (!c) return;
    this.summary.replaceChildren(h('span.label', 'EST '), String(c.established), '  ', h('span.label', 'LISTEN '), String(c.listening), '  ', h('span.label', 'REMOTE HOSTS '), String(c.remoteHosts));
    this.ctx.setStatus(`${c.count} SOCKETS`);
    if (!this.table.hidden) {
      this.table.replaceChildren(...c.list.slice(0, 60).map((x) => h('div.conn-row', h('span.mono', `${x.peer}:${x.peerPort}`), h('span.dim', x.protocol.toUpperCase()), h('span.dim', x.process ?? '—'))));
    }
  }
}
registerModuleType({ manifest: { ...manifest('connections', 'Connections', 'Active network connections (local and remote endpoints) and traffic graph.', { colSpan: 1, rowSpan: 2, w: 0.18, h: 0.2 }, ['monitor.connections', 'monitor.network']), configSchema: [{ key: 'showList', label: 'Show connection list', type: 'bool', default: true }] }, create: (c) => new ConnectionsModule(c) });

// ───────────────────────── storage ─────────────────────────

class StorageModule extends MonitorModule {
  protected override topics: MonitorTopic[] = ['storage', 'disk.io'];
  private list = h('div.stack');
  private io = h('div.row.mono');
  private graph!: Graph;
  protected build(): void {
    const g = h('div.disk-graph');
    this.graph = new Graph(g, { min: 0, max: 'auto' });
    this.ctx.body.append(this.list, this.io, g);
  }
  protected render(): void {
    const s = this.get<StorageItem[]>('storage');
    if (s) {
      this.list.replaceChildren(...s.map((f) => h('div.fs-item', h('div.row', h('span.mono.grow', f.mount), h('span.dim', `${f.type}${f.rw === false ? ' ro' : ''}`), h('span.mono', `${formatBytes(f.used)} / ${formatBytes(f.size)}`)), bar(f.use))));
    }
    const io = this.get<{ readPerSec: number | null; writePerSec: number | null }>('disk.io');
    this.io.replaceChildren(h('span.label', 'READ '), formatRate(io?.readPerSec), '  ', h('span.label', 'WRITE '), formatRate(io?.writePerSec));
    const mon = this.ctx.app.monitor;
    this.graph.draw([mon.history('disk.read'), mon.history('disk.write')]);
  }
}
registerModuleType({ manifest: manifest('storage', 'Storage Monitor', 'Mounted filesystems, used/available space, types and disk activity.', { colSpan: 1, rowSpan: 2, w: 0.2, h: 0.2 }, ['monitor.storage']), create: (c) => new StorageModule(c) });

// ───────────────────────── processes ─────────────────────────

type SortKey = 'cpu' | 'mem' | 'pid' | 'name';
class ProcessModule extends MonitorModule {
  protected override topics: MonitorTopic[] = ['processes'];
  private filter = h('input', { placeholder: 'filter…', spellcheck: 'false' });
  private table = h('div.proc-table.scroll');
  private sort: SortKey = 'cpu';
  private compact = false;
  protected build(): void {
    this.compact = this.ctx.config<boolean>('compact', false);
    const head = h('div.proc-row.head', ...(['pid', 'name', 'cpu', 'mem'] as SortKey[]).map((k) => h('span', { class: `c-${k}`, onclick: () => { this.sort = k; this.render(); } }, k.toUpperCase())));
    if (!this.compact) this.ctx.body.append(h('div.row', this.filter));
    this.ctx.body.append(head, this.table);
    this.filter.addEventListener('input', () => this.render());
  }
  protected render(): void {
    const d = this.get<ProcData>('processes');
    if (!d) return;
    const q = this.filter.value.trim().toLowerCase();
    let list = d.list.filter((p) => !q || p.name.toLowerCase().includes(q) || String(p.pid) === q || p.command.toLowerCase().includes(q) || p.user?.toLowerCase().includes(q));
    const cmp: Record<SortKey, (a: ProcData['list'][number], b: ProcData['list'][number]) => number> = { cpu: (a, b) => b.cpu - a.cpu, mem: (a, b) => b.mem - a.mem, pid: (a, b) => a.pid - b.pid, name: (a, b) => a.name.localeCompare(b.name) };
    list = list.sort(cmp[this.sort]).slice(0, this.compact ? 8 : 200);
    this.ctx.setStatus(`${d.all} PROCESSES · ${d.running} RUNNING`);
    this.table.replaceChildren(...list.map((p) => {
      const row = h('div.proc-row', { title: p.command, tabindex: '0' }, h('span.c-pid', String(p.pid)), h('span.c-name', p.name), h('span.c-cpu', `${fmt(p.cpu, 1)}%`), h('span.c-mem', `${fmt(p.mem, 1)}%`));
      row.addEventListener('dblclick', () => void this.terminate(p.pid, p.name, d.self));
      row.addEventListener('keydown', (e) => { if (e.key === 'Delete') void this.terminate(p.pid, p.name, d.self); });
      return row;
    }));
  }
  private async terminate(pid: number, name: string, self: number): Promise<void> {
    const app = this.ctx.app;
    if (pid === self) return app.overlays.toast('Refusing to terminate SYNAPSE-UI itself', 'warn');
    const ok = await app.overlays.confirm({ title: 'Terminate process', message: `Send SIGTERM to "${name}" (pid ${pid})?\nUnsaved work in that program may be lost.`, confirm: 'Terminate', danger: true });
    if (!ok) return;
    const r = await bridge.monitor.kill(pid, 'SIGTERM');
    app.overlays.toast(r.ok ? `Sent SIGTERM to ${name} (${pid})` : `Could not signal ${pid}: ${r.error}`, r.ok ? 'ok' : 'error');
  }
}
registerModuleType({ manifest: { ...manifest('processes', 'Process Monitor', 'Running processes with CPU/RAM, search, sorting and filtering. Double-click (or Delete) to terminate after confirmation.', { colSpan: 1, rowSpan: 3, w: 0.22, h: 0.3 }, ['monitor.processes', 'process.kill']), configSchema: [{ key: 'compact', label: 'Compact (top 8)', type: 'bool', default: false }] }, create: (c) => new ProcessModule(c) });

export type { ModuleContext };
