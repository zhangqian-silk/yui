import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { Readable, addAbortSignal } from 'node:stream';
import type { ModelTransport } from '../index.js';

/** One product-owned pool, no global fetch dispatcher. No redirects or retries.
 * Gateway owns each Response reader; cancelling it destroys its Node response.
 * Closing the pool after execution has settled releases idle owned sockets. */
export function createProductTransport(): { transport: ModelTransport; close(): void } {
  const http = new HttpAgent({ keepAlive: true, maxSockets: 1 });
  const https = new HttpsAgent({ keepAlive: true, maxSockets: 1 });
  let closed = false;
  return {
    transport(endpoint, init) {
      return new Promise((resolve, reject) => {
        if (closed) { reject(new Error('Product transport closed')); return; }
        const secure = new URL(endpoint).protocol === 'https:';
        const request = (secure ? httpsRequest : httpRequest)(endpoint, {
          method: init.method, headers: init.headers, signal: init.signal, agent: secure ? https : http,
        }, response => {
          addAbortSignal(init.signal, response);
          try {
            const headers = new Headers();
            for (const [key, value] of Object.entries(response.headers)) {
              if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
            }
            const status = response.statusCode ?? 500;
            // Response forbids bodies on these statuses. Release the actual body
            // regardless; Gateway will classify the empty response truthfully.
            if ([204, 205, 304].includes(status)) {
              response.destroy();
              resolve(new Response(null, { status, headers }));
            } else resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, { status, headers }));
          } catch (error) { response.destroy(); reject(error); }
        });
        request.on('error', reject);
        request.end(init.body);
      });
    },
    close() { if (!closed) { closed = true; http.destroy(); https.destroy(); } },
  };
}
