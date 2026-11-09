# Optional component maintenance

Contract 1 · 2026-10-24 · shipped with this Yui source version.
This manual describes **implemented** operations, not permission to operate
someone's service. Component-specific instructions: [metabridge](model-metabridge.md),
[CLIProxyAPI v8.0.12](model-cliproxyapi.md), [native connection tool](model-connection-tools.md).
Web serves these under `/models/docs/{maintenance,metabridge,cliproxyapi,connection}`.

## Ownership and normal path

Register a module and endpoints first. Configuration ownership (`external` or
`configuration`) does not grant lifecycle maintenance. An endpoint needs neither
an installation nor a managed service. A maintained component is independent of
Task/AgentRun lifetime; no Task cleanup stops it.

Provider management's configuration action offers a copyable Operator prompt.
Run `yui models guide maintenance --json` for its current procedure/manual paths;
this reads no instance and submits no Job. Copy/paste into Operator is a handoff,
not blanket authorization for service operations. Ordinary model use does not
require maintenance.

There is no manual component configuration form in Web. Operator uses
`yui models maintain --task <actual-task-id> --input <json>` with the specification
below, or the existing capability/API. Read saved delegation/Job results before an
operation. The first successful submission saves its exact configuration in
the existing global `model-maintenance-ID` Job definition. Each action is an
ordinary JobRun with its own frozen input, request identity, process custody,
logs and business result. Later explicit actions revise that same definition.
No generic orchestrator, auto-updater, task-owned service or parallel upstream
configuration is created. Global Job history is the operation authority.

Only the existing local Web user or authenticated Operator may submit.
The maintenance specification is a scope declaration, not an authentication
credential. No Task Role can acquire global maintenance via these capabilities.
Native configuration file writes use the same existing local-user/Operator
boundary, not a browser-supplied private plan.

## Exact source and commands

Example specification; replace **all** example paths and explicitly review
the chosen repository and command arguments before delegating:

```json
{
  "repository": "https://github.com/zhangqian-silk/metabridge.git",
  "ref": "refs/heads/main",
  "directory": "/absolute/private/metabridge-releases",
  "build": [{"argv":["npm","ci","--no-audit","--no-fund"],"timeoutMs":300000}],
  "verify": [{"argv":["node","--check","server.js"],"timeoutMs":15000}],
  "configFiles": ["/absolute/private/metabridge/config.json","/absolute/private/metabridge/providers/cpa.json"],
  "migration": "none",
  "service": null
}
```

`directory` must already exist, be owned, non-symlink and not group/world
writable (`mkdir -m 700` is appropriate for a new owned directory).
Git and build toolchains are optional component prerequisites, not additional
Yui installation dependencies. Local absolute Git repositories, HTTPS and
explicit `ssh://git@host/path` URLs are supported. Credentials in repository
URLs, remote helpers and guessed sources are rejected. Do not put secrets in
commands: references and command arguments are durable Job input.

The selected ref must be a complete `refs/heads/...` or `refs/tags/...`.
Check remote update calls `git ls-remote`, resolving annotated tags to their
commit. A successful result records source/ref, exact commit and observation
time. It is a remote observation **at that time**, not a perpetual “latest”.
Authentication failure/missing ref is failed evidence, never cached success.
There is no GitHub release-channel resolver: use an explicit release tag or
maintained branch. Never substitute a tag's display name for its resolved commit.

Copy the returned 40-character commit into Build & switch pinned version.
The model service requires a successful check for that repository/ref/commit
in this instance's Job history. A subsequent remote change does not change the
approved target. Fetch verifies that exact commit before checkout.

Update (also first installation) performs:

1. Acquire this installation's exclusive maintenance lock.
2. Back up every explicitly inventoried native config/credential file privately;
   record paths, byte digests and modes in the Job's `maintenance/config-backup`.
3. Initialize a fresh `release-COMMIT-UUID` checkout and fetch the exact commit.
   Never pull, reset, checkout or write in the source/running/user repository.
4. Execute only approved build/verify argv, without a shell wrapper or inherited
   Controller secrets. Build HOME/TMPDIR are private to that checkout. Review
   scripts as executable repository code: directory separation is **not** a
   hostile-code sandbox. Tools can download dependencies; that effect must be
   within the caller's repository/build authorization.
5. Recheck config bytes/modes and current/previous selections, then atomically
   select `current`; retain `previous` and all prior builds.

Failures before switching retain the prior `current`, plus diagnostic checkout
and private backups. Unknown command outcomes retain the lock and require
inspection, not retry. The Job runner terminates its owned process group on
command timeout. External/daemonized processes deliberately escaping that group
are outside this trusted-build contract; never authorize untrusted build code.

`installedVersion` describes the selected validated commit; module `version`
is the declared compatibility target. `runtimeVersion` remains unknown:
a symlink switch cannot prove which binary/config an existing process loaded.
Updating never silently restarts a service, refreshes catalogs or changes an
Agent binding/default Provider.

## Explicit service takeover

Only user-systemd is implemented. Supply this non-null service field:

```json
{
  "manager":"systemd-user",
  "unit":"my-bridge.service",
  "fragmentPath":"/absolute/home/.config/systemd/user/my-bridge.service",
  "fragmentRevision":"SHA256_OF_JSON_STRING_ENCODED_EXACT_FRAGMENT_TEXT"
}
```

Compute the revision with the shipped `modelDigest` function, not `sha256sum`
of the raw file:

```sh
node --input-type=module -e 'import{readFileSync}from"node:fs";import{modelDigest}from"./dist/models/modelManagementFiles.js";console.log(modelDigest(readFileSync(process.argv[1],"utf8")))' /absolute/owned/unit.service
```

