# Alpha limitations

- Linux/NixOS x86_64 is the development and locally tested platform. Windows/macOS packages are built in CI; interactive validation, signing and notarization remain separate work. Linux aarch64 is declared but untested locally.
- FPS caps are goals, not guarantees. Many high-density views plus bloom can reduce throughput. WebGL2 only; no WebGPU backend. Canvas transfers and main-thread simulation can limit performance.
- Graphics are artistic/scientific simulations, not neural inference. Globe arcs are decorative and throughput-driven, not inferred geographic network destinations.
- Script extensions are isolated but can consume resources. They cannot install arbitrary rendering engines or use shell/filesystem APIs. No public extension registry or automatic updates.
- Windows helper opens the palette; POSIX authenticated OSC command behavior has not been verified through ConPTY.
- Audio loopback depends on OS/compositor; unsupported capture is reported. No silent microphone capture.
- Generated TOML writes regenerate comments/formatting. External edit conflicts use last writer wins with backups. Schema version 1 has no historic SYNAPSE format migrations yet; eDEX settings import is supported.
- MP4 requires ffmpeg, and capture at high resolution/duration can exhaust disk/RAM. Shader timings in diagnostics are CPU scheduling/submission, not GPU timer queries.
- Legacy eDEX plugins do not run unchanged. Some globe/UI internals have been ported rather than retained verbatim; see MIGRATION.md.

Full dependency audit snapshot (2026-11-16): npm reports 13 moderate transitive findings in build/lint tooling, traced to minimatch glob-pattern denial of service (GHSA-g3hv-75wg-m249). Production-only audit reports zero vulnerabilities. The suggested automatic fix includes a breaking electron-builder downgrade, so it has not been applied blindly. Avoid building untrusted source/glob inputs; updating these tooling dependencies remains maintenance work.
