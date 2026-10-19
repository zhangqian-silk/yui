# Caller identity, discovery and authorization

Yui is a single-user local control plane, not a security boundary against another
process that can modify the same user's files. A provider thread ID is a location
hint, not proof that Yui manages that thread. Ordinary unmanaged Agents share the
existing public-user CLI surface; they do not need an Operator registration,
Manifest or per-thread Grant. This changes classification, not the user's
authorization for any external effect.

## Responsibilities and sources

| Question | Authoritative implementation | What it does not establish |
| --- | --- | --- |
| Which command templates should this audience see? | `cli/commandCatalog.ts`, projected by `commandDiscovery.ts` into help and completion | Current authentication, target authorization or a Grant |
| Is this native identity ordinary, current or historical? | `runtime/sessionCaller.ts`, existing RoleSessionSet `sessions` and `history`; `storage/nativeSessionLookup.ts` | A new identity register or cross-Home authentication |
| May this Session act now? | `runtime/managedCaller.ts`, current Role binding, revocation and captured effective launch | Active Run occupancy is not required for ordinary Leader management |
| Which Task, Assignment, Project and records may it use? | `task/taskAuthority.ts`, context read authorization and command domain owners | A general “query is safe” rule |
| Which capability template and exact target are available? | `kernel/builtinCapabilities.ts`, `CapabilityRegistry`, domain `AccessAssessment` | Provider availability or a reusable authorization token |
| May a Controller operation execute? | `CallAuthority`, `jobControl` and the corresponding service | CLI help is not an access-control layer |
| May it access an additional resource or irreversible effect? | `CapabilityGrant`, `grant/taskAuthorization.ts`, resource/plugin/release consumers | Task activation does not authorize arbitrary resources |

The full command inventory is generated from the catalog, not maintained as a
second per-command permissions table: use `yui --json help` and scoped
`yui --json help task`, or traverse `describeCommandTree(discoveryCommandTree(env))`
in offline tooling. Complete role hints retain an offline template even without
a running Home; that is not authentication. Native-ID-only callers are resolved
from read-only local storage for help/completion; if that read fails the CLI shows
the restricted `unbound` template. No Controller or provider is started for that
observation. Execution resolves the original caller again and performs the
applicable domain checks.

## Caller matrix

| Caller | Default rights | Boundaries / escalation |
| --- | --- | --- |
| User terminal; unknown valid `CODEX_THREAD_ID` with no Yui hints | Existing public catalog: public Project/config/Task information, Draft creation, user participation and existing public maintenance entry points | No managed inbox, Job or Grant issuer identity; no automatic discussion/development. Only perform effects the user actually requested |
| Current Operator (including native-ID-only Desktop) | Existing global management and Task supervision; explicit Grant issuance/revocation | Current native binding and operation-specific resource/effect checks |
| Custom GlobalRole | Its visible read/self-context and configured scoped operations | Not an Operator merely because global; Home mutations and Task-management rights are not inherited from Operator |
| Task Leader | Own Task management and readable context; delivery work within captured writable Projects | Planning Sessions do not gain delivery authority from Task activation. New resource/effect authority uses an original user/Operator source or InputRequest |
| Worker / Reviewer, including native-ID-only | Current Assignment's selected context, workspace and operations | Frozen references, Assignment/Review identity and Project bounds; ask Leader via the existing Assignment Message for missing authority |
| Partial, conflicting or unknown **Yui** identity; historical/replaced/stopped Session | No public fallback | Use original Home and current Session; preserve original input and receipts. Explicitly scoped historical self-diagnostics remain available through their existing entry |
| Revoked Session | No revived mutation/inbox authority | Command-time revocation checks remain authoritative even if an offline template is visible |

Public is not synonymous with read-only: terminal users already have maintenance
and participation commands. This change intentionally gives ordinary Agents that
same product surface, not all internal commands. Conversely, a read may expose
private Assignment context, consume a resource Grant or acquire a provider:
never derive permission from command spelling or the `query` effect alone.

Draft creation copies the configured Leader Agent, model, permissions and profile
through the existing role-copy path. It saves facts without creating a Run,
Session or execution workspace. `discuss` and `develop` remain separate explicit
submission/activation paths.

## Discovery's three states

| Observation | Meaning | Execution behavior |
| --- | --- | --- |
| `hidden` | Caller cannot discover/apply for that capability/target | Omitted/unavailable; cannot be enabled by typing a hidden help command |
| `requestable` | Existing request route can supply the missing exact authority | Includes action, Task, parameter bounds and `leader-message`, `leader-input` or `operator` route; call is denied until authority exists |
| `authorized` | Current caller and exact parameters satisfy the assessed boundary | Call rechecks current state; revocation, expiry, consumed uses or provider failure can still prevent execution |
| No `access` field | Template or domain without an exact assessment | Not a fourth persisted state and not a claim of authorization; supply target input where supported and obey domain checks |

Capability search/commands/panels reuse the same registry and assessments.
Describe with exact input is an observation only: it does not acquire a provider
or consume a Grant. Hidden/denied, invalid input and provider unavailability remain
distinct. Static help/completion cannot promise any of these exact target states.

## Grant and delegation matrix

