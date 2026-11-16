# Troubleshooting

- NixOS generic Electron fails to start: enter `nix develop`, or use `nix run`; AppImages need `appimage-run`.
- No display / Playwright launch failure: use an active desktop DISPLAY or `xvfb-run -a`. Headless harnesses select X11 by default; set SYNAPSE_REAL_DISPLAY=1 to preserve a real Wayland session.
- Wayland/NVIDIA: try Settings → Graphics ozone selection and restart. Test X11/XWayland as a fallback; record driver/compositor and app logs. Do not disable the sandbox to solve a driver issue.
- Black visualization: open diagnostics, check WebGL support, reduce density/postprocessing; verify host driver setup. Terminals should remain usable.
- PTY failure: run npm run rebuild:native in the development shell; check configured shell path. The Nix package supplies its own native addon.
- Missing GPU metrics: driver tooling/sysfs may not expose utilization or VRAM. Unavailable is expected on unsupported hardware; it is not zero usage.
- Bad TOML: read the reported issue, correct syntax, or restore backups. Valid external edits apply live. For isolation use SYNAPSE_CONFIG_DIR=/tmp/synapse-debug with a fresh directory.
- No MP4: install ffmpeg and restart so it is on PATH. PNG sequences are preserved if encoding fails.
- Extension absent: check manifest ID/folder match, validation errors, permissions and enabled state. Script modules also need the global allow-scripts switch.

Logs are in the state directory's logs/ (see CONFIGURATION.md). Include sanitized logs/config, reproduction, version, driver and platform in reports. Exclude terminal content, access tokens and private paths where unnecessary.
