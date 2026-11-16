/**
 * Electron hardening:
 *  - every renderer sandboxed, context-isolated, no Node integration
 *  - navigation locked to the app origin; new windows / webviews refused
 *  - permission requests denied except clipboard and *explicitly enabled* audio capture
 *  - IPC accepted only from the main window's top-level app frame
 */
import { app, desktopCapturer, session, shell, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { APP_ORIGIN } from './protocol';
import { logger } from './log';

const log = logger('security');

export const captureAllowed = { microphone: false, system: false };

/**
 * Origin of a URL as "scheme://host". (WHATWG URL reports an opaque "null"
 * origin for non-special schemes such as app://, so compare explicitly.)
 */
export function urlOrigin(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

export function isAppUrl(url: string): boolean {
  return urlOrigin(url) === APP_ORIGIN;
}

let trustedContentsId: number | null = null;
export function setTrustedContents(wc: WebContents): void {
  trustedContentsId = wc.id;
}

/** Only the main window's top-level frame, loaded from app://synapse, may use privileged IPC. */
export function senderDiagnostics(event: IpcMainInvokeEvent | Electron.IpcMainEvent): string {
  const f = event.senderFrame;
  return `sender=${event.sender.id} trusted=${trustedContentsId} frame=${f ? `${f.url} parent=${f.parent ? 'yes' : 'none'}` : 'none'}`;
}

export function isTrustedSender(event: IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
  const frame = event.senderFrame;
  if (!frame || trustedContentsId === null) return false;
  if (event.sender.id !== trustedContentsId) return false;
  // Top-level frame only (iframes, including sandboxed extensions, are rejected).
  if (frame.parent !== null) return false;
  return isAppUrl(frame.url);
}

export function hardenApp(getDevtoolsAllowed: () => boolean, openExternalPolicy: () => 'ask' | 'allow' | 'deny'): void {
  app.enableSandbox();

  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-navigate', (ev, url) => {
      if (!isAppUrl(url)) {
        ev.preventDefault();
        log.warn(`blocked navigation to ${url}`);
      }
    });
    contents.on('will-redirect', (ev, url) => {
      if (!isAppUrl(url)) ev.preventDefault();
    });
    contents.on('will-attach-webview', (ev) => {
      ev.preventDefault();
      log.warn('blocked <webview> attachment');
    });
    contents.setWindowOpenHandler(({ url }) => {
      // Links are opened externally only through the explicit app:open-external IPC (with policy + confirmation).
      if (/^https?:\/\//.test(url) && openExternalPolicy() === 'allow') void shell.openExternal(url);
      else log.info(`refused window.open(${url.slice(0, 200)})`);
      return { action: 'deny' };
    });
    contents.on('devtools-opened', () => {
      if (!getDevtoolsAllowed()) contents.closeDevTools();
    });
  });

}

/** Session-level permission handlers (must run after app ready). */
export function hardenSession(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const origin = details.requestingUrl ? safeOrigin(details.requestingUrl) : '';
    if (origin !== APP_ORIGIN || (trustedContentsId !== null && wc.id !== trustedContentsId)) return callback(false);
    if (permission === 'clipboard-sanitized-write' || permission === 'clipboard-read') return callback(true);
    if (permission === 'media') {
      const types = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
      const audioOnly = types.length > 0 && types.every((t) => t === 'audio');
      const ok = audioOnly && captureAllowed.microphone;
      if (!ok) log.warn(`denied media permission (types=${types.join(',')}, mic allowed=${captureAllowed.microphone})`);
      return callback(ok);
    }
    if (permission === 'fullscreen') return callback(true);
    log.info(`denied permission ${permission}`);
    callback(false);
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    if (safeOrigin(requestingOrigin) !== APP_ORIGIN) return false;
    if (permission === 'clipboard-sanitized-write' || permission === 'clipboard-read' || permission === 'fullscreen') return true;
    if (permission === 'media') return captureAllowed.microphone;
    return false;
  });
  // System-audio capture (loopback) — available on Windows and macOS 13+; requires explicit opt-in.
  ses.setDisplayMediaRequestHandler(
    (request, callback) => {
      if (!captureAllowed.system || safeOrigin(request.securityOrigin ?? '') !== APP_ORIGIN) return callback({});
      void desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
        if (!sources[0]) return callback({});
        callback({ video: sources[0], audio: 'loopback' });
      });
    },
    { useSystemPicker: false },
  );
}

function safeOrigin(url: string): string {
  return urlOrigin(url);
}
