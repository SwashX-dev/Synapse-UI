// Dev helper: load every preset into the focused visualization and report build errors.
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const outDir = process.argv[2] ?? '/tmp/synapse-engines';
fs.mkdirSync(outDir, { recursive: true });
const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-cfg-'));
fs.writeFileSync(path.join(cfg, 'config.toml'), 'config_version = 1\n[application]\nfullscreen = false\nboot_animation = false\nfirst_run_complete = true\nworkspace = "cinematic"\n[performance]\nbattery_saver = false\nmode = "balanced"\n');
const env = { ...process.env, SYNAPSE_CONFIG_DIR: cfg };
delete env.WAYLAND_DISPLAY; env.XDG_SESSION_TYPE = 'x11';
const app = await electron.launch({ executablePath: process.env.SYNAPSE_ELECTRON, args: ['.'], env, timeout: 60000 });
const page = await app.firstWindow();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e.stack ?? e)));
await page.waitForTimeout(4000);
const ids = await page.evaluate(() => window.__SYNAPSE__.presets().map((p) => p.id));
const results = [];
for (const id of ids) {
  errors.length = 0;
  await page.evaluate((pid) => window.__SYNAPSE__.commands.execute(['animation', 'load', pid]), id);
  await page.waitForTimeout(Number(process.env.WAIT ?? 3500));
  const st = await page.evaluate(() => { const v = [...window.__SYNAPSE__.graphics.views][0]; return { ready: v.ready, error: v.error, stats: v.stats() }; });
  await page.screenshot({ path: path.join(outDir, `${id}.png`) });
  results.push({ id, ...st, errors: [...errors].slice(0, 3) });
  console.log(id, st.ready ? 'OK' : 'NOT READY', st.error || '', errors.length ? `ERRORS: ${errors.slice(0, 2).join(' | ').slice(0, 400)}` : '');
}
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
await app.close();
