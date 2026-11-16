#!/usr/bin/env node
/**
 * Build: esbuild bundles main, preload, renderer and workers into dist/,
 * and copies static assets (fonts, sounds, keyboard layouts, globe data).
 *   node scripts/build.mjs [--production] [--watch]
 */
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prod = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const out = path.join(root, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const define = {
  __SYNAPSE_VERSION__: JSON.stringify(pkg.version),
  __SYNAPSE_DEV__: JSON.stringify(!prod),
};
const common = {
  bundle: true,
  sourcemap: prod ? false : 'linked',
  minify: prod,
  legalComments: prod ? 'linked' : 'inline',
  logLevel: 'warning',
  define,
};

const targets = [
  { ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js', platform: 'node', target: 'node22', format: 'cjs', external: ['electron', 'node-pty', 'systeminformation'] },
  { ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload/preload.js', platform: 'node', target: 'node22', format: 'cjs', external: ['electron'] },
  {
    ...common,
    entryPoints: ['src/renderer/main.ts'],
    outfile: 'dist/renderer/app.js',
    platform: 'browser',
    target: 'chrome130',
    format: 'esm',
    external: ['/assets/*'],
    loader: { '.glsl': 'text', '.txt': 'text' },
  },
  {
    ...common,
    entryPoints: fs.readdirSync(path.join(root, 'src/renderer/workers')).filter((f) => f.endsWith('.worker.ts')).map((f) => `src/renderer/workers/${f}`),
    outdir: 'dist/renderer/workers',
    entryNames: '[name]',
    platform: 'browser',
    target: 'chrome130',
    format: 'esm',
  },
];

function copyDir(src, dest, filter = () => true) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, ent.name);
    const b = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDir(a, b, filter);
    else if (filter(a)) fs.copyFileSync(a, b);
  }
}

function copyStatic() {
  const assets = path.join(out, 'renderer', 'assets');
  fs.mkdirSync(assets, { recursive: true });
  fs.copyFileSync(path.join(root, 'src/renderer/index.html'), path.join(out, 'renderer', 'index.html'));
  copyDir(path.join(root, 'src/assets/fonts'), path.join(assets, 'fonts'));
  copyDir(path.join(root, 'src/assets/audio'), path.join(assets, 'audio'));
  copyDir(path.join(root, 'src/assets/kb_layouts'), path.join(assets, 'kb_layouts'));
  copyDir(path.join(root, 'src/assets/icons'), path.join(assets, 'icons'), (f) => f.endsWith('.png') || f.endsWith('.svg'));
  fs.mkdirSync(path.join(assets, 'misc'), { recursive: true });
  for (const f of ['grid.json', 'boot_log.txt']) fs.copyFileSync(path.join(root, 'src/assets/misc', f), path.join(assets, 'misc', f));
  const layouts = fs.readdirSync(path.join(root, 'src/assets/kb_layouts')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  fs.writeFileSync(path.join(assets, 'kb_layouts', 'index.json'), JSON.stringify(layouts));
}

const t0 = Date.now();
fs.rmSync(out, { recursive: true, force: true });
copyStatic();
if (watch) {
  const ctxs = await Promise.all(targets.map((t) => esbuild.context({ ...t, absWorkingDir: root })));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('[build] watching for changes…');
} else {
  await Promise.all(targets.map((t) => esbuild.build({ ...t, absWorkingDir: root })));
  console.log(`[build] ${prod ? 'production' : 'development'} build done in ${Date.now() - t0} ms → dist/`);
}
