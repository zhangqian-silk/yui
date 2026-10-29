<p align="right"><strong>English</strong> | <a href="./release-workflow.zh-CN.md">简体中文</a></p>

# Authorized release operations

A release workflow is an explicitly chosen, authorized sequence of
external release effects — pull requests, CI confirmation, merges, version
tags, npm publishes, fresh-install smoke tests, CLI updates, Controller
replacements, Project migrations, and post-verification. It is a specialized
external-effect facility, not Yui's Task planning or Agent execution model.
The Agent selects a predeclared plan, and the facility drives that plan
from durable state: every transition is persisted before the next external
call, so a crash, timeout, or revoked grant never leaves the release guessing.

Two task-level record families back it:

- **CapabilityGrant** (`capability-grant-N`) — the authority. A named granter
  scopes a grant to actions, parameter bounds, an expiry, a use count, and an
  irreversibility ceiling.
- **ReleaseWorkflow** (`release-workflow-N`) — the plan and its progress: an
  exact source (repository + pinned commit, optionally an artifact), an
  immutable ordered step plan, and one persisted record per step.

The engine (`src/release/releaseWorkflowEngine.ts`) owns persisted transitions and the workflow lock; the
`yui task workflow` and `yui task grant` commands drive it. Every external
system sits behind `ReleaseWorkflowPorts`
(`src/release/releaseWorkflowPorts.ts`). Disposable SQLite and deterministic
external ports exercise recovery without real GitHub, npm, git, Controller,
or model effects.

## Yui's default release boundary

For development of Yui itself, the repository's `AGENTS.md` owns the release policy:
do not release a version by default. Development, tests, acceptance, PR creation
and merge do not include changing version numbers, creating release tags or
GitHub Releases, or publishing to npm. Each external effect still requires the
Task's actual authorization. A workflow containing only PR, CI and merge steps
is a valid delivery plan; its `ReleaseWorkflow` name does not authorize any
package release, global CLI update or Controller replacement.

When the user explicitly asks to release a new version, select minor for new
features or incompatible interface/behavior changes, and patch for compatible
fixes. Incompatibility does not require major or another version-level approval;
major is used only when explicitly requested by the user.

This is Yui's project-specific numbering convention, not the usual SemVer
backward-compatibility meaning. A minor release can be incompatible. Users must
read its compatibility and migration notes before upgrading; release notes must
identify affected contracts and how to move to the new interfaces, not label
incompatible behavior as compatible. Do not add historical compatibility mechanisms
merely to avoid a version decision. Package versions remain distinct from protocol
and persistent-storage contracts: their compatibility checks and required migrations
are unchanged, and the storage rules below do not authorize a package release.

### 2.19.0 compatibility and migration notes

