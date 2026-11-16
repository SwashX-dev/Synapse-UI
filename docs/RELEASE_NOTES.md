SYNAPSE-UI 3.0.0-alpha.1 modernizes eDEX-UI into a modular terminal and neural visualization workstation. Includes real PTYs, 36 presets, live themes/layout editing, TOML configuration, isolated local extensions and a replacement for the original unauthenticated terminal WebSocket transport.

Early alpha: back up configuration, review docs/LIMITATIONS.md, and report reproducible issues. Linux is the locally validated platform. Windows/macOS packages are unsigned and need interactive platform testing. Linux aarch64 is not locally validated. GPU behavior depends on drivers; frame caps are not guaranteed FPS. MP4 encoding requires ffmpeg.

Choose the package for your operating system and architecture. SHA256SUMS lists artifact hashes. NixOS users can use the flake or appimage-run. GPL-3.0, preserving eDEX-UI attribution and history.

Full dependency audit snapshot (2026-11-16): npm reports 13 moderate transitive findings in build/lint tooling, traced to minimatch glob-pattern denial of service (GHSA-g3hv-75wg-m249). Production-only audit reports zero vulnerabilities. The suggested automatic fix includes a breaking electron-builder downgrade, so it has not been applied blindly. Avoid building untrusted source/glob inputs; updating these tooling dependencies remains maintenance work.
