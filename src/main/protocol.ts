/**
 * The renderer is served from a private, privileged `app://synapse` origin
 * instead of file://. This gives a real origin for CSP and sender validation,
 * blocks path traversal, and avoids file://'s broad local-file access.
 */
import { net, protocol } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { safeJoin } from './safe-path';

export const APP_HOST = 'synapse';
export const APP_ORIGIN = `app://${APP_HOST}`;
export const APP_URL = `${APP_ORIGIN}/index.html`;

export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob: mediastream:",
  "connect-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.map': 'application/json',
};

export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true, corsEnabled: false } },
  ]);
}

export interface ExtensionResolver {
  /** Absolute directory of an enabled + approved script extension, or null. */
  (id: string): string | null;
}

export function installAppProtocol(rendererRoot: string, extensions: ExtensionResolver): void {
  protocol.handle('app', async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('bad request', { status: 400 });
    }
    if (url.host !== APP_HOST) return new Response('not found', { status: 404 });
    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return new Response('bad request', { status: 400 });
    }

    // Third-party script extensions: isolated, network-less, opaque-origin frames.
    const ext = rel.match(/^\/ext\/([a-z0-9][a-z0-9._-]{1,63})\/(.+)$/);
    if (ext) {
      const dir = extensions(ext[1]);
      if (!dir) return new Response('extension not enabled or not approved', { status: 403 });
      const file = safeJoin(dir, ext[2]);
      if (!file) return new Response('forbidden', { status: 403 });
      return serveFile(file, {
        'Content-Security-Policy': `default-src 'none'; script-src ${APP_ORIGIN}/ext/${ext[1]}/; style-src ${APP_ORIGIN}/ext/${ext[1]}/ 'unsafe-inline'; img-src data: blob:; font-src data:; sandbox allow-scripts`,
      });
    }

    if (rel === '/' || rel === '') rel = '/index.html';
    const file = safeJoin(rendererRoot, rel);
    if (!file) return new Response('forbidden', { status: 403 });
    return serveFile(file, file.endsWith('.html') ? { 'Content-Security-Policy': APP_CSP } : {});
  });
}

async function serveFile(file: string, extraHeaders: Record<string, string>): Promise<Response> {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return new Response('not found', { status: 404 });
  } catch {
    return new Response('not found', { status: 404 });
  }
  const res = await net.fetch(pathToFileURL(file).toString());
  const headers = new Headers();
  headers.set('Content-Type', MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
  return new Response(res.body, { status: 200, headers });
}
