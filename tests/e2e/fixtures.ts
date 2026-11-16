import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(__filename);
export const root = path.resolve(__dirname, '../..');

export interface Launched { app: ElectronApplication; page: Page; cfg: string; errors: string[]; close(): Promise<void> }

/** Launch SYNAPSE-UI with an isolated config directory. */
export async function launch(config = '', opts: { keepConfig?: string } = {}): Promise<Launched> {
  const cfg = opts.keepConfig ?? fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-e2e-'));
  if (!opts.keepConfig) {
    fs.writeFileSync(path.join(cfg, 'config.toml'), `config_version = 1\n[application]\nfullscreen = false\nboot_animation = false\nfirst_run_complete = true\n${config}\n[performance]\nbattery_saver = false\nmode = "eco"\n`);
  }
  const env: Record<string, string> = { ...(process.env as Record<string, string>), SYNAPSE_CONFIG_DIR: cfg };
  delete env.ELECTRON_RUN_AS_NODE;
  // Headless CI/Xvfb: force X11 so a developer's Wayland session is not used.
  if (process.env.SYNAPSE_REAL_DISPLAY !== '1') { delete env.WAYLAND_DISPLAY; env.XDG_SESSION_TYPE = 'x11'; }
  const executablePath = process.env.SYNAPSE_ELECTRON || (require('electron') as unknown as string);
  let app: ElectronApplication | null = null;
  for (let attempt = 0; attempt < 2 && !app; attempt++) {
    try {
      app = await electron.launch({ executablePath, args: [root], env, timeout: 60_000 });
      await app.firstWindow({ timeout: 45_000 });
    } catch (e) {
      await app?.close().catch(() => {});
      app = null;
      if (attempt === 1) throw e;
    }
  }
  const page = await app!.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.waitForFunction(() => !!(window as unknown as { __SYNAPSE__?: { workspace?: { current?: unknown } } }).__SYNAPSE__?.workspace?.current, null, { timeout: 60_000 });
  return { app: app!, page, cfg, errors, close: async () => { await app!.close().catch(() => {}); } };
}

/** Text currently in the active terminal buffer. */
export function terminalText(page: Page): Promise<string> {
  return page.evaluate(() => [...document.querySelectorAll('.term-tab-content.active .xterm-rows')].map((e) => (e as HTMLElement).innerText).join('\n'));
}

export async function typeInTerminal(page: Page, text: string): Promise<void> {
  await page.locator('.term-tab-content.active .xterm').first().click();
  await page.keyboard.type(text, { delay: 5 });
  await page.keyboard.press('Enter');
}
