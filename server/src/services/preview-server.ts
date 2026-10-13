/**
 * Preview server — serves project files raw so the dashboard's file viewer can
 * show images, video, audio, PDFs and live HTML pages (with their CSS/JS/images
 * resolving relative to the file, like opening it in a browser).
 *
 * It runs on its own loopback port so previewed pages get a different origin
 * from the dashboard: a page Claude generated (or one in a cloned repo) can't
 * read the dashboard or call the OctoAlly API (index.ts rejects requests whose
 * Origin is this server).
 *
 * URL scheme: the absolute file path is the URL path, e.g.
 *   http://127.0.0.1:42012/C:/Users/me/proj/index.html   (Windows)
 *   http://127.0.0.1:42012/home/me/proj/index.html      (Linux/macOS)
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'http';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { extname, join, resolve } from 'path';

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', xhtml: 'application/xhtml+xml',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8', map: 'application/json',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8', xml: 'application/xml', wasm: 'application/wasm',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
  tif: 'image/tiff', tiff: 'image/tiff',
  // .mov/.m4v are usually H.264 in an MP4-compatible container; Chromium plays them as video/mp4.
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', weba: 'audio/webm',
  pdf: 'application/pdf',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  glb: 'model/gltf-binary', gltf: 'model/gltf+json',
};

function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.startsWith('[')
    ? hostHeader.slice(0, hostHeader.indexOf(']') + 1)
    : hostHeader.split(':')[0];
  const h = host.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
}

/** URL path → absolute filesystem path (or null if malformed). */
function toFsPath(urlPath: string): string | null {
  let p: string;
  try { p = decodeURIComponent(urlPath); } catch { return null; }
  if (p.includes('\0')) return null;
  if (process.platform === 'win32') {
    p = p.replace(/^\/+/, '');                 // "/C:/x" → "C:/x"
    if (!/^[A-Za-z]:[\\/]/.test(p) && !/^\\\\|^\/\//.test(p)) return null;
  } else if (!p.startsWith('/')) {
    return null;
  }
  return resolve(p);
}

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isLoopbackHost(req.headers.host)) return send(res, 403, 'Forbidden host');
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');

  const url = new URL(req.url || '/', 'http://127.0.0.1');
  let filePath = toFsPath(url.pathname);
  if (!filePath) return send(res, 400, 'Bad path');

  let info;
  try {
    info = await stat(filePath);
    if (info.isDirectory()) {
      filePath = join(filePath, 'index.html');
      info = await stat(filePath);
    }
  } catch {
    return send(res, 404, 'Not found');
  }
  if (!info.isFile()) return send(res, 404, 'Not found');

  const ext = extname(filePath).slice(1).toLowerCase();
  const headers: Record<string, string | number> = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    // Only OctoAlly (any local port) may frame previews — not arbitrary websites.
    'Content-Security-Policy': "frame-ancestors 'self' http://localhost:* http://127.0.0.1:* http://[::1]:*",
  };

  const size = info.size;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    let start = m && m[1] !== '' ? parseInt(m[1], 10) : NaN;
    let end = m && m[2] !== '' ? parseInt(m[2], 10) : NaN;
    if (m && isNaN(start) && !isNaN(end)) { start = Math.max(0, size - end); end = size - 1; } // suffix range
    if (isNaN(end) || end >= size) end = size - 1;
    if (!m || isNaN(start) || start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(filePath, { start, end }).on('error', () => res.destroy()).pipe(res);
    return;
  }

  res.writeHead(200, { ...headers, 'Content-Length': size });
  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
}

let previewPort: number | null = null;
let server: Server | null = null;

export function getPreviewPort(): number | null {
  return previewPort;
}

export function getPreviewBase(): string | null {
  return previewPort ? `http://127.0.0.1:${previewPort}` : null;
}

/** Start on the preferred port (default: main port + 2), or any free port if taken. */
export function startPreviewServer(preferredPort: number): Promise<void> {
  return new Promise((resolveStart) => {
    server = createServer((req, res) => {
      handle(req, res).catch(() => { try { send(res, 500, 'Error'); } catch { /* closed */ } });
    });
    const listen = (port: number) => {
      server!.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && port !== 0) listen(0);
        else { console.warn(`  Preview server unavailable: ${err.message}`); resolveStart(); }
      });
      server!.listen(port, '127.0.0.1', () => {
        const addr = server!.address();
        previewPort = typeof addr === 'object' && addr ? addr.port : null;
        resolveStart();
      });
    };
    listen(preferredPort);
  });
}
