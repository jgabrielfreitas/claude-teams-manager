import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { MiddlewareHandler } from 'hono';

/**
 * Serves the built client (`dist/client`) with an SPA fallback.
 *
 * In development this middleware finds no build and does nothing: Vite serves
 * the client on its own port and proxies `/api` back here.
 */

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

async function readableFile(path: string): Promise<{ size: number } | undefined> {
  try {
    const info = await stat(path);
    return info.isFile() ? { size: info.size } : undefined;
  } catch {
    return undefined;
  }
}

function toWebStream(path: string): ReadableStream {
  return Readable.toWeb(createReadStream(path)) as unknown as ReadableStream;
}

export function staticClient(rootDir: string): MiddlewareHandler {
  const root = resolve(rootDir);

  return async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
    if (c.req.path.startsWith('/api')) return next();

    const requested = decodeURIComponent(new URL(c.req.url).pathname);
    const relative = normalize(requested).replace(/^([/\\])+/, '');
    if (relative.split(sep).includes('..')) return c.text('Not found', 404);

    const candidate = relative ? join(root, relative) : join(root, 'index.html');
    const file = (await readableFile(candidate)) ? candidate : undefined;

    if (file) {
      const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
      const immutable = file.includes(`${sep}assets${sep}`);
      return new Response(toWebStream(file), {
        headers: {
          'content-type': type,
          'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
        },
      });
    }

    // SPA fallback: any unknown path is a client route.
    const index = join(root, 'index.html');
    if (await readableFile(index)) {
      return new Response(toWebStream(index), {
        headers: { 'content-type': CONTENT_TYPES['.html']!, 'cache-control': 'no-cache' },
      });
    }

    return next();
  };
}
