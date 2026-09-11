<p align="right"><strong>English</strong> | <a href="./sqlite-control-plane-design.zh-CN.md">简体中文</a></p>

# SQLite control-plane storage

Yui has one authoritative product Store: `YUI_HOME/yui.db` in WAL mode. The
highest contiguous, checksummed row in `schema_migrations` is the one Home
storage version accepted by the running release.

## Authority

- `yui.db` owns Tasks, WorkItems, AgentRuns, Messages, Decisions, results, Project
  Knowledge references, managed workspace records, runtime bindings, mailboxes,
  durable events, and configuration.
- Provider Sessions, transcripts, processes, caches, telemetry, and runtime
  observations support execution and diagnosis; they do not replace durable
  Task facts.
- Configuration and diagnostics outside the database do not define another
  storage version or permit rebuilding Task truth heuristically.

## Admission

Ordinary commands open a Home only when all of these are true:

1. `yui.db` exists and its migration ledger is a valid immutable prefix.
2. The ledger head exactly matches the running CLI's current storage version.
3. Current record validation and reference integrity succeed.

An older Home inside the CLI's supported range fails ordinary admission but is
classified as upgradeable. `yui doctor` and `yui upgrade --dry-run` report the
ordered path without changing the Home. Explicit `yui upgrade` is the only
standalone mutation boundary: it quiesces the Controller, backs up `yui.db`,
applies all missing migrations transactionally, and validates the current
model. A newer, below-minimum, incomplete, or malformed Home fails closed.
There is no runtime normalization, repair worker, file-Store fallback, dual
read/write path, or second migration authority.

## Write and concurrency contract

- Each mutation is one SQLite transaction.
- WAL plus `synchronous=FULL` provides the durable commit boundary.
- `home_meta.revision` is the Home-wide CAS/revision used by callers that need
  a frozen read/modify/write boundary.
- Typed columns support indexed identity and status queries; the full validated
  record payload remains the durable domain representation.
- Mailbox claim, exact AgentRun terminalization, active-pointer removal, result
  persistence, and downstream wake creation are transactionally coupled where
  they form one product fact.
- Idempotency keys and unique constraints protect repeatable external-effect
  acknowledgements; they do not form a second workflow state machine.

## AgentRun and Session boundary

An AgentRun is an explicitly requested execution. It records associated visible
inputs and the original result, not hidden reasoning or the full tool trace.
A Provider Session can contain multiple Runs, ordinary native chat and
notifications. Native chat and notifications do not automatically create Runs.
Only an exactly correlated native terminal settles the Run; the Leader remains
the authority for WorkItem and Task acceptance.

## Update behavior

`yui update` stages an exact package and asks that staged binary to classify the
Home as current, migration-ready, or blocked. It then stops the exact
Controller, activates the same package, runs the staged release's complete
migration chain when required, verifies the installed binary and current Home,
and starts the replacement Controller.

Every persistent schema or payload change appends one immutable, contiguous
storage migration. The CLI publishes both `storageVersion` and
`minimumStorageVersion`; every valid Home in that inclusive range can upgrade
directly to the current version without installing intermediate releases.
The current source declares storage version **18**, with minimum supported
migration version **1**, in `src/storage/storageVersions.ts`. Homes below that
floor are not migration inputs and remain untouched.
The target binary's `upgrade --update-preflight` and `--update-apply` result
shapes and parent-owned handover-lock proof remain backward compatible with
every updater released from storage version 1 onward, so an old source CLI can
still drive a much newer target's complete migration chain.
