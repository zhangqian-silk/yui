// Test-only transport boundary. Never fabricates a Yui receipt: either withhold
// the request or let Yui finish and drop the actual response connection.
import http from "node:http";
import { appendFileSync } from "node:fs";

export async function startFaultProxy(port, upstream, evidence) {
  let mode = null, blockReceipts = false;
  const log = event => appendFileSync(evidence, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n");
  const server = http.createServer((request, response) => {
    if (request.url === "/__fault") {
      let body = "";
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        const value = JSON.parse(body || "{}");
        mode = value.mode ?? null; blockReceipts = value.blockReceipts === true;
        log({ control: value }); response.end("{}");
      });
      return;
    }
    if (blockReceipts && request.url.startsWith("/api/conversation?") && request.url.includes("requestId=")) {
      log({ blockedReceipt: request.url }); response.destroy(); return;
    }
    const fault = request.method === "POST" && request.url.startsWith("/api/conversation?") ? mode : null;
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      if (fault === "before") {
        log({ fault, url: request.url, body: body.toString(), forwarded: false });
        response.destroy(); return;
      }
      const outgoing = http.request({
        hostname: "127.0.0.1", port: upstream, path: request.url, method: request.method,
        headers: { ...request.headers, host: `127.0.0.1:${upstream}`,
          ...(request.headers.origin ? { origin: `http://127.0.0.1:${upstream}` } : {}) }
      }, incoming => {
        if (fault === "after") {
          const received = [];
          incoming.on("data", chunk => received.push(chunk));
          incoming.on("end", () => {
            log({ fault, url: request.url, body: body.toString(), forwarded: true,
              status: incoming.statusCode, receipt: Buffer.concat(received).toString() });
            response.destroy();
          });
        } else {
          response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response);
        }
      });
      outgoing.on("error", error => { log({ error: error.message }); response.destroy(); });
      outgoing.end(body);
    });
  });
  await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
  return async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
}
