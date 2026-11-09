# Unified model management

Contract 1 · storage 1.24 · Task 150. This replaces the coupled Task-122
connection API. [Component manuals](model-components.md) describe the supported
versions, native configuration and recovery boundaries.

## Ownership and entry points

Yui stores **references**, not upstream configuration: `ModuleInstance` records
optional maintenance, `ModelEndpoint` records an inference protocol/address and
client credential reference, and `AgentBinding` selects an endpoint for an exact
configured Agent. An endpoint can have no module. A native binding has no endpoint.
Multiple Agent bindings can reference one CPA; quota belongs to the CPA/account,
not to the number of bindings. Registration and ordinary reads never contact
an upstream. They neither install a component nor acquire a service.

The Web product separates Agent management (configured tools, native model/effort
observations, Roles and Profiles) from Provider management (connections, CPA
configuration and account observations). `/api/settings/group` for an Agent adds
`observation.native`, a bounded read-only user-config/native-cache projection.
Model reads add `nativeProviders`; these are not registered endpoints and never
become writable references implicitly. Registered CPA instances expose redacted
provider metadata from their native JSON API-key configuration. Credential values
and auth-file contents are never returned. No upstream lookup or native process
launch is needed for these local projections.

Only Agent and Provider are primary Web destinations. Provider reads all
configured module views through the existing read selector, preserving the
module identity and partial failures rather than hiding other modules behind
a resource selector. metabridge and CPA are optional, expandable component
details, not mandatory pages or suppliers. Their configuration rows, registered
endpoints and native connections retain distinct identities; equal names or
addresses do not prove equal credentials, accounts or an active request path.
Catalog and quota observations live inside Provider management and refresh only
after the corresponding explicit action.

### Role execution settings and reusable templates

Agent management separates execution tools, global Role execution settings and
the secondary Profile template library. Each Role can select one Profile, read
a before/after preview, then explicitly apply it. Selection is not a write and
Profiles are not stacked. Unsaved Role edits must be resolved first.

Applying a Profile copies its resolved Agent runtime, access, description,
instructions, Skills and access constraints once. Role name, workspace, enabled
state, responsibilities and expected output remain unchanged. Template-owned
empty values clear prior values, including prior constraints for a write Profile;
these removals appear in the preview. A read Profile supplies the same read-only
constraint as task-role Profile application. This is not a permanent binding:
subsequent Profile edits do not update existing Roles. Running Sessions retain
their captured configuration and existing Tasks are never rebound.

`GET /api/settings/group?id=role/NAME` includes available and unavailable
`profiles`. `GET /api/settings/profile?id=role/NAME&profileId=ID` performs a local,
read-only preview without native capability discovery. Its revision pins the
target Role, Profile and resolved runtime (including inherited Worker settings).
`POST /api/settings/profile` takes `{id,profileId,revision,acknowledgeLive}`.
It validates the candidate, rechecks the preview inside the transaction and
uses the same application command as
`yui config role apply-profile NAME PROFILE [--yes]`. A live Session requires
acknowledgement; pending runtime lifecycle work still blocks mutation.
Preview does not guarantee runtime/model availability.

Provider projections include known, bounded display fields for protocol, source
file, model aliases/exclusions, priority, route matchers and compaction policy.
Conditional local compaction rules must not label the whole route as local
compaction. These are configuration observations, not proof of runtime support;
headers, key payloads and arbitrary configuration objects are not exposed.

Web uses the existing local token, same-origin JSON mutation and mutation-error
boundaries. API error results distinguish `not-submitted` from `unknown`; on
unknown outcome inspect the exact resource/request before deciding a next action.
No automatic retry of a write is performed.

CLI and Operator use the same Controller-owned service through existing
capabilities (a Task supplies the established authenticated capability envelope):

```sh
yui models guide metabridge --json
yui models read --task task-N --json
yui models save --task task-N --input \
  '{"revision":"READ_REGISTRY_REVISION","requestId":"register-api-1","kind":"endpoint","resource":{"id":"api","moduleId":null,"url":"https://gateway.example/v1","protocol":"responses","clientKeyFile":"/private/client.key"}}'
```

