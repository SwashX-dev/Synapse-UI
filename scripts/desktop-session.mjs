import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export async function session(workspace = 'neural-lab', mode = 'balanced') {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-measure-'));
  fs.writeFileSync(path.join(cfg, 'config.toml'), `config_version = 1\n[application]\nfullscreen = false\nboot_animation = false\nfirst_run_complete = true\nworkspace = ${JSON.stringify(workspace)}\n[performance]\nbattery_saver = false\nmode = ${JSON.stringify(mode)}\n`);
  const env = { ...process.env, SYNAPSE_CONFIG_DIR: cfg };
  delete env.ELECTRON_RUN_AS_NODE;
  if (env.SYNAPSE_REAL_DISPLAY !== '1') { delete env.WAYLAND_DISPLAY; env.XDG_SESSION_TYPE = 'x11'; }
  let app;
  try {
    app = await electron.launch({ executablePath: env.SYNAPSE_ELECTRON, args: ['.'], env, timeout: 60000 });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.waitForFunction(() => window.__SYNAPSE__?.workspace?.current, null, { timeout: 60000 });
    return { app, page, close: async () => { try { await app.close(); } finally { fs.rmSync(cfg, { recursive: true, force: true }); } } };
  } catch (error) {
    await app?.close().catch(() => {});
    fs.rmSync(cfg, { recursive: true, force: true });
    throw error;
  }
}
