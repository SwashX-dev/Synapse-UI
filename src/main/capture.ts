/**
 * Writes screenshots, recordings and offline image sequences. The renderer
 * only supplies a file *name*; the directory is decided here (configured
 * folder or Videos/Pictures), so renderer code cannot write arbitrary paths.
 * MP4 encoding uses an ffmpeg found on PATH, if any.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { which } from './shells';
import { logger } from './log';

const log = logger('capture');

export class CaptureService {
  private sequences = new Map<string, { dir: string; frames: number }>();
  constructor(private dirs: () => { images: string; videos: string }) {}

  private unique(dir: string, name: string): string {
    fs.mkdirSync(dir, { recursive: true });
    const ext = path.extname(name);
    const base = path.basename(name, ext).replace(/[^A-Za-z0-9._ -]/g, '_');
    let file = path.join(dir, base + ext);
    for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${base}-${i}${ext}`);
    return file;
  }

  save(name: string, kind: 'image' | 'video', data: Uint8Array): string {
    const dir = kind === 'image' ? this.dirs().images : this.dirs().videos;
    const file = this.unique(dir, name);
    fs.writeFileSync(file, data);
    log.info(`saved ${kind} ${file} (${data.byteLength} bytes)`);
    return file;
  }

  beginSequence(name: string): { id: string; dir: string } {
    const dir = this.unique(this.dirs().videos, name.replace(/\.[a-z0-9]+$/i, ''));
    fs.mkdirSync(dir, { recursive: true });
    const id = `seq-${crypto.randomBytes(8).toString('hex')}`;
    this.sequences.set(id, { dir, frames: 0 });
    return { id, dir };
  }

  frame(id: string, index: number, png: Uint8Array): void {
    const s = this.sequences.get(id);
    if (!s) throw new Error('unknown sequence');
    if (s.frames > 100_000) throw new Error('sequence too long');
    fs.writeFileSync(path.join(s.dir, `frame-${String(index).padStart(6, '0')}.png`), png);
    s.frames++;
  }

  ffmpegPath(): string | null {
    return which(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  }

  async endSequence(id: string, opts: { encode: 'none' | 'mp4' | 'webm'; fps: number; quality: number }): Promise<{ dir: string; frames: number; video: string | null; error?: string }> {
    const s = this.sequences.get(id);
    if (!s) throw new Error('unknown sequence');
    this.sequences.delete(id);
    if (opts.encode === 'none') return { dir: s.dir, frames: s.frames, video: null };
    const ffmpeg = this.ffmpegPath();
    if (!ffmpeg) return { dir: s.dir, frames: s.frames, video: null, error: 'ffmpeg was not found on PATH; the PNG frames were kept' };
    const out = `${s.dir}.${opts.encode}`;
    const crf = Math.round(40 - opts.quality * 25); // quality 1 → crf 15, 0.1 → crf 37
    const args =
      opts.encode === 'mp4'
        ? ['-y', '-framerate', String(opts.fps), '-i', path.join(s.dir, 'frame-%06d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', String(crf), '-movflags', '+faststart', out]
        : ['-y', '-framerate', String(opts.fps), '-i', path.join(s.dir, 'frame-%06d.png'), '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', String(crf + 5), out];
    const err = await new Promise<string | null>((resolve) => {
      const p = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      p.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
      p.on('error', (e) => resolve(e.message));
      p.on('close', (code) => resolve(code === 0 ? null : `ffmpeg exited with ${code}: ${stderr.split('\n').slice(-3).join(' ')}`));
    });
    if (err) return { dir: s.dir, frames: s.frames, video: null, error: err };
    log.info(`encoded ${s.frames} frames → ${out}`);
    return { dir: s.dir, frames: s.frames, video: out };
  }
}