Use a real, existing authorized Task ID, not the illustrative `task-N`.
`models guide [metabridge|binding|maintenance]` is offline and needs no Task.
Other `models` commands are narrow aliases for the existing capability calls;
they retain caller authentication, Task scope and request/Job semantics.
`read` accepts the existing read selectors directly (and defaults to `{}`).
`preview`, `save`, `save-provider`, `refresh`, `maintain`, `connection-preview`
and `connection-apply` take the documented Web request body directly as `--input`
JSON. The CLI supplies the capability's outer `input` envelope; `save` selects
resource and `save-provider` selects Provider. Optional `--request-id` is the
outer capability invocation ID, distinct from the body request ID. Neither is
automatically regenerated. There is no implicit apply, retry, refresh or install.
`yui capability describe models.save --task task-N --input ...` remains available
for an exact authorization assessment using the original capability envelope.

Only an existing authenticated Operator has global configuration capability
permission. A Task Leader or Worker does not gain access to global model
configuration just because it can read/manage its Task. `maintenance` is a
declared scope, **not caller authority**. The Web token represents the existing
local user authority, not a Task-role grant. There is no new proxy or generic
plugin platform.

## Registry and writes

Optional lifecycle operations and server-side standalone-tool invocation are
documented in [model-maintenance.md](model-maintenance.md). They reuse the
existing global Job definition/Run contracts (no new persistent envelope).
`models.maintain`, `models.connection-preview` and `models.connection-apply`
share the model-management caller boundary; Task roles gain no global authority.
`models.read` kind `maintenance` reads exact-module cached Job evidence.
Web uses GET/POST `/api/models/maintenance`, POST
`/api/models/connection/preview` and `/api/models/connection/apply`.
Admission is not saved/applied: inspect the exact Job business result.
The UI leads with a copyable Operator prompt. Component registration,
maintenance specifications and native configuration tools are not Web forms;
Operator uses the CLI/API. Existing server-side revision, authorization and
unknown-outcome protections remain unchanged.
Docs: `/models/docs/maintenance`, `/models/docs/metabridge`,
`/models/docs/cliproxyapi` and `/models/docs/connection`.

`GET /api/models/registry` returns `{revision,registry}`.
The registry has `modules`, `endpoints`, `bindings` and a bounded recent request
receipt window. `GET /api/models?moduleId=...` returns the same references plus a
Provider-editor projection and its separate revision. Provider revisions include
the selected bridge's native file bytes. `connection` in that view is a derived,
non-writable bridge projection; it is never stored. The old
`POST /api/models/connection` is removed.

`POST /api/models/resource` accepts `{revision,requestId,kind,resource}`, where
`kind` is `module`, `endpoint` or `binding`. For unregister use `removeId` instead
of `resource`. References must resolve before committing; remove dependent
bindings/endpoints explicitly first. Unregistering deletes only the Yui reference,
never a native file, service or credential. Exact recent request replay is
readback-only; reusing a request ID with other parameters is rejected. Outside
the receipt window, an old revision still cannot authorize replay over new state.

All object fields are explicit and unknown fields are rejected:

| Object | Fields |
| --- | --- |
| Module | `id`, `kind` (`metabridge`/`cliproxyapi`), `version`, `managementUrl`, `managementKeyFile`, `configFile`, `maintenance` (`external`/`configuration`), `quotaAdapter` (`none`/`factory-quota-v1`) |
| Endpoint | `id`, `moduleId` (nullable), `url`, `protocol` (`responses`/`anthropic-messages`), `clientKeyFile` |
| Binding | `agentId`, `adapterId` (`codex`/`claude`), `endpointId` (nullable), `model`, `scope` (`yui-new-session`) |

Empty optional file/management URL strings mean absent. File references must be
absolute. Secrets themselves are not registry values. Changing a credential's
destination origin requires a new file reference or explicitly clearing the old
one first. A module management key is never used by an endpoint or Agent.

`POST /api/models/binding/preview` accepts `{revision,binding}` and statically
checks exact configured Agent identity/adapter, endpoint references and protocol.
It does not validate credentials by contacting a model. Commit the same binding
with `resource`; preview does not grant authority or waive the revision check.
Results say `saved` for references and `new-session-only` for bindings, never
runtime applied. No global Role configuration is edited.
Native bindings must leave `model` empty, preserving the native model choice.

Codex receives a Responses Provider in its per-thread App Server configuration;
Claude CLI receives its own process's `ANTHROPIC_BASE_URL` and explicit gateway
bearer credential. Claude's URL is the server root (the CLI appends `/v1/messages`),
while the Responses URL includes `/v1`. A Responses endpoint is not accepted as
an Anthropic endpoint. Claude gateway bindings require a client key reference so
a saved native subscription is not forwarded by accident.
Explicit Codex endpoint bindings use `requires_openai_auth:false` and only the
declared client key, not a copied native login. For an existing mixed
official-subscription metabridge deployment that requires native authentication
forwarding, retain the native binding and its independently maintained Codex
configuration; do not register that setup as a generic API-key binding.

