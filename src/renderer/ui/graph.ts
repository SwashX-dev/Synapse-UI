/** Lightweight 2D canvas time-series graphs (eDEX "smoothie" style), theme-aware. */
import { cssVar, fitCanvas, type Ring } from '../core/util';

export interface GraphOptions {
  min?: number;
  max?: number | 'auto';
  fill?: boolean;
  grid?: number;
  stroke?: number;
  colors?: string[];
  label?: string;
}

export class Graph {
  readonly canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  constructor(parent: HTMLElement, private opts: GraphOptions = {}) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'graph';
    parent.append(this.canvas);
    this.g = this.canvas.getContext('2d')!;
  }

  draw(series: Ring[]): void {
    const c = this.canvas;
    if (!c.isConnected || c.clientWidth < 4 || c.clientHeight < 4) return;
    fitCanvas(c);
    const g = this.g;
    const w = c.width, h = c.height;
    const dpr = window.devicePixelRatio || 1;
    g.clearRect(0, 0, w, h);
    const grid = cssVar(c, '--border') || '#444';
    const colors = this.opts.colors ?? [0, 1, 2, 3].map((i) => cssVar(c, `--graph-${i}`) || '#fff');
    // Grid
    g.strokeStyle = grid;
    g.globalAlpha = 0.25;
    g.lineWidth = 1;
    const gl = this.opts.grid ?? 4;
    g.beginPath();
    for (let i = 1; i < gl; i++) {
      const y = Math.round((h / gl) * i) + 0.5;
      g.moveTo(0, y);
      g.lineTo(w, y);
    }
    for (let i = 1; i < 10; i++) {
      const x = Math.round((w / 10) * i) + 0.5;
      g.moveTo(x, 0);
      g.lineTo(x, h);
    }
    g.stroke();
    g.globalAlpha = 1;
    const min = this.opts.min ?? 0;
    let max = this.opts.max === undefined || this.opts.max === 'auto' ? 0 : this.opts.max;
    if (this.opts.max === undefined || this.opts.max === 'auto') {
      for (const r of series) max = Math.max(max, r.max());
      max = max <= 0 ? 1 : max * 1.15;
    }
    series.forEach((r, si) => {
      if (r.count < 2) return;
      const col = colors[si % colors.length];
      const n = r.capacity;
      g.beginPath();
      for (let i = 0; i < r.count; i++) {
        const x = w - ((r.count - 1 - i) / (n - 1)) * w;
        const y = h - ((r.at(i) - min) / (max - min || 1)) * (h - 2 * dpr) - dpr;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.strokeStyle = col;
      g.lineWidth = (this.opts.stroke ?? 1.2) * dpr;
      g.stroke();
      if (this.opts.fill && si === 0) {
        g.lineTo(w, h);
        g.lineTo(w - ((r.count - 1) / (n - 1)) * w, h);
        g.closePath();
        g.globalAlpha = 0.12;
        g.fillStyle = col;
        g.fill();
        g.globalAlpha = 1;
      }
    });
    if (this.opts.label) {
      g.fillStyle = cssVar(c, '--text-dim') || '#888';
      g.font = `${9 * dpr}px ${cssVar(c, '--font-mono') || 'monospace'}`;
      g.fillText(this.opts.label, 4 * dpr, 11 * dpr);
    }
  }
}

/** Radial gauge drawn on a canvas. */
export function drawGauge(c: HTMLCanvasElement, value: number | null, label: string, unit = '%'): void {
  if (!c.isConnected || c.clientWidth < 8) return;
  fitCanvas(c);
  const g = c.getContext('2d')!;
  const w = c.width, h = c.height, dpr = window.devicePixelRatio || 1;
  const r = Math.min(w, h) / 2 - 6 * dpr;
  g.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2;
  const fg = cssVar(c, '--fg') || '#fff', dim = cssVar(c, '--border') || '#444';
  g.lineWidth = 2 * dpr;
  g.strokeStyle = dim;
  g.globalAlpha = 0.45;
  g.beginPath();
  g.arc(cx, cy, r, Math.PI * 0.75, Math.PI * 2.25);
  g.stroke();
  for (let i = 0; i <= 20; i++) {
    const a = Math.PI * 0.75 + (i / 20) * Math.PI * 1.5;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * (r - 4 * dpr), cy + Math.sin(a) * (r - 4 * dpr));
    g.lineTo(cx + Math.cos(a) * (r - (i % 5 ? 7 : 10) * dpr), cy + Math.sin(a) * (r - (i % 5 ? 7 : 10) * dpr));
    g.stroke();
  }
  g.globalAlpha = 1;
  if (value !== null) {
    g.strokeStyle = fg;
    g.lineWidth = 3 * dpr;
    g.beginPath();
    g.arc(cx, cy, r, Math.PI * 0.75, Math.PI * 0.75 + Math.max(0, Math.min(1, value / 100)) * Math.PI * 1.5);
    g.stroke();
  }
  g.fillStyle = fg;
  g.textAlign = 'center';
  g.font = `${Math.max(10, r * 0.42)}px ${cssVar(c, '--font-ui') || 'sans-serif'}`;
  g.fillText(value === null ? '—' : `${value.toFixed(0)}${unit}`, cx, cy + r * 0.12);
  g.fillStyle = cssVar(c, '--text-dim') || '#888';
  g.font = `${Math.max(8, r * 0.2)}px ${cssVar(c, '--font-mono') || 'monospace'}`;
  g.fillText(label, cx, cy + r * 0.52);
}
