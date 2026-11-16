import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { launch, terminalText, typeInTerminal, type Launched } from './fixtures';

type W = { __SYNAPSE__: any; synapse: any; require?: unknown; process?: unknown };

test.describe('application', () => {
  let L: Launched;
  test.beforeAll(async () => { L = await launch('workspace = "custom"'); });
  test.afterAll(async () => { await L.close(); });

  test('starts with the configured workspace and no errors', async () => {
    const info = await L.page.evaluate(() => { const a = (window as unknown as W).__SYNAPSE__; return { ws: a.workspace.current.id, title: document.title, modules: document.querySelectorAll('.mod').length }; });
    expect(info.ws).toBe('custom');
    expect(info.title).toBe('SYNAPSE-UI');
    expect(info.modules).toBeGreaterThanOrEqual(5);
    expect(await L.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
    expect(L.errors.filter((e) => !/WebGL|GPU/i.test(e))).toEqual([]);
  });

  test('renderer has no Node.js privileges and only the narrow bridge', async () => {
    const r = await L.page.evaluate(() => {
      const w = window as unknown as W;
      return { require: typeof w.require, process: typeof w.process, bridgeKeys: Object.keys(w.synapse).sort(), hasIpc: 'ipcRenderer' in w.synapse || 'invoke' in w.synapse };
    });
    expect(r.require).toBe('undefined');
    expect(r.process).toBe('undefined');
    expect(r.hasIpc).toBe(false);
    expect(r.bridgeKeys).toEqual(['app', 'audio', 'capture', 'config', 'dialog', 'ext', 'fs', 'monitor', 'platform', 'pty']);
  });

  test('rejects invalid IPC messages', async () => {
    const results = await L.page.evaluate(async () => {
      const s = (window as unknown as W).synapse;
      const tryIt = async (fn: () => Promise<unknown>) => { try { await fn(); return 'accepted'; } catch (e) { return String(e).slice(0, 80); } };
      return [
        await tryIt(() => s.pty.write('not-a-session', 'rm -rf /\r')),
        await tryIt(() => s.pty.write('pty-0123456789ab', 'echo')),
        await tryIt(() => s.monitor.kill(1, 'SIGKILL')),
        await tryIt(() => s.app.openExternal('javascript:alert(1)')),
        await tryIt(() => s.config.set({ 'application.theme': '../../x' })),
      ];
    });
    expect(results[0]).toMatch(/invalid arguments/);
    expect(results[1]).toMatch(/unknown terminal session/);
    expect(results[2]).toMatch(/invalid arguments/);
    expect(results[3], results[3]).toMatch(/invalid argument/);
    expect(results[4]).toBe('accepted'); // accepted by IPC, rejected by validation:
    const theme = await L.page.evaluate(() => (window as unknown as W).__SYNAPSE__.get('application.theme'));
    expect(theme).toBe('obsidian');
  });

  test('runs a real shell: input, output and multiple sessions', async () => {
    await typeInTerminal(L.page, 'echo SYNAPSE_E2E_$((6*7))');
    await expect.poll(() => terminalText(L.page)).toContain('SYNAPSE_E2E_42');
    await L.page.evaluate(() => (window as unknown as W).__SYNAPSE__.commands.run('terminal.newTab'));
    await expect.poll(() => L.page.evaluate(() => (window as unknown as W).synapse.pty.list().then((l: unknown[]) => l.length))).toBeGreaterThanOrEqual(2);
  });

  test('the in-terminal synapse command controls the app (authenticated OSC bridge)', async () => {
    test.skip(process.platform === 'win32', 'POSIX helper script');
    await typeInTerminal(L.page, 'synapse theme set terminal-green');
    await expect.poll(() => L.page.evaluate(() => (window as unknown as W).__SYNAPSE__.activeTheme.id), { timeout: 15000 }).toBe('terminal-green');
    await expect.poll(() => terminalText(L.page)).toContain('theme → terminal-green');
    // A forged sequence without the session token is ignored.
    await typeInTerminal(L.page, "printf '\\033]7701;forged-token-0000000000;dGhlbWUAc2V0AG9ic2lkaWFu\\007'");
    await L.page.waitForTimeout(800);
    expect(await L.page.evaluate(() => (window as unknown as W).__SYNAPSE__.activeTheme.id)).toBe('terminal-green');
  });

  test('settings changes are written to config.toml', async () => {
    await L.page.evaluate(() => (window as unknown as W).__SYNAPSE__.set({ 'terminal.font_size': 17 }));
    await expect.poll(() => fs.readFileSync(path.join(L.cfg, 'config.toml'), 'utf8')).toContain('font_size = 17');
  });

  test('external edits to config.toml apply live; invalid files are reported', async () => {
    const file = path.join(L.cfg, 'config.toml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/font_size = \d+/, 'font_size = 23'));
    await expect.poll(() => L.page.evaluate(() => (window as unknown as W).__SYNAPSE__.get('terminal.font_size'))).toBe(23);
    const good = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, '[terminal\nbroken = = =');
    await expect.poll(() => L.page.evaluate(() => (window as unknown as W).__SYNAPSE__.snapshot.issues.map((i: { message: string }) => i.message).join(' '))).toMatch(/syntax error/);
    expect(await L.page.evaluate(() => (window as unknown as W).__SYNAPSE__.get('terminal.font_size'))).toBe(23);
    fs.writeFileSync(file, good);
  });

  test('switches workspaces without restarting and keeps terminal sessions', async () => {
    const before = await L.page.evaluate(() => (window as unknown as W).synapse.pty.list().then((l: { id: string }[]) => l.map((x) => x.id)));
    await L.page.evaluate(() => (window as unknown as W).__SYNAPSE__.commands.execute('workspace switch scientific'));
    await expect.poll(() => L.page.evaluate(() => (window as unknown as W).__SYNAPSE__.workspace.current.id)).toBe('scientific');
    await L.page.evaluate(() => (window as unknown as W).__SYNAPSE__.workspace.switchTo('custom'));
    await expect.poll(() => L.page.evaluate(() => (window as unknown as W).__SYNAPSE__.workspace.current.id)).toBe('custom');
    const after = await L.page.evaluate(() => (window as unknown as W).synapse.pty.list().then((l: { id: string }[]) => l.map((x) => x.id)));
    for (const id of before) expect(after).toContain(id);
  });

  test('workspace editing: add, duplicate, remove, undo/redo, persist', async () => {
    const r = await L.page.evaluate(async () => {
      const a = (window as unknown as W).__SYNAPSE__;
      a.overlays.toggleEditor();
      const n0 = a.workspace.current.modules.length;
      await a.commands.execute('module add telemetry');
      const n1 = a.workspace.current.modules.length;
      return { n0, n1, editorOpen: a.overlays.editorOpen, editorDom: !!document.querySelector('.ws-editor') };
    });
    expect(r.n1).toBe(r.n0 + 1);
    expect(r.editorOpen).toBe(true);
    expect(r.editorDom).toBe(true);
    const boxes = await L.page.locator('.ws-box').count();
    expect(boxes).toBe(r.n1);
    // drag the first floating/docked box and check the layout changed
    const box = L.page.locator('.ws-box').last();
    const bb = (await box.boundingBox())!;
    await L.page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await L.page.mouse.down();
    await L.page.mouse.move(bb.x + bb.width / 2 - 140, bb.y + bb.height / 2 - 90, { steps: 8 });
    await L.page.mouse.up();
    await L.page.keyboard.press('Control+d');
    await expect.poll(() => L.page.evaluate(() => (window as unknown as W).__SYNAPSE__.workspace.current.modules.length)).toBe(r.n1 + 1);
    await L.page.keyboard.press('Control+z');
    await expect.poll(() => L.page.evaluate(() => (window as unknown as W).__SYNAPSE__.workspace.current.modules.length)).toBe(r.n1);
    await L.page.keyboard.press('Control+Shift+z');
    await expect.poll(() => L.page.evaluate(() => (window as unknown as W).__SYNAPSE__.workspace.current.modules.length)).toBe(r.n1 + 1);
    await L.page.evaluate(() => (window as unknown as W).__SYNAPSE__.overlays.toggleEditor());
    await expect.poll(() => fs.existsSync(path.join(L.cfg, 'layouts', 'custom.json'))).toBe(true);
    const saved = JSON.parse(fs.readFileSync(path.join(L.cfg, 'layouts', 'custom.json'), 'utf8'));
    expect(saved.modules.length).toBe(r.n1 + 1);
  });

  test('graphics: multiple visualizations, pause, preset change, context-loss recovery, disposal', async () => {
    await L.page.evaluate(() => (window as unknown as W).__SYNAPSE__.workspace.switchTo('scientific'));
    await expect.poll(() => L.page.evaluate(() => [...(window as unknown as W).__SYNAPSE__.graphics.views].filter((v: { ready: boolean }) => v.ready).length), { timeout: 60000 }).toBeGreaterThanOrEqual(6);
    const t0 = await L.page.evaluate(() => [...(window as unknown as W).__SYNAPSE__.graphics.views][0].time);
    await L.page.evaluate(() => (window as unknown as W).__SYNAPSE__.commands.execute('animation pause'));
    await L.page.waitForTimeout(600);
    const tp = await L.page.evaluate(() => [...(window as unknown as W).__SYNAPSE__.graphics.views][0].time);
    await L.page.waitForTimeout(800);
    const tp2 = await L.page.evaluate(() => [...(window as unknown as W).__SYNAPSE__.graphics.views][0].time);
    expect(tp2).toBe(tp);
    expect(tp).toBeGreaterThanOrEqual(t0);
    await L.page.evaluate(() => (window as unknown as W).__SYNAPSE__.commands.execute('animation resume'));
    const res = await L.page.evaluate(() => (window as unknown as W).__SYNAPSE__.commands.execute('animation load particle-ocean'));
    expect(res.ok).toBe(true);
    const lost = await L.page.evaluate(() => (window as unknown as W).__SYNAPSE__.graphics.testContextLoss());
    if (lost) {
      await expect.poll(() => L.page.evaluate(() => (window as unknown as W).__SYNAPSE__.graphics.lost)).toBe(false);
      await expect.poll(() => L.page.evaluate(() => [...(window as unknown as W).__SYNAPSE__.graphics.views].every((v: { ready: boolean }) => v.ready)), { timeout: 60000 }).toBe(true);
    }
    await L.page.evaluate(() => (window as unknown as W).__SYNAPSE__.workspace.switchTo('custom'));
    await expect.poll(() => L.page.evaluate(() => (window as unknown as W).__SYNAPSE__.graphics.views.size)).toBe(1);
  });

  test('fullscreen and windowed mode', async () => {
    await L.page.evaluate(() => (window as unknown as W).synapse.app.setFullscreen(true));
    await expect.poll(() => L.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(true);
    await L.page.evaluate(() => (window as unknown as W).synapse.app.setFullscreen(false));
    await expect.poll(() => L.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())).toBe(false);
  });

  test('settings, palette and tool windows open', async () => {
    for (const [fn, sel] of [['openSettings', '.settings'], ['openPalette', '.palette'], ['openThemeEditor', '.theme-editor'], ['openModuleManager', '[data-panel="modules"]'], ['openAnimationEditor', '.anim-editor']] as const) {
      await L.page.evaluate((f) => (window as unknown as W).__SYNAPSE__.overlays[f](), fn);
      await expect(L.page.locator(sel).first()).toBeVisible();
      await L.page.keyboard.press('Escape');
    }
  });
});

test('shutdown terminates every shell process', async () => {
  const L = await launch('workspace = "custom"');
  await expect.poll(() => L.page.evaluate(() => (window as unknown as W).synapse.pty.list().then((l: unknown[]) => l.length))).toBeGreaterThan(0);
  const pids: number[] = await L.page.evaluate(() => (window as unknown as W).synapse.pty.list().then((l: { pid: number }[]) => l.map((x) => x.pid)));
  await L.close();
  await expect.poll(() => pids.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }).length, { timeout: 10000 }).toBe(0);
});

