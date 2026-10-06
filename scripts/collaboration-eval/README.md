# Collaboration evaluation — deterministic partial baseline

This small research entry is outside `npm test` and core CI. It measures
deterministic scripts using Yui persistence and discovery, not model coding
ability, Agent understanding, or real-service reliability.

The business library in [cases/README.md](cases/README.md) contains 24 frozen
base cases (18 development / 6 holdout), four F variants and five P definitions.
The current runner connects F cases to real Yui Message, Decision and, for K
cases, Project Knowledge writes and complete original reads. It exercises
native Decision supersession and Knowledge retirement. The evaluator checks
actual candidate files, local Git repositories, source bytes and effects.

This is **partial evidence**, not the full case baseline: managed dependency
acceptance, frozen assignments and native permission fences are not yet wired.
All five P adapters exercise genuine predecessor/successor Session handoffs.
A string saying
“accepted” in business material is not a native acceptance receipt. The
F's deterministic participant runs as a bounded local child, outside a managed
Agent Role; P uses managed Leaders. There is no filesystem sandbox or proof of model understanding.

## Run, then analyze

Use supported Node (24 recommended) and the per-checkout isolated launcher:

```sh
make install-local
node scripts/collaboration-eval/run.mjs \
  --version /absolute/path/to/Yui \
  --case C01,W01,R01,A01,O02 \
  --out /absolute/path/to/a-new-report-directory
node scripts/collaboration-eval/analyze.mjs /absolute/path/to/a-new-report-directory
node scripts/collaboration-eval/compare.mjs /absolute/path/to/record-A /absolute/path/to/record-B
```

`--case` accepts comma-separated IDs (including explicit variant IDs), `dev`,
or `all`. Selecting `dev` includes its four variants. `--mode F|P|all` defaults
to F. The complete declared selection is `--case all --mode all`, yielding 33
conditions across 24 base cases. P uses native managed Leaders and is never
substituted with a Controller restart. Any selection containing holdout requires `--allow-holdout true`.
Do not use that flag until development calibration and strategy freeze are
complete. Merely listing or statically hashing holdout is not executing it.

The report directory's parent must exist. An existing directory is refused
before creating any fixture. Each invocation reserves a new directory and
stores append-once `evidence.json` plus SHA-256. `record.json` without complete
evidence denotes an interrupted save; analysis must not fill in its history.
The analyzer only reads and hashes saved records. It does not import the
runner, start a Home, contact Yui, repair evidence or rerun cases.
Hashes detect accidental change, not hostile replacement of both record/hash.

Comparison verifies both saved hashes, pairs exact case/variant/F-or-P identities,
and retains the union of planned conditions, including missing counterparts,
failures and pending-human outcomes. A fair pair requires matching case freeze,
policy/oracle/harness/proxy, actual case-module hashes, seed, source material,
budgets and recorded toolchain;
both sources must be clean. Different target commits are allowed. Incompatible
experiments retain outcomes but emit no cost deltas. Even compatible negative
deltas are descriptive only: this tool does not infer an optimization benefit,
waive unverified boundaries or convert bytes into tokens. Missing cost evidence
is unknown, never zero. It reads no current Home and never reruns a case.
Earlier records lacking actual case-module hashes remain analyzable but are
not accepted for fair A/B comparison: a frozen declaration alone cannot prove
the preparation/simulator/code-check bytes that actually executed.

The manifest records target commit and dirty status, CLI/lockfile hashes,
harness/strategy/oracle/freeze hashes, Node/platform, condition selection and
fixed seed 89. Original CLI outputs/errors, public readback refs, evaluator-only
material manifests, actual outputs/digests, effect ledgers and manual rubric
packages survive fixture cleanup. Failed attempts are not overwritten.
An exit code of zero means this partial adapter executed without infrastructure
or automatic business-check failure; it does **not** mean the full Task passed.

## Readback and score boundaries

`readback.mjs` keeps distinct identities for the signed business fact and its
enclosing native Yui source. The participant receives only complete observed
originals, never the preparation object or expected answers. Every original
retains native store/ref/revision/digest; business values retain their own
source/version/digest. Message discovery follows empty incomplete pages;
long original reads require one source/digest, contiguous UTF-16 offsets and
a matching final SHA-256.

