/**
 * Terminal sessions. Shells run in the main process via node-pty; data flows
 * to the renderer ONLY over Electron IPC to the owning WebContents.
 *
 * Unlike eDEX-UI (which exposed each shell on an unauthenticated
 * ws://localhost:3000+ WebSocket — CVE-2023-30856) nothing here listens on a
 * socket, so other local processes and web pages cannot reach a terminal.
 *
 * Sessions survive renderer module remounts (e.g. switching workspaces) and
 * keep a bounded scrollback buffer that is replayed on re-attach.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { IPty } from 'node-pty';
import type { PtyCreated } from '../shared/ipc';
import { Events } from '../shared/ipc';
import { loginArgs, resolveShell } from './shells';
import { logger } from './log';

const log = logger('pty');
const REPLAY_LIMIT = 256 * 1024;
const FLUSH_MS = 6;
const MAX_SESSIONS = 64;

export interface Sink {
  id: number;
  send(channel: string, ...args: unknown[]): void;
  isDestroyed(): boolean;
}

export interface PtyOptions {
  shell: string;
  args: string[];
  login: boolean;
  cwd: string;
  env: Record<string, string>;
  appCommands: boolean;
  binDir: string | null;
  scrollbackBytes?: number;
}

interface Session {
  id: string;
  pty: IPty;
  owner: Sink;
  shell: string;
  shellId: string;
  cwd: string;
  token: string;
  replay: string[];
  replayBytes: number;
  pending: string;
  flushTimer: NodeJS.Timeout | null;
  exited: boolean;
  title: string;
}

type PtyModule = typeof import('node-pty');

export class PtyManager {
  private sessions = new Map<string, Session>();
  private ptyModule: PtyModule | null = null;

  constructor(private loadPty: () => PtyModule = () => require('node-pty') as PtyModule) {}

  private pty(): PtyModule {
    this.ptyModule ??= this.loadPty();
    return this.ptyModule;
  }

  create(owner: Sink, req: { shell?: string; cwd?: string; cols: number; rows: number }, opts: PtyOptions): PtyCreated & { token: string } {
    if (this.sessions.size >= MAX_SESSIONS) throw new Error(`too many terminal sessions (max ${MAX_SESSIONS})`);
    const resolved = resolveShell(req.shell || opts.shell);
    const id = `pty-${crypto.randomBytes(9).toString('hex')}`;
    const token = crypto.randomBytes(24).toString('base64url');
    const cwd = pickCwd(req.cwd || opts.cwd);
    const args = [...(opts.login ? loginArgs(resolved.id) : []), ...opts.args];
    const env = buildEnv(opts, id, token);
    const p = this.pty().spawn(resolved.path, args, {
      name: 'xterm-256color',
      cols: req.cols,
      rows: req.rows,
      cwd,
      env,
      ...(process.platform === 'win32' ? { useConpty: true } : {}),
    });
    const s: Session = { id, pty: p, owner, shell: resolved.path, shellId: resolved.id, cwd, token, replay: [], replayBytes: 0, pending: '', flushTimer: null, exited: false, title: resolved.id };
    this.sessions.set(id, s);
    const limit = opts.scrollbackBytes ?? REPLAY_LIMIT;
    p.onData((data) => {
      s.replay.push(data);
      s.replayBytes += data.length;
      while (s.replayBytes > limit && s.replay.length > 1) s.replayBytes -= s.replay.shift()!.length;
      s.pending += data;
      if (s.pending.length > 64 * 1024) this.flush(s);
      else s.flushTimer ??= setTimeout(() => this.flush(s), FLUSH_MS);
    });
    p.onExit(({ exitCode, signal }) => {
      this.flush(s);
      s.exited = true;
      if (!s.owner.isDestroyed()) s.owner.send(Events.ptyExit, id, exitCode, signal ?? 0);
      this.sessions.delete(id);
      log.info(`session ${id} (${s.shellId}, pid ${p.pid}) exited with ${exitCode}${signal ? ` signal ${signal}` : ''}`);
    });
    log.info(`session ${id}: ${resolved.path} ${args.join(' ')} (pid ${p.pid}) in ${cwd}`);
    return { id, pid: p.pid, shell: resolved.id, cwd, token };
  }

  private flush(s: Session): void {
    if (s.flushTimer) clearTimeout(s.flushTimer);
    s.flushTimer = null;
    if (!s.pending) return;
    const data = s.pending;
    s.pending = '';
    if (!s.owner.isDestroyed()) s.owner.send(Events.ptyData, s.id, data);
  }

  private get(owner: Sink, id: string): Session {
    const s = this.sessions.get(id);
    if (!s || s.owner.id !== owner.id) throw new Error(`unknown terminal session ${id}`);
    return s;
  }

  write(owner: Sink, id: string, data: string): void {
    const s = this.get(owner, id);
    if (!s.exited) s.pty.write(data);
  }

  resize(owner: Sink, id: string, cols: number, rows: number): void {
    const s = this.get(owner, id);
    if (s.exited) return;
    try {
      s.pty.resize(cols, rows);
    } catch (e) {
      log.debug(`resize ${id} failed`, e);
    }
  }

  kill(owner: Sink, id: string): void {
    const s = this.get(owner, id);
    this.terminate(s);
  }

  /** Re-attach a (possibly remounted) terminal: returns buffered output. */
  attach(owner: Sink, id: string): { replay: string; shell: string; token: string } {
    const s = this.get(owner, id);
    this.flush(s);
    return { replay: s.replay.join(''), shell: s.shellId, token: s.token };
  }

  list(owner: Sink): { id: string; pid: number; shell: string }[] {
    return [...this.sessions.values()].filter((s) => s.owner.id === owner.id).map((s) => ({ id: s.id, pid: s.pty.pid, shell: s.shellId }));
  }

  /** Current working directory and foreground process name (best effort, per platform). */
  async info(owner: Sink, id: string): Promise<{ cwd: string | null; process: string | null; pid: number }> {
    const s = this.get(owner, id);
    const pid = s.pty.pid;
    if (process.platform === 'linux') {
      let fg = pid;
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const tpgid = Number(fields[5]);
        if (tpgid > 0) fg = tpgid;
      } catch { /* exited */ }
      const read = (p: string) => { try { return fs.readlinkSync(p); } catch { return null; } };
      let name: string | null = null;
      try { name = fs.readFileSync(`/proc/${fg}/comm`, 'utf8').trim(); } catch { name = s.pty.process; }
      return { cwd: read(`/proc/${fg}/cwd`) ?? read(`/proc/${pid}/cwd`), process: name, pid };
    }
    if (process.platform === 'darwin') {
      const cwd = await new Promise<string | null>((resolve) =>
        execFile('lsof', ['-a', '-d', 'cwd', '-p', String(pid), '-Fn'], { timeout: 1500 }, (err, out) => {
          if (err) return resolve(null);
          const line = out.split('\n').find((l) => l.startsWith('n'));
          resolve(line ? line.slice(1) : null);
        }),
      );
      return { cwd, process: s.pty.process || null, pid };
    }
    return { cwd: null, process: s.pty.process || null, pid };
  }

  tokenFor(owner: Sink, id: string): string {
    return this.get(owner, id).token;
  }

  /** Kill every session owned by a WebContents (window closed / reloaded). */
  disposeOwner(ownerId: number): void {
    for (const s of [...this.sessions.values()]) if (s.owner.id === ownerId) this.terminate(s);
  }

  disposeAll(): void {
    for (const s of [...this.sessions.values()]) this.terminate(s);
  }

  get size(): number {
    return this.sessions.size;
  }

  private terminate(s: Session): void {
    if (s.flushTimer) clearTimeout(s.flushTimer);
    this.sessions.delete(s.id);
    if (s.exited) return;
    s.exited = true;
    try {
      if (process.platform === 'win32') s.pty.kill();
      else {
        s.pty.kill('SIGHUP');
        const pid = s.pty.pid;
        setTimeout(() => { try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }, 1500).unref();
      }
    } catch (e) {
      log.debug(`kill ${s.id} failed`, e);
    }
  }
}

