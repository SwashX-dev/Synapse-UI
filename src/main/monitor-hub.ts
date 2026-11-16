/**
 * Unified monitoring service. Each topic is polled ONCE no matter how many
 * modules display it, only while at least one subscriber exists, at a
 * configurable interval. Results are pushed to subscribed WebContents.
 *
 * Values the platform does not expose are reported as null — never invented.
 * Nothing collected here is transmitted anywhere except to the local UI.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MonitorTopic } from '../shared/ipc';
import { Events } from '../shared/ipc';
import type { Sink } from './pty-manager';
import { logger } from './log';

const log = logger('monitor');
type SI = typeof import('systeminformation');

export const BASE_INTERVALS: Record<MonitorTopic, number> = {
  cpu: 1000,
  'cpu.speed': 2000,
  'cpu.temp': 3000,
  mem: 1500,
  net: 1000,
  'net.connections': 5000,
  storage: 15000,
  'disk.io': 2000,
  processes: 2500,
  gpu: 2000,
  battery: 30000,
  system: 1000,
};

export interface HubSettings {
  enabled: boolean;
  intervalScale: number;
  networkInterface: string;
  processLimit: number;
  gpu: boolean;
}

interface TopicState {
  subs: Map<number, Sink>;
  timer: NodeJS.Timeout | null;
  inflight: boolean;
  last: unknown;
  lastAt: number;
}

export class MonitorHub {
  private topics = new Map<MonitorTopic, TopicState>();
  private si: SI | null = null;
  private staticInfo: unknown = null;
  private defaultIface: string | null = null;
  private lastNet: { at: number; rx: number; tx: number; iface: string } | null = null;
  private lastDisk: { at: number; r: number; w: number } | null = null;

  constructor(private settings: HubSettings, private loadSi: () => SI = () => require('systeminformation') as SI) {}

  private lib(): SI {
    this.si ??= this.loadSi();
    return this.si;
  }

  configure(s: Partial<HubSettings>): void {
    const prev = this.settings;
    this.settings = { ...this.settings, ...s };
    if (prev.enabled !== this.settings.enabled || prev.intervalScale !== this.settings.intervalScale || prev.networkInterface !== this.settings.networkInterface) {
      this.lastNet = null;
      for (const [topic, st] of this.topics) this.reschedule(topic, st);
    }
  }

  subscribe(sink: Sink, topic: MonitorTopic): void {
    const st = this.state(topic);
    st.subs.set(sink.id, sink);
    if (st.last !== undefined && st.last !== null && Date.now() - st.lastAt < 60_000) sink.send(Events.monitorData, topic, st.last);
    if (!st.timer) this.reschedule(topic, st);
  }

  unsubscribe(sink: Sink, topic: MonitorTopic): void {
    const st = this.state(topic);
    st.subs.delete(sink.id);
    if (st.subs.size === 0 && st.timer) {
      clearTimeout(st.timer);
      st.timer = null;
    }
  }

  removeSink(sinkId: number): void {
    for (const [, st] of this.topics) {
      st.subs.delete(sinkId);
      if (st.subs.size === 0 && st.timer) { clearTimeout(st.timer); st.timer = null; }
    }
  }

  /** Active topics and their subscriber counts (diagnostics + tests). */
  activity(): Record<string, number> {
    return Object.fromEntries([...this.topics].filter(([, s]) => s.subs.size).map(([t, s]) => [t, s.subs.size]));
  }

  stop(): void {
    for (const st of this.topics.values()) if (st.timer) clearTimeout(st.timer);
    this.topics.clear();
  }

  private state(topic: MonitorTopic): TopicState {
    let st = this.topics.get(topic);
    if (!st) {
      st = { subs: new Map(), timer: null, inflight: false, last: undefined, lastAt: 0 };
      this.topics.set(topic, st);
    }
    return st;
  }

  private reschedule(topic: MonitorTopic, st: TopicState): void {
    if (st.timer) clearTimeout(st.timer);
    st.timer = null;
    if (!this.settings.enabled || st.subs.size === 0) return;
    if (topic === 'gpu' && !this.settings.gpu) return;
    const tick = async () => {
      if (!st.subs.size) { st.timer = null; return; }
      if (!st.inflight) {
        st.inflight = true;
        try {
          const data = await this.poll(topic);
          st.last = data;
          st.lastAt = Date.now();
          for (const [id, sink] of st.subs) {
            if (sink.isDestroyed()) st.subs.delete(id);
            else sink.send(Events.monitorData, topic, data);
          }
        } catch (e) {
          log.debug(`poll ${topic} failed`, e);
        } finally {
          st.inflight = false;
        }
      }
      st.timer = setTimeout(tick, Math.max(250, BASE_INTERVALS[topic] * this.settings.intervalScale));
    };
    st.timer = setTimeout(tick, 10);
  }

  // ───────────────────────── pollers ─────────────────────────

  async poll(topic: MonitorTopic): Promise<unknown> {
    const si = this.lib();
    switch (topic) {
      case 'cpu': {
        const l = await si.currentLoad();
        return { load: round(l.currentLoad), user: round(l.currentLoadUser), system: round(l.currentLoadSystem), cores: l.cpus.map((c) => round(c.load)), loadavg: os.loadavg().map(round) };
      }
      case 'cpu.speed': {
        const s = await si.cpuCurrentSpeed();
        return { avg: s.avg || null, min: s.min || null, max: s.max || null, cores: s.cores ?? [] };
      }
      case 'cpu.temp': {
        const t = await si.cpuTemperature();
        const valid = (v: number | null | undefined) => (typeof v === 'number' && v > 0 && v < 150 ? v : null);
        return { main: valid(t.main), max: valid(t.max), cores: (t.cores ?? []).map(valid) };
      }
      case 'mem': {
        const m = await si.mem();
        return { total: m.total, used: m.used, active: m.active, available: m.available, free: m.free, buffcache: m.buffcache, swaptotal: m.swaptotal, swapused: m.swapused };
      }
      case 'net':
        return this.pollNet(si);
      case 'net.connections': {
        const conns = await si.networkConnections();
        const established = conns.filter((c) => c.state === 'ESTABLISHED');
        const listening = conns.filter((c) => c.state === 'LISTEN');
        const remote = established.filter((c) => c.peerAddress && !isLoopback(c.peerAddress));
        return {
          count: conns.length,
          established: established.length,
          listening: listening.length,
          remoteHosts: new Set(remote.map((c) => c.peerAddress)).size,
          list: remote.slice(0, 200).map((c) => ({ protocol: c.protocol, local: c.localAddress, localPort: c.localPort, peer: c.peerAddress, peerPort: c.peerPort, state: c.state, process: c.process || null, pid: c.pid || null })),
        };
      }
      case 'storage': {
        const fsList = await si.fsSize();
        return fsList
          .filter((f) => f.size > 0 && !/^(\/proc|\/sys|\/run\/user|\/dev\/shm)/.test(f.mount))
          .slice(0, 32)
          .map((f) => ({ fs: f.fs, type: f.type, size: f.size, used: f.used, available: f.available, use: round(f.use), mount: f.mount, rw: f.rw }));
      }
      case 'disk.io': {
        const fsStats = await si.fsStats().catch(() => null);
        const now = Date.now();
        let rSec: number | null = null, wSec: number | null = null;
        if (fsStats && typeof fsStats.rx === 'number') {
          if (this.lastDisk) {
            const dt = (now - this.lastDisk.at) / 1000;
            if (dt > 0) { rSec = Math.max(0, (fsStats.rx - this.lastDisk.r) / dt); wSec = Math.max(0, (fsStats.wx - this.lastDisk.w) / dt); }
          }
          this.lastDisk = { at: now, r: fsStats.rx, w: fsStats.wx };
        }
        return { readPerSec: rSec, writePerSec: wSec };
      }
      case 'processes': {
        const p = await si.processes();
        const list = p.list
          .filter((x) => x.pid !== 0)
          .sort((a, b) => b.cpu - a.cpu || b.mem - a.mem)
          .slice(0, this.settings.processLimit)
          .map((x) => ({ pid: x.pid, parentPid: x.parentPid, name: x.name, cpu: round(x.cpu), mem: round(x.mem), memRss: x.memRss, user: x.user, state: x.state, started: x.started, command: (x.command + (x.params ? ' ' + x.params : '')).slice(0, 300) }));
        return { all: p.all, running: p.running, blocked: p.blocked, sleeping: p.sleeping, list, self: process.pid };
      }
      case 'gpu':
        return this.pollGpu(si);
      case 'battery': {
        const b = await si.battery();
        return { hasBattery: b.hasBattery, percent: b.hasBattery ? b.percent : null, isCharging: b.isCharging, acConnected: b.acConnected, timeRemaining: b.timeRemaining ?? null };
      }
      case 'system':
        return { uptime: os.uptime(), time: Date.now(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    }
  }

  private async pollNet(si: SI): Promise<unknown> {
    const wanted = this.settings.networkInterface;
    if (wanted === 'auto' && !this.defaultIface) this.defaultIface = await si.networkInterfaceDefault().catch(() => null);
    const iface = wanted === 'auto' ? this.defaultIface : wanted;
    const stats = await si.networkStats('*');
    const all = stats.filter((s) => s.iface !== 'lo');
    const main = all.find((s) => s.iface === iface) ?? all.find((s) => s.operstate === 'up') ?? all[0];
    const now = Date.now();
    let rx: number | null = null;
    let tx: number | null = null;
    if (main) {
      if (this.lastNet && this.lastNet.iface === main.iface) {
        const dt = (now - this.lastNet.at) / 1000;
        if (dt > 0) { rx = Math.max(0, (main.rx_bytes - this.lastNet.rx) / dt); tx = Math.max(0, (main.tx_bytes - this.lastNet.tx) / dt); }
      }
      this.lastNet = { at: now, rx: main.rx_bytes, tx: main.tx_bytes, iface: main.iface };
    }
    const ifaces = await si.networkInterfaces().catch(() => []);
    const info = (Array.isArray(ifaces) ? ifaces : [ifaces]).find((i) => i.iface === main?.iface);
    return {
      iface: main?.iface ?? null,
      operstate: main?.operstate ?? 'unknown',
      rxPerSec: rx,
      txPerSec: tx,
      rxTotal: main?.rx_bytes ?? null,
      txTotal: main?.tx_bytes ?? null,
      ip4: info?.ip4 || null,
      ip6: info?.ip6 || null,
      mac: info?.mac || null,
      type: info?.type ?? null,
      speed: info?.speed ?? null,
      interfaces: all.map((s) => ({ iface: s.iface, operstate: s.operstate })),
    };
  }

  private async pollGpu(si: SI): Promise<unknown> {
    const g = await si.graphics();
    const controllers = g.controllers.map((c) => ({
      model: c.model || c.name || 'Unknown GPU',
      vendor: c.vendor || null,
      vram: c.vram ?? null,
      memoryUsed: c.memoryUsed ?? null,
      memoryTotal: c.memoryTotal ?? null,
      utilization: c.utilizationGpu ?? null,
      utilizationMemory: c.utilizationMemory ?? null,
      temperature: c.temperatureGpu ?? null,
      power: c.powerDraw ?? null,
      powerLimit: c.powerLimit ?? null,
      clockCore: c.clockCore ?? null,
      fan: c.fanSpeed ?? null,
      source: c.utilizationGpu !== undefined ? 'driver' : 'static',
    }));
    // AMD (amdgpu) exposes live counters in sysfs; systeminformation only reads NVIDIA live values.
    if (process.platform === 'linux') {
      for (const card of amdSysfsCards()) {
        const target = controllers.find((c) => /amd|ati|radeon/i.test(`${c.vendor} ${c.model}`) && c.utilization === null);
        if (target) Object.assign(target, card, { source: 'sysfs' });
      }
    }
    return { controllers };
  }

  async getStatic(): Promise<unknown> {
    if (this.staticInfo) return this.staticInfo;
    const si = this.lib();
    const [osInfo, cpu, system, chassis, graphics, ifaces] = await Promise.all([
      si.osInfo().catch(() => null),
      si.cpu().catch(() => null),
      si.system().catch(() => null),
      si.chassis().catch(() => null),
      si.graphics().catch(() => null),
      si.networkInterfaces().catch(() => []),
    ]);
    let user = 'user';
    try { user = os.userInfo().username; } catch { /* ignore */ }
    this.staticInfo = {
      os: osInfo && { platform: osInfo.platform, distro: osInfo.distro, release: osInfo.release, codename: osInfo.codename, kernel: osInfo.kernel, arch: osInfo.arch, hostname: osInfo.hostname },
      cpu: cpu && { manufacturer: cpu.manufacturer, brand: cpu.brand, cores: cpu.cores, physicalCores: cpu.physicalCores, speed: cpu.speed, speedMax: cpu.speedMax, socket: cpu.socket, cache: cpu.cache },
      system: system && { manufacturer: system.manufacturer, model: system.model, version: system.version },
      chassis: chassis && { type: chassis.type, manufacturer: chassis.manufacturer },
      gpus: graphics?.controllers.map((c) => ({ model: c.model, vendor: c.vendor, vram: c.vram })) ?? [],
      displays: graphics?.displays.map((d) => ({ model: d.model, resolutionX: d.resolutionX, resolutionY: d.resolutionY, refresh: d.currentRefreshRate, main: d.main })) ?? [],
      interfaces: (Array.isArray(ifaces) ? ifaces : [ifaces]).filter((i) => !i.internal).map((i) => i.iface),
      user,
      totalMem: os.totalmem(),
      sessionType: process.env.XDG_SESSION_TYPE ?? null,
      desktop: process.env.XDG_CURRENT_DESKTOP ?? null,
    };
    return this.staticInfo;
  }
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}

function isLoopback(addr: string): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr.startsWith('127.') || addr === '0.0.0.0' || addr === '::' || addr === '*';
}