For native F runs, decision facts are read from active `task-decision`
originals; K-case evidence comes from active `project-knowledge` originals.
Other public facts use Messages. Historical Decisions are superseded and
historical Knowledge retired using the real CLI. A successful mutation whose
JSON envelope only contains a text receipt is followed by original-record
discovery, not a guessed ID or replay.

The independent business scorer remains separate from the participant.
Business results are `scripted-pass`, `fail` or `pending-human`; all successful
W/R structural checks remain `pending-human` with actual texts and rubric.
The enclosing condition is `partial-evidence` while native obligations remain
unexercised. The saved `boundaries` and `stages` distinguish saved, discovered,
unverified understanding and deterministic action. Failures/timeouts/not-run
remain in the selected denominator. Variants/P conditions do not add independent
base cases. No automatic whole-suite success rate is emitted.

O02/P has an initially empty business ledger. Only the predecessor's native
Turn receives the original send request, performs the local simulated send
with a dropped response, and saves its unknown-effect checkpoint. Current
facts are published after confirmed native stop. A native `session new`
request creates a fresh successor that reads the checkpoint and current originals, queries
the original key, and persists its result. Its native Message receipt provides
the exact ref/digest for final readback, avoiding a second scan of all Messages.
The independent oracle checks that the effect remains exactly once.
The business simulator's worker/query-only grant is **not** a native Yui Worker
permission: this adapter uses two managed Leader Sessions and still reports
native Worker permissions/assignment/acceptance as unexercised.

Preparation's optional `deferNotification` changes only when O02's effect is
performed. Its module freeze hash was advanced for this adapter correction;
the holdout materials, participant and oracle hashes remain unchanged.
Earlier evidence retains its old preparation/freeze hashes.

For the other four P conditions, evaluator-only staging removes later source
assets before launching the predecessor. The only source at that time is the
T0 input. C05's predecessor reads the existing SDK and writes a cursor mapping
plan; W01 writes a constrained draft; R02 saves an unaccepted logs-v1 conclusion;
A03 computes the orders-s1 partial aggregate and per-order checkpoint.
The actual native Message checkpoint replaces the prepared checkpoint fact.
After confirmed native Session stop, the evaluator publishes the current
sources (including corrected logs / orders-s2). A fresh Session checks that
the current checkpoint equals the predecessor's original, then produces the
independently scored outcome. Predecessor artifacts survive in raw evidence.
Full regeneration from valid facts is permitted; this is not a measure of
human-like draft understanding or minimal editing.

## Resources, costs and bounds

Each condition owns a fresh temporary user directory, YUI_HOME, fake Provider
executable and tmux namespace. Only the absolute target checkout launcher is
called. F never activates an Agent; P activates only the fake Provider. The fake executable
cannot fall back to a real model. All data and Git repos are artificial, local
and remote-free. Knowledge projects are fixture-owned, not real Projects.

Cleanup is registered before `setup`, which can start a Controller. On success
or exceptions it stops the exact owned Controller, releases its tmux server,
then deletes only the fixture root; uncertain cleanup retains ownership data.
Native Role Sessions stop before the Controller. The grace budget is shared across cleanup commands. SIGINT/SIGTERM request a
bounded stop: the current synchronous child call finishes or times out, then
ordinary cleanup/evidence saving runs and remaining conditions stay not-run.
Hard kills are not cleanup receipts; inspect retained paths before recovery.

Per-case limits come from the frozen library: 60 seconds/40 reads/1 MiB for
single-code/docs/research, 90 seconds/60 reads/2 MiB for multi-code/data/ops;
20 seconds cleanup grace. CLI calls have a 20-second maximum within the case
deadline; participant child execution has the remaining deadline. Reads include
failed calls, verification reads and pagination. Effect counts are checked
against case limits before persisting a result; the bounded audited simulator
is not a protection against hostile arbitrary code.
Native participant traces, including idle-notification reads, are included
in the aggregate when their terminals are observed. Each native Turn also
has a 20-read/1-MiB/20-second local bound. The aggregate is checked after
delivery of those traces; it is not a cross-process hard read quota. Exceeding
it records `budget-exceeded`, never a successful score.

