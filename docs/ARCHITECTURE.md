# Architecture

The fork preserves eDEX history and assets while replacing its renderer and exposed terminal transport. TypeScript is bundled by `scripts/build.mjs` into `dist/main`, `dist/preload`, `dist/renderer` and worker bundles. No UI framework is required.

## Process boundaries

`src/main/main.ts` composes configuration, PTY management, monitoring, extension discovery, captures and BrowserWindow. Security flags are selected before ready. `app://synapse` serves the application with CSP and path checks. Navigation, new windows and webviews are blocked.

`src/preload/preload.ts` exposes purpose-specific methods. IPC channels validate argument tuples in `src/shared/ipc.ts`; main checks that callers are the trusted top frame. The renderer cannot import Node or access raw ipcRenderer.

## Modules and state

`workspace/module.ts` defines lifecycle and registration; `workspace/manager.ts` owns active layout and instances, and `workspace/editor.ts` applies pure shared layout operations with history. Module disposal must release subscriptions, workers, event listeners and geometry. PTYs belong to main, not individual DOM elements, so workspace changes can reattach them.

`MonitorHub` refcounts shared topic pollers. Renderer data sources provide numeric metrics to graphs, expressions and parameter bindings. Missing hardware readings remain null.

## Graphics

One WebGL2 context renders each view sequentially, then copies the drawing buffer into a module canvas. Per-view postprocessing, camera, parameters and resources are disposed independently. Network generation runs in a worker. This avoids browser context limits but rendering/copying many views still costs time.

## Persistent formats

Settings registry, theme schema, preset schema, layout schema and extension manifests live under `src/shared`. Configuration service owns atomic writes, validation, watchers, external-edit backups and snapshots. See CONFIGURATION.md and MODULE_API.md for contracts.
