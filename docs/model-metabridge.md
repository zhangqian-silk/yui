# metabridge: independent operation and optional maintenance

Manual revision 1 · 2026-10-24 · selected target commit
`ccc782e2ac3e4c91d89893207582dad16b45e623`, **not** remote latest.
Source: `https://github.com/zhangqian-silk/metabridge`.
The historical local name `codex-metabridge` is not a runtime identity.
The selected README/package.json and native configuration are source evidence;
this delivery tests isolated file/Git fixtures, not this real service or model.

## Install and run independently

metabridge combines/routes sources for Codex. CPA and bridge are independent;
direct Provider API and official-subscription routes can coexist. Responses
compatibility is not a promise for every Agent/protocol.

The exact package.json requires Node >=20.9 and `sharp` 0.35.5. Native package
installation can require a platform toolchain. It is optional for Yui users.
For an authorized install, resolve an approved source ref to an exact commit,
initialize a fresh checkout and review its package/lockfile. Run `npm ci` there,
then `node --check server.js` as a minimal static check. This baseline declares
no `npm run build`. Repository/dependency execution and downloads need their
own explicit scope. [Maintenance](model-maintenance.md) implements this pinned
workflow with independent builds and retained old versions; never pull in a
running/dirty checkout.

The baseline reads `MB_CONFIG_FILE`, otherwise its native user config. Listener
environment variables such as `MB_HOST`/`MB_PORT` can override file settings.
An independently runnable, explicit launch is:

```sh
MB_CONFIG_FILE=/absolute/private/bridge/config.json node /absolute/releases/current/server.js
```

Only start after checking config, dependency and intended listener conditions,
and after obtaining startup authority. Stop through the known owning process/
service manager, never `pkill` or guessed port ownership.

## Configuration, credentials and clients

Root native JSON (isolated example, not fixed/default ports):

```json
{"host":"127.0.0.1","port":18418,"providerFiles":["providers/cpa.json"]}
```

`providers/cpa.json`:

```json
{"name":"cpa","via":"cpa","protocol":"responses","wire_api":"responses","base_url":"http://127.0.0.1:18417/v1","prefix":"cpa/","enabled":true,"requestMode":"passthrough","compaction":{"mode":"passthrough"},"auth":{"type":"keyfile","file":"cpa-client.key"}}
```

Prepare the authorized inference key privately. Key references are relative
to the Provider directory; Provider references are relative to the root.
CPA's management/upstream credentials do not belong here. A direct Provider
uses `via:"direct"` and its API root/key. `base_url` is a full root; native
`base` has different `/v1` semantics. Root `providerFiles` and inline `backends`
are alternatives, not two authorities. Keep credential-bearing files private.
Preserve official `codex-subscription` routes and native Codex login; generic
API-key bindings don't replace mixed official-subscription authentication.

The [standalone connection tool](model-connection-tools.md) edits supported
listener/Provider-file fields without replacing routes. It refuses unsupported
inline migrations/processing/auth policies. Use its complete field/auth
reference; it never reads native login or refreshes a catalog.
Adding a Codex Provider and `selectProvider` are distinct inputs.

Register a module with kind `metabridge`, exact version and config path.
`maintenance:"configuration"` delegates configuration editing, not service
ownership; `external` is reference-only. Register a separate Responses endpoint
for the exact Codex Agent, or retain native binding for mixed subscription mode.
No CPA, default Provider switch or service takeover is implied. The
[shared API](model-management-api.md) gives full registration shapes.
Models → Component maintenance provides instructions to copy to Operator, without
a manual configuration form. Operator uses `yui models connection-preview` and
`connection-apply` to invoke the same standalone implementation through Jobs;
independent entry is
`node /absolute/yui/dist/models/configureConnection.js --help`.

## Save, application and service control

This baseline loads configuration at startup. Saved is not runtime applied.
Delegate an inspected exact user-systemd unit only when authorized; its
ExecStart should use the selected build and stable config path. Its fragment
digest/identity is checked and unreviewed drop-ins are refused. Specify actual
dependency relationships; not every bridge needs CPA.

Start/stop/restart/status and redacted log metadata use the
[maintenance contract](model-maintenance.md). Reviewed preflight commands must
check this instance's config/dependencies/listener. Restart impacts shared
requests and possibly unknown clients. Service active, readiness and inference
are distinct. Yui doesn't call `/healthz`, catalog or a model as a hidden check;
it doesn't restart Codex's daemon.

## Complex native field edit and authority reread

For a field outside the common form, edit the exact native owner structurally.
This executable example changes `catalogTtlMs` on an **authorized isolated JSON
root**, preserves other fields, backs up and checks bytes before replacement:

```sh
node --input-type=module - /absolute/private/config.json /absolute/private/new-backup.json <<'JS'
import { writeFileSync } from "node:fs";
import { modelJsonFile, modelDigest, replaceModelFile } from "./dist/models/modelManagementFiles.js";
const [file, backup] = process.argv.slice(2);
const old = modelJsonFile(file);
writeFileSync(backup, old.raw, { flag:"wx", mode:0o600 });
replaceModelFile(old, {...old.value,catalogTtlMs:60000});
const after = modelJsonFile(file);
if(after.value.catalogTtlMs!==60000) throw Error("readback");
console.log(JSON.stringify({before:modelDigest(old.raw),after:modelDigest(after.raw),backup,applied:false}));
JS
```

Run from a built Yui checkout with all external editors excluded. This proves
file mechanics, not full native semantic/runtime validation. Check field meaning
against the exact source when changing versions. For `webSearch`/shared routing
also validate the referenced backend and enablement before writing.
Explicitly refresh this module's configuration status, then reread its Provider
projection. A changed digest proves native authority reread; runtime stays
unknown. Never write an old cached projection over a newer native file.

## Recover and hand off

Retain the prior build, failed checkout and explicitly inventoried config/
Provider/key backups. Authentication/ref/build failures don't switch versions.
Unknown restart needs exact Job/unit/process/link inspection, not retry.
`sharp`/Node ABI and native format changes must be reviewed per version.
Automatic binary rollback requires `migration:"none"` and neither restores config
nor restarts. For native restoration, compare current bytes/mode to the recorded
post-write state and validate the private backup before atomic replacement.
Connection-tool changes have executable revision-checked `restore`.

Disable separate schedules and prepare no-effect handoff. Preserve version,
startup/unit, config, data and private keys before removing unused Yui references.
The service remains independently running. Stop, uninstall, delete and revoke
are separate effects. [Maintenance](model-maintenance.md) includes deterministic
installation/failure/handoff verification and cleanup; real service/model/
active Session compatibility is not established by those fixtures.
