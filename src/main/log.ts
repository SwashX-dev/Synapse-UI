/** Tiny leveled logger (stdout + rotating file in the state directory). */
import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
export type LogLevel = keyof typeof LEVELS;

let level: LogLevel = 'info';
let stream: fs.WriteStream | null = null;

export function setLogLevel(l: LogLevel): void {
  level = l;
}

export function openLogFile(dir: string): string | null {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'synapse-ui.log');
    try {
      if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, file + '.1');
    } catch { /* first run */ }
    stream = fs.createWriteStream(file, { flags: 'a' });
    return file;
  } catch {
    return null;
  }
}

function write(l: LogLevel, scope: string, msg: unknown[]): void {
  if (LEVELS[l] > LEVELS[level]) return;
  const text = msg.map((m) => (m instanceof Error ? m.stack ?? m.message : typeof m === 'string' ? m : JSON.stringify(m))).join(' ');
  const line = `${new Date().toISOString()} ${l.toUpperCase().padEnd(5)} [${scope}] ${text}`;
  (l === 'error' ? console.error : l === 'warn' ? console.warn : console.log)(line);
  stream?.write(line + '\n');
}

export function logger(scope: string) {
  return {
    error: (...m: unknown[]) => write('error', scope, m),
    warn: (...m: unknown[]) => write('warn', scope, m),
    info: (...m: unknown[]) => write('info', scope, m),
    debug: (...m: unknown[]) => write('debug', scope, m),
  };
}
