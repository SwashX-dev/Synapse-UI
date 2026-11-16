import fs from 'node:fs';
import path from 'node:path';
import { session } from './desktop-session.mjs';
const out = process.argv[2] ?? 'media';
fs.mkdirSync(out, { recursive: true });
const s = await session();
try {
  for (const id of ['neural-lab', 'classic-edex', 'scientific', 'cinematic']) {
    await s.page.evaluate((id) => window.__SYNAPSE__.workspace.switchTo(id), id);
    await s.page.waitForFunction(() => { const g = window.__SYNAPSE__.graphics; return g.supported && [...g.views].every(v => v.ready); }, null, { timeout: 60000 });
    await s.page.waitForTimeout(3500);
    await s.page.screenshot({ path: path.join(out, `${id}.png`) });
    console.log(`Captured ${id}`);
  }
} finally { await s.close(); }
