# Model components: operator and Agent manual

Documentation revision 3 · 2026-10-26. Read the matching component section
before modifying a registered instance. These instructions do not grant
permission to operate a real service or consume an account.

Versioned operating manuals: [metabridge](model-metabridge.md),
[CLIProxyAPI v8.0.12](model-cliproxyapi.md), [maintenance](model-maintenance.md),
[standalone connection tools](model-connection-tools.md), and
[unified API](model-management-api.md). Web serves these at `/models/docs`,
`/models/docs/metabridge`, `/models/docs/cliproxyapi`, `/models/docs/maintenance`
and `/models/docs/connection`. Common operations share the business service;
complex fields use matching native instructions and explicit reread.

## Normal user path: copy instructions to Operator

Connection, Agent binding and component maintenance are infrequent operations.
The Web pages lead with current references and a **Copy instructions for Operator**
button, not configuration fields. Paste the text into the existing Operator
conversation, confirm the intended change, then reread the Web settings when
Operator finishes. Copying neither sends a message nor executes any operation.
On LAN HTTP, browsers may refuse automatic clipboard access; the read-only text
remains selectable for manual copying. Prompts never include registry addresses,
key files or secret values.

Model-source and Agent-selection forms remain under a closed **Advanced:
configure manually** disclosure. Component registration, maintenance specifications
and native configuration tools have no manual Web editor; Operator uses the
existing CLI/API and standalone tools. Existing services, native Agent configuration, catalog
and quota observation semantics are unchanged. No new Skill installation is
required: Web and CLI share static prompts, and the CLI points to the manuals
shipped with its own version rather than an independently updated instruction
package.

Start with `yui models guide metabridge --json` (or `binding`, `maintenance`).
This offline command returns the prompt, Operator procedure, command examples
and absolute installed manual paths. It reads no service or user configuration.
An existing mixed official-subscription metabridge setup usually needs the native
Agent path, not another generic API-key binding. Inspect the actual setup first.

Operator must establish exact Agent, service and effect scope. Default to new
Yui Sessions; personal native configuration is a separate explicit choice.
Reuse existing services without installation or lifecycle takeover. Ask only
for missing choices, explain changes before confirmation, preview/check revisions,
back up files, apply only authorized effects and read back each result. A generic
handoff prompt does not authorize restart, upgrade, deletion or real-model/quota
validation. Never print secrets or copy login credentials. Unknown results require
inspection of the same request/Job, not replay.

| Component | Target evidence | Yui scope in this delivery |
| --- | --- | --- |
| CLIProxyAPI | `router-for-me/CLIProxyAPI`, tag `v8.0.12`, `config.example.yaml` fetched at this tag | Independent endpoints, reference registration, native configuration method, explicit configuration-status reread |
| metabridge | `zhangqian-silk/metabridge`, reference commit `ccc782e2ac3e4c91d89893207582dad16b45e623`; local file contract tested | Provider editor, independent endpoint, optional pinned Git/service maintenance |
| Factory/Command Code quota extension | `factory-quota-v1` wire contract from the existing adapter; **no extension build/version verified** | Opt-in, deterministic fixture-tested read adapter; do not infer compatibility from CPA version |
| Codex | App Server per-thread config contract; static launch fixtures, not a real installed binary compatibility test | Exact configured `codex` Agent, Responses endpoint or native |
| Claude Code CLI | Anthropic gateway bearer-env contract; static launch fixtures, not a real CLI/model compatibility test | Exact configured `claude` Agent, Anthropic Messages endpoint or native |

Sources:

* https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.12/config.example.yaml
* https://learn.chatgpt.com/docs/app-server
* https://learn.chatgpt.com/docs/config-file/config-reference
* https://code.claude.com/docs/en/llm-gateway-connect

The first version is a selected target, not “latest”. A locally installed
version or tag does not establish a remote latest release. Record the resolved
commit in the exact maintenance Job result, separately from runtime version. No package,
plugin or binary was installed into a user's service by this delivery.

## CLIProxyAPI v8.0.12

### Responsibility and independent use

CPA owns upstream credentials, account state and model mappings. It can serve
multiple clients without metabridge. Its client credential is not its upstream
credential or management credential. A compatible Responses endpoint can serve
Codex; a separately declared Messages endpoint can serve Claude CLI. Register
two endpoints referring to the same module to share CPA/account observations.

Do not copy native Codex or Claude login files into CPA. OAuth, account deletion,
account-pool bulk operations and plugin installation require separate scope.

### Files, fields and precedence

Start from the exact v8.0.12 template, in an owned private directory. Discover
the actual configuration path from the instance's explicitly owned launch
definition/arguments, not from a process name or port. Register that absolute
path as `configFile`; Yui does not move it or create a second upstream authority.
The native template uses:

