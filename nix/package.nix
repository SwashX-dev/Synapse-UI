{ lib, buildNpmPackage, nodejs_24, electron, python3, pkg-config, makeWrapper, makeDesktopItem, copyDesktopItems }:
buildNpmPackage {
  pname = "synapse-ui";
  version = "3.0.0-alpha.1";
  src = lib.cleanSource ../.;
  nodejs = nodejs_24;
  npmDepsHash = "sha256-bNWQngxxnJU0PA17Fyx7W7bDfNUu4WShvamKa7DHVFo=";
  nativeBuildInputs = [ python3 pkg-config makeWrapper copyDesktopItems ];
  ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
  npm_config_nodedir = "${nodejs_24}/include/node";
  npmBuildScript = "build:prod";
  postBuild = ''
    npm prune --omit=dev --ignore-scripts --offline
  '';
  desktopItems = [ (makeDesktopItem {
    name = "synapse-ui";
    desktopName = "SYNAPSE-UI";
    exec = "synapse-ui %U";
    icon = "synapse-ui";
    categories = [ "System" "TerminalEmulator" ];
    comment = "Neural visualization and terminal workstation";
  }) ];
  installPhase = ''
    runHook preInstall
    mkdir -p $out/share/synapse-ui $out/share/icons/hicolor/512x512/apps
    cp -r dist resources package.json node_modules $out/share/synapse-ui/
    cp build/icon.png $out/share/icons/hicolor/512x512/apps/synapse-ui.png
    makeWrapper ${electron}/bin/electron $out/bin/synapse-ui \
      --add-flags $out/share/synapse-ui
    runHook postInstall
  '';
  meta = {
    description = "Modular neural visualization and terminal workstation, forked from eDEX-UI";
    homepage = "https://github.com/SwashX-dev/Synapse-UI";
    license = lib.licenses.gpl3Only;
    platforms = lib.platforms.linux;
    mainProgram = "synapse-ui";
  };
}
