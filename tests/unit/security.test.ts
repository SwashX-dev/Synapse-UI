import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Invoke } from '../../src/shared/ipc';
import { safeJoin } from '../../src/main/safe-path';
import { checkExtensionManifest } from '../../src/shared/manifest';
import { ExtensionRegistry } from '../../src/main/extensions';

const root = path.resolve(__dirname, '../..');

describe('CVE-2023-30856 regression (no network terminal transport)', () => {
  it('does not depend on a WebSocket server library', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(deps.ws).toBeUndefined();
    expect(deps['xterm-addon-attach']).toBeUndefined();
  });

  it('never opens a listening socket in main-process code', () => {
    const files = fs.readdirSync(path.join(root, 'src/main')).filter((f) => f.endsWith('.ts'));
    for (const f of files) {
      const src = fs.readFileSync(path.join(root, 'src/main', f), 'utf8');
      expect(src, f).not.toMatch(/WebSocketServer|new\s+WebSocket|\.listen\(|createServer\(|require\(['"]ws['"]\)|from ['"]ws['"]/);
    }
  });
});

describe('IPC argument validation', () => {
  it('accepts well-formed requests', () => {
    expect(Invoke['pty:write'].safeParse(['pty-abcdef012345', 'ls\r']).success).toBe(true);
    expect(Invoke['pty:create'].safeParse([{ cols: 80, rows: 24 }]).success).toBe(true);
    expect(Invoke['monitor:subscribe'].safeParse(['cpu']).success).toBe(true);
  });
  it('rejects malformed or hostile requests', () => {
    const bad: [keyof typeof Invoke, unknown[]][] = [
      ['pty:write', ['../../etc', 'x']],
      ['pty:write', ['pty-abcdef012345', 42]],
      ['pty:write', ['pty-abcdef012345', 'x'.repeat((1 << 20) + 1)]],
      ['pty:resize', ['pty-abcdef012345', 1e9, 24]],
      ['pty:create', [{ cols: 'eighty', rows: 24 }]],
      ['monitor:subscribe', ['/etc/shadow']],
      ['monitor:kill', [1, 'SIGKILL']],
      ['monitor:kill', [1234, 'SIGSEGV']],
      ['config:delete-theme', ['../config']],
      ['config:restore-backup', ['../../x']],
      ['app:open-external', ['javascript:alert(1)']],
      ['app:open-path', ['/etc']],
      ['fs:list', ['/tmp\u0000/x']],
      ['capture:save', [{ name: '../escape.png', kind: 'image', data: new Uint8Array(1) }]],
      ['capture:save', [{ name: 'ok.png', kind: 'image', data: 'not bytes' }]],
      ['app:quit', ['unexpected']],
    ];
    for (const [ch, args] of bad) expect(Invoke[ch].safeParse(args).success, `${ch} ${JSON.stringify(args).slice(0, 60)}`).toBe(false);
  });
});

describe('protocol path containment', () => {
  it('keeps requests inside the renderer root', () => {
    const r = '/opt/synapse/renderer';
    expect(safeJoin(r, '/index.html')).toBe('/opt/synapse/renderer/index.html');
    expect(safeJoin(r, '/assets/../index.html')).toBe('/opt/synapse/renderer/index.html');
    expect(safeJoin(r, '/../../../etc/passwd')).toBe('/opt/synapse/renderer/etc/passwd');
    expect(safeJoin(r, '..\\..\\etc\\passwd')).toBe('/opt/synapse/renderer/etc/passwd');
    expect(safeJoin(r, '/a\u0000b')).toBeNull();
  });
});

describe('module permissions', () => {
  const base = { manifest_version: 1, id: 'demo-mod', name: 'Demo', version: '1.0.0', description: '', author: 'x' };
  it('accepts declarative modules with matching permissions', () => {
    const r = checkExtensionManifest({ ...base, kind: 'panel', permissions: ['monitor.cpu'], panel: { title: 'P', widgets: [{ kind: 'value', label: 'CPU', source: 'cpu.load' }] } });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });
  it('rejects undeclared, forbidden or inconsistent permissions', () => {
    expect(checkExtensionManifest({ ...base, kind: 'panel', permissions: [], panel: { title: 'P', widgets: [{ kind: 'value', label: 'CPU', source: 'cpu.load' }] } }).ok).toBe(false);
    expect(checkExtensionManifest({ ...base, kind: 'presets', permissions: ['terminal.write'], presets: [{ id: 'aa', name: 'A', engine: 'particles' }] }).ok).toBe(false);
    expect(checkExtensionManifest({ ...base, kind: 'presets', permissions: ['script'], presets: [{ id: 'aa', name: 'A', engine: 'particles' }] }).ok).toBe(false);
    expect(checkExtensionManifest({ ...base, kind: 'script', permissions: [], entry: 'index.html' }).ok).toBe(false);
    expect(checkExtensionManifest({ ...base, kind: 'script', permissions: ['script'], entry: '../outside.html' }).ok).toBe(false);
    expect(checkExtensionManifest({ ...base, kind: 'script', permissions: ['script', 'pty.spawn'], entry: 'index.html' }).ok).toBe(false);
  });
  it('requires approval before enabling and gates script serving', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-ext-'));
    const mod = path.join(dir, 'demo-mod');
    fs.mkdirSync(mod);
    fs.writeFileSync(path.join(mod, 'manifest.json'), JSON.stringify({ ...base, kind: 'script', permissions: ['script', 'monitor.cpu'], entry: 'index.html' }));
    fs.writeFileSync(path.join(mod, 'index.html'), '<p>hi</p>');
    const reg = new ExtensionRegistry(dir);
    expect(() => reg.setEnabled('demo-mod', true)).toThrow(/approve/);
    reg.approve('demo-mod', ['script', 'monitor.cpu', 'pty.spawn']);
    expect(reg.list()[0].approved.sort()).toEqual(['monitor.cpu', 'script']);
    reg.setEnabled('demo-mod', true);
    expect(reg.scriptDir('demo-mod', false)).toBeNull();
    expect(reg.scriptDir('demo-mod', true)).toBe(mod);
    reg.approve('demo-mod', ['monitor.cpu']);
    expect(reg.list()[0].enabled).toBe(false);
    expect(reg.scriptDir('demo-mod', true)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
