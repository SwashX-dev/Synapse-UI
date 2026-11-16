# Themes

Theme TOML files can inherit a built-in using `base = "obsidian"`, with id and name plus partial colors, effects, typography, spacing and animation tables. Per-type overrides live under `[modules.cpu.colors]`, etc. Full validated structure: `src/shared/theme.ts`.

```toml
format = 1
id = "lab-amber"
name = "Lab Amber"
base = "obsidian"
[colors]
accent = "#ffb454"
neural = "#f5d9a5"
[effects]
glow_intensity = 0.15
```

Use Ctrl+Shift+T for live editing, duplication, undo/redo, reset, import/export. Built-in themes are not overwritten; save a custom file or duplicate first. A file with a built-in ID overrides it. Legacy eDEX JSON can be converted during import. Colors accept validated CSS hex/rgb/rgba formats; fonts and gradients are restricted. Workspace/module overrides layer over the selected theme. See `examples/amber-theme`.