Raw native CLI diagnostics are written append-once to a fixture-owned sidecar
outside YUI_HOME. The native terminal binds its exact Session/Turn, byte length
and SHA-256. The evaluator verifies ownership and those identities, merges the
complete raw trace into saved evidence, then removes the sidecar during cleanup.
Business records and results still travel through real Yui public APIs; the
sidecar is diagnostics, not another context/acceptance store. This avoids
recursively paging a large trace embedded in a native report. Observer reads
remain counted; failed older attempts retain their original costs and outcome.

The trace separates preparation, queries, writes and cleanup. Analyzer reports
their call counts, UTF-8 returned bytes and elapsed times separately. This is
not model latency; bytes are never converted into precise tokens or prices.
Model calls are zero, tokens unverified, costs N/A, human preparation unknown.
Fake-runtime setup warnings remain in raw stderr, not silently hidden.

## Focused checks and coverage gaps

```sh
node --test scripts/collaboration-eval/check.mjs \
  scripts/collaboration-eval/native-worker.check.mjs \
  scripts/collaboration-eval/predecessor.check.mjs \
  scripts/collaboration-eval/compare.check.mjs \
  scripts/collaboration-eval/cases/tests/business.test.mjs
```

Checks cover business outcomes, deliberate duplicate effects, readback/digest
boundaries, active native records, selection/denominators and holdout opt-in.
Old first-slice O02 simulator checks remain useful independent regression
evidence; they are not the current 24-case runner.

Fixed-head development execution of all five P adapters succeeded, with three
scripted business passes and two pending-human outcomes; all five remain
partial-evidence. The seven business/calibration fixture roots were released.
The six holdout F cases were then run once after development freeze: four
scripted business passes and two pending-human outcomes, all partial-evidence
with released fixtures. The 33-condition descriptive baseline has 22 scripted
business passes and 11 pending-human conditions, not 33 native collaboration
passes. Its cohorts use distinct historical harness heads, not a fair A/B.

Remaining coverage gaps are native frozen assignment/acceptance/permission
business-case wiring and real semantic quality. The permitted first deterministic
subset does not hide or automatically pass those obligations. The saved Task
report contains per-type outcomes, costs, historical failures, manual rubric,
cleanup evidence and one recommendation: propagate exact result receipt refs
instead of rereading all old Messages. No product performance gain is claimed.
Task artifact reference:
`git:d1b5fc2397978cbb2d0b7f90996c82a80e4930fe:reports/deterministic-baseline.md`
(Task `task-89`, not a Project Git commit).

### Native lifecycle calibration

`native-session-probe.mjs <checkout> <new-output-directory>` is a development
calibration, not a scored business case. It activates a scratch Task with a
deterministic Provider, lets its actual managed Leader read an original and
persist a checkpoint, then requests a fresh Session through the native CLI.
The successor independently reads both originals. Evidence correlates each
result with its exact native Session/Turn terminal and checks that the old
observed identity cannot append a new Message after replacement.

The optional fake-Provider handler reuses the existing package-smoke transport;
it does not change product permissions or inject records into Yui's database.
Its CLI child inherits the real Host identity plus the Provider's own Thread ID.
Cleanup stops the registered fixture Roles before its Controller and tmux server.
Use a short fixture `TMPDIR` if the environment's default path exceeds native
Unix socket limits; the probe still creates its own random owned directory.
Calibration has a 90-second overall budget, 120 observer reads, a 20-second/
20-read handler budget and 20-second cleanup grace. Raw handler traces are
referenced by terminal digests and retained in saved evidence. This does not establish business P preparation,
Worker assignment/acceptance, sandbox enforcement or model understanding.

`native-worker-probe.mjs <checkout> <new-output-directory>` separately checks
a read-only, Gitless managed Worker. It extracts the exact AgentRun identity
from its real Provider input, loads its frozen Context, expands the original
assigned WorkItem, and attempts self-acceptance using the actual Host identity.
The evaluator requires an authority rejection (not just an arbitrary failure),
an exact completed original Run result, and a still-unaccepted WorkItem.
It changes the live Task title, checks that the frozen original remains
unchanged, then explicitly submits and accepts the inspected Candidate.
This uses the same isolated fixture and budgets as the Session calibration.
It does not upgrade F/P business scores, establish dependency integration or
cross-Project filesystem permissions, or replace the outstanding case wiring.
