# Controlled Web access

Yui remains a single-user control plane. Web visitors who authenticate can act
as that user, including reading private Task data and using Terminal. This is
not a multi-user permission system.

## Local and LAN startup

`yui web` defaults to `127.0.0.1:4173`. A plain user terminal waits until
Ctrl-C and then closes its listener. `--detach`, `--json`, and current managed
Operator starts instead return a Controller-owned startup receipt.

For trusted LAN access, first create a unique random password file on the
Controller machine, outside any repository or served directory:

```sh
# Run in a private directory; creation is exclusive and never overwrites a file.
node -e 'require("node:fs").writeFileSync("web-password", require("node:crypto").randomBytes(32).toString("base64url")+"\n", {mode:0o600,flag:"wx"})'
yui web --host 0.0.0.0 --port 4173 --auth-file /absolute/private/web-password --detach
yui web --status --json
yui web --stop --json
```

The browser's native HTTP authentication prompt uses username `yui` and the
password from that file. Obtain it privately on the machine; never put it in
a URL, command argument, Task message, screenshot, or shared log. There is no
default password. The file must be a regular non-symlink file owned by the
Controller's OS user, with no group/other permissions, and contain 32–128
printable non-space ASCII characters plus an optional final newline.
It can also protect a loopback listener.

Accepted bindings are loopback, literal RFC1918 IPv4/private ULA IPv6, and
`0.0.0.0` / `::`. DNS aliases, proxy headers and public-IP bindings are not
supported. Wildcards listen on **all** matching interfaces, potentially
including publicly routed interfaces; this feature neither configures a
firewall nor creates a tunnel. Prefer an explicit private address to limit
interfaces.

Startup and status return the actual bound address separately from candidate
access URLs. Wildcards advertise currently discovered private addresses, never
`0.0.0.0` or `::`. IPv6 URLs use brackets. Multiple addresses are listed, not
guessed into one universal link. If none is suitable, the result says so.
The listener is live, but a listed URL is not a claim that a remote machine's
routing or firewall permits access. Interface changes require an explicit
stop/start to refresh the allowed addresses and links.

## Security and revocation

LAN HTTP Basic authentication runs before workbench HTML (including its CSRF
token), static assets, sensitive APIs and Terminal WebSocket upgrades.
Authentication is checked on every request/handshake; it does not issue a
separate persisted browser session. Host must match the startup address set
and actual listener port. Supplied Origin must match the request's exact
HTTP origin; LAN writes and all Terminal handshakes require it. API tokens
remain mandatory, and cross-site user API fetches are refused. No general CORS
opt-in or forwarded-Host trust is added.

Task service previews retain their existing narrower credential: a
listener-scoped, unguessable ticket issued only through the authenticated,
page-token-protected preview-list API. It authorizes GET/HEAD of one registered
live Job only, never the workbench, user API, writes or Terminal, and expires
on listener restart or when the service stops. The opaque preview sandbox's
module/fetch requests may present this ticket without the user's Basic
credential and with `Origin: null`; its existing restricted CORS remains.
The main password is never embedded in a preview URL or forwarded upstream.
Treat preview links as private read capabilities, not public sharing links.
Ordinary Task artifact/file APIs continue to require full authentication.

**HTTP is not TLS.** Basic credentials and private data are recoverable by
network observers. Only use this on a trusted network. Public exposure, TLS
termination, reverse-proxy trust and enterprise SSO are outside this feature.

Browsers may cache Basic credentials. Closing a tab is not logout.
`yui web --stop` closes HTTP connections and all Web terminals, without stopping
Agents. To revoke a password permanently, stop Web, replace the password file
privately, and start again. Each new listener also creates a fresh page token.
Changing the file alone does not alter a running listener. Wrong credentials
produce a 401 challenge; stale page tokens require reloading after authentication.
There is no automatic password recovery or anonymous fallback.

## Lifecycle and Operator authority

The existing Controller owns exactly one listener and one Kernel. A repeat
start with the same host, port and credential-file path returns the existing
receipt, without claiming to reload credentials; changing configuration
requires explicit stop/start. A foreground repeat does not claim ownership or
stop another caller's listener. Stops are bound to the observed listener ID.
Port conflicts, unavailable addresses and invalid credential files fail before
a running receipt is returned. In-progress lifecycle changes are reported,
not represented as a successful start or stop.

Controller shutdown/recovery closes Web and does **not** automatically reopen
the network entry point. Query status, then explicitly start if still authorized.
If the Controller is unavailable, the CLI reports that error rather than
printing an old URL. No extra daemon, Controller restart, Agent replacement or
runtime-state editing is needed for Web start/stop.

The current global Operator may carry out user-requested Web lifecycle
operations. CLI and Controller both validate its current native Session in the
selected Home. Task Leader/Worker/Reviewer and custom global Roles cannot use
this path. Partial, revoked, replaced or wrong-Home identities never fall back
to public-user authority. The local socket's OS-user/Home authentication still
applies to plain user terminals; this is not protection from another process
that already controls the same OS account and can modify Yui's Home.

Starting a listener does not authenticate its visitors or issue the Operator a
browser credential. The Operator must retain its managed identity, use only the
user's requested exposure and credential file, and report the receipt and HTTP
limitations without revealing secrets.
