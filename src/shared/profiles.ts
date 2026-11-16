/**
 * Built-in workspace profiles. Users can edit and save over any of them
 * (saved copies live in layouts/<id>.json and take precedence).
 */
import { ModuleLayoutSchema, type ModuleInstance, type Workspace } from './workspace';

type G = { col: number; row: number; colSpan: number; rowSpan: number };
type F = { x: number; y: number; w: number; h: number };

function mod(id: string, type: string, place: { g?: G; f?: F; docked?: boolean; z?: number; opacity?: number; pinned?: boolean }, config: Record<string, unknown> = {}, title?: string): ModuleInstance {
  const g = place.g ?? { col: 0, row: 0, colSpan: 1, rowSpan: 1 };
  const f = place.f ?? { x: 0.35, y: 0.3, w: 0.3, h: 0.3 };
  return {
    id,
    type,
    title,
    config,
    layout: ModuleLayoutSchema.parse({ docked: place.docked ?? !place.f, ...g, ...f, z: place.z ?? 1, opacity: place.opacity ?? 1, pinned: place.pinned ?? false }),
  };
}

const viz = (preset: string, extra: Record<string, unknown> = {}) => ({ preset, ...extra });

export const BUILTIN_WORKSPACES: Workspace[] = [
  {
    format: 1,
    id: 'classic-edex',
    name: 'Classic eDEX',
    description: 'The original eDEX-UI arrangement: system columns, central terminal, filesystem and on-screen keyboard, ENCOM globe.',
    mode: 'grid',
    theme: 'edex-classic',
    grid: { cols: 4, rows: 12, gap: 6, colSizes: [17, 28.5, 37.5, 17], rowSizes: [] },
    modules: [
      mod('clock', 'clock', { g: { col: 0, row: 0, colSpan: 1, rowSpan: 1 } }),
      mod('sysinfo', 'sysinfo', { g: { col: 0, row: 1, colSpan: 1, rowSpan: 1 } }),
      mod('hardware', 'hardware', { g: { col: 0, row: 2, colSpan: 1, rowSpan: 1 } }),
      mod('cpu', 'cpu', { g: { col: 0, row: 3, colSpan: 1, rowSpan: 3 } }),
      mod('memory', 'memory', { g: { col: 0, row: 6, colSpan: 1, rowSpan: 3 } }, { style: 'pointmap' }),
      mod('toplist', 'processes', { g: { col: 0, row: 9, colSpan: 1, rowSpan: 3 } }, { compact: true }),
      mod('shell', 'terminal', { g: { col: 1, row: 0, colSpan: 2, rowSpan: 7 } }, { tabs: 5 }, 'MAIN SHELL'),
      mod('fs', 'filesystem', { g: { col: 1, row: 7, colSpan: 1, rowSpan: 5 } }),
      mod('kb', 'keyboard', { g: { col: 2, row: 7, colSpan: 1, rowSpan: 5 } }),
      mod('netstat', 'network', { g: { col: 3, row: 0, colSpan: 1, rowSpan: 2 } }),
      mod('globe', 'visualization', { g: { col: 3, row: 2, colSpan: 1, rowSpan: 6 } }, viz('encom-globe', { hud: false }), 'WORLD VIEW'),
      mod('conninfo', 'connections', { g: { col: 3, row: 8, colSpan: 1, rowSpan: 4 } }),
    ],
  },
  {
    format: 1,
    id: 'neural-lab',
    name: 'Neural Laboratory',
    description: 'A massive Neural Sphere surrounded by terminals and scientific telemetry. Hybrid: floating readouts hover over the docked sphere.',
    mode: 'hybrid',
    grid: { cols: 3, rows: 12, gap: 6, colSizes: [18, 64, 18], rowSizes: [] },
    modules: [
      mod('cpu', 'cpu', { g: { col: 0, row: 0, colSpan: 1, rowSpan: 3 } }),
      mod('mem', 'memory', { g: { col: 0, row: 3, colSpan: 1, rowSpan: 2 } }, { style: 'bars' }),
      mod('gpu', 'gpu', { g: { col: 0, row: 5, colSpan: 1, rowSpan: 2 } }),
      mod('net', 'network', { g: { col: 0, row: 7, colSpan: 1, rowSpan: 2 } }),
      mod('events', 'events', { g: { col: 0, row: 9, colSpan: 1, rowSpan: 3 } }),
      mod('sphere', 'visualization', { g: { col: 1, row: 0, colSpan: 1, rowSpan: 8 }, z: 1 }, viz('neural-sphere', { bindings: [{ param: 'activity', source: 'cpu.load', inMin: 0, inMax: 100, outMin: 0.35, outMax: 1.6 }] }), 'NEURAL SPHERE // CORTICAL MESH'),
      mod('shell', 'terminal', { g: { col: 1, row: 8, colSpan: 1, rowSpan: 4 } }, { tabs: 3 }),
      mod('telemetry', 'telemetry', { g: { col: 2, row: 0, colSpan: 1, rowSpan: 4 } }),
      mod('wave', 'waveform', { g: { col: 2, row: 4, colSpan: 1, rowSpan: 2 } }, { source: 'cpu.load', label: 'CPU LOAD TRACE' }),
      mod('wave2', 'waveform', { g: { col: 2, row: 6, colSpan: 1, rowSpan: 2 } }, { source: 'net.rx', label: 'RX TRACE' }),
      mod('procs', 'processes', { g: { col: 2, row: 8, colSpan: 1, rowSpan: 4 } }, { compact: true }),
      mod('clockf', 'clock', { f: { x: 0.44, y: 0.018, w: 0.12, h: 0.07 }, z: 5, opacity: 0.85 }, { compact: true }),
      mod('osc', 'visualization', { f: { x: 0.69, y: 0.5, w: 0.12, h: 0.16 }, z: 6, opacity: 0.85 }, viz('wave-lab', { hud: false }), 'OSCILLOSCOPE'),
    ],
  },
  {
    format: 1,
    id: 'cyber-sec',
    name: 'Cybersecurity Workstation',
    description: 'Network topology and globe visualizations, live connections, processes and twin terminals.',
    mode: 'grid',
    theme: 'cybernetic-blue',
    grid: { cols: 4, rows: 12, gap: 6, colSizes: [20, 30, 30, 20], rowSizes: [] },
    modules: [
      mod('net', 'network', { g: { col: 0, row: 0, colSpan: 1, rowSpan: 2 } }),
      mod('conn', 'connections', { g: { col: 0, row: 2, colSpan: 1, rowSpan: 3 } }, { showList: true }),
      mod('procs', 'processes', { g: { col: 0, row: 5, colSpan: 1, rowSpan: 7 } }),
      mod('topology', 'visualization', { g: { col: 1, row: 0, colSpan: 2, rowSpan: 6 } }, viz('network-topology'), 'NETWORK TOPOLOGY // LIVE ENDPOINTS'),
      mod('t1', 'terminal', { g: { col: 1, row: 6, colSpan: 1, rowSpan: 6 } }, { tabs: 2 }),
      mod('t2', 'terminal', { g: { col: 2, row: 6, colSpan: 1, rowSpan: 6 } }, { tabs: 2 }),
      mod('globe', 'visualization', { g: { col: 3, row: 0, colSpan: 1, rowSpan: 5 } }, viz('encom-globe'), 'ENCOM GLOBE+'),
      mod('cpu', 'cpu', { g: { col: 3, row: 5, colSpan: 1, rowSpan: 3 } }),
      mod('events', 'events', { g: { col: 3, row: 8, colSpan: 1, rowSpan: 4 } }),
    ],
  },
  {
    format: 1,
    id: 'scientific',
    name: 'Scientific Research',
    description: 'Several simultaneous simulations with data monitors, plots and a control terminal.',
    mode: 'grid',
    theme: 'obsidian',
    grid: { cols: 4, rows: 3, gap: 6, colSizes: [], rowSizes: [1, 1, 0.8] },
    modules: [
      mod('chaos', 'visualization', { g: { col: 0, row: 0, colSpan: 1, rowSpan: 1 } }, viz('lorenz-attractor'), 'LORENZ SYSTEM σ=10 ρ=28 β=8/3'),
      mod('mol', 'visualization', { g: { col: 1, row: 0, colSpan: 1, rowSpan: 1 } }, viz('molecular-lab')),
      mod('orbit', 'visualization', { g: { col: 2, row: 0, colSpan: 2, rowSpan: 1 } }, viz('orbital-mechanics')),
      mod('dna', 'visualization', { g: { col: 0, row: 1, colSpan: 1, rowSpan: 1 } }, viz('dna-helix')),
      mod('em', 'visualization', { g: { col: 1, row: 1, colSpan: 1, rowSpan: 1 } }, viz('electromagnetic-field')),
      mod('waves', 'visualization', { g: { col: 2, row: 1, colSpan: 1, rowSpan: 1 } }, viz('wave-lab')),
      mod('plot', 'dataplot', { g: { col: 3, row: 1, colSpan: 1, rowSpan: 1 } }, { source: 'function', expression: 'sin(t*1.7)*exp(-0.1*mod(t,20)) + 0.2*sin(t*13)' }),
      mod('shell', 'terminal', { g: { col: 0, row: 2, colSpan: 2, rowSpan: 1 } }),
      mod('telemetry', 'telemetry', { g: { col: 2, row: 2, colSpan: 1, rowSpan: 1 } }),
      mod('perf', 'performance', { g: { col: 3, row: 2, colSpan: 1, rowSpan: 1 } }),
    ],
  },
  {
    format: 1,
    id: 'cinematic',
    name: 'Cinematic Visualization',
    description: 'Minimal interface elements around an enormous animated visualization.',
    mode: 'freeform',
    performance: 'cinematic',
    grid: { cols: 12, rows: 12, gap: 0, colSizes: [], rowSizes: [] },
    modules: [
      mod('sphere', 'visualization', { f: { x: 0, y: 0, w: 1, h: 1 }, z: 1 }, viz('neural-sphere', { camera: 'cinematic', chrome: false })),
      mod('clock', 'clock', { f: { x: 0.015, y: 0.02, w: 0.14, h: 0.08 }, z: 2, opacity: 0.7 }, { compact: true }),
      mod('telemetry', 'telemetry', { f: { x: 0.83, y: 0.72, w: 0.155, h: 0.25 }, z: 3, opacity: 0.6 }),
    ],
  },
  {
    format: 1,
    id: 'custom',
    name: 'Custom Workspace',
    description: 'A blank-slate starting point. Press Ctrl+Shift+E to edit and drag modules in from the library.',
    mode: 'hybrid',
    grid: { cols: 6, rows: 6, gap: 6, colSizes: [], rowSizes: [] },
    modules: [
      mod('shell', 'terminal', { g: { col: 0, row: 3, colSpan: 4, rowSpan: 3 } }),
      mod('viz', 'visualization', { g: { col: 0, row: 0, colSpan: 4, rowSpan: 3 } }, viz('neural-sphere')),
      mod('cpu', 'cpu', { g: { col: 4, row: 0, colSpan: 2, rowSpan: 2 } }),
      mod('mem', 'memory', { g: { col: 4, row: 2, colSpan: 2, rowSpan: 2 } }),
      mod('net', 'network', { g: { col: 4, row: 4, colSpan: 2, rowSpan: 2 } }),
    ],
  },
];
