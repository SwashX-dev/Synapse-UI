/**
 * Renderer side of the unified monitoring API: one subscription per topic
 * (ref-counted in the preload bridge), latest values, and shared histories so
 * every graph of the same metric draws from the same buffer.
 */
import { bridge } from './bridge';
import { Ring } from './util';
import type { MonitorTopic } from '../../shared/ipc';

export interface CpuData { load: number; user: number; system: number; cores: number[]; loadavg: number[] }
export interface MemData { total: number; used: number; active: number; available: number; free: number; buffcache: number; swaptotal: number; swapused: number }
export interface NetData { iface: string | null; operstate: string; rxPerSec: number | null; txPerSec: number | null; rxTotal: number | null; txTotal: number | null; ip4: string | null; ip6: string | null; mac: string | null; type: string | null; speed: number | null; interfaces: { iface: string; operstate: string }[] }
export interface ConnData { count: number; established: number; listening: number; remoteHosts: number; list: { protocol: string; local: string; localPort: string; peer: string; peerPort: string; state: string; process: string | null; pid: number | null }[] }
export interface GpuController { model: string; vendor: string | null; vram: number | null; memoryUsed: number | null; memoryTotal: number | null; utilization: number | null; utilizationMemory: number | null; temperature: number | null; power: number | null; powerLimit: number | null; clockCore: number | null; fan: number | null; source: string }
export interface ProcData { all: number; running: number; blocked: number; sleeping: number; self: number; list: { pid: number; parentPid: number; name: string; cpu: number; mem: number; memRss: number; user: string; state: string; started: string; command: string }[] }
export interface StorageItem { fs: string; type: string; size: number; used: number; available: number; use: number; mount: string; rw: boolean | null }

/** Derived scalar metrics, all recorded into shared history rings. */
export const METRICS: Record<string, { topic: MonitorTopic; label: string; unit: string; min: number; max: number | 'auto'; read: (d: unknown) => number | null }> = {
  'cpu.load': { topic: 'cpu', label: 'CPU load', unit: '%', min: 0, max: 100, read: (d) => (d as CpuData).load },
  'cpu.user': { topic: 'cpu', label: 'CPU user', unit: '%', min: 0, max: 100, read: (d) => (d as CpuData).user },
  'cpu.system': { topic: 'cpu', label: 'CPU system', unit: '%', min: 0, max: 100, read: (d) => (d as CpuData).system },
  'cpu.loadavg': { topic: 'cpu', label: 'Load average (1 min)', unit: '', min: 0, max: 'auto', read: (d) => (d as CpuData).loadavg[0] ?? null },
  'cpu.temp': { topic: 'cpu.temp', label: 'CPU temperature', unit: '°C', min: 20, max: 105, read: (d) => (d as { main: number | null }).main },
  'cpu.speed': { topic: 'cpu.speed', label: 'CPU clock', unit: 'GHz', min: 0, max: 'auto', read: (d) => (d as { avg: number | null }).avg },
  'mem.used': { topic: 'mem', label: 'Memory used', unit: '%', min: 0, max: 100, read: (d) => { const m = d as MemData; return m.total ? ((m.total - m.available) / m.total) * 100 : null; } },
  'mem.swap': { topic: 'mem', label: 'Swap used', unit: '%', min: 0, max: 100, read: (d) => { const m = d as MemData; return m.swaptotal ? (m.swapused / m.swaptotal) * 100 : 0; } },
  'net.rx': { topic: 'net', label: 'Network receive', unit: 'B/s', min: 0, max: 'auto', read: (d) => (d as NetData).rxPerSec },
  'net.tx': { topic: 'net', label: 'Network transmit', unit: 'B/s', min: 0, max: 'auto', read: (d) => (d as NetData).txPerSec },
  'net.total': { topic: 'net', label: 'Network total', unit: 'B/s', min: 0, max: 'auto', read: (d) => { const n = d as NetData; return n.rxPerSec === null ? null : (n.rxPerSec ?? 0) + (n.txPerSec ?? 0); } },
  'conn.established': { topic: 'net.connections', label: 'Established connections', unit: '', min: 0, max: 'auto', read: (d) => (d as ConnData).established },
  'conn.remote': { topic: 'net.connections', label: 'Remote hosts', unit: '', min: 0, max: 'auto', read: (d) => (d as ConnData).remoteHosts },
  'gpu.util': { topic: 'gpu', label: 'GPU utilisation', unit: '%', min: 0, max: 100, read: (d) => (d as { controllers: GpuController[] }).controllers.find((c) => c.utilization !== null)?.utilization ?? null },
  'gpu.temp': { topic: 'gpu', label: 'GPU temperature', unit: '°C', min: 20, max: 100, read: (d) => (d as { controllers: GpuController[] }).controllers.find((c) => c.temperature !== null)?.temperature ?? null },
  'gpu.mem': { topic: 'gpu', label: 'GPU memory used', unit: '%', min: 0, max: 100, read: (d) => { const c = (d as { controllers: GpuController[] }).controllers.find((x) => x.memoryUsed !== null && x.memoryTotal); return c ? (c.memoryUsed! / c.memoryTotal!) * 100 : null; } },
  'gpu.power': { topic: 'gpu', label: 'GPU power', unit: 'W', min: 0, max: 'auto', read: (d) => (d as { controllers: GpuController[] }).controllers.find((c) => c.power !== null)?.power ?? null },
  'disk.read': { topic: 'disk.io', label: 'Disk read', unit: 'B/s', min: 0, max: 'auto', read: (d) => (d as { readPerSec: number | null }).readPerSec },
  'disk.write': { topic: 'disk.io', label: 'Disk write', unit: 'B/s', min: 0, max: 'auto', read: (d) => (d as { writePerSec: number | null }).writePerSec },
  'proc.count': { topic: 'processes', label: 'Processes', unit: '', min: 0, max: 'auto', read: (d) => (d as ProcData).all },
  'proc.running': { topic: 'processes', label: 'Running processes', unit: '', min: 0, max: 'auto', read: (d) => (d as ProcData).running },
  'battery.percent': { topic: 'battery', label: 'Battery', unit: '%', min: 0, max: 100, read: (d) => (d as { percent: number | null }).percent },
};

