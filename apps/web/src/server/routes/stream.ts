import type { AppCore } from '@claude-team/core';
import { routes } from '@claude-team/protocol';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

const HEARTBEAT_MS = 25_000;

/**
 * The realtime channel: every `AppEvent` the core emits, forwarded verbatim.
 *
 * The browser holds exactly one of these and refreshes its views from it, so
 * nothing in this application polls.
 */
export function streamRoutes(core: AppCore): Hono {
  const app = new Hono();

  app.get(routes.stream(), (c) =>
    streamSSE(c, async (stream) => {
      // Writes are chained so two events can never interleave on the wire.
      let chain: Promise<unknown> = Promise.resolve();
      const enqueue = (write: () => Promise<unknown>) => {
        chain = chain.then(write).catch(() => undefined);
      };

      enqueue(() => stream.write(`retry: 2000\n: connected\n\n`));

      // Deliberately unnamed events: the payload's own `type` is the vocabulary,
      // so the browser needs a single `onmessage` handler for the whole union.
      const unsubscribe = core.subscribe((event) => {
        enqueue(() => stream.writeSSE({ data: JSON.stringify(event) }));
      });

      const heartbeat = setInterval(() => {
        enqueue(() => stream.write(`: heartbeat ${Date.now()}\n\n`));
      }, HEARTBEAT_MS);

      await new Promise<void>((resolve) => {
        stream.onAbort(resolve);
        c.req.raw.signal?.addEventListener('abort', () => resolve(), { once: true });
      });

      clearInterval(heartbeat);
      unsubscribe();
    }),
  );

  return app;
}
