// Dev helper: launch SYNAPSE-UI via Playwright, capture console + a screenshot.
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const out = process.argv[2] ?? '/tmp/synapse-probe.png';
const ws = process.argv[3] ?? '';
const wait = Number(process.argv[4] ?? 6000);
const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-cfg-'));
fs.writeFileSync(path.join(cfg, 'config.toml'), `config_version = 1\n[application]\nfullscreen = false\nboot_animation = false\nfirst_run_complete = true\n${ws ? `workspace = "${ws}"\n` : ''}[performance]\nbattery_saver = false\nmode = "${process.env.PERF ?? 'high'}"\n`);
function headlessEnv(cfg) { const e = { ...process.env, SYNAPSE_CONFIG_DIR: cfg }; if (process.env.SYNAPSE_REAL_DISPLAY !== '1') { delete e.WAYLAND_DISPLAY; e.XDG_SESSION_TYPE = 'x11'; } return e; }
const app = await electron.launch({ executablePath: process.env.SYNAPSE_ELECTRON, args: ['.', '--no-sandbox-disabled'], env: headlessEnv(cfg), timeout: 60000 });
const page = await app.firstWindow();
page.on('console', (m) => console.log(`[console.${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => console.log(`[pageerror] ${e.stack ?? e}`));
await page.setViewportSize?.({ width: 1600, height: 900 }).catch(() => {});
await page.waitForTimeout(wait);
await page.screenshot({ path: out });
const info = await page.evaluate(() => { const a = window.__SYNAPSE__; return a ? { ws: a.workspace.current?.id, views: a.graphics.views.size, fps: a.graphics.fps, supported: a.graphics.supported, err: a.graphics.error } : 'no app'; });
console.log('INFO', JSON.stringify(info));
await app.close();
console.log('saved', out);