```yaml
config-version: 8
server:
  host: "127.0.0.1"
  port: 18417
management:
  allow-remote: false
  secret-key: ""    # empty disables management; inject a separate private secret when authorized
  disable-control-panel: true
access:
  api-keys:
    - "REPLACE_WITH_A_CLIENT_KEY"
routing:
  strategy: "round-robin"
```

This is an isolated example, not a universal port/default. The upstream template
defaults host to `""` (all interfaces); choose loopback explicitly when local
access is intended. `server.tls` holds `enable`, `cert`, `key`.
`management.secret-key` is hashed by the native program when plaintext is
provided; empty disables management routes. `access.api-keys` are inference
client keys. Never bind the management key file as `clientKeyFile`.

For upstream model mappings inspect the exact template's `api-keys` entries:
Claude entries include `keys`, `base-url`, `prefix`, `models` (`name`/`alias`)
and `excluded-models`. Preserve other providers and account-auth directories;
do not replace the whole template with this minimal example. Use only
credential methods supported by the selected upstream/CPA build. No guessed
environment-variable interpolation is promised.

The v8 template documents that, when v8 and legacy spellings coexist, v8 wins,
including false, zero and empty collections. GET or `config-version:8` alone
does not migrate a legacy config. A successful native `/v8/management` write
does. Thus changing the top-level version is **not** a format migration method.
Keep legacy migration and rollback under the native component's versioned
procedure; Yui's storage migration never performs them.

### Common Yui registrations

Use Web → Models: **Model sources**, **Agent access** and **Component maintenance**
provide Operator handoff prompts; only sources and Agent selection retain optional
manual editors under Advanced. Component configuration is handled through Operator.
**Models & quota** reads cached observations. The advanced Agent access editor
derives its adapter from the selected Agent and previews the exact selection
before saving. Native access preserves the Agent's own model choice;
an override affects only new Yui Sessions, never existing Sessions or personal
configuration. Cached model suggestions are not an inference test.
The old `/settings/connection` address opens `/models/connection`.
CLI/API callers can use the equivalent `models.save` capability. Example module:

```json
{"id":"shared-cpa","kind":"cliproxyapi","version":"8.0.12","managementUrl":"http://127.0.0.1:18417","managementKeyFile":"","configFile":"/owned/cpa/config.yaml","maintenance":"external","quotaAdapter":"none"}
```

Example Responses endpoint:

```json
{"id":"cpa-responses","moduleId":"shared-cpa","url":"http://127.0.0.1:18417/v1","protocol":"responses","clientKeyFile":"/owned/client.key"}
```

For Claude CLI register another endpoint with protocol `anthropic-messages`,
URL `http://127.0.0.1:18417` (no `/v1` suffix) and a client bearer key accepted
by that server. Then preview/commit a binding for the exact configured Agent
ID. Do not select an adapter by Role name or model brand.

### Native field modification and Yui reread (isolated runnable example)

`routing.strategy` is intentionally not a Web field. An authorized Agent can
change it using a structured YAML editor and the following ownership procedure.
The isolated regression exercises this same round-trip without starting CPA:

1. Create an owned disposable directory with a 0600 `config.yaml` containing
   the example above. Register only its reference in an isolated Yui store.
2. Explicitly refresh `kind:"status",resourceId:"shared-cpa"` and retain its
   configuration digest. Read cached status again; no file/network refresh
   occurs on that read.
3. Obtain exclusive native-config write ownership (all other editors stopped),
   record a digest and private backup, and structurally change only
   `routing.strategy` from `round-robin` to `fill-first`, preserving other fields.
   Use a YAML parser; do not perform an unbounded textual replacement on a
   real config. Recheck the original digest immediately before atomic rename.
4. Parse the resulting YAML and check the selected native version's allowed
   value (`round-robin` or `fill-first`). This is static validation, not proof
   the running process loaded it. Do not invent a `--check` CLI flag.
5. Explicitly refresh Yui status. A changed digest proves Yui reread the native
   file. Runtime remains `unknown`; neither saving nor digest change claims
   hot reload. Application/restart needs the separately authorized service path.
6. To restore, first require that the current digest equals the exact digest
   you wrote; otherwise stop and report conflict. Restore the private backup,
   then refresh Yui status. Retain backups on partial/unknown outcomes.

No HTTP conditional-write contract was verified for v8.0.12. This first
delivery deliberately does not expose a generic CPA HTTP PUT editor. A local
exclusive-writer agreement is not an ETag or a lock against external editors.

### Installation, service and recovery handoff

The trusted source is the repository/tag above. For an authorized installation,
resolve a reviewed exact artifact/commit, build in an independent directory
using the upstream release instructions for the target platform, verify its
reported version, preserve the prior installation/config and only then switch
an explicitly owned service definition. Never `git pull` in a live or dirty
deployment. v8 configuration migration may not be downgrade-safe; a binary
rollback alone is insufficient.

