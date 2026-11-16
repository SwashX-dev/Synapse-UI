/** Event channels pushed from main to renderer (kept dependency-free for the preload bundle). */
export const Events = {
  ptyData: 'pty:data',
  ptyExit: 'pty:exit',
  ptyMeta: 'pty:meta',
  monitorData: 'monitor:data',
  configChanged: 'config:changed',
  configIssues: 'config:issues',
  fullscreenChanged: 'app:fullscreen',
  notify: 'app:notify',
} as const;
