# Configuration

Linux: `$XDG_CONFIG_HOME/synapse-ui` (default `~/.config/synapse-ui`). Windows: `%APPDATA%/SYNAPSE-UI`. macOS: `~/Library/Application Support/SYNAPSE-UI`. `SYNAPSE_CONFIG_DIR` overrides the config root. Linux Chromium state/logs live under `$XDG_STATE_HOME/synapse-ui` (default `~/.local/state/synapse-ui`); an override keeps test state in `.state` beneath it.

Files: `config.toml`, `keybindings.toml`, `themes/*.toml`, `layouts/*.json`, `animations/presets/*.json`, `modules/<id>/manifest.json`, and `backups/`.

```toml
config_version = 1
[application]
fullscreen = false
theme = "obsidian"
workspace = "neural-lab"
[performance]
mode = "balanced"
target_fps = 60
battery_saver = true
[terminal]
font_size = 13
```

The app generates the complete commented config. The exhaustive settings reference is [SETTINGS.md](SETTINGS.md), generated from `src/shared/settings.ts`. Some settings require restart; the GUI and reference indicate them. Arbitrary keys from earlier design proposals are not supported.

GUI updates are validated then written atomically. External edits are debounced and validated; malformed TOML leaves the last working configuration active and reports an issue. Per-field invalid values use defaults. Concurrent edits follow last-writer-wins with a backup and notification. Generated writes replace comments and formatting; keep personal commentary in a separate file.

Settings → Import / Export supports bundles and reset. Back up the whole directory before migrating or resetting. `config_version` tracks format changes; unknown newer formats should be checked against release notes before editing.