Discover the service manager/unit through explicit instance ownership, not
`pkill`, port matching or a system-wide service scan. Stop/restart impacts all
known bindings and may affect unknown external consumers. A unit reporting
running is not model readiness. Git update and user-systemd start/stop/log
execution use separately delegated maintenance Jobs, not module registration.
The maintenance manual specifies exact identity checks and recovery boundaries.

Missing management route: check whether the management secret is empty or
remote access is disabled. Missing quota route: do not enable guessed plugins;
inspect the separately installed extension version and scope first. Invalid
config: retain the original file and private backup, report static vs runtime
errors separately, and restore only after checking current revision.

## metabridge

metabridge owns routing/aggregation, not CPA account configuration. The assigned
baseline identifies commit `ccc782e2ac3e4c91d89893207582dad16b45e623`; the editor
supports the native JSON file contract below, not every future build's fields.
Inspect the instance's actual source/version before using it. No new binary
compatibility or live reload behavior is claimed by the file fixtures.

Its root configuration uses listener `host`/`port` and either inline `backends`
or a nonempty `providerFiles` array, never both. Provider-file paths resolve
relative to the root; preserve native ownership and private credentials.
`providerFiles` and `backends` are native alternatives, not two Yui authorities.

An API Provider has `name`, explicit `via` (`direct`/`cpa`), `protocol:"responses"`,
`prefix` ending in `/`, `enabled`, and `auth` (`static`, `keyfile`, `gateway`).
`base` has native `/v1`-prepend semantics; `base_url` is a complete API root.
The editor preserves the spelling and unrelated fields. It refuses implicit
policies, shared route mappings and unsupported protocol edits. Official
`codex-subscription` auth remains the Agent's native auth, not a generic key.

Minimal standalone routing example (substitute an actual client credential
through a private native configuration process, not by publishing this file):

```json
{"host":"127.0.0.1","port":18418,"backends":[{"name":"cpa","via":"cpa","protocol":"responses","wire_api":"responses","base_url":"http://127.0.0.1:18417/v1","prefix":"cpa/","enabled":true,"auth":{"type":"static","key":"REPLACE_WITH_CPA_CLIENT_KEY"}}]}
```

Direct Provider routing uses `via:"direct"` and that Provider's API root;
there is no required CPA. A CPA alone similarly requires no metabridge.
Register the bridge module/config path separately, opt into `configuration`
maintenance only when authorized, and bind a Responses endpoint to the exact
Codex Agent. For Codex → bridge → CPA the endpoint belongs to the bridge, while
the CPA remains a separate module and quota source.
Explicit Yui bindings are API-client-key mode (`requires_openai_auth:false`).
For the existing mixed official-subscription mode requiring native auth
forwarding, keep the Agent's native binding/configuration instead. Yui does not
copy that login into a generic endpoint or claim this API-key mode replaces it.

The Provider form performs preview by loading current facts and requiring the
current revision on submit. It preserves official routes, prevents broken
web-search dependencies and retains unlinked secret-bearing files. Concurrent
external writers must be excluded. A failed root-reference update can leave a
private orphan file; inspect its identity/reference status before any cleanup.
Saved is not applied, and directory refresh is not inference verification.

Complex field example: an authorized Agent may edit a native `webSearch`
reference that the form intentionally does not expose. Back up both referenced
files, require exclusive ownership/current byte digests, verify the destination
backend exists and is enabled where required, preserve unrelated native fields,
atomically replace the owning file, then reread `/api/models?moduleId=ID` and
explicitly refresh configuration status. This changes the Provider revision.
Do not request model inference as a validation shortcut.

Installation/update and service handoff follow the same exact-source,
independent-build, prior-version/config retention and explicit unit ownership
rules as CPA. The standalone connection tool owns listener and
Codex-user-config editing; Web/Operator call that shared implementation through
Jobs. The maintenance manual covers implemented Git/systemd operations.
Existing independent deployments remain authoritative until exact instance
maintenance is explicitly delegated.
Never restart a shared Codex daemon to apply a bridge binding.

## Credentials and observation recovery

Store management, inference-client and upstream credentials separately. Keep
owned key files private (0600), non-symlink and bounded. Avoid exporting the
Controller environment wholesale. Endpoint catalog reads use only the endpoint
key; CPA quota uses only its management key. HTTP reads pin DNS, reject private
non-loopback addresses, do not redirect or use proxies, and enforce deadlines
and response-size limits. Explicit local loopback is supported.

Directory refresh may make upstream requests or have provider-specific side
effects; requesting it is distinct from registration. Failed refresh keeps
the last success and latest failure. Unknown is not zero. Per-account failures
keep their prior values and success time with `stale:true`, even when other
accounts refresh successfully. Quota is keyed by
module/account scope; do not add balances with unlike units or multiply by Agent
bindings. Nothing calls a destructive consumption/usage queue.

When relinquishing management, remove only Yui references after inspecting
dependencies. Keep native config, service startup instructions, data and
credentials. Stop, uninstall, delete data and revoke keys are separate effects.
Record known consumer impact and unknown consumers before an authorized restart.
