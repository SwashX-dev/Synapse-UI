# Measured performance

Measured 2026-11-16 on NixOS x86_64, Ryzen 5 7235HS (8 logical CPUs), 31 GiB RAM, RTX 4050 Laptop GPU, Electron 45.2.3 / Chromium 156. ANGLE reports NVIDIA OpenGL ES 3.2. Desktop Wayland session, 1600×900 viewport; 4-second warmup and 15-second sampling per workspace. Ready-to-workspace startup: 3.09 seconds.

**These are exploratory, contended measurements, not isolated benchmarks.** eDEX-UI and the IDE were already running; local e2e tests overlapped the early workloads. Adaptive resolution/quality remained active and state carries between workspaces. Thermal/power and display scheduling affect results. These results do not demonstrate a stable 60 FPS target.

| Workspace | Profile | Scheduler ticks/s | Frame interval p95 ms | CPU work p95 ms | Mean app CPU % | Mean app RSS MiB |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| cinematic | cinematic | 23.6 | 48.7 | 12.7 | 6.1 | 936 |
| neural-lab | balanced | 20.5 | 90.2 | 18.6 | 10.2 | 972 |
| scientific | balanced | 29.9 | 48.7 | 20.6 | 19.0 | 1012 |

Scheduler ticks count shared scheduler frames observed through requestAnimationFrame; they are not a guarantee that every view rendered each tick. Per-view instantaneous FPS and dimensions are recorded in the raw JSON. Work times are CPU submission/copy work, not GPU timer queries. RSS sums Electron processes and can double-count shared pages. CPU percentages sum the per-process Electron readings; the initial sample can be zero. NVIDIA utilization/VRAM samples are system-wide and cannot be attributed solely to this app.

After switching to Custom: 1 remaining visualization, 0 shared resources, 7 renderer geometries and 15 textures. This is a point-in-time cleanup snapshot, not a leak test. Startup excludes time until all neural geometry is ready.

Raw data: [desktop](../bench-results/desktop-rtx4050.json), [earlier Xvfb run with contention](../bench-results/xvfb-contention.json). The Xvfb run predates explicit GL backend capture and must not be called a discrete-GPU benchmark.

## Reproduce

```sh
nix develop
npm run build
SYNAPSE_REAL_DISPLAY=1 node scripts/bench.mjs bench-results/desktop.json
# Headless comparison:
xvfb-run -a -s "-screen 0 1600x900x24" node scripts/bench.mjs bench-results/headless.json
# Actual application captures:
xvfb-run -a npm run screenshots
```

Set BENCH_SECONDS=30 for longer samples. For comparable runs, stop other workloads, fix power/profile/quality, keep driver/display/viewport identical and repeat. The script records backend, profiles, per-view sizes, frame intervals, CPU work, process metrics, GPU samples and cleanup state. Missing NVIDIA tools yield no GPU samples rather than invented values.
