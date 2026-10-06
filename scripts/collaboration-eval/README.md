# Collaboration evaluation — implementation in progress

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
acceptance, frozen assignments, native permission fences and genuine
predecessor/successor Session handoff are not yet wired. A string saying
“accepted” in business material is not a native acceptance receipt. The
deterministic participant runs as a bounded local child, outside a managed
Agent Role. There is no filesystem sandbox or proof of model understanding.

## Run, then analyze

Use supported Node (24 recommended) and the per-checkout isolated launcher:

```sh
make install-local
node scripts/collaboration-eval/run.mjs \
  --version /absolute/path/to/Yui \
  --case C01,W01,R01,A01,O02 \
  --out /absolute/path/to/a-new-report-directory
node scripts/collaboration-eval/analyze.mjs /absolute/path/to/a-new-report-directory
```

`--case` accepts comma-separated IDs (including explicit variant IDs), `dev`,
or `all`. Selecting `dev` includes its four variants. `--mode F|P|all` defaults
to F. The complete declared selection is `--case all --mode all`, yielding 33
conditions across 24 base cases. P conditions currently remain `not-run` with
an explicit missing-adapter reason; they are never replaced by a Controller
restart. Any selection containing holdout requires `--allow-holdout true`.
Do not use that flag until development calibration and strategy freeze are
complete. Merely listing or statically hashing holdout is not executing it.

The report directory's parent must exist. An existing directory is refused
before creating any fixture. Each invocation reserves a new directory and
stores append-once `evidence.json` plus SHA-256. `record.json` without complete
evidence denotes an interrupted save; analysis must not fill in its history.
The analyzer only reads and hashes saved records. It does not import the
runner, start a Home, contact Yui, repair evidence or rerun cases.
Hashes detect accidental change, not hostile replacement of both record/hash.

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

## Resources, costs and bounds

Each condition owns a fresh temporary user directory, YUI_HOME, fake Provider
executable and tmux namespace. Only the absolute target checkout launcher is
called. This F adapter never activates an Agent, and the fake executable
cannot fall back to a real model. All data and Git repos are artificial, local
and remote-free. Knowledge projects are fixture-owned, not real Projects.

Cleanup is registered before `setup`, which can start a Controller. On success
or exceptions it stops the exact owned Controller, releases its tmux server,
then deletes only the fixture root; uncertain cleanup retains ownership data.
The grace budget is shared across cleanup commands. SIGINT/SIGTERM request a
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

The trace separates preparation, queries, writes and cleanup. Analyzer reports
their call counts, UTF-8 returned bytes and elapsed times separately. This is
not model latency; bytes are never converted into precise tokens or prices.
Model calls are zero, tokens unverified, costs N/A, human preparation unknown.
Fake-runtime setup warnings remain in raw stderr, not silently hidden.

## Focused checks and remaining delivery

```sh
node --test scripts/collaboration-eval/check.mjs \
  scripts/collaboration-eval/cases/tests/business.test.mjs
```

Checks cover business outcomes, deliberate duplicate effects, readback/digest
boundaries, active native records, selection/denominators and holdout opt-in.
Old first-slice O02 simulator checks remain useful independent regression
evidence; they are not the current 24-case runner.

Still outstanding: genuine P lifecycles, native frozen assignment/acceptance/
permission wiring, fair saved-record A/B comparison, dev-then-frozen-holdout
baseline, final manual quality disposition and Task-level delivery validation.
Product optimization should follow those measured gaps, not this adapter's
normal scripted outcomes. The Task is not complete.

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
included in terminal outputs. This does not establish business P preparation,
Worker assignment/acceptance, sandbox enforcement or model understanding.