const HISTORY = 300;

export class MonitorStore {
  private latest = new Map<MonitorTopic, unknown>();
  private listeners = new Map<MonitorTopic, Set<(d: unknown) => void>>();
  private unsubs = new Map<MonitorTopic, () => void>();
  private histories = new Map<string, Ring>();
  private coreHistories: Ring[] = [];
  enabled = true;

  subscribe<T = unknown>(topic: MonitorTopic, fn: (d: T) => void): () => void {
    let set = this.listeners.get(topic);
    if (!set) {
      set = new Set();
      this.listeners.set(topic, set);
    }
    set.add(fn as (d: unknown) => void);
    if (!this.unsubs.has(topic)) this.unsubs.set(topic, bridge.monitor.subscribe(topic, (d) => this.ingest(topic, d)));
    const cached = this.latest.get(topic);
    if (cached !== undefined) queueMicrotask(() => fn(cached as T));
    return () => {
      const s = this.listeners.get(topic);
      if (!s) return;
      s.delete(fn as (d: unknown) => void);
      if (s.size === 0) {
        this.unsubs.get(topic)?.();
        this.unsubs.delete(topic);
      }
    };
  }

  get<T = unknown>(topic: MonitorTopic): T | undefined {
    return this.latest.get(topic) as T | undefined;
  }

  history(metric: string): Ring {
    let r = this.histories.get(metric);
    if (!r) {
      r = new Ring(HISTORY);
      this.histories.set(metric, r);
    }
    return r;
  }

  coreHistory(i: number): Ring {
    while (this.coreHistories.length <= i) this.coreHistories.push(new Ring(HISTORY));
    return this.coreHistories[i];
  }

  value(metric: string): number | null {
    const m = METRICS[metric];
    if (!m) return null;
    const d = this.latest.get(m.topic);
    if (d === undefined) return null;
    try {
      return m.read(d);
    } catch {
      return null;
    }
  }

  /** Subscribe to whatever topic a metric needs; returns release function. */
  acquireMetric(metric: string): () => void {
    const m = METRICS[metric];
    if (!m) return () => {};
    return this.subscribe(m.topic, () => {});
  }

  activeTopics(): string[] {
    return [...this.unsubs.keys()];
  }

  private ingest(topic: MonitorTopic, d: unknown): void {
    this.latest.set(topic, d);
    for (const [name, m] of Object.entries(METRICS)) {
      if (m.topic !== topic) continue;
      let v: number | null;
      try { v = m.read(d); } catch { v = null; }
      if (v !== null && Number.isFinite(v)) this.history(name).push(v);
    }
    if (topic === 'cpu') (d as CpuData).cores.forEach((c, i) => this.coreHistory(i).push(c));
    for (const fn of this.listeners.get(topic) ?? []) {
      try { fn(d); } catch (e) { console.error(e); }
    }
  }
}
