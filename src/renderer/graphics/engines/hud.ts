/** Small HUD drawing helpers for the scientific overlay look. */
import type { HudInfo } from '../types';
import type { Ring } from '../../core/util';

type Css = HudInfo['colors'];

export function hudFont(g: CanvasRenderingContext2D, px: number, mono: string): void {
  g.font = `${px}px "${mono}", "Fira Mono", monospace`;
  g.textBaseline = 'alphabetic';
}

/** Key/value block; first row with an empty value is a title. */
export function drawHudBlock(g: CanvasRenderingContext2D, x: number, y: number, rows: [string, string][], c: Css, align: 'left' | 'right'): void {
  g.save();
  const lh = 13;
  const keyW = 74;
  rows.forEach(([k, v], i) => {
    const yy = y + i * lh;
    if (!v) {
      g.fillStyle = c.fg;
      g.globalAlpha = 0.9;
      g.textAlign = align;
      g.fillText(k, x, yy);
      g.globalAlpha = 0.25;
      g.fillRect(align === 'left' ? x : x - 140, yy + 4, 140, 1);
      return;
    }
    g.globalAlpha = 0.55;
    g.fillStyle = c.dim;
    if (align === 'left') {
      g.textAlign = 'left';
      g.fillText(k, x, yy);
      g.globalAlpha = 0.9;
      g.fillStyle = c.fg;
      g.fillText(v, x + keyW, yy);
    } else {
      g.textAlign = 'right';
      g.fillText(k, x - keyW - 4, yy);
      g.globalAlpha = 0.9;
      g.fillStyle = c.fg;
      g.fillText(v, x, yy);
    }
  });
  g.restore();
}

export function drawSparkline(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, ring: Ring, c: Css, label: string): void {
  if (w < 40) return;
  g.save();
  g.strokeStyle = c.dim;
  g.globalAlpha = 0.35;
  g.strokeRect(x + 0.5, y + 0.5, w, h);
  g.globalAlpha = 0.55;
  g.fillStyle = c.dim;
  g.textAlign = 'left';
  g.fillText(label, x, y - 4);
  const max = Math.max(1e-6, ring.max());
  g.globalAlpha = 0.9;
  g.strokeStyle = c.fg;
  g.beginPath();
  for (let i = 0; i < ring.count; i++) {
    const px = x + (i / Math.max(1, ring.capacity - 1)) * w;
    const py = y + h - (ring.at(i) / max) * (h - 2) - 1;
    if (i === 0) g.moveTo(px, py);
    else g.lineTo(px, py);
  }
  g.stroke();
  g.restore();
}

/** Corner brackets around a rectangle (eDEX targeting look). */
export function brackets(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, len: number, color: string, alpha = 0.5): void {
  g.save();
  g.strokeStyle = color;
  g.globalAlpha = alpha;
  g.beginPath();
  g.moveTo(x, y + len); g.lineTo(x, y); g.lineTo(x + len, y);
  g.moveTo(x + w - len, y); g.lineTo(x + w, y); g.lineTo(x + w, y + len);
  g.moveTo(x + w, y + h - len); g.lineTo(x + w, y + h); g.lineTo(x + w - len, y + h);
  g.moveTo(x + len, y + h); g.lineTo(x, y + h); g.lineTo(x, y + h - len);
  g.stroke();
  g.restore();
}

/** Standard title + subtitle block used by most engines. */
export function titleBlock(g: CanvasRenderingContext2D, info: HudInfo, title: string, rows: [string, string][], right: [string, string][] = [], w = 0): void {
  hudFont(g, 10, info.colors.mono);
  drawHudBlock(g, 12, 18, [[title, ''], ...rows], info.colors, 'left');
  const r = [...right, ['CAMERA', info.camera.toUpperCase()] as [string, string], ...(info.showFps ? [['FPS', info.fps.toFixed(0)] as [string, string]] : [])];
  if (w > 260) drawHudBlock(g, w - 12, 18, r, info.colors, 'right');
}
