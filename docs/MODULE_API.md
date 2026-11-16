# Module API (manifest version 1)

Third-party modules are local folders containing `manifest.json`. Import through the Module Manager, inspect errors/permissions, approve, then enable. IDs must match folder names; examples in `examples/` are ready for import. A permission change requires approval again.

Kinds: `panel` (declarative telemetry widgets), `presets` (validated preset array), `themes` (relative TOML filenames), `script` (HTML entry). The schema and validation are in `src/shared/manifest.ts`. Common fields: manifest_version, id, name, version, description, author, kind, category, permissions; optional defaultSize and configSchema.

Panels provide title and widgets with kind `value`, `bar`, `sparkline`, or `label`; source is a metric such as `cpu.load`, with optional unit/min/max or a safe mathematical expression. Declare corresponding `monitor.cpu`, `monitor.memory`, etc. permissions. Expressions use the same capability checks as direct sources.

Scripts require `script` permission AND the global `security.allow_extension_scripts` switch. They run in an opaque-origin iframe with `sandbox="allow-scripts"`, restrictive CSP and no Node, filesystem, shell or network access. A script may post `{type: "subscribe", sources: ["cpu.load"]}` to parent. Parent sends `{type: "data", values: {"cpu.load": 12}, theme: {fg,bg,accent,font}}` every 250 ms while visible, containing only approved sources. Check `event.source === parent`. No terminal or arbitrary host API is exposed. See `examples/cpu-script`.

Allowed extension permissions: monitor.cpu, monitor.memory, monitor.gpu, monitor.network, monitor.storage, monitor.processes, monitor.connections, audio.analysis, data.files, script. Shell spawning/writing, filesystem.read and process.kill are reserved for trusted built-ins and cannot be granted to third-party modules.

Native bundled modules implement `SynModule.mount/dispose` through a `ModuleContext`; they are trusted application code. Adding a new renderer engine requires source changes and a rebuild, not merely installing a script extension. Implement `EngineDef`, declare parameter specs, return an EngineInstance with update/dispose, register in `graphics/engines/index.ts`, and provide presets. Do not expose Electron APIs to extensions.
