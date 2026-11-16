// Dev helper: screenshot every workspace and the main tool windows.
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const outDir = process.argv[2] ?? '/tmp/synapse-ui';
fs.mkdirSync(outDir, { recursive: true });
const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-cfg-'));
fs.writeFileSync(path.join(cfg, 'config.toml'), 'config_version = 1\n[application]\nfullscreen = false\nboot_animation = false\nfirst_run_complete = true\n[performance]\nbattery_saver = false\nmode = "balanced"\n');
const env = { ...process.env, SYNAPSE_CONFIG_DIR: cfg };
if (process.env.SYNAPSE_REAL_DISPLAY !== '1') { delete env.WAYLAND_DISPLAY; env.XDG_SESSION_TYPE = 'x11'; }
const app = await electron.launch({ chromiumSandbox: true, executablePath: process.env.SYNAPSE_ELECTRON, args: ['.'], env, timeout: 60000 });
const page = await app.firstWindow();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e.stack ?? e)));
await page.waitForTimeout(3000);
const shot = async (name) => { await page.screenshot({ path: path.join(outDir, `${name}.png`) }); console.log('shot', name, errors.length ? `errors: ${errors.splice(0).join(' | ').slice(0, 600)}` : ''); };
const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
const want = (n) => !only || only.includes(n);
for (const ws of ['classic-edex', 'neural-lab', 'cyber-sec', 'scientific', 'cinematic', 'custom']) {
  if (!want(ws)) continue;
  await page.evaluate((id) => window.__SYNAPSE__.workspace.switchTo(id), ws);
  await page.waitForTimeout(Number(process.env.WAIT ?? 6000));
  await shot(`ws-${ws}`);
}
const tool = async (name, fn) => {
  if (!want(name)) return;
  await page.evaluate(fn);
  await page.waitForTimeout(1500);
  await shot(`tool-${name}`);
  await page.keyboard.press('Escape');
  await page.evaluate(() => { const a = window.__SYNAPSE__; if (a.overlays.editorOpen) a.overlays.toggleEditor(); });
  await page.waitForTimeout(400);
};
await page.evaluate(() => window.__SYNAPSE__.workspace.switchTo('neural-lab'));
await page.waitForTimeout(2500);
await tool('settings', () => window.__SYNAPSE__.overlays.openSettings('APPEARANCE'));
await tool('palette', () => window.__SYNAPSE__.overlays.openPalette('neural'));
await tool('editor', () => window.__SYNAPSE__.overlays.toggleEditor());
await tool('theme', () => window.__SYNAPSE__.overlays.openThemeEditor());
await tool('anim', () => window.__SYNAPSE__.overlays.openAnimationEditor());
await tool('modules', () => window.__SYNAPSE__.overlays.openModuleManager());
await tool('firstrun', () => window.__SYNAPSE__.overlays.openFirstRun());
await tool('diag', () => window.__SYNAPSE__.overlays.toggleDiagnostics());
await app.close();
