# Task HTTP preview

The Web Dock's **Preview** tab displays an actual foreground HTTP service,
not an HTML artifact. **Open window** opens the same isolated running page
without the control interface. Both paths use the current Yui Web connection:
when Web is reached through an SSH tunnel, preview uses that tunnel too. No
Controller `localhost` address is substituted with the browser's `localhost`,
and no additional service port needs forwarding.

## Publish a service

A preview is an explicitly opted-in, single-step DurableJob. Start it from the
current authorized Task Leader/Worker using the existing `job start` command,
with `--env YUI_HTTP_PREVIEW=1`. The Job's existing Project, workspace, HEAD,
assignment and idempotent request checks still apply. There is no Web command
executor, URL registration form or separate service registry.

The foreground application must listen on the Unix socket passed in
`process.env.YUI_PREVIEW_SOCKET`; it must not daemonize. For example:

```js
import { createServer } from "node:http";
const server = createServer((request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end("<h1>Running development service</h1>");
});
server.listen(process.env.YUI_PREVIEW_SOCKET);
```

```sh
yui job start --task <task> --project <project> --head <exact-sha> \
  --workspace <managed-project-checkout> --request-id <new-request-id> \
  --env YUI_HTTP_PREVIEW=1 --step 'web=/absolute/path/to/node server.mjs'
```

For development of Yui itself, use the checkout's absolute
`output/dev/bin/yui` and an independent Home, as required by `AGENTS.md`.
This example does not grant external-resource or production authority.

The existing Job timeout applies (the CLI's default is 30 minutes). A service
that only binds TCP is not supported by this first contract; adapt the actual
application's listener to the supplied socket. Do not publish a proxy to an
arbitrary port or URL as a substitute for the owned service.

## Supported HTTP and browser boundary

- GET and HEAD, relative scripts/styles/images and same-service relative GET
  fetches. Responses must honor `Accept-Encoding: identity`; each request is
  bounded to two seconds and eight MiB. Relative redirects remain scoped to
  the same service.
- Root-absolute asset paths, absolute redirects, external resources,
  WebSocket/HMR, SSE, cookies, browser storage, forms, uploads and authenticated
  applications are not supported. The backend passes `X-Forwarded-Prefix`
  for applications that can generate preview-relative URLs. It does not
  rewrite arbitrary HTML, JavaScript or CSS.
- Preview responses always carry a CSP sandbox with scripts allowed but
  without `allow-same-origin`, including when opened as a top-level window.
  Their browser origin is opaque. The iframe adds the same sandbox.
  No popups, top-level iframe navigation, workers or nested frames are granted.
- Each Web listener issues a distinct read-only ticket bound to one Task and
  Job. This is not the control token. Do not share preview URLs: possession
  permits reading that service while its Job and Task remain available.
  Tickets expire on Web listener restart and cannot authorize control APIs.
- Browser cookies, Authorization and the Yui page token are never forwarded.
  Upstream cookie, CSP, CORS and arbitrary redirect headers are not trusted.
  No browser-supplied host, port or URL chooses the upstream. Every request
  resolves the exact Job again and connects only to its registered socket.

This is browser isolation, not an OS sandbox for developer code. A trusted
Task process still has its existing local filesystem/network permissions.

## Facts, stop and cleanup

The Dock checks at most the newest 16 registered Jobs on opening and every
five seconds while visible. `HTTP ready` means a bounded service response,
not successful browser rendering. The browser's restrictions may still
prevent an incompatible application from displaying. Opening a preview does
not start or restart a Job.

Queued/recently starting Jobs show **Starting**; a service that has not bound
its socket after 30 seconds shows **Failed** with recovery guidance.
Non-success HTTP responses, timeouts, missing sockets, invalid ownership and
unknown Job outcomes are reported, not inferred as readiness. Inspect the
original Job and its log before starting a corrected Job with a new request.

Closing/hiding the Dock, switching Tasks or closing a separate window only
releases that view. **Stop service** writes the same exact Job cancellation
request used by the CLI. **Stopping** is not **Stopped**. The Job runner owns
process-group termination and publishes its existing exit evidence; the
Controller retains the result in Task context. Stop and settle running Jobs
before Task completion/archive using the existing lifecycle gates. An ended
Task or disabled execution gate also prevents preview traffic, but that alone
does not prove the service process stopped.

The receipt describes the foreground Job, not proof that a deliberately
detached descendant is gone. Existing runtime inventory and cleanup checks
remain authoritative for surviving processes; preview never scans or kills
processes by name or by a browser-supplied PID.

Only the short IPC socket is outside Home (the same Unix socket length
constraint as existing Controller/Agent Host IPC). Its private directory is
derived from the exact Home/Task/Job artifact location and effective uid.
Exclusive creation refuses stale endpoints; cleanup checks the original
directory inode, removes only its socket, then removes the empty directory.
Failure retains evidence rather than deleting unknown contents. Durable Job
history and logs remain in Home. No persistent record schema changes.
