/** Shell discovery. Never assumes a shell exists — every candidate is checked on disk. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ShellInfo } from '../shared/ipc';

const POSIX_CANDIDATES = ['bash', 'zsh', 'fish', 'nu', 'pwsh', 'elvish', 'xonsh', 'ksh', 'mksh', 'tcsh', 'dash', 'sh'];
const WIN_CANDIDATES = ['pwsh.exe', 'powershell.exe', 'cmd.exe', 'nu.exe', 'bash.exe', 'wsl.exe'];

const PRETTY: Record<string, string> = {
  bash: 'Bash', zsh: 'Zsh', fish: 'Fish', nu: 'Nushell', pwsh: 'PowerShell 7', powershell: 'Windows PowerShell', cmd: 'Command Prompt',
  elvish: 'Elvish', xonsh: 'Xonsh', ksh: 'KornShell', mksh: 'MirBSD Korn', tcsh: 'tcsh', dash: 'Dash', sh: 'POSIX sh', wsl: 'WSL',
};

export function which(cmd: string, envPath = process.env.PATH ?? ''): string | null {
  if (path.isAbsolute(cmd)) return isExecutable(cmd) ? cmd : null;
  const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase())] : [''];
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, cmd + (cmd.toLowerCase().endsWith(ext) ? '' : ext));
      if (isExecutable(p)) return p;
    }
  }
  return null;
}

function isExecutable(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultShellPath(): string | null {
  if (process.platform === 'win32') return which('pwsh.exe') ?? which('powershell.exe') ?? process.env.COMSPEC ?? 'cmd.exe';
  const envShell = process.env.SHELL;
  if (envShell && isExecutable(envShell)) return envShell;
  try {
    const sh = os.userInfo().shell;
    if (sh && isExecutable(sh)) return sh;
  } catch { /* no passwd entry */ }
  return which('bash') ?? which('sh');
}

export function detectShells(): ShellInfo[] {
  const found = new Map<string, ShellInfo>();
  const def = defaultShellPath();
  const add = (p: string) => {
    let real = p;
    try { real = fs.realpathSync(p); } catch { /* keep */ }
    const base = path.basename(p).replace(/\.exe$/i, '');
    if ([...found.values()].some((s) => s.path === p || s.id === base)) return;
    found.set(p, { id: base, name: PRETTY[base] ?? base, path: p, default: def !== null && (p === def || real === def) });
  };
  if (def) add(def);
  if (process.platform === 'win32') {
    for (const c of WIN_CANDIDATES) { const p = which(c); if (p) add(p); }
  } else {
    for (const c of POSIX_CANDIDATES) { const p = which(c); if (p) add(p); }
    try {
      for (const line of fs.readFileSync('/etc/shells', 'utf8').split('\n')) {
        const l = line.trim();
        if (l && !l.startsWith('#') && isExecutable(l) && !/nologin|false/.test(l)) add(l);
      }
    } catch { /* not present (e.g. NixOS may differ) */ }
  }
  return [...found.values()];
}

/** Resolve the configured shell ("auto", a name on PATH, or an absolute path). */
export function resolveShell(setting: string): { path: string; id: string } {
  const tryResolve = (s: string) => (s === 'auto' || !s ? defaultShellPath() : which(s));
  const p = tryResolve(setting) ?? defaultShellPath();
  if (!p) throw new Error('no usable shell found (checked $SHELL, the passwd entry, bash and sh)');
  return { path: p, id: path.basename(p).replace(/\.exe$/i, '') };
}

/** Arguments that make a shell a login shell, where that concept applies. */
export function loginArgs(shellId: string): string[] {
  if (process.platform === 'win32') return shellId === 'pwsh' || shellId === 'powershell' ? ['-NoLogo'] : [];
  if (['bash', 'zsh', 'sh', 'dash', 'ksh', 'mksh', 'fish', 'tcsh'].includes(shellId)) return ['-l'];
  if (shellId === 'nu') return ['--login'];
  return [];
}
