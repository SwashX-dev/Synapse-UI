/**
 * Third-party module discovery and permission bookkeeping.
 * <config>/modules/<id>/manifest.json, state in <config>/modules/.state.json.
 * Nothing here executes extension code; script extensions are only ever
 * served (by protocol.ts) into sandboxed, network-less iframes once the user
 * has enabled them, approved their permissions and allowed extension scripts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { checkExtensionManifest, type ExtensionManifest } from '../shared/manifest';
import { logger } from './log';

const log = logger('extensions');
const MAX_FILES = 200;
const MAX_TOTAL = 20 * 1024 * 1024;

export interface ExtensionInfo {
  id: string;
  dir: string;
  manifest: ExtensionManifest | null;
  errors: string[];
  warnings: string[];
  enabled: boolean;
  approved: string[];
  /** Declared permissions that are not yet approved. */
  pending: string[];
  /** Theme/preset payloads read from disk for declarative modules. */
  themeFiles: { name: string; text: string }[];
}

interface State { enabled: Record<string, boolean>; approvals: Record<string, string[]> }

export class ExtensionRegistry {
  private state: State = { enabled: {}, approvals: {} };
  constructor(private dir: string) {
    this.load();
  }

  private get stateFile(): string {
    return path.join(this.dir, '.state.json');
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as Partial<State>;
      this.state = { enabled: { ...(raw.enabled ?? {}) }, approvals: { ...(raw.approvals ?? {}) } };
    } catch {
      this.state = { enabled: {}, approvals: {} };
    }
  }

  private save(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2), { mode: 0o600 });
  }

  list(): ExtensionInfo[] {
    this.load();
    const out: ExtensionInfo[] = [];
    let names: string[];
    try { names = fs.readdirSync(this.dir).filter((n) => !n.startsWith('.')); } catch { return out; }
    for (const name of names) {
      const dir = path.join(this.dir, name);
      try {
        if (!fs.lstatSync(dir).isDirectory()) continue;
      } catch { continue; }
      const info: ExtensionInfo = { id: name, dir, manifest: null, errors: [], warnings: [], enabled: false, approved: [], pending: [], themeFiles: [] };
      try {
        const check = checkExtensionManifest(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')));
        info.errors = check.errors;
        info.warnings = check.warnings;
        if (check.manifest) {
          info.manifest = check.manifest;
          if (check.manifest.id !== name) info.errors.push(`manifest id "${check.manifest.id}" must match folder name "${name}"`);
          if (check.manifest.kind === 'themes') {
            for (const t of check.manifest.themes ?? []) {
              try { info.themeFiles.push({ name: t, text: fs.readFileSync(path.join(dir, t), 'utf8').slice(0, 256 * 1024) }); } catch (e) { info.errors.push(`cannot read ${t}: ${(e as Error).message}`); }
            }
          }
        }
      } catch (e) {
        info.errors.push(`manifest.json: ${(e as Error).message.split('\n')[0]}`);
      }
      const declared = info.manifest?.permissions ?? [];
      info.approved = (this.state.approvals[name] ?? []).filter((p) => declared.includes(p));
      info.pending = declared.filter((p) => !info.approved.includes(p));
      info.enabled = !!this.state.enabled[name] && info.errors.length === 0 && info.pending.length === 0;
      out.push(info);
    }
    return out;
  }

  setEnabled(id: string, enabled: boolean): ExtensionInfo | null {
    const info = this.list().find((x) => x.id === id);
    if (!info) return null;
    if (enabled && (info.errors.length || info.pending.length)) throw new Error(info.errors.length ? `cannot enable: ${info.errors[0]}` : `approve its permissions first (${info.pending.join(', ')})`);
    this.state.enabled[id] = enabled;
    this.save();
    return this.list().find((x) => x.id === id) ?? null;
  }

  /** Grant exactly `permissions` (must be a subset of what the manifest declares). */
  approve(id: string, permissions: string[]): ExtensionInfo | null {
    const info = this.list().find((x) => x.id === id);
    if (!info?.manifest) return null;
    const declared = new Set(info.manifest.permissions);
    const granted = permissions.filter((p) => declared.has(p));
    this.state.approvals[id] = granted;
    if (granted.length < declared.size) this.state.enabled[id] = false;
    this.save();
    log.info(`permissions for ${id}: ${granted.join(', ') || '(none)'}`);
    return this.list().find((x) => x.id === id) ?? null;
  }

  /** Directory to serve for an enabled, approved script extension. */
  scriptDir(id: string, scriptsAllowed: boolean): string | null {
    if (!scriptsAllowed) return null;
    const info = this.list().find((x) => x.id === id);
    if (!info?.enabled || info.manifest?.kind !== 'script' || !info.approved.includes('script')) return null;
    return info.dir;
  }

  /** Copy an extension folder into the modules directory (regular files only, size-limited). */
  importFrom(src: string): ExtensionInfo {
    const raw = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
    const check = checkExtensionManifest(raw);
    if (!check.manifest) throw new Error(`invalid manifest: ${check.errors.join('; ')}`);
    const id = check.manifest.id;
    const dest = path.join(this.dir, id);
    if (fs.existsSync(dest)) throw new Error(`a module with id "${id}" is already installed`);
    let files = 0;
    let total = 0;
    const copy = (from: string, to: string) => {
      fs.mkdirSync(to, { recursive: true });
      for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
        if (ent.name.startsWith('.')) continue;
        const a = path.join(from, ent.name);
        const b2 = path.join(to, ent.name);
        if (ent.isSymbolicLink()) continue;
        if (ent.isDirectory()) copy(a, b2);
        else if (ent.isFile()) {
          const size = fs.statSync(a).size;
          if (++files > MAX_FILES || (total += size) > MAX_TOTAL) throw new Error('module is too large');
          fs.copyFileSync(a, b2);
        }
      }
    };
    try {
      copy(src, dest);
    } catch (e) {
      fs.rmSync(dest, { recursive: true, force: true });
      throw e;
    }
    this.state.enabled[id] = false;
    this.save();
    return this.list().find((x) => x.id === id)!;
  }

  remove(id: string): boolean {
    const dest = path.join(this.dir, id);
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(id) || !fs.existsSync(dest)) return false;
    fs.rmSync(dest, { recursive: true, force: true });
    delete this.state.enabled[id];
    delete this.state.approvals[id];
    this.save();
    return true;
  }
}
