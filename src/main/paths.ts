/**
 * Platform-appropriate locations.
 *  Linux:   $XDG_CONFIG_HOME/synapse-ui (default ~/.config/synapse-ui)
 *           Chromium/session state in $XDG_STATE_HOME/synapse-ui
 *  macOS:   ~/Library/Application Support/SYNAPSE-UI
 *  Windows: %APPDATA%\SYNAPSE-UI
 * SYNAPSE_CONFIG_DIR overrides the config directory (portable installs, tests).
 */
import os from 'node:os';
import path from 'node:path';

export interface AppPaths {
  config: string;
  state: string;
  themes: string;
  layouts: string;
  modules: string;
  presets: string;
  backups: string;
  logs: string;
  configFile: string;
  keybindingsFile: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = os.homedir()): AppPaths {
  let config: string;
  let state: string;
  if (env.SYNAPSE_CONFIG_DIR) {
    config = path.resolve(env.SYNAPSE_CONFIG_DIR);
    state = path.join(config, '.state');
  } else if (platform === 'win32') {
    config = path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'SYNAPSE-UI');
    state = path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'SYNAPSE-UI');
  } else if (platform === 'darwin') {
    config = path.join(home, 'Library', 'Application Support', 'SYNAPSE-UI');
    state = path.join(home, 'Library', 'Caches', 'SYNAPSE-UI');
  } else {
    const xdgConfig = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, '.config');
    const xdgState = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(home, '.local', 'state');
    config = path.join(xdgConfig, 'synapse-ui');
    state = path.join(xdgState, 'synapse-ui');
  }
  return {
    config,
    state,
    themes: path.join(config, 'themes'),
    layouts: path.join(config, 'layouts'),
    modules: path.join(config, 'modules'),
    presets: path.join(config, 'animations', 'presets'),
    backups: path.join(config, 'backups'),
    logs: path.join(state, 'logs'),
    configFile: path.join(config, 'config.toml'),
    keybindingsFile: path.join(config, 'keybindings.toml'),
  };
}

/** Where an original eDEX-UI install kept its settings (Electron userData for "eDEX-UI"). */
export function legacyEdexSettingsPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = os.homedir()): string {
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'eDEX-UI', 'settings.json');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'eDEX-UI', 'settings.json');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'eDEX-UI', 'settings.json');
}
