{
  description = "SYNAPSE-UI — a modular, GPU-accelerated neural visualization and futuristic terminal environment built upon eDEX-UI";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (pkgs: rec {
        synapse-ui = pkgs.callPackage ./nix/package.nix { };
        default = synapse-ui;
      });

      apps = forAllSystems (pkgs: {
        default = {
          type = "app";
          program = "${self.packages.${pkgs.stdenv.hostPlatform.system}.synapse-ui}/bin/synapse-ui";
        };
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          name = "synapse-ui-dev";
          packages = with pkgs; [
            nodejs_24
            electron
            python3
            gcc
            gnumake
            pkg-config
            git
            ffmpeg
            xvfb-run
          ];
          # Use nixpkgs' patched Electron instead of the generic binary that npm
          # would download (which cannot run on NixOS without patching).
          ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
          ELECTRON_OVERRIDE_DIST_PATH = "${pkgs.electron}/bin";
          SYNAPSE_ELECTRON = "${pkgs.electron}/bin/electron";
          shellHook = ''
            echo "SYNAPSE-UI dev shell — node $(node --version), electron ${pkgs.electron.version}"
            echo "  npm ci && npm start      build and launch"
            echo "  npm test                 unit tests"
            echo "  npm run test:e2e         end-to-end tests (uses \$SYNAPSE_ELECTRON)"
          '';
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt-rfc-style);
    };
}