function amdSysfsCards(): Record<string, number | null>[] {
  const out: Record<string, number | null>[] = [];
  let cards: string[];
  try { cards = fs.readdirSync('/sys/class/drm').filter((n) => /^card\d+$/.test(n)); } catch { return out; }
  for (const card of cards) {
    const dev = path.join('/sys/class/drm', card, 'device');
    const num = (f: string) => { try { return Number(fs.readFileSync(path.join(dev, f), 'utf8').trim()); } catch { return null; } };
    const busy = num('gpu_busy_percent');
    if (busy === null) continue;
    const used = num('mem_info_vram_used');
    const total = num('mem_info_vram_total');
    let temp: number | null = null;
    let power: number | null = null;
    try {
      const hw = fs.readdirSync(path.join(dev, 'hwmon'))[0];
      if (hw) {
        const t = num(`hwmon/${hw}/temp1_input`);
        const p = num(`hwmon/${hw}/power1_average`) ?? num(`hwmon/${hw}/power1_input`);
        temp = t !== null ? t / 1000 : null;
        power = p !== null ? p / 1e6 : null;
      }
    } catch { /* no hwmon */ }
    out.push({ utilization: busy, memoryUsed: used !== null ? used / 1048576 : null, memoryTotal: total !== null ? total / 1048576 : null, temperature: temp, power });
  }
  return out;
}
