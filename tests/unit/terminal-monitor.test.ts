import { afterEach, describe, expect, it } from 'vitest';
import { PtyManager, buildEnv, type Sink } from '../../src/main/pty-manager';
import { detectShells, loginArgs, resolveShell } from '../../src/main/shells';
import { MonitorHub } from '../../src/main/monitor-hub';

const posix = process.platform !== 'win32';

function sink(id: number) {
  const events: [string, unknown[]][] = [];
  const s: Sink & { events: typeof events; output(sid: string): string } = {
    id,
    events,
    send: (ch, ...args) => events.push([ch, args]),
    isDestroyed: () => false,
    output: (sid) => events.filter(([ch, a]) => ch === 'pty:data' && a[0] === sid).map(([, a]) => a[1]).join(''),
  };
  return s;
}
const waitFor = async (fn: () => boolean, ms = 8000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
};
const opts = { shell: 'sh', args: [], login: false, cwd: '', env: { SYNAPSE_TEST: '1' }, appCommands: true, binDir: '/opt/synapse/bin' };

describe.runIf(posix)('PtyManager (real shells via node-pty)', () => {
  const mgr = new PtyManager();
  afterEach(() => mgr.disposeAll());

  it('starts a shell, round-trips input/output and resizes', async () => {
    const s = sink(1);
    const created = mgr.create(s, { cols: 100, rows: 30 }, opts);
    expect(created.id).toMatch(/^pty-/);
    expect(created.token.length).toBeGreaterThan(20);
    mgr.write(s, created.id, 'echo SYN$((6*7))_$SYNAPSE_TEST; stty size\r');
    await waitFor(() => s.output(created.id).includes('SYN42_1'));
    await waitFor(() => /30 100/.test(s.output(created.id)));
    mgr.resize(s, created.id, 120, 40);
    mgr.write(s, created.id, 'stty size\r');
    await waitFor(() => /40 120/.test(s.output(created.id)));
  });

  it('isolates sessions between owners', () => {
    const a = sink(1), b = sink(2);
    const created = mgr.create(a, { cols: 80, rows: 24 }, opts);
    expect(() => mgr.write(b, created.id, 'echo hijack\r')).toThrow(/unknown terminal session/);
    expect(() => mgr.kill(b, created.id)).toThrow();
    expect(mgr.list(b)).toEqual([]);
    expect(mgr.list(a)).toHaveLength(1);
  });

  it('replays scrollback on re-attach and cleans up processes', async () => {
    const s = sink(7);
    const c = mgr.create(s, { cols: 80, rows: 24 }, opts);
    mgr.write(s, c.id, 'echo REPLAY_ME\r');
    await waitFor(() => s.output(c.id).includes('REPLAY_ME'));
    expect(mgr.attach(s, c.id).replay).toContain('REPLAY_ME');
    const pid = c.pid;
    mgr.disposeOwner(7);
    expect(mgr.size).toBe(0);
    await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 5000);
  });

  it('reports the working directory on Linux', async () => {
    if (process.platform !== 'linux') return;
    const s = sink(3);
    const c = mgr.create(s, { cols: 80, rows: 24 }, { ...opts, cwd: '/tmp' });
    const info = await mgr.info(s, c.id);
    expect(info.cwd).toBe('/tmp');
  });

  it('notifies when the shell exits', async () => {
    const s = sink(4);
    const c = mgr.create(s, { cols: 80, rows: 24 }, opts);
    mgr.write(s, c.id, 'exit 3\r');
    await waitFor(() => s.events.some(([ch, a]) => ch === 'pty:exit' && a[0] === c.id));
    const ev = s.events.find(([ch]) => ch === 'pty:exit')!;
    expect(ev[1][1]).toBe(3);
  });
});

