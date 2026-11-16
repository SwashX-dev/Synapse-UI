// Wall-clock throughput and CPU-side scheduling measurements, not GPU timer queries.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { session } from './desktop-session.mjs';
const out = process.argv[2] ?? 'bench-results/latest.json';
const seconds = Number(process.env.BENCH_SECONDS ?? 15);
if (!Number.isFinite(seconds) || seconds < 3 || seconds > 300) throw new Error('BENCH_SECONDS must be 3–300');
const started = performance.now();
const s = await session();
const startupMs = performance.now() - started;
const report = { date: new Date().toISOString(), platform: `${os.platform()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model, cores: os.cpus().length, ramGiB: os.totalmem() / 2 ** 30, display: process.env.SYNAPSE_REAL_DISPLAY === '1' ? 'desktop' : 'X11 (may be Xvfb)', viewport: '1600x900', startupMs, seconds, workloads: [] };
try {
  report.electron = await s.app.evaluate(async ({ app }) => ({ version: process.versions.electron, chrome: process.versions.chrome, gpuFeatures: app.getGPUFeatureStatus(), gpu: await app.getGPUInfo('basic') }));
  for (const workspace of ['cinematic', 'neural-lab', 'scientific']) {
    await s.page.evaluate((id) => window.__SYNAPSE__.workspace.switchTo(id), workspace);
    await s.page.waitForFunction(() => { const g = window.__SYNAPSE__.graphics; return g.supported && [...g.views].every(v => v.ready); }, null, { timeout: 60000 });
    await s.page.waitForTimeout(4000);
    const backend = await s.page.evaluate(() => { const gl = window.__SYNAPSE__.graphics.renderer.getContext(); const ext = gl.getExtension('WEBGL_debug_renderer_info'); return { renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR) }; });
    const metrics = [], gpu = [];
    const timer = setInterval(async () => {
      try { metrics.push(await s.app.evaluate(({ app }) => app.getAppMetrics())); } catch { /* app closing */ }
      try { gpu.push(execFileSync('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,temperature.gpu', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 1500 }).trim()); } catch { /* unavailable is represented by empty samples */ }
    }, 1000);
    let sample;
    try {
      sample = await s.page.evaluate(async (ms) => {
        const a = window.__SYNAPSE__, g = a.graphics;
        const frames = [], work = []; let last = g.lastFrameAt;
        const start = performance.now();
        await new Promise(resolve => {
          function tick() {
            if (g.lastFrameAt !== last) { frames.push(g.lastFrameAt - last); work.push(g.workMs); last = g.lastFrameAt; }
            if (performance.now() - start >= ms) resolve(); else requestAnimationFrame(tick);
          }
          requestAnimationFrame(tick);
        });
        return { elapsedMs: performance.now() - start, intervalsMs: frames, schedulerWorkMs: work, views: [...g.views].map(v => v.stats()), profile: a.perf.profile, quality: a.perf.quality, renderScale: a.perf.renderScale };
      }, seconds * 1000);
    } finally { clearInterval(timer); }
    const stats = values => {
      const v = values.toSorted((a, b) => a-b);
      return { mean: v.reduce((a,b) => a+b,0) / (v.length || 1), p50: v[Math.floor(v.length * .5)] ?? null, p95: v[Math.min(v.length-1, Math.floor(v.length * .95))] ?? null };
    };
    report.workloads.push({ workspace, backend, ...sample, fps: sample.intervalsMs.length * 1000 / sample.elapsedMs, frameMs: stats(sample.intervalsMs), workMs: stats(sample.schedulerWorkMs), processMetrics: metrics, nvidiaSystemSamples: gpu });
    console.log(workspace, report.workloads.at(-1).fps.toFixed(1), 'FPS');
  }
  await s.page.evaluate(() => window.__SYNAPSE__.workspace.switchTo('custom'));
  await s.page.waitForTimeout(2000);
  report.afterCleanup = await s.page.evaluate(() => { const g = window.__SYNAPSE__.graphics; return { views: g.views.size, sharedResources: g.shared.size, renderer: g.renderer?.info.memory }; });
} finally { await s.close(); }
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(`Wrote ${out}`);