An active Session retains its captured endpoint/binding references, including
process restoration. The current registry is considered only when resolving a
fresh Session. Continuing an old Session after a binding change does not adopt
that change. Stop/replace only through the existing separately authorized
Session lifecycle. There is no shared-daemon restart or default-user-config edit.
Credential file contents are resolved privately at launch; normal read models
and binding previews contain references only. Real provider behavior is not
established by deterministic launch tests.

## Bridge Provider editor

`POST /api/models/provider` requires the selected `moduleId`, Provider-view
`revision`, `requestId`, `exclusiveWriter:true`, and either:

* `{operation:"save",provider:{id?,name,via,baseUrl,prefix,enabled,apiKey?}}`
* `{operation:"remove",id}`

The module must explicitly delegate configuration maintenance. The user must
exclude other file writers for this operation; byte checks plus atomic rename
are **not** a cross-process conditional-write protocol. Unknown outcomes must
be read back, not blindly resubmitted. Multi-file additions may leave a private
unreferenced Provider file if the root reference write is unconfirmed. It is
retained, not automatically deleted. An inline removal retains the complete
Provider in a private sibling file before unlinking it.

Provider behavior retained from the existing editor: official/subscription,
implicit-policy and unsupported/shared routes are read-only; preserve address
spelling, unrelated fields, explicit namespaces and web-search references.
No last-enabled-backend removal. Changing destination requires a newly supplied
client key. Keys entered through Web use password inputs, are cleared after
submission and are never projected in results. Save is not reload/application.

CPA upstream configuration is **not** edited through this bridge interface.
For v8.0.12, use the constrained native configuration method in the component
manual. Yui does not promise conditional HTTP writes where none were verified.

## Observation reads and explicit refresh

* `GET /api/models/catalog?resourceId=ENDPOINT&cursor=0`
* `GET /api/models/quota?resourceId=CPA&source=factory` (or `command-code`)
* `GET /api/models/status?resourceId=MODULE`
* `POST /api/models/refresh` with `{revision:REGISTRY_REVISION,kind,resourceId,source?}`

Kinds are `catalog`, `quota`, `status`. For catalog the source is the exact
endpoint and only `/models` relative to its API root is read. This is the
endpoint-reported list, not proof that all upstreams are healthy. There is no
implicit `/healthz`, inference, OAuth or consumption of a usage queue.

Status refresh reads an explicitly referenced owned local configuration file
and reports its digest with runtime `unknown`: configuration availability is
not service readiness. Service-manager/process observations belong to the
lifecycle integration, not a guessed port probe.

Quota refresh is enabled only by separately declaring `factory-quota-v1`.
That names the explicitly installed extension's **wire contract**, not a claim
that every CPA v8.0.12 installation has the plugin. Its routes are
`/v0/management/plugins/factory-quota/accounts` and `/command-code`.
No installed extension artifact/version was independently verified here. The
adapter is fixture-validated against that documented contract only; absent or
incompatible extensions remain unsupported/failed. Do not probe a real account
to discover compatibility without separate authorization.

Observations report `source`, `accountScope`, `unit`, latest `attemptedAt`,
last successful `observedAt`, `status`, `error`, `stale` and items. Failure keeps
the last successful items/time, marks stale and records the recent failure.
Partial account failures retain each failed account's prior values and
`observedAt`, with per-item `stale:true`; successful accounts may advance.
Unknown numeric fields stay null, never zero. Different quota units are not
added. Account identifiers are digested; balances retain their explicit detail
kinds (USD or separate credit pools). Ordinary reads do not request refresh.
The bounded caches are Controller-local and expire after restart; new resource
revisions cannot reuse another destination's observations.

## Storage transition

The centralized 1.23 → 1.24 transition archives the old config bytes and splits
the old bridge/CPA references. It does not read files, migrate upstream formats,
contact services, create bindings, switch an Agent or delegate maintenance.
Existing historical Session snapshots remain absent of endpoint overrides.
Fresh Sessions may capture reference-only `modelEndpoint` snapshots; old
Sessions retain their original native behavior. There is one writable registry,
not old/new dual configuration readers.

Git update, service-manager start/stop and composition with the standalone
configuration tool are the next integration WorkItem's committed scope. Their
absence from this service is not a statement that those features are permanently
unsupported. No update/service operation is simulated as successful here.