This minor adds message backlog and blocked-delivery monitoring with Operator
alerts (PR #492). Observations distinguish live work, paused execution and bounded
retry from stalled delivery, retain original evidence, and deduplicate alerts
across Controller restarts. Alerts include evidence-matched management guidance:
inspect the exact input and execution first, distinguish rejected retry from
unknown-result resolution, and require scoped stop proof or explicit replacement
authority where applicable. Monitoring never retries, stops or replaces execution
automatically; an alert is not recovery authority or proof of a unique root cause.

Storage remains **1.24**, and Controller/Host protocols remain v1. Existing
messages and events are preserved; this release adds no storage migration.
Older supported Homes still use the centralized contiguous migration chain.
With separate update authority, the Operator verifies the published artifact
then runs `yui update --version 2.19.0`. Compatible live Sessions are retained;
publishing alone does not update the installed program or recover other Tasks.
Exact-merge Core CI and the same tarball's fresh-install platform/Node matrix
remain release gates. These checks do not establish real-model behavior.

### 2.18.0 compatibility and migration notes

This minor includes the already-merged independent Jobs workspace and global
Shell script Jobs (PR #490), plus Controller reliability and diagnostics.
Exact Session stop/replacement no longer waits for unrelated global scheduling
to drain. Stop proof, single-writer ownership and unknown-input replay fences
remain required. Session health distinguishes historical failures from the
current authority; conclusively rejected obsolete inputs can be retired without
erasing their original evidence.

Task-scoped lazy read caches, indexed observation queries and persistence
timings reduce projection work and separate request/worker/database costs.
With the default persistence worker, periodic maintenance lock waits no longer
block the socket thread; idle Global recovery and settled retry checks are
read-only. Actual admission and other business writes may still contend.
Bounded, redacted asynchronous diagnostics retain incident evidence in
`runtime/controller-diagnostics.jsonl` and two rotated files. These changes
address reproduced mechanisms, not a proven unique cause of every historical
timeout. See [managed runtime](managed-turn-and-session-runtime.md).

Storage advances from **1.22 through 1.23 to 1.24**: 1.23 declares revisioned
global Shell script definitions and Run snapshots; 1.24 adds Task read-revision
tokens and triggers without rewriting historical payloads. A production 1.21
Home first applies the existing 1.22 Role/Profile availability transition.
Use the centralized contiguous same-major migration, never manual schema edits.
Controller RPC and Host control/event protocols remain v1. Compatible live
Hosts/Sessions are retained, not hot-upgraded; unreported Host capabilities and
unknown results remain explicit.

With separate production authority, the Operator uses
`yui update --version 2.18.0` after verifying the published artifact. Refresh a
consistent maintenance backup and capture the current executable/Controller
identity before migration. An earlier online DB snapshot alone is not a complete
rollback point and cannot overwrite subsequently accepted input. Do not open a
1.24 Home with an older binary; rollback requires the matching pre-upgrade
program and consistent Home backup, with intervening effects reconciled.

Release gates require exact-merge-commit Core CI and the same runtime archive's
fresh-install platform/Node matrix before npm publication. Local deterministic
tests and prior smoke evidence do not replace those gates or prove real-model
behavior. Publication does not itself update a production Home or resolve
another Task's execution.

### 2.17.0 compatibility and migration notes

This minor adds persistent Role/Profile enable and disable controls in CLI and
Web settings. Use `yui config role enable|disable`, `yui config profile
enable|disable`, and `yui task role enable|disable` with the relevant identity.
Disabled templates cannot be selected for new bindings; existing Task Role
copies remain independent. Disabling a Role prevents new execution and pauses
eligible pending work; it does not kill a running Turn, discard pending input,
block exact terminal recording or erase inspection/claim/acknowledgement access.
Re-enabling resumes eligible work under its existing authority and retry budgets,
without replaying accepted or unknown input.

Storage advances from **1.21 to 1.22** through the centralized additive migration
for optional `enabled` fields. Existing records without the field remain enabled;
their historical payloads are preserved. With separate upgrade authorization,
use `yui update --version 2.17.0`; the updater owns preflight, backup, migration
and Controller handover. Do not open the upgraded Home with an older binary.

The release also includes the merged Draft planning Session replacement repair
and stronger behavioral-constraint/real-path review handoffs. Validation uses
deterministic tests and the exact-tarball fresh-install matrix, not real-model
behavior. Publishing does not update the global CLI, migrate a production Home,
restart its Controller or deploy a production Web listener.

### 2.16.0 compatibility and migration notes

This minor refreshes the Web workbench (PR #484). One global navigation rail
(Workbench / Models / Settings) is shared by the workbench and management pages,
and the task sidebar can be collapsed. Dialogs, menus, presses and column layout
changes use one motion source; reduced-motion preferences, narrow layouts and
hidden documents get instant updates. The 「結」 brand glyph is replaced by a
vector capital-Y mark drawn from the active theme's tokens, and each theme has a
matching SVG favicon that follows theme switches.

These are presentation changes only. Web APIs, sign-in sessions, `--auth-file`,
CLI commands and Controller/Host protocols are unchanged. Scripts or browser
automation that matched the old brand glyph or previous navigation markup must
use the current page structure. Storage remains **1.21**; there is no migration.

With separate upgrade authorization, use `yui update --version 2.16.0`; the
updater owns preflight, backup and Controller handover. A running Web listener
serves the new assets after it is restarted. Release gates reuse exact-commit
Core CI and the existing fresh-install matrix (Linux x64, macOS x64/arm64,
Node 20/22/24/26). Publishing does not update the global CLI, migrate a
production Home, restart its Controller or deploy a production Web listener.

### 2.15.0 compatibility and migration notes

This minor replaces the browser's HTTP Basic prompt with a standalone English/
Chinese sign-in page, inline errors and safe return to the requested page.
The credential file format and `--auth-file` stay unchanged, but HTTP Basic
`Authorization` headers are no longer accepted. Scripts must obtain a session
through same-origin JSON `POST /auth/login` and retain its cookie; status now
reports `local`/`password`, not `local`/`basic`. See [Web access](web-access.md).

Sessions are listener-local and in memory, with an 8-hour inactivity limit and
24-hour absolute limit. There is no sign-out button; the backend logout endpoint
and session revocation remain. Every terminal relay boundary checks the session.
Stopping or restarting Web ends all sessions. HTTP remains unencrypted and is
for trusted networks only; this is not multi-user authentication or public TLS
hosting.

This release also includes timezone-aligned default Project sync (PR #481):
new defaults use `0 */6 * * *` with a captured explicit timezone. Storage moves
from **1.20 to 1.21** through the centralized migration. Only provably unedited
revision-1 built-in defaults are converted, with original bytes retained;
higher revisions and customized/disabled plans are preserved. See
[Project sync](project-sync.md) for explicit schedule updates. Earlier supported
Homes use the existing contiguous same-major migration chain.

With separate upgrade authorization, use `yui update --version 2.15.0`; the
updater owns backup, migration and Controller handover. Do not edit storage
manually or open upgraded Homes with an older binary. Minor numbering is not
a blanket compatibility promise.

Release gates reuse exact-commit Core CI and install the same checksummed
runtime archive on Linux x64 and macOS x64/arm64 with Node 20/22/24/26 before
npm publication. These are isolated deterministic checks, not real-model
validation. Publishing does not update the global CLI, migrate a production
Home, restart its Controller or deploy a production Web listener.

### 2.14.0 compatibility and migration notes

The `v2.13.0` tag is retained as failed release evidence: its publication gates
failed before npm publication. This replacement minor retains the feature below
and fixes the package-smoke handover observation: one Controller snapshot and a
bounded 60-second multi-turn wait, preserving the input, Host identity, terminal
and no-replay assertions. Production runtime timeouts and release gates are
unchanged; the full fresh-install matrix must pass before publication.

This minor adds Settings → Permissions: a read-only command-by-role discovery
matrix and built-in capability contracts, with bounded search, filters and
details. The view derives from the existing command catalog, discovery projection
and capability registry; it is not a second ACL or an authorization engine.

Role-template visibility is not an exact invocation's authorization result.
Task, Project, Assignment, lifecycle, resource and Grant boundaries still apply
at execution time. Viewing a role does not impersonate it, execute a command,
issue or revoke authorization, or consume the viewed operation's Grant.
The new GET endpoints retain the existing Web access and request protections.
Existing CLI authorization, discovery and default permissions are unchanged.
See [authorization](authorization.md).

Storage remains **1.20**; this feature adds no storage migration or protocol
change. Earlier supported Homes still use the existing contiguous same-major
migration chain. With separate update authorization, use
`yui update --version 2.14.0`; the updater owns preflight, backup, migration when
needed, and Controller handover. Do not open upgraded Homes with an older binary
or edit storage manually. Minor numbering is not a general compatibility promise.

Release gates require exact-commit Core CI and fresh installation of the same
runtime tarball on Linux x64 and macOS x64/arm64 with Node 20/22/24/26.
These are deterministic isolated checks, not real-model validation. Publication
does not update a global CLI, migrate a production Home, replace its Controller,
or deploy or start a production Web listener.

### 2.12.0 compatibility and migration notes

This minor completes the scoped Job platform: explicit business results and fixed
artifacts, Schedule targets and service authorization, controlled Project refresh,
Task delegation, optional Agent execution, and shared Task/global Web management.
The Task Jobs tab and Settings → Jobs & schedules expose exact historical Runs,
their immutable configuration, execution evidence and authorized artifact previews.

Consumers must distinguish definition ownership, execution target, process/native
terminal evidence and the explicit `businessResult`; delivery or exit alone is
not business success. Branch on the executor kind instead of assuming every Run
is a shell process. Fixed artifact references retain their exact source identity
and scope; a readable preview is not execution authority. Task delegation preserves
immutable provenance and does not implicitly activate a Draft Task. Agent Session
replacement preserves Run requirements/results without replaying input; unknown
delivery or unproven old writers still block replacement.
See [Jobs and Runs](job-runs.md).

Schedules retain their existing admission path, not a second execution state.
Service authorization is explicit and does not inherit an old Session's authority
or authorize Agent execution. Controlled `project.refresh` binds the current
managed Project target and uses the existing clean, verified fast-forward path;
publication does not enable synchronization for any registered Project.
See [Schedules](schedules.md).

Storage advances from **1.14 to 1.20** through the centralized contiguous chain:
**1.15** business results; **1.16** Schedule targets/service authorization;
**1.17** fixed Run artifacts; **1.18** controlled Project refresh;
**1.19** Task delegation/provenance; **1.20** Agent Run/Session evidence.
Supported **1.0–1.19** Homes use the declared same-major migrations, preserving
historical evidence rather than inventing results or grants. With separate update
authorization, use `yui update --version 2.12.0`; the updater owns preflight,
backup, migration and Controller handover. Do not open upgraded Homes with an
older binary or edit storage manually. Minor numbering is not a SemVer
backward-compatibility promise.

Release gates require exact-commit Core CI and fresh installation of the same
runtime tarball on Linux x64 and macOS x64/arm64 with Node 20/22/24/26 before
publication. These are deterministic isolated checks, not real-model validation.
Publishing does not update the global CLI, migrate a production Home, replace
its Controller or run a real Project synchronization.

### 2.11.0 compatibility and migration notes

This minor lets ordinary, unmanaged native Agent conversations use the same
public operations as a local terminal, including general information reads and
Draft Task creation. A native thread ID alone is a lookup hint, not proof of a
managed Role. Draft creation preserves configured Agent, model, permissions and
Profile inheritance; it does not start discussion or development.

Current ID-only managed Desktop conversations retain their Role, Task,
Assignment and Grant checks. Known historical, stopped, conflicting or
incompletely specified managed identities are refused, never downgraded to
public authority. Unbinding a Session or deleting a Role retains stopped
identity history. Help and completion share caller discovery; offline Role
templates are guidance, not authorization. Exact capability assessment and
execution continue to use current resource and Grant boundaries.
See the [authorization responsibility and permission matrices](authorization.md).

Identity lookup is local to the selected Home. A bare ID known only in another
Home, or whose history was already deleted by an older version, cannot be
distinguished from an ordinary thread without Yui hints. Managed conversations
must retain the correct Home/Manifest; this release neither scans other Homes
nor reconstructs deleted history.

Storage advances from **1.13 to 1.14** through an explicit centralized migration
that allows global Session history to survive Role deletion while preserving
existing payloads. Supported **1.0–1.13** Homes use the contiguous same-major
upgrade path. With separate update authorization, use
`yui update --version 2.11.0`; the updater owns preflight, backup, migration and
Controller handover. Do not open upgraded Homes with an older binary or edit
storage manually. Package minor numbering is not a compatibility promise.

Release gates reuse exact-commit Core CI and exercise one runtime tarball on
Linux x64 and macOS x64/arm64 with Node 20/22/24/26 before npm publication.
These are deterministic, isolated checks, not real-model validation. Publication
does not update a global CLI, migrate a production Home, replace a production
Session or start a Web listener.

### 2.10.0 compatibility and migration notes

This stable minor includes exact-turn inbox handling and successor recovery
(Task131 / PR #463 and Task134 / PR #464), plus authenticated trusted-LAN Web
access and current Operator lifecycle controls (Task135 / PR #465).
It also includes explicit Task Project delivery scope and safe ordinary archive
(PR #462), and deployment-specific GitLab publication URLs (PR #461).

Web still defaults to loopback. Explicit private/wildcard binding requires
`--auth-file <absolute-path>` with an owner-only password file; the browser
username is `yui`. Authentication precedes workbench content, APIs and Terminal,
while sandbox previews retain their narrower, listener-scoped read tickets.
HTTP remains unencrypted: use a trusted network, not a public deployment.
Current Operator starts, `--detach`, and `--json` return Controller-owned
receipts; inspect with `yui web --status` and stop with `yui web --stop`.
Credential rotation requires stop/start, and Controller recovery does not
automatically reopen Web. See [controlled Web access](web-access.md).

Inbox consumers should use the current/history views and exact returned
identities. Missing acknowledgement is not proof that work was never executed.
A successor inspects original input and prior effects before settling a retained
claim; it does not replay the input or borrow another Session's authority.
Exact terminal handling checks remain bounded. Project delivery exclusions
require original scoped authorization and do not erase bindings or prove a merge.
See [CLI information contracts](cli-information-contract.md) and
[Project delivery scope](project-delivery-scope.md).

Storage advances from **1.11 to 1.13** through the centralized transitions:
**1.12** declares Project delivery decisions; **1.13** declares exact inbox
attempt/target identities, Global input retirement and terminal handling checks.
Historical messages, claims and acceptance evidence are preserved without
inventing old Turn ownership or ACKs. Supported **1.0–1.12** Homes use the
existing same-major update path. With separate update authorization, use
`yui update --version 2.10.0`; the updater owns preflight, backup, migration and
Controller handover. Do not open upgraded Homes with an older binary or edit
storage manually. Package minor numbering is not a blanket compatibility promise.

Release gates reuse exact-commit Core CI and test one runtime tarball on
Linux x64 and macOS x64/arm64 with Node 20/22/24/26 before npm publication.
These are deterministic and isolated runtime checks, not real-model validation.
Publishing does not update any global CLI, migrate a production Home, replace
an Agent Session or start a production Web listener.

### 2.9.0 compatibility and migration notes

This stable minor includes scoped Job definitions and exact execution Runs,
persistent Schedules, controlled Project refresh, and their Task/settings
management UI. It also includes Task124's activation-source and bounded
temporal-context changes (PR #458) and Task130's tool-neutral publication
verification (PR #459).

There are deliberate interface changes. Job definitions and Runs have distinct
identities; existing `job start/get/cancel/acknowledge` continue to address
one-shot Task executions, while `job define/run/runs/run-get` manage the new
definition/Run model. Schedules reference scoped Jobs and do not replace Run
results. `task brief update` now requires the `writeGuard` from `task brief show`
as `--if-current`; reread and reconcile after a stale-guard rejection. Activation
requests require explicit source provenance for Leaders. Context consumers must
respect bounded pages, frozen references and Home/Task-bound event continuations.
See [Jobs](job-runs.md), [Schedules](schedules.md) and
[CLI information contracts](cli-information-contract.md).

Leaders may verify a PR/MR through any authorized CLI/API and record exact
structured evidence with `task publication verify --observation`. Built-in
gh/glab adapters remain optional. `publication upsert --verified` can no longer
assert verification without evidence; use the verification entry point instead.
Existing historical evidence is retained. Candidate/object binding, immutable
history, observation freshness and ordinary archive safety remain enforced;
tool output interpretation remains the authorized Leader's responsibility.

Storage advances from **1.8 to 1.11** through the centralized contiguous
migrations: **1.9** adds Job definitions/global Runs and preserves each old
Task execution's identity and original payload; **1.10** adds Schedules;
**1.11** declares activation-source event provenance without inventing historical
sources or rewriting frozen digests. Supported **1.0–1.10** Homes use the
existing same-major update path. With update authorization, run
`yui update --version 2.9.0`; the updater owns preflight, backup, migration and
Controller handover. Do not open an upgraded Home with an older binary or edit
storage manually. Missing historical provenance remains an explicit diagnostic.

Release validation uses exact-commit Core CI and the existing fresh-install
matrix for the same runtime tarball on Linux x64, macOS x64/arm64 and Node
20/22/24/26, with checksums and npm provenance. This is not real-model or company
API validation. Package publication does not itself update any global CLI,
Home or Controller; that is a separately authorized Operator operation.

### 2.8.1 compatibility and migration notes

This patch fixes maintenance startup for an existing Operator conversation
that supplies only its native identity, including Codex Desktop. `doctor`,
`upgrade` and `update` authenticate against the supported Home before requiring
current storage, so an older Home can reach the updater's read-only preflight.
Structured preflight failures retain their original diagnosis and recovery
guidance. Ordinary commands still require current storage and current authority.

Storage remains **1.8**. The existing contiguous **1.0 through 1.8** migration
chain, backup, maintenance lock and exact Controller handover are unchanged.
Use `yui update --version 2.8.1`; no manual intermediate upgrade or replacement
native Session is required for supported Homes. Pre-1.0 / 0.x Home formats are
outside this release's supported migration contract; no historical authorization
exception or legacy conversion is introduced.

Verification includes an isolated published 2.7.1 CLI with storage 1.7 and a
live Controller/Host: one native-only update preserves the original Host and
native conversation, migrates storage and processes new input afterward.
Only the external Provider is simulated. Publishing does not update a user's
global CLI, Home or production Controller.

### 2.8.0 compatibility and migration notes

This minor adds native metabridge model management: provider configuration,
cached model catalogs, and manual subscription-quota observations through the
supported CPA extensions. Models and Settings share navigation, canonical
section URLs, browser history, locale and theme handling. Content-versioned
static assets improve repeat navigation; HTML and account APIs remain uncached.
The release also includes the chat-style Conversation dock, bounded runtime
diagnostics, native caller/inbox corrections, and review-context improvements
merged since 2.7.1.

Storage advances from **1.7 to 1.8** through the centralized additive transition
for optional, non-secret model connection references. Existing Homes remain
unconfigured. A separately authorized upgrade can use
`yui update --version 2.8.0`; the updater owns preflight, backup, migration and
Controller replacement. Do not open an upgraded Home with an older binary or
edit its storage manually.

metabridge and CPA remain separately operated services; installing Yui does not
start, reload or adopt them. Configure their connection references explicitly.
Saving provider configuration does not prove it is applied or validate inference.
CPA still owns its upstream OAuth/account pool. Quota refresh may query billing
services but does not renew credentials, reset quota or run inference. Unknown,
partial and stale observations remain distinct.

Release evidence is deterministic core CI and isolated, fresh-install package
smoke on supported Linux/macOS and Node versions, not real-model validation.
Publishing this package alone does not authorize a global CLI update, a Home
migration, or any production-service restart.

### 2.7.1 compatibility and migration notes

This release delivers the intended 2.7 feature line. The `v2.7.0` attempt stopped
before npm publication because package smoke compared a macOS temporary path
with its physical alias. The smoke now uses the physical package root; its
assertions and the cross-platform release gate remain intact.

This minor adds own-scope Agent inbox discovery, full reads, claims and
acknowledgements for GlobalRoles and Task Leaders, Workers and Reviewers.
Use `yui inbox list/show/claim/ack` from the current managed Session; reads do
not consume input, claims do not grant additional authority, and an
acknowledgement is not execution-result acceptance. Durable receipts arbitrate
with automatic delivery without replaying unknown native input.

Storage advances from **1.6 to 1.7** through the centralized additive migration
for Message and Leader-wake inbox receipts. Use `yui update --version 2.7.1`
for an exact upgrade; the updater preflights the target Home, takes a backup
when migration is required, and coordinates the exact Controller replacement.
Do not edit stored records manually. Task, Session and original input history
remain authoritative.

Runtime and Role instructions now use stable current source paths and independent
integer `VERSION` files. Every managed turn checks `yui session skills --json`;
only unchanged full instructions still present in context may be reused.
Recovery, version changes and missing/uncertain context require full reload.
Configured Skills must supply `VERSION` beside `SKILL.md`.

Frozen packages remain historical audit, not a Session admission condition.
Valid pre-1.5 Sessions may resume without that evidence; no historical read,
native acceptance or input consumption is fabricated. Identity, scope, writer,
lifecycle, protocol/storage and unknown-input fences are unchanged. The Skill
loading change itself adds no storage migration.

This release also recovers Operator notification backlogs and Desktop-direct
terminal facts across Controller replacement, retaining exact input and Turn
identities. SQLite prefers the pinned modern N-API driver, with a bounded
compatibility fallback when that optional native candidate is unavailable;
this fixes the reproduced Node 24 native GC abort.

Deterministic core checks and isolated assembled/fresh-install package smoke
are the release evidence; they do not establish real-model behavior.
Publishing this package alone does not authorize a global CLI update, Home
migration or Controller replacement.

### 2.6.0 compatibility and migration notes

This minor includes Task111's paged current activity and parallel execution
summary. Task runtime lists can discover all current Roles, Runs, Reviews,
Jobs and open InputRequests beyond the compact samples; exact record details
remain on demand. `task context list --view current` selects current membership,
while the default `all` retains history. Refresh a changed collection instead
of reusing its stale pagination cursor.

Execution consumers must handle the additional derived `waiting-on-jobs`
status and `wait-for-jobs` action, and the parallel `activity` categories.
These are not Task lifecycle states or new scheduling authority. Waiting for
user input no longer hides concurrent work. Unknown outcomes remain unknown
and never authorize replay.

Compact native observations now return category totals and bounded Session
samples with `operationCount`/`backgroundCount`, not embedded child lists.
Consumers needing those rows must page `/api/tasks/<id>/activity`.
Coverage is explicitly partial: selected native Sessions and retained,
exactly fenced child observations, not a live process inventory. Native facts
may describe an AgentRun and must not be added to it as separate executors.

No storage migration is added; storage remains **1.6**. Existing acceptance
evidence uses deterministic tests and isolated browser fixtures, not real-model
validation. Publishing this package does not upgrade a global CLI, migrate a
Home or restart a Controller.

### 2.5.0 compatibility and migration notes

This minor includes Task110's notification and context-loading improvements.
Normal and recovery notifications share bounded facts, optional attributed
author summaries and exact action entries. A summary is not acceptance or
authority: relevant requirements, user messages and execution results must
still be read in full.

Session instructions name the required Skills explicitly. Reuse is conditional
on the complete same-version instructions remaining available in context;
first entry, changed instructions or missing/compacted content require loading
the exact Manifest and referenced files again. There is no persistent read
receipt, instruction cache or additional model call for summarization.

`task wake show` now focuses on relevant messages, results and referenced
evidence by default. Use `--history` for the broader fixed-window diagnostic
view and follow pagination when present. Consumers must not treat the focused
view as all history. Original records, exact older references, deduplication,
snapshot boundaries and unknown-input no-replay rules are preserved.

No storage migration is added; storage remains **1.6**. Deterministic tests and
package smoke do not prove real-model instruction reuse or compaction recovery.
Byte measurements are not token savings and can increase for a simple first
entry. Publishing this package does not upgrade a global CLI, migrate a Home
or restart a Controller.

### 2.4.0 compatibility and migration notes

This minor ships the unified Web Task/Operator conversations and same-thread
Codex terminal access, Task workbench, settings, text materials, pinned
Markdown/image previews, bounded search and exact selection references,
Task-owned HTTP previews, current-Session model/Slash controls, Skill browsing
and explicit bindings. Knowledge applicability, complete frozen Skill packages,
and sourced usage/cost evidence are included. Git 2.29+ compatibility and the
Task109 model-validation, terminal-reader isolation and unknown-send recovery
fixes are included; Task110's unmerged work is not part of this release.

Storage is now **1.6**. Use the supported centralized, contiguous same-major
upgrade path for older supported Homes; do not edit stored records manually.
Historical missing cost remains unknown. Old Skill provenance is not rebuilt
from today's files. The original 2.4 restoration restriction for missing packages
is superseded by the current Skill-loading contract above; preserve old history
without making that audit evidence a Session admission condition.
Current model adoption is connection-local and does not change future defaults;
exit the Host-owned native TUI before changing its model (closing a viewer only
detaches it). Unknown sends must be inspected by their original request ID,
not replayed from a fresh tab. These are explicit behavioral boundaries, not
a general backward-compatibility promise.

The [Task109 report](testing/web-coverage-final.md) records Linux browser and
real-model evidence with its original platform and sandbox limitations.
Official CI/package smoke is separate evidence, not macOS browser/live-model
coverage. Real-model checks remain opt-in. Publishing this package does not
upgrade the global CLI, migrate a user's Home or restart their Controller.

### 2.3.0 compatibility and migration notes

This minor release separates Task acceptance and verified remote delivery from
immutable Integration history and temporary workspace cleanup. Integration
history remains readable after its workspace is released.

Automation that previously treated leftover workspaces as an unconditional
archive blocker must now inspect business settlement, exact delivery and runtime
quiescence separately from physical cleanup. Ordinary archive releases safe
resources child-first and retains dirty, unknown or live resources with their
ownership and diagnostics. `--force` is separate explicit authority; it neither
proves delivery or quiescence nor permits discarding retained data.

For an ordinary Integration conflict, resolve and stage files in that attempt's
workspace, then run `yui task integration continue <task>/<integration>`.
Do not create a replacement attempt or require a manual-resolution decision
just for a normal Git conflict. Cleanup uses exact ownership and Git
registrations; missing paths alone do not establish that cleanup is complete.

These are behavioral changes under Yui's minor-version convention. There is no
new persistent schema or storage migration in 2.3.0. Existing Task and
Integration evidence is preserved. This package release does not itself
install the global CLI, activate a runtime or restart a Controller. Users
upgrading from 2.1.0 must also apply the 2.2.0 API guidance below.

### 2.2.0 compatibility and migration notes

This minor release adds the independent `yui agent` entry, explicit model/tool
configuration, durable local sessions, context compaction and offline evaluation,
alongside Task handoff/Leader scope fixes and Web layout improvements.

The independent Agent's public `createAgent({ onEvent })` option from 2.1.0 has
been replaced. Passing `onEvent` in JavaScript no longer invokes the callback;
the turn may complete with facts retained only in memory. Update callers before
upgrading—this is an incompatible interface change, despite the minor version.

Use `recorder.record` for required ordered recording; it is awaited and a rejected
record stops new effects. Use synchronous `observer.observe` for optional display
or telemetry; its failure is reported in `observerErrors` and does not stop the
turn. An observer must enqueue asynchronous work itself, not return a Promise.
For an old awaited persistence callback, the equivalent construction is:

```js
const agent = createAgent({
  provider,
  tools,
  recorder: { record: persistEvent }, // async (event) => { await durableWrite(event); }
  observer: { observe: renderEvent }, // optional, synchronous
});
```

Inspect `result.recording` for recording evidence and `result.error` for failure.
Recording errors now use `recording_failed`, not `event_sink_failed`. Do not move
required persistence into an observer. Existing Tasks and historical reports
remain readable, but a new Review requires frozen candidate/report evidence;
missing historical evidence is not reconstructed. Context compaction requires
an explicit compressor when the budget is exceeded. These notes do not authorize
global CLI installation, Home migration or Controller restart.

The operations and examples below describe how to execute already-authorized
effects, not a default sequence to run after completing or merging a Task.

## Stable 1.0 baseline and release evidence

Package 1.0.0 defines the storage **1.0** contract directly. The runtime and
current source carry no historical migration chain, old-format reader,
conversion tool, fixture or compatibility test. A fresh Home initializes the
current schema; any unsupported storage identity is rejected without mutation.

Storage versions have two levels. Default updates may advance only contiguous
minor versions within the same major; pinning a package does not authorize a
cross-major conversion. Current Yui-owned envelopes and protocols start at 1,
without resetting business revisions, epochs or audit evidence.
Any future persistent change requires an explicit new minor transition;
published schema definitions must not be silently replaced.
Current bounded automatic recovery, lock waiting, transactions, replay
protection and valid exact-identity caches remain normal runtime behavior.

Stable releases use npm `latest`; prereleases use `next`, never the stable
default. The release workflow builds one runtime archive, verifies it across
supported Node versions on Linux x64, macOS x64 and macOS arm64, publishes that exact archive to npm, then creates the
matching GitHub Release. Every release carries the runtime archive, checksum and
provenance. A stable tag becomes GitHub latest; a prerelease does not.

Platform jobs compile Yui's native helpers from the same source commit.
The archive includes every supported helper under `dist/runtime/native/`;
runtime selection uses the exact OS and architecture, without install scripts
or downloading executable code on first use. Dependencies such as SQLite
remain ordinary npm dependencies installed for the consumer's platform.

The GitHub Release job uploads only missing assets to a draft, downloads and
compares every asset against the tested artifact, and never overwrites a
published asset. A retry accepts only byte-identical existing evidence. If npm
has already published and the Release job fails, rerun that failed job with the
retained artifact rather than rebuilding or republishing the package. The
runtime tarball must contain neither tools/ nor historical storage migrations.

Use `yui update --version <exact-version>` for an exact published package.
Staged metadata must match the requested version, and target-owned storage
preflight runs before activation and again under the maintenance fence.
An unsupported Home remains unchanged. Current update/activation children must
explicitly identify their handover-lock owner.

Restoration checks the captured executable/argv, package version, Controller
protocol and both storage-version bounds against status and live identity.
Missing contract fields are errors, not an older-Controller exception.

## Authorization model

Every (re)submission of a step passes `checkGrant(grant, request, now)`
(`src/grant/capabilityGrant.ts`) **before** the external call. The step kind
is the grant action: a grant lists the step kinds it authorizes, for example
`--action npm-publish --action version-tag`. The decision is fail-closed —
every denial carries a machine-readable reason and stops the run:

| Reason | Meaning |
| --- | --- |
| `grant-missing` | No grant record is bound to the workflow (engine-level). |
| `grant-revoked` | The grant was revoked by an operator. |
| `grant-expired` | The wall clock passed the grant's `expiresAt`. |
| `grant-uses-exhausted` | The grant's `maxUses` has been consumed. |
| `grant-action-not-allowed` | The step kind is not in the grant's actions. |
| `grant-parameter-missing` | A bounded parameter is absent from the step. |
| `grant-parameter-value-not-allowed` | A bounded parameter has an out-of-bounds value. |
| `grant-irreversibility-exceeds-ceiling` | The step is more irreversible than the grant's ceiling. |

Additional rules:

- **One use per authorized submission.** The engine records a grant use
  between the successful decision and the external call, so a `maxUses` grant
  fails closed on the attempt that would exceed it.
- **Irreversible steps need a confirmed prefix.** A step marked
  `irreversible` additionally requires every earlier step to be `succeeded`;
  otherwise the step fails with `prerequisite-not-confirmed` and the run
  stops. This is what keeps an `npm-publish` from running behind a failed PR.
- **Denials are recorded.** When a pending step is denied, the engine starts
  and fails the step with the denial in its log, so `workflow status` shows
  exactly where authorization stopped.
- **Rebinding.** A revoked, expired, or too-narrow grant does not dead-end
  the workflow. Issue a new grant and resume with
  `yui task workflow resume <task> <workflow> --grant <new-grant>`; the plan,
  source, and all confirmed step evidence are immutable across the rebind.

## Stable Task-final Review contract

Compatible CLI package updates and Controller replacements do not change an
active Task's final-review capability. Managed Sessions use the ordinary
`yui` command, compatibility is checked by protocol and storage identity, and
a replacement Leader presents the contract already established by durable Task
evidence. No version-aware Operator action is required.
Candidate and Task-final ReviewRound records must all carry that one contract.
Conflicting records fail closed; there is no rebind event, recovery command, or
second contract state machine.

## Current Agent Host boundary

A running Host keeps its original Endpoint implementation. It records exact
Session/attempt/native-Turn facts in the existing durable Inbox before contacting
the Controller; only the current Controller resolves Run ownership, validates
authority/workspace/lifecycle/history, and commits the result. An Inbox file is
not acceptance. Files are consumed only after commit, so downtime or a lost ACK
does not replay user input or model work.

Startup facts use the exact Run identity from the redeemed launch payload, not
the long-lived Session environment. This preserves pre-adoption evidence even
when the frozen Run workspace differs from the Role's default; later activity
and terminal facts still resolve solely by their own native input identities.

The current Host boundary is control `yui-agent-host-control/v1`, event source
`yui-agent-host-events/v1`, and Controller RPC version 1. Hosts do not open the
Home database, including for process custody, native account locations, or
execution-environment checks. Only the Controller owns storage and resolves
durable facts; malformed current input fails at its normal protocol boundary.

Compatible upgrades retain logical Sessions and live Hosts. A build generation
is diagnostic provenance, not a native-resume gate: after a safe authorized Host
release, the current built-in adapter may resume the same native identity.
Model, account, permissions, workspace and current authority are not relaxed.
No module hot-replacement or old-code installation is used.

The supported interoperability range is the existing control/event v1 and RPC
version 1, not arbitrary historical processes. Host status now advertises
`controlCapabilities` and `hostImplementation` captured at process load, separate
from the Endpoint build. Controllers request `reconcile-turn` only when
advertised. Pre-advertisement v1 Hosts still support status and raw Inbox
consumption; exact terminal republication is unavailable, not guessed from a
package version. Unknown protocols remain refused.

`update` reports program/storage completion separately from retained Host state.
It neither interrupts compatible busy Hosts nor automatically replaces an
unsupported one. A required refresh uses the existing explicit lifecycle, with
exact Turn, background execution and writer-release evidence before reattachment.
Idle status alone is insufficient; uncertain state blocks refresh rather than
authorizing force-kill, input replay or a new native identity. Controller
handover locks, process-generation fences and Session authority remain enforced.

Storage upgrades are limited to the current major's explicit minor steps.
Cross-major conversion is independently authorized and is not a runtime fallback.
New Sessions use the ordinary `yui` entry from their launch environment; updates
do not generate or retarget per-Session CLI scripts. Global Context commands
remain self-contained for remote TUI/Desktop use. Correct PATH and Home selection
are required: protocol/storage checks do not distinguish every same-contract
installation. Development uses an explicit isolated checkout entry.
Runtime diagnostics do not interpret `schema.json`, `state.json`, or a whole-map release
idempotency file; current SQLite data and per-key release receipts remain the
authorities, and unrelated files are left untouched.

`task role status`, `task role list`, and `task role session inspect` expose Host
reporting alongside durable Run state. Pending native results or known reporting
failures require attention; they do not mean the Provider failed, the Run ended,
or the work was accepted. The Host's live diagnostics inspect only its own event
file identities and never parse or quarantine another producer's newer payload.
Missing event delivery is unreported, not healthy. `unpersisted` counts original
facts still held in the Host after an Inbox write failure. Reconciliation first
retries those exact bytes in observation order, then republishes retained exact
terminal evidence; it does not execute input. Keep this Host alive until its
bytes are durable. A filesystem fault followed by process loss cannot be
repaired by inventing a result. Task and Global full reconciliation use the
same capability-gated operation, including a final input with no queued successor.

## CLI and Controller release boundary

The global `yui` command is the stable user and managed-Session interface. It
does not follow `runtime/active-release.json` for ordinary commands: that
pointer selects the Controller release, not the CLI package. This keeps CLI,
Operator Session, and Controller replacement compatible without pinning every
command to one immutable build.

A source-checkout or otherwise unverified local CLI is not this published
interface. When `YUI_HOME` already names an active release, such a CLI fails
before opening storage and reports its build/source, the durable Home identity,
and its invocation class. `make install-local` continues to default to the
checkout's isolated `output/dev/home`; explicitly pointing that launcher at a
release-owned Home is rejected.

An explicit `yui release activate <release-id|build-id>` is the one exception.
The global CLI verifies the installed target release and its matching smoke
receipt, then delegates the unchanged activation arguments to that target's
`dist/cli.js`. The target release therefore owns the complete handover protocol
and timeout hierarchy. A no-target activation, help, `--json`, and every other
command remain on the global CLI. Activation does not add another ordinary CLI
routing path.

## Step catalog

The plan is a fixed, predeclared subset of operations. Each plan entry has an
id (unique within the workflow), a kind, optional params, and an optional
irreversibility level (`none` | `reversible` | `irreversible`).

| Kind | External effect | Authoritative identity |
| --- | --- | --- |
| `pr-create-or-reuse` | Creates the release PR, or reuses an open one for the head. | `pull-request` number |
| `ci-confirm` | Reads the CI conclusion for the source ref; succeeds only on `success`. | — |
| `merge` | Merges the named PR (squash by default). | — |
| `version-tag` | Creates and pushes the annotated version tag. | `git-tag` name |
| `npm-publish` | Publishes the tarball to the registry. | `npm-package` version |
| `fresh-install-smoke` | Installs and runs the published package from the registry. | — |
| `cli-update` | Updates the Yui CLI/Controller home via the existing update orchestrator. | `controller-home` |
| `controller-replace` | Stops and restarts the file-task Controller. | — |
| `project-migrate` | Runs the Project migration through the existing project command. | — |
| `post-verify` | Runs an arbitrary verification command. | — |

Steps may reference earlier evidence: a param value of
`$externalId:<step-id>` resolves to the referenced step's confirmed external
id at run time, so a `merge` step can consume the PR number the `pr` step
produced without the operator knowing it in advance. A reference to an
unconfirmed step fails the run rather than guessing.

## Recovery and resume semantics

A run always starts from the **resume cursor**: the first plan step whose
status is not terminal (`succeeded` or `skipped`). There is no "start over" —
confirmed steps are never re-run.

Because every state transition is persisted before the next external call, a
process exit at any point is recoverable: re-invoke `run` (or `resume`) and
the engine continues from the first unconfirmed step. `--max-steps <n>` bounds
a single run; a run that exhausts its budget mid-workflow returns
`budget-exhausted` and the next invocation continues.

In-flight steps are resolved by **authoritative identity query**, never by
blind re-submission:

- A step left `running` or `unknown` is queried first by its recorded
  `externalIdentity`.
  - `exists` → the step reaches `succeeded` **without a second submission**
    (`unknown` is confirmed, `running` is completed).
  - `unknown` → the run stops with outcome `unknown`; the step is never
    re-submitted while its fate is unknowable.
  - `absent` → the effect never landed, so the step is re-attempted (a
    `running` step records the recovery attempt).
- A `running` step **without** an external identity crashed before recording a
  submission result. An irreversible step is queried through the port anyway
  (the adapter consults its durable idempotency store): `exists` confirms the
  step without a second submission, `unknown` stops as `unconfirmed`, and only
  an authoritative `absent` re-attempts the step exactly once. A reversible
  step always falls through and re-attempts under the same idempotency key.
- A timeout **without** an external identity marks the step as `unknown`
  (unconfirmed) so it is never re-submitted blindly; on resume it fails closed
  as `unconfirmed`.
- A `failed` step is retried on the next run; its `attempts` counter and logs
  grow per attempt.

Run outcomes: `succeeded`, `failed`, `unknown`, `unauthorized`,
`unconfirmed`, `budget-exhausted`. Each carries a machine-readable
`stopReason` (for example `unknown:publish`, `unauthorized:grant-revoked`,
`budget-exhausted:verify`) and the list of step ids attempted that run.

## Idempotency key contract

Each step's idempotency key is **predeclared at create time** and never
changes:

```text
<taskId>/<workflowId>/<stepId>
```

The key is passed to every `executeStep` call for that step, including
retries after a confirmed-absent timeout. The port contract requires
`executeStep` to be idempotent under the same key: a retried attempt must not
produce a second side effect. The engine side of the contract is stricter
still — it never blindly calls `executeStep` for an `unknown` step; it first
re-queries by the recorded identity. A deterministic core scenario checks
uncertain-effect queries, confirmed-step reuse and grant exhaustion against
real SQLite. This proves those engine boundaries, not the idempotency of real
external services or every release adapter.

## Operator guide

Session authority is checked against current durable bindings. Telemetry is
grouped by Role/AgentRun, and process owners use PID/start identity. Storage
changes follow the [single explicit upgrade boundary](sqlite-control-plane-design.md);
ordinary commands never rewrite the Home schema.

Operator grant issue and revoke retain their existing authority. They require
the current registered global Operator conversation. Its native session ID
must match the durable live session binding: Codex commands use `CODEX_THREAD_ID`
when present, otherwise `YUI_NATIVE_SESSION_ID`; Claude uses `YUI_NATIVE_SESSION_ID`.
Host generation and launch-time Agent labels are not caller identity. Resuming
the same conversation through another entry point does not revoke its authority.
An unregistered, replaced, or ended conversation has no such authority.
A current delivery Leader can instead issue finite, expiring grants for its own
Task from an original user/Operator Message, using `--source-message`,
`--purpose` (a verbatim authorization quotation), and `--request-id`. It must
choose only the actions actually authorized by that source. Source validation
is not natural-language approval; development intent is not publication intent.
Release scope requires Task Projects and their repositories; package/version
effects also need explicit package/version bounds. Global update, Controller
replacement and migration remain Operator-only. The Leader may revoke only
Leader-issued grants in its Task. Empty environments, Worker/Reviewer or
planning/replaced Sessions confer no such authority. Granter/revoker attribution
comes from the current Session; there is no `--granter`/`--by` label to spoof.
See the [complete source/ordinary archive contract](../skills/yui-leader/references/authorization.md).

```sh
# 1. The Operator session issues the authority for the release chain.
yui task grant issue task-15 \
  --action pr-create-or-reuse --action npm-publish --action post-verify \
  --irreversibility-ceiling irreversible

# 2. Create the workflow against an exact source and a predeclared plan.
#    An npm-publish step requires a content-addressed source artifact: the
#    immutable workflow source can never gain one later, so a plan without
#    --source-artifact is rejected at creation.
yui task workflow create task-15 \
  --grant capability-grant-1 \
  --source-repo acme/widget --source-commit abc1234deadbeef0000000000000000000000000 \
  --source-artifact widget-1.0.0.tgz@sha512-<base64-integrity> \
  --step pr:pr-create-or-reuse \
  --step publish:npm-publish --step-irreversibility publish=irreversible \
  --step-param publish:tarball=./dist/widget-1.0.0.tgz \
  --step verify:post-verify --step-param verify:command='yui --version'

# 3. Run (or resume) and inspect.
yui task workflow run    task-15 release-workflow-1
yui task workflow resume task-15 release-workflow-1 [--grant capability-grant-2] [--max-steps 1]
yui task workflow status task-15 release-workflow-1

# 4. Revoke authority at any time; the next step stops unauthorized.
yui task grant revoke task-15 capability-grant-1
```

`workflow status` renders each step's status, attempt count, and confirmed
external id, so an operator can see exactly where a release stopped and why.

## Real-resource boundary

Real execution happens only through the `yui` CLI, which wires the real
adapter (`createReleaseWorkflowPorts`). The adapter is a thin shell over
existing atomic operations — `gh`, `npm`, `git`, the CLI update orchestrator,
Controller stop/restart, and `project migrate` — and it runs only when a human
granter has issued an explicit CapabilityGrant that passes `checkGrant` for
each step. A local test request never substitutes for that authority.

The tag-triggered `publish.yml` workflow is the only maintained release smoke.
It reuses the exact commit that passed core CI and adds only artifact assembly,
fresh installation, and provenance checks required to publish.

Business contracts and full Jobs/Schedules wiring run once in Core CI on Linux
Node 24. Release still installs the same checksummed archive on all three
platforms × Node 20/22/24/26: every install checks CLI/setup/native helpers,
Doctor/PTY and real SQLite SQL/GC. Node 24 additionally checks real process
lifecycle on each platform. See the [coverage table](testing/verification-levels.md#ci-and-release).
Dependency installation does not build the project; each source job builds once
and verifies native dependencies afterwards. Smoke logs separate phase timings.
Post-publication registry checks and byte-identical GitHub assets are distinct
evidence and are not replaced by pre-publication smoke.

That workflow authenticates through npm Trusted Publishing (OIDC), so the
release identity lives in two places outside the tag: `repository`, `bugs`, and
`homepage` are copied verbatim from the source `package.json` into the published
manifest by `assemble-runtime-package.mjs`, and the package's npm Trusted
Publisher entry names the GitHub owner, repository, workflow file, and
environment. npm compares `repository.url` against the building repository
case-sensitively before accepting provenance. Renaming or transferring the
GitHub repository therefore has to update those URLs and the npm Trusted
Publisher entry together with the rename; otherwise the next tag reaches
`npm publish` and fails there, after the tag and the gated build already
succeeded.

## Adapter security hardening

The real adapter (`createReleaseWorkflowPorts`) applies additional safeguards
beyond the engine's grant checks:

- **Tarball option injection.** An option-looking tarball path (one starting
  with `-`) is rejected before any subprocess — both the `tar -xOf` manifest
  inspection and `npm publish` — sees it, so a crafted path can never be
  interpreted as a flag.
- **Tarball TOCTOU.** After the frozen `source.artifact.integrity` is verified,
  the verified bytes are snapshotted to a workflow-private, read-only temp
  file. Both the `tar -xOf` manifest inspection and `npm publish` read the
  snapshot, never the live tarball path, so a replacement of the original file
  after verification cannot change what is published. The snapshot is removed
  when the step completes.
- **Pinned external commands.** The adapter resolves the external commands it
  shells out to (`gh`, `git`, `npm`, `tar`, `sh`) to absolute paths at
  construction time via `resolveExecutable`, walking the caller's `PATH`
  once. Every subprocess invocation uses the resolved path, so a later `PATH`
  change (or a manipulated working directory) cannot redirect a release effect
  to a different binary. An unresolvable command returns a synthetic failure
  (exit 127) without invoking any binary.
- **Pinned cli-update activation target.** Before the irreversible update
  effect, the adapter persists the exact activation target — the Home plus the
  global npm prefix (`bin/yui`) — to a durable file under the Home
  (`release/cli-update-identity/<idempotency-key>.json`). A hard-exit recovery
  query (a step with no recorded identity) reads this file and invokes that
  pinned target; if the file is absent (the process exited before the
  pre-effect persistence), the query returns `unknown` rather than deriving
  the target from the resume caller's `npm prefix --global` or `PATH`, so a
  different installation in the resume environment cannot attest the step.
- **Controller lifecycle verification.** A `cli-update` recovery query proves
  the replacement Controller actually owns the target Home: it runs
  `yui --json controller status` (with `YUI_HOME` pinned to the recorded Home)
  and requires a `current` controller resource whose `yuiHome` resolves to
  that Home, then `yui --json controller identity` and requires the
  authenticated Controller identity to match the activated artifact: the
  Node.js executable path, the exact Controller entrypoint derived from the
  pinned global binary, and the package version. Binary health alone (doctor,
  `--version`) never confirms the handoff, and any unprovable state returns
  `unknown`. This applies to both the identity-bearing query and the
  hard-exit query (a step with no recorded identity).
- **npm integrity comparison.** An `npm-publish` recovery query does not stop
  at the published version: it fetches `dist.integrity` via
  `npm view <pkg>@<version> dist.integrity` and compares it byte-for-byte with
  the frozen `source.artifact.integrity`. A match confirms the step; the same
  version with different bytes is a conflict and returns `unknown` (never a
  confirmation, never a re-publish); a missing version is `absent`.
