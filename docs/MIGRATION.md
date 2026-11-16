# Migrating from eDEX-UI

Back up your eDEX user data first. SYNAPSE uses a separate `synapse-ui` directory and preserves the upstream Git history in master. Main is the new application; old plugins and scripts are not automatically loaded.

Use Settings → Import / Export → eDEX settings import, or the first-run import option. The importer maps supported terminal/theme/application settings. The legacy WebSocket port is intentionally dropped: IPC replaces that transport. Unsupported keys do not become active settings. Import legacy theme JSON through the theme tooling; verify the result because typography/effects differ.

Classic eDEX provides a familiar terminal/monitor/globe/keyboard layout. New workspaces are JSON layouts, themes are TOML and animation presets are JSON. Rewrite third-party customizations as version-1 manifests; old renderer JavaScript cannot safely run with main-process privileges.

Compare your shell, font, bindings, startup layout and performance profile before deleting any old installation. Do not copy Chromium state between the applications.
