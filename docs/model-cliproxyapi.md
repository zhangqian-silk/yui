# CLIProxyAPI v8.0.12: shared CPA and optional maintenance

Manual revision 1 · selected tag `v8.0.12` · 2026-10-24.
Source: `https://github.com/router-for-me/CLIProxyAPI`.
Reference files at this tag: `config.example.yaml`, `go.mod`,
`cmd/server/main.go`. They are source evidence, not a real installed-build test
or remote-latest claim. go.mod requires Go 1.26.0; validate the actual platform
and toolchain independently. Go isn't required for Yui users who don't build CPA.

## Install, configure and run independently

CPA owns upstream credentials, account state and model mappings. It can serve
compatible Codex/Claude clients without metabridge. Registration doesn't grant
OAuth/login, account deletion, bulk account-pool or plugin installation scope.

For an authorized source install, check an approved branch/tag remotely,
approve its exact commit and build in a fresh checkout; for example,
`go build -o cliproxyapi ./cmd/server`. Dependency retrieval and repository
execution must be authorized. Build metadata must follow that release's
instructions: a `dev` version string isn't an official release artifact.
Retain exact source commit provenance. Never pull in an active/dirty checkout.
[Maintenance](model-maintenance.md) implements isolated pinned build/switch.

Use the native `-config /absolute/private/config.yaml` flag from the selected
entry point, not guessed defaults or a nonexistent `--check` flag. Static
parsing, startup and inference are separate tiers. An explicit owned unit can
execute the binary under `releases/current` with a stable external config path.
Check dependencies/listener/config before starting. No automatic service/port
takeover or implied bridge dependency occurs.

Read the full versioned template before modifying a real file. Isolated example:

```yaml
config-version: 8
server:
  host: "127.0.0.1"
  port: 18417
management:
  allow-remote: false
  secret-key: ""
  disable-control-panel: true
access:
  api-keys: ["REPLACE_WITH_INFERENCE_CLIENT_KEY"]
routing:
  strategy: "round-robin"
```

Ports/paths are examples. Native defaults aren't a secure loopback deployment
choice. Empty management secret disables management; native hashing/remote/TLS
and v8-over-legacy precedence follow the selected template. `access.api-keys`
are inference keys, not management or upstream keys. Preserve native provider,
account/auth-directory and model mapping fields. Don't copy Codex/Claude native
login into arbitrary API credentials.

Changing `config-version` alone doesn't migrate a legacy configuration. Native
v8 migration may make binary downgrade unsafe. Use `migration:"manual"` and
make the native migration/recovery decision separately. No verified conditional
HTTP write is promised by this adapter.

## Independent/shared access and Yui

Register kind `cliproxyapi`, version `8.0.12`, exact native config path and
optional management URL/private key reference. Configuration and lifecycle
delegation are independent. Register a Responses endpoint with `/v1` for Codex;
if supported by the selected build, register a separate `anthropic-messages`
server-root endpoint for Claude CLI. Both can refer to one CPA module so quota
isn't multiplied by Agent bindings. See [shared API](model-management-api.md).

The [connection tool](model-connection-tools.md) can add a Codex direct CPA
Provider with explicit auth. No bridge is required, and default selection is a
separate `selectProvider` input. Per-Agent Yui bindings affect fresh Sessions;
they don't rewrite native defaults or restart a shared daemon.
For Codex → bridge → CPA keep bridge routes and CPA accounts separate.

Ordinary observation reads are cached. Explicit status refresh rereads the
native file without networking; directory/quota refresh are different effects.
`factory-quota-v1` is **wire-contract tested only**: no extension build/version
was verified. CPA v8.0.12 doesn't prove extension presence/compatibility. Don't
install guessed plugins for a missing route. Unknown isn't zero, failed refresh
retains stale values and unlike quota units aren't added.

## Complex native field edit and Yui reread

`routing.strategy` isn't a common Web field. The assigned metabridge README's
CPA setup documents JSON as valid accepted YAML. For this isolated executable
example create a private JSON representation, not a complete production config:

```json
{"config-version":8,"server":{"host":"127.0.0.1","port":18417},"management":{"allow-remote":false,"secret-key":"","disable-control-panel":true},"access":{"api-keys":["ISOLATED_ONLY"]},"routing":{"strategy":"round-robin"}}
```

With exclusive ownership, run from a built Yui checkout:

```sh
node --input-type=module - /absolute/private/cpa.json /absolute/private/new-backup.json <<'JS'
import { writeFileSync } from "node:fs";
import { modelJsonFile, modelDigest, replaceModelFile } from "./dist/models/modelManagementFiles.js";
const [file, backup] = process.argv.slice(2);
const old = modelJsonFile(file);
if(old.value["config-version"]!==8) throw Error("wrong version");
if(!["round-robin","fill-first"].includes(old.value.routing?.strategy)) throw Error("unsupported routing");
writeFileSync(backup, old.raw, {flag:"wx",mode:0o600});
replaceModelFile(old,{...old.value,routing:{...old.value.routing,strategy:"fill-first"}});
const after=modelJsonFile(file);
if(after.value.routing.strategy!=="fill-first") throw Error("readback");
console.log(JSON.stringify({before:modelDigest(old.raw),after:modelDigest(after.raw),backup,applied:false}));
JS
```

For existing YAML, use its matching structured YAML parser and preserve other
fields. The JSON-only helper refuses YAML rather than silently converting it.
The example tests file mechanics, not a live native parser or all config
semantics. Refresh the CPA module's Yui configuration status and retain the new
digest; runtime stays unknown. Never overwrite an external edit from a cached
projection. Deterministic native edit/reread fixtures are listed in
[maintenance](model-maintenance.md).

## Service, recovery and independent handoff

Delegate exact user-systemd unit/fragment identity for start/stop/restart/status
and redacted log metadata. Reviewed preflight commands must check this
instance's config, dependencies and intended listener. Native dependency/
ExecStartPre rules remain relevant. Service active is not model readiness;
restart affects shared and unknown consumers. Nonzero/timeout action results
aren't automatically retried: inspect the exact Job/unit/process first.

Update retains old build and the explicit private config inventory. Include
auth/account files only when that backup is authorized; it isn't a remote-state
or database backup. Binary rollback refuses manual migrations and never
restores config or restarts. For native restore, compare current bytes/mode to
your recorded post-write state and validate the backup before atomic replacement.
Stop on later edits. Connection-tool changes use executable revision-checked
restore, not a guessed whole-directory copy.

Disable separate schedules, prepare no-effect handoff, preserve source/version,
config/auth/startup instructions and service, then remove unused Yui references.
Stopping, uninstalling, deleting data/accounts and revoking credentials require
separate effects. The [maintenance contract](model-maintenance.md) contains
exact Web/CLI/Operator input, failure/recovery and fixture cleanup instructions.
No real CPA/model/quota/account or native-session compatibility is claimed.