test('first run shows the setup wizard and can be skipped', async () => {
  const fsMod = await import('node:fs');
  const os = await import('node:os');
  const cfg = fsMod.mkdtempSync(path.join(os.tmpdir(), 'synapse-e2e-fresh-'));
  const L = await launch('', { keepConfig: cfg });
  await expect(L.page.locator('.first-run')).toBeVisible({ timeout: 30000 });
  await L.page.getByRole('button', { name: 'SKIP' }).click();
  await expect.poll(() => fsMod.readFileSync(path.join(cfg, 'config.toml'), 'utf8')).toContain('first_run_complete = true');
  await L.close();
});

test('a normal launch opens no listening sockets (CVE-2023-30856 regression)', async () => {
  test.skip(process.platform !== 'linux', 'uses /proc');
  // Launched WITHOUT Playwright so no remote-debugging port exists: any listener would be ours.
  const { spawn } = await import('node:child_process');
  const os = await import('node:os');
  const { createRequire } = await import('node:module');
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-e2e-net-'));
  fs.writeFileSync(path.join(cfg, 'config.toml'), 'config_version = 1\n[application]\nfullscreen = false\nboot_animation = false\nfirst_run_complete = true\nworkspace = "custom"\n');
  const env: Record<string, string> = { ...(process.env as Record<string, string>), SYNAPSE_CONFIG_DIR: cfg };
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.env.SYNAPSE_REAL_DISPLAY !== '1') { delete env.WAYLAND_DISPLAY; env.XDG_SESSION_TYPE = 'x11'; }
  const exe = process.env.SYNAPSE_ELECTRON || (createRequire(__filename)('electron') as unknown as string);
  const child = spawn(exe, [path.resolve(__dirname, '../..')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  try {
    await expect.poll(() => out.includes('window created'), { timeout: 60000 }).toBe(true);
    await new Promise((r) => setTimeout(r, 6000)); // let the renderer start terminals and monitoring
    const tree = new Set<number>([child.pid!]);
    for (let pass = 0; pass < 4; pass++) {
      for (const d of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
        try {
          const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
          const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
          if (tree.has(ppid)) tree.add(Number(d));
        } catch { /* gone */ }
      }
    }
    const listening = new Set<string>();
    // TCP sockets in LISTEN state (0A): a terminal transport like eDEX's WebSocket would show up here.
    for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
      try {
        for (const line of fs.readFileSync(f, 'utf8').split('\n').slice(1)) {
          const cols = line.trim().split(/\s+/);
          if (cols.length > 9 && cols[3] === '0A') listening.add(cols[9]);
        }
      } catch { /* no ipv6 */ }
    }
    const owned: string[] = [];
    for (const pid of tree) {
      // Shells are user programs, not SYNAPSE-UI; only inspect Electron processes.
      let cmd = '';
      try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
      if (!/electron/i.test(cmd)) continue;
      let fds: string[] = [];
      try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
      for (const fd of fds) {
        try {
          const m = fs.readlinkSync(`/proc/${pid}/fd/${fd}`).match(/^socket:\[(\d+)\]$/);
          if (m && listening.has(m[1])) owned.push(`pid ${pid} inode ${m[1]}`);
        } catch { /* closed */ }
      }
    }
    expect(owned).toEqual([]);
    // (A port probe of 127.0.0.1:3000 is deliberately not used: other software — e.g. an
    // original eDEX-UI instance — may legitimately be listening there on the test machine.)
  } finally {
    child.kill('SIGTERM');
  }
});
