import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { Readable } from 'node:stream';
import { protocol } from 'electron';
import { MEDIA_SCHEME } from '../shared/brand';
import type { ProjectStore } from './projects';

const TYPES: Record<string, string> = {
  // QuickTime files share the MP4 structure; Chromium plays them when served as MP4.
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4', '.webm': 'video/webm',
  '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.weba': 'audio/webm', '.ogg': 'audio/ogg',
  '.jsonl': 'application/x-ndjson', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png',
};

export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: false } },
  ]);
}

/**
 * zeyvola-media://<projectId>/<relative path>. Serves only files inside a known project
 * folder and supports byte ranges so <video> can seek.
 */
export function handleMediaProtocol(store: ProjectStore): void {
  protocol.handle(MEDIA_SCHEME, async (req) => {
    try {
      const url = new URL(req.url);
      const projectId = url.hostname.startsWith('prj_') ? url.hostname : decodeURIComponent(url.host);
      const rel = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      const file = store.resolve(projectId, rel);
      const info = await stat(file);
      if (!info.isFile()) return new Response('Bulunamadı', { status: 404 });
      const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
      const size = info.size;
      const range = req.headers.get('range');
      // The renderer (file://) uploads frames to WebGL, which requires CORS-approved media.
      const headers: Record<string, string> = {
        'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*',
      };
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        let start = m?.[1] ? Number(m[1]) : 0;
        let end = m?.[2] ? Number(m[2]) : size - 1;
        if (!m?.[1] && m?.[2]) { start = Math.max(0, size - Number(m[2])); end = size - 1; }
        if (start >= size || end < start) {
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
        }
        end = Math.min(end, size - 1);
        const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>;
        return new Response(body, {
          status: 206,
          headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
        });
      }
      const body = Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>;
      return new Response(body, { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
    } catch {
      return new Response('Bulunamadı', { status: 404 });
    }
  });
}

export function mediaBase(projectId: string): string {
  return `${MEDIA_SCHEME}://${projectId}/`;
}