| Capability / effect | Default or reusable authority | Required exact checks |
| --- | --- | --- |
| Public information | Existing public command path, no Grant | Local Home/storage contract and domain visibility |
| Task / Assignment reads and management | Current matching Role; permission categories such as `task:read`, `task:manage` are reused | Task/Assignment/Review identity, record readability, lifecycle, planning/delivery |
| Job operations | Current managed caller, no repeated per-command approval inside authorized work | Controller reauthentication, owner, workspace, project, head and Assignment |
| Local resource read/write | Existing resource registration plus exact Grant when required | Task, canonical resource path/id, read vs write, parameter bounds, expiry/use count |
| Plugin management vs execution | Authorized management is separate from executing author code | Adopted environment, plugin/package digest, phase and exact `plugin.execute` Grant |
| Release / other high-impact effects | Explicit user authority; existing Operator or source-authorized delivery-Leader Grant | Project/repository/commit, action, package/version/registry where applicable, irreversible ceiling and original operation receipts |

Operator issuance uses its current managed Session. Delivery-Leader issuance must
cite an original user/Operator Message and exact quoted purpose, stays inside the
Task and selected Projects, requires finite uses/expiry and action-specific bounds.
A Role report is not user authority. Worker/Reviewer requests go to Leader; a
genuinely missing user decision uses InputRequest. A response is not itself a
Grant. Consumption, revocation and idempotent retries remain with existing
consumers; discovery does not replenish uses or turn unknown effects into retries.
No extra approval is added for already-authorized normal role work.

## Identity limits and recovery

The canonical lookup includes both active and historical registrations, including
inactive Agents in a Session set. The active runtime inventory remains optimized
for scheduling; it is deliberately not used to prove absence of managed history.
Unbinding moves a stopped Session into the existing history rather than deleting
its identity. Role removal retains stopped Session sets while deleting the Role
and active runtime projection; those records do not grant authority without a
current Role binding. History erased by an earlier version cannot be reconstructed.
Storage 1.13 → 1.14 removes only the global Session table's Role foreign key so
that its existing identity evidence may outlive Role removal; payload bytes are
preserved. Existing Homes require an explicit supported upgrade, never an
implicit read-time migration. There is no new authorization state, global thread
registry or cross-Home scan.

An unknown provider ID in Home B contains no evidence that it was managed in Home
A. Treating every such ID as invalid would again reject ordinary Agent sessions.
Therefore retain the intended Home/Manifest/Yui hints for managed work; with those
hints, a missing registration fails closed. Do not clear hints, forge a Role,
borrow a parent's transport identity or change Home to obtain public authority.
Ambiguous registration also fails closed. Native-ID-only help on broken storage
remains a limited template, while execution reports the original storage/identity
failure. Complete launch hints can still show a role's static help on a broken
Home; they cannot authorize reads or effects.

## Read-only Web templates

Open **Settings → Command permissions** (`/settings/permissions`) to compare
CLI discovery for ordinary terminals/unmanaged sessions, Operator, GlobalRole,
Task Leader, Worker and Reviewer. Configured GlobalRole names are selectable;
they use the existing global discovery audience, not a new role impersonation
path. Search, category/role filters and 30-row pages keep the view bounded.
Expand a command for its audience-filtered usage and scope explanation.

“Visible” means the existing `discoveryCommandTree` retains the executable
command; “Hidden” means it does not. Neither is an exact authorization
assessment. Worker and Reviewer can share a template while having different
Assignment/Review and workspace constraints. Planning/delivery, lifecycle,
revocation and resource/Grant checks remain in their existing execution owners.
The directory cannot express every domain condition and this page does not
attempt to infer them from command names.

The adjacent **Built-in capability contracts** view projects
`BUILTIN_CAPABILITIES`, the same descriptors registered in `CapabilityRegistry`,
including required permission categories, input names, declared effect and
semantic source. It does not invent a CLI-to-capability mapping or interpret
those categories as role grants. Task-local plugin descriptors are excluded.
Exact `hidden` / `requestable` / `authorized` observations still require the
existing authenticated discovery path and target input; this page performs no
such assessment and emits no `access` field.

The `/api/permissions` metadata, `/commands`, `/command` and `/capabilities`
routes are GET-only, use the existing Web authentication, Host/Origin and page
token protection, and reject target/identity arguments. The only Store read is
the configured global role list, projected to names. No Session, Task contents,
Grant, plugin instance or Provider is read/acquired, and no operation is invoked.
New catalog commands enter automatically; do not maintain a Web ACL.
`web-permissions.test.js` checks full projection coverage, option filtering,
private-read/write exclusion and the HTTP read-only boundary.

## Verification and maintenance

`cli-authority.test.js` exercises isolated launcher-backed public reads, Draft
creation/config inheritance, native-only managed callers, historical denial,
maintenance and cross-Task fences. `agent-inbox.test.js` covers current/historical
and ambiguous native lookup plus Assignment/Reviewer/revocation boundaries.
`caller-discovery.test.js` covers projection and transient three-state behavior;
`leader-authorization.test.js` covers real registry/resource/Grant issuance,
consumption, revocation and surfaces. Controller Job checks are tested independently
of CLI discovery. Run the required `npm test` gate; no real model or production
Home is needed for these contracts.

When adding a command, extend the catalog for presentation and the actual domain
owner for authorization; do not invent a second CLI allowlist. When adding a
capability, reuse the registry permission category and its resource owner's
assessment/consumption checks. Extend a category only when the new operation
really has the same data and effect boundary.