describe('shell environment', () => {
  it('strips Electron internals and adds terminal identification', () => {
    process.env.ELECTRON_RUN_AS_NODE = '1';
    process.env.NODE_OPTIONS = '--inspect';
    const env = buildEnv({ env: { EXTRA: 'x' }, appCommands: true, binDir: '/opt/bin' }, 'pty-abc', 'tok');
    delete process.env.ELECTRON_RUN_AS_NODE;
    delete process.env.NODE_OPTIONS;
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.TERM).toBe('xterm-256color');
    expect(env.SYNAPSE_TERM_TOKEN).toBe('tok');
    expect(env.PATH.startsWith('/opt/bin')).toBe(true);
    expect(env.EXTRA).toBe('x');
    const off = buildEnv({ env: {}, appCommands: false, binDir: '/opt/bin' }, 'pty-abc', 'tok');
    expect(off.SYNAPSE_TERM_TOKEN).toBeUndefined();
  });

  it.runIf(posix)('detects only shells that exist', () => {
    const shells = detectShells();
    expect(shells.length).toBeGreaterThan(0);
    expect(shells.some((s) => s.default)).toBe(true);
    expect(resolveShell('definitely-not-a-shell').path).toBeTruthy();
    expect(loginArgs('bash')).toEqual(['-l']);
    expect(loginArgs('nu')).toEqual(['--login']);
  });
});

describe('MonitorHub', () => {
  const fakeSi = () => {
    const calls: Record<string, number> = {};
    const count = (k: string) => (calls[k] = (calls[k] ?? 0) + 1);
    const si = {
      currentLoad: async () => (count('load'), { currentLoad: 50, currentLoadUser: 30, currentLoadSystem: 20, cpus: [{ load: 40 }, { load: 60 }] }),
      cpuTemperature: async () => (count('temp'), { main: -1, max: null, cores: [] }),
      mem: async () => (count('mem'), { total: 100, used: 50, active: 40, available: 60, free: 10, buffcache: 20, swaptotal: 0, swapused: 0 }),
      graphics: async () => (count('gpu'), { controllers: [{ model: 'Fake GPU', vendor: 'X' }], displays: [] }),
    };
    return { si: si as unknown as typeof import('systeminformation'), calls };
  };

  it('polls once per topic regardless of subscriber count, only while subscribed', async () => {
    const { si, calls } = fakeSi();
    const hub = new MonitorHub({ enabled: true, intervalScale: 0.25, networkInterface: 'auto', processLimit: 10, gpu: true }, () => si);
    const a = sink(1), b = sink(2);
    hub.subscribe(a, 'cpu');
    hub.subscribe(b, 'cpu');
    await new Promise((r) => setTimeout(r, 700));
    const n = calls.load;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(4);
    expect(a.events.filter(([ch]) => ch === 'monitor:data').length).toBe(b.events.filter(([ch]) => ch === 'monitor:data').length);
    hub.unsubscribe(a, 'cpu');
    hub.unsubscribe(b, 'cpu');
    const after = calls.load;
    await new Promise((r) => setTimeout(r, 600));
    expect(calls.load).toBe(after);
    hub.stop();
  });

  it('reports unavailable values as null instead of inventing them', async () => {
    const { si } = fakeSi();
    const hub = new MonitorHub({ enabled: true, intervalScale: 1, networkInterface: 'auto', processLimit: 10, gpu: true }, () => si);
    expect(await hub.poll('cpu.temp')).toEqual({ main: null, max: null, cores: [] });
    const gpu = (await hub.poll('gpu')) as { controllers: { utilization: unknown; temperature: unknown; source: string }[] };
    expect(gpu.controllers[0].utilization).toBeNull();
    expect(gpu.controllers[0].temperature).toBeNull();
    expect(gpu.controllers[0].source).toBe('static');
  });

  it('does not poll when monitoring is disabled', async () => {
    const { si, calls } = fakeSi();
    const hub = new MonitorHub({ enabled: false, intervalScale: 0.25, networkInterface: 'auto', processLimit: 10, gpu: true }, () => si);
    hub.subscribe(sink(1), 'mem');
    await new Promise((r) => setTimeout(r, 400));
    expect(calls.mem ?? 0).toBe(0);
    hub.stop();
  });
});