Yui never discovers ownership by process name/port and never creates/overwrites
a unit. Explicitly inspect/adopt an existing unit first, including ExecStart,
environment, credentials, ports, dependencies and external clients. Unit
`Id`/`FragmentPath` must match and its fragment digest must remain unchanged.
Unreviewed systemd drop-ins are refused, not silently adopted.

For a new installation, the explicitly owned unit should execute
`/absolute/private/releases/current/...` and use a stable external config path.
Choose its absolute executable and configuration arguments from the exact
component version. `After=` alone does not start a CPA: use actual unit
relationships only when this bridge instance really depends on that CPA.
Do not install a second instance on a guessed port.

Start/restart require approved `verify` commands. Extend them to statically
validate the exact native configuration, check declared dependencies and probe
availability of the intended listener (or inspect the existing owned listener
when restarting). These are caller-reviewed preflight programs, not automatic
port-owner discovery. Build-time syntax validation alone is **not** a sufficient
service preflight. systemd's own dependency/ExecStartPre checks still apply.
No built-in network health/model probe is added.

Start/stop/restart submit `systemctl --user OP EXACT_UNIT`; status reads only
that unit's properties. Status, process readiness and inference are separate
fields. Manager success does not prove application/readiness/model success.
Restart affects all known bindings and possibly unknown external consumers;
explicitly acknowledge that impact. It never restarts Codex's shared daemon.

Logs read at most 100 exact-unit journal entries, returning timestamps,
priorities and `[redacted]` messages. **All message text is withheld** because
bare keys cannot be reliably recognized. Use separately authorized native
journal inspection for detailed text; do not paste secret-bearing messages into
Yui/Agent transcripts. Status/log operations never call an upstream.

## Failure, rollback, restore and handoff

Inspect the exact JobRun business result, not just process exit or “accepted”.
A nonzero/timeout service action may have partial effects and is unknown, not
safe to retry. Inspect unit/process/config/current link first. Active or unknown
runs block a new model operation. An explicit Job acknowledgement records
inspection; it does not undo effects. Never auto-delete a stale lock. Confirm
the exact run/group is stopped and inspect its owner evidence before removing
only its `.maintenance-lock` directory.

Select previous version only switches the retained binary selection, without
restart or config restore. It is allowed only with `migration:"none"`.
`migration:"manual"` refuses automatic update/rollback: make the version's
native migration and configuration recovery decision first. Don't change that
declaration merely to bypass an incompatible downgrade.

Update does not edit native config. The inventory covers **only** listed files:
include referenced Provider files, auth files and any migration data separately.
It is not a database/account-pool/remote-state backup. To restore native files,
obtain exclusive ownership, compare current bytes/modes to the exact known
post-operation revision, validate private backups and atomically restore only
those files. Stop on any subsequent edit or unknown effect. For connection-tool
changes, use its executable `restore --from EXACT_RECEIPT` (its typed
ConnectionConfigResult is `files`, `warnings`, `schemaVersion` and
`status:configurationResult` from the Job data); don't feed a whole Job envelope
as a native restore receipt. The tool validates its private backup digests.

Prepare independent handoff records that no service/file/key was removed.
It replaces this Job definition's executable action with a no-effect handoff;
it does not stop/uninstall the component. Disable separately created schedules
first, preserve startup/config instructions and evidence, then remove unused
Yui bindings/endpoints/module references in dependency order. To relinquish only
configuration editing, set the module's maintenance to `external`. Native
services, selected versions, data and credentials remain. Uninstall, deletion,
credential revocation and stopping require separate explicit operations.

## CLI / Operator and connection tools

Use the existing authenticated capability envelope described in
[model-management-api.md](model-management-api.md):

* `models.read` with `{"kind":"maintenance","resourceId":"MODULE"}` reads cached
  delegation/results and `moduleRevision`, without service/upstream probing.
* `models.maintain` accepts `{"input":{"revision":"REGISTRY_REVISION",
  "requestId":"STABLE_ID","maintenance":{"moduleId":"MODULE",
  "moduleRevision":"FROM_READ","spec":{},"operation":"check-update"}}}`.
  Replace `spec` with the complete object above. Mutating operations also need
  `exclusiveWriter:true,impactAcknowledged:true`; update needs `commit`.
* `models.connection-preview` accepts `{"input":{"input":{...ConnectionConfigInput}}}`.
* `models.connection-apply` accepts `{"input":{"input":{...same input},
  "planDigest":"FROM_PREVIEW","requestId":"STABLE_ID","exclusiveWriter":true}}`.

Web equivalents are GET/POST `/api/models/maintenance`,
POST `/api/models/connection/preview` and `/api/models/connection/apply`.
Return is **Job admission**, not saved/applied. Use the existing Jobs Web/CLI
to read the exact run's result/evidence; no automatic replay is performed.
The native tool library is shared, and its private plan is reconstructed on the
server and checked again in the controlled runner immediately before applying.
Default Provider selection is a separate explicit input, not implied by adding
a Provider. Files saved, runtime applied, service restarted, new/old Session
effects and catalog refresh are reported separately.

## Deterministic verification

From this checkout with dependencies built:

```sh
npm run build
node --import ./test/helpers/physical-tmpdir.mjs --test test/platform/model-maintenance.test.js test/core/model-maintenance-service.test.js test/core/model-registry.test.js
```

These tests create local Git sources, isolated native configs and simulated
service-manager responses, with teardown registered before allocation. They
cover independent installation, source preservation, validation failure,
retained versions/backups, native edit/reread, tool application and caller/replay
boundaries. No real component, model, quota, account or user service is exercised.
