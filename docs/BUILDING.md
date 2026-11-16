# Building and testing

Use Node 24, npm, Python 3, and a native C++ toolchain. Linux needs Electron runtime libraries and Xvfb for headless tests; Windows needs Visual Studio C++ build tools for native fallback. macOS needs Xcode command-line tools.

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run rebuild:native
npm run test:e2e
npm run dist:linux  # native Linux host
npm run dist:win    # native Windows host
npm run dist:mac    # native macOS host
```

On NixOS enter `nix develop` first. It selects the patched nixpkgs Electron with SYNAPSE_ELECTRON/ELECTRON_OVERRIDE_DIST_PATH and suppresses npm's generic binary download. Headless commands use `xvfb-run -a -s "-screen 0 1600x900x24" ...`. For electron-builder, unset ELECTRON_OVERRIDE_DIST_PATH and ELECTRON_SKIP_BINARY_DOWNLOAD so it downloads the redistributable Electron rather than packaging the Nix wrapper. Built AppImages run with `appimage-run` on NixOS.

`nix build` uses buildNpmPackage, a fixed npm dependency hash, offline production bundling, native node-pty and a nixpkgs Electron wrapper. When package-lock changes, recompute npmDepsHash (set lib.fakeHash, build once to obtain the reported hash, then replace). The flake exposes Linux x86_64/aarch64; only x86_64 is locally verified.

CI runs lint, types, unit tests, production audit and Linux Electron e2e under Xvfb. Packages is manually dispatchable and reused by Release. A `v<package.version>` tag triggers CI, then Linux/Windows/macOS packaging, then publication and SHA256SUMS. Any failed prerequisite blocks publication. macOS and Windows are unsigned until signing credentials and notarization are configured. Artifacts do not establish runtime compatibility; test on each OS before claiming it.