function pickCwd(requested: string): string {
  const home = os.homedir();
  if (!requested) return home;
  const expanded = requested === '~' ? home : requested.startsWith('~/') ? path.join(home, requested.slice(2)) : requested;
  try {
    if (path.isAbsolute(expanded) && fs.statSync(expanded).isDirectory()) return expanded;
  } catch { /* fall through */ }
  return home;
}

/** Environment for a shell: the user's environment minus Electron internals, plus terminal identification. */
export function buildEnv(opts: Pick<PtyOptions, 'env' | 'appCommands' | 'binDir'>, id: string, token: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^(ELECTRON_|CHROME_|GOOGLE_API_KEY|NODE_OPTIONS$|NODE_ENV$|ORIGINAL_XDG_CURRENT_DESKTOP$|SYNAPSE_)/.test(k)) continue;
    env[k] = v;
  }
  if (process.env.ORIGINAL_XDG_CURRENT_DESKTOP) env.XDG_CURRENT_DESKTOP = process.env.ORIGINAL_XDG_CURRENT_DESKTOP;
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'SYNAPSE-UI';
  env.TERM_PROGRAM_VERSION = process.env.npm_package_version ?? '3';
  if (opts.appCommands) {
    env.SYNAPSE_TERM_TOKEN = token;
    env.SYNAPSE_SESSION = id;
    if (opts.binDir) env.PATH = `${opts.binDir}${path.delimiter}${env.PATH ?? env.Path ?? ''}`;
  }
  for (const [k, v] of Object.entries(opts.env)) env[k] = v;
  return env;
}
