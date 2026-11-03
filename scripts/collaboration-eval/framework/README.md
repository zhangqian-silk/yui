# Maintained collaboration framework

## Engineering measurements, Agent analysis

New runs freeze `decisionPolicy: "agent-analysis"` in `plan.json`. Engineering
collects immutable evidence, counts costs and reports objective checks. The
executing Agent owns trajectory interpretation, semantic quality, comparability,
causal attribution and the keep/revise/drop decision. Neither process exit nor
a program grade is an adoption decision. No model review starts automatically.
Historical plans, receipts, grades and seals retain their original meanings.

Default experiment workflow:

1. Assemble a coherent candidate containing related interface, Skill and
   notification changes; record the baseline/candidate commits, changed mechanisms,
   affected Roles and the question that would change the adoption decision.
   Do not start a full A/B for each wording change or a few KB of abbreviation.
   Use deterministic same-input output/contract checks for those changes.
2. Validate the assembled candidate offline, then select only representative
   scenarios needed for the remaining question. Freeze both arms on the same
   harness, business inputs and model configuration. Shared framework fixes
   belong in both arms, not the treatment. Bundle results do not establish each
   component's individual effect.
3. Before any separately authorized model execution, state a bounded number of
   invocations, wall/token spending allowance (including any optional review),
   and stopping rule. Do not automatically replace failed samples, expand the
   matrix or rerun to eliminate every unknown. Current runtime time/idle and
   concurrency limits remain; there is no automatic combined token cap yet.
4. Run `npm run eval:analyze -- <sealed-A> [sealed-B]`. The report includes
   attributed Role/Thread/Turn/stage usage, tool calls, observed output bytes,
   wrapper CLI counts, objective checks, failures and coverage gaps. Missing
   data is not zero. No frozen source bundle is supplied by this command, so
   instruction/body classification and repeat-body bytes are explicitly not
   measured; the existing `history.mjs analyze` indexed-archive flow resolves
   exact frozen source bundles when that additional measurement is needed.
5. The current Agent reads the relevant actual commands, outputs and business
   originals, then writes a separate analysis: mechanisms actually used; quality
   differences; cold/warm and fourth-turn history; additional discovery/confirmation
   rounds; model variation, compaction and infrastructure confounders; recommendation
   and limits. Retain unfavorable and incomplete samples. Independent model review
   is optional and targeted to material unresolved questions, not a default extra
   four-turn chain. Analysis never overwrites raw evidence or old grades.

For new runs, exit zero means collection completed and cleanup is released,
not that the Subject passed every check. A known reading/loading failure in a
non-recovery business scenario remains a failure but may permit later observation
after exact native quiescence and the existing protocol/authority/effect fences.
Binding, wrong CLI, unknown/missing effects, handling, forbidden writes and recovery
boundaries are not relaxed. The existing narrow `business-warm` planning-answer
exception remains; this is not permission to continue arbitrary failed actions.
Historical completion projections keep their legacy nonpass exit behavior.

## Representative business chains

The opt-in business scenarios below use the
same runner, native adapter, CLI, lifecycle, cost accounting and anonymous review
export as the existing scenarios. Freeze it separately from legacy arithmetic
scenarios. It has no padding, tail markers, memory attestations or new service.

| Scenario | Business inputs / expected observable result |
| --- | --- |
| `business-route` | Operator routes a workshop kit request and two revisions to the same Task/Leader, unchanged and with claim/ACK. The plan changes from Cedar 12 + Maple 8, to Maple 16 only, to Cedar 24 only. Both Roles receive cold + two later inputs. |
| `business-conflict` | Leader combines enrolment, warehouse reserve, signed corrections and venue clearance. A newer unapproved logistics draft cannot override signed facts or authorize dispatch. Cedar allocation changes 12 → 10 → 10; Maple is first venue-blocked, then stock-blocked. |
| `business-recovery` | The stage-2 plan is committed before a deliberately retained claim. Existing exact-stop/replacement wiring starts a fresh successor, which reloads instructions/originals, inspects the preserved effect and ACKs without rewriting/replaying it. A later enrolment correction yields Cedar 12 with Maple stock-blocked. |
| `business-warm` | Four routed inputs in the same Sessions. The first three preserve `business-route` exactly. The fourth supplies signed final enrolment and withdraws Maple's earlier exclusion; the existing stock and two-kit requirement still apply. Correct output is Cedar 18 + Maple 12, reserve untouched and 4 kits remaining. Ignoring either new facts or the changed request is wrong. |

`business-warm` complements the padded `normal-warm` transport diagnostic with
a substantive fourth-turn decision. It is not a large-document workload or
proof of native context compaction. Run it as an explicit new freeze, not an
extension or replacement of a previous chain's missing outcomes.

All materials are synthetic. Decisions are planning-only; carrier ETA remains
unknown. Whole cohorts, per-person kits, reserve, request exclusions and signed
source precedence determine the answers across multiple originals. An unrelated
prior-season archive is discoverable but not a required source. Scripts compare
literal objective answers and exact effects/ownership/handling only; semantic
quality requires Agent analysis of the originals, with independent review only
when it resolves a material uncertainty. Full-original/read/load
obligations are retained. An unreviewed Task-context carrier limits instruction
observation to unknown, not the independently observed business dimension;
unsafe violations and unknown effects still stop their chain. Reading/loading
findings follow the bounded policy above. Completion and nonpassing observation
grading remain separate; new runs use collection-only exit status.

```sh
node scripts/collaboration-eval/framework/run.mjs --mode fake \
  --product /absolute/checkout --out /new/existing-parent/business-freeze \
  --scenarios business-route,business-conflict,business-recovery \
  --permission-mode session-only --concurrency 3
```

`plan.json` freezes each scene's original materials, requests and evaluator-only
literal answers; `preflight.json` binds their hash and execution source hashes.
The fake participant receives only actual CLI originals/requests, never the
answer catalog. Anonymous review packages include the business contracts,
originals and request revisions but exclude the objective answer catalog and
program grades. Existing `quantifyInvocation`/history exports measure the full
owned chain, per Role/Thread/Turn tools, failures, wall time, cumulative input and
output tokens and cached subsets. Fake token/billing absence stays unknown,
not an estimate or zero. Exporting a package does not run a reviewer.

New review packages include a sealed dependency-free `read.mjs`: run
`node ./read.mjs V000001 0,12000` inside the case and continue at `nextOffset`.
New packages also support an optional bounded directory
(`node ./read.mjs --catalog '{"role":"leader","limit":8}'`) and explicitly
selected whole-document batches
(`node ./read.mjs --batch '[{"id":"V000001"},{"id":"V000002"}]' 12000`).
The directory's `next` object retains filters and the sealed index hash.
The batch's `next` selections retain each source hash and exact offset.
Each batch has 1–8 selections and a 2–24000 UTF-16 **text** budget; headers are
additional, so leave room in the caller's output budget. Inspect each result:
an invalid source produces an error, while other selected originals remain
readable. The CLI exits nonzero if any selection fails. Literal text and
single-field citation boundaries are unchanged. Body pages include title,
recorded time and Role/Thread/Turn to avoid a follow-up metadata read.
Recorded time is not source edit time or authority; unavailable edit time
remains null. Directory excerpts are literal navigation, never summaries that
replace originals. Known IDs can bypass discovery. These are review-material
interfaces, not new product Task-message CLI operations or loading receipts.
No repository/helper discovery outside the case is needed. `READING.md` and
`view-index.json.stageNavigation` link actual saved producer calls and their
timestamps to each stage's effect observations. A frozen future material is
not an already-submitted request. Missing saved producer evidence stays
unknown. These are source pointers, not expected answers or program verdicts;
raw originals and exact single-field citation validation remain unchanged.

Native CLI identity now needs an owned completed tool in the actual
Role/Thread/context epoch executing the frozen absolute/cwd-relative CLI entry
with `--json version`, before the effect. This proves the probe only. Stage
identity also requires the actual Decision, routed Message or successor ACK
receipt in its exact native command start/completion interval and Turn, with
the owned executable. Addressed `operator submit` binds its structured
Task/Message, submission key and saved-submission identities together.
Historical frozen products' exact `Saved message <id> to <task>.` JSON text
receipt remains readable for audit; malformed structured data never falls back
to text. `task message send` uses its structured Task/Message receipt.
Both still require the exact command target/request key and native interval.
For future captures, the owned process observer also retains complete ordinary
non-JSON stdout up to 32 KiB as `stdoutText`, separately from a JSON envelope.
Only the exact ordinary `operator submit` saved-message identity line can bind
a routed effect, with matching byte count/hash, successful process exit,
target/request key, durable identity and existing native interval checks.
Malformed JSON, conflicting structured data, oversize text or another effect
remain unknown. Captured output is not proof that the model saw or read it.
This does not reconstruct missing text or regrade historical invocations.
All visible completed handling-window CLI commands through that
Turn's terminal are checked, including failed commands and commands completing
after the effect timestamp: an observed foreign entry fails, bare lookup or
unsupported shell shape stays unknown. A warm Turn may reuse its same-epoch
version probe, never a previous Turn/Thread's effect command. Composite CLI JSON
commands are bounded static partitions, not an interpreter or per-atom clock.
A proxy PATH/product label or version probe alone cannot prove business entry.
This establishes supported observed explicit-entry provenance, not hidden
execution completeness, shared-daemon PATH inheritance or OS isolation.
Open native tools/RPCs remain a separate continuation fence, not completed
command identity proof.
No shared daemon or global installation is modified.

Real Subject execution requires an exact product/Skill/input/framework freeze
and explicit resource authority. A single-product exploratory batch is useful:
its purpose can be finding optimization opportunities across business work, not
proving a small saving with single-variable A/B attribution. Independent chains
may run concurrently while each chain's inputs remain ordered. A fake run is
not real-model, constraint-comprehension, cost-benefit, native-compaction or
OS-isolation proof.

Report three separate outcomes: observable business/constraint results,
objective per-Role/Turn cost, and independent semantic review. Missing
load/memory evidence limits its own dimension; it neither erases business
evidence nor turns real errors into unknown. Preserve the original exit and
seal. Do not keep changing a scorer merely to remove observation unknowns.
Summarize the highest-value opportunities with evidence, risk and a next
experiment; descriptive observations do not establish causal savings.
If no verified fresh-session reviewer entry is available, export the existing
anonymous readable package and give its exact path and questions to the Leader
for new-session review. Exporting is not reviewing.

Current exploratory report:
[`run119-business-exploration`](../../../evidence/run119-business-exploration/REPORT.md).

## Three independent layers

1. `run.mjs`: collect frozen Subject evidence and retain the original grades,
   exits, seals and cleanup. `versions.mjs` identifies execution modules;
   analysis/review-only source edits do not change a future run's identity.
2. `history.mjs` / `quantify.mjs`: read saved directory/archive evidence, verify
   seals and preflight identities, index duplicates, measure owned visible
   outputs (including failed tools), exact complete/repeated instruction
   outputs, native tokens and time. `history-quant/1` is supplemental, not a
   retroactive regrade. `analyze.mjs` uses the same saved-evidence reader.
3. `semantic-review.mjs`: export anonymous first-pass cases with a fixed
   rubric, exact historical instructions and complete indexed accessible
   visible trajectories. New independent `gpt-6-luna/medium` sessions judge
   before A/B comparison. Export/import does not execute a model; developer
   self-checks never count as independent review.

```sh
node scripts/collaboration-eval/framework/history.mjs index evidence /new/index.json
node scripts/collaboration-eval/framework/history.mjs analyze /new/index.json /new/analysis \
  run77-host,run82-struct,run91-pair,run95-pages,run102-runtime-pair
node scripts/collaboration-eval/framework/history.mjs view /old-sealed-case /new/readable-case
node scripts/collaboration-eval/framework/history.mjs read /new/readable-case V000001 0,6000
node scripts/collaboration-eval/framework/history.mjs diagnose \
  /new/readable-case /review.json /receipt-paths.json
node scripts/collaboration-eval/framework/history.mjs import \
  /new/readable-case /review.json /new/validated.json /receipt-paths.json
node scripts/collaboration-eval/framework/history.mjs compare /validated-A /validated-B /new/comparison.json
```

All output paths must be new. Archive links/path escapes are rejected before
extraction; only owned temporary extraction directories are removed. No source
Home, Provider, saved commands or historical Subject is executed by analysis.
Retired security diagnostics are inventoried but not reopened.

`diagnose` is read-only and uses the same package, identity and citation
validation as `import`. It reports all criterion-local structural failures in
one response; a rejected review exits nonzero. Identity/package failures do not
credit individual criteria. Valid sibling criteria are not partially imported,
and structural validity is not semantic correctness or independent acceptance.
No quotations, old reviews or program grades are repaired.

The current planning obligation mapping is bound to reviewed complete
Runtime/Leader/Operator tree hashes in `currentPlanningContract`, not VERSION
alone. These include the Runtime31/Leader14/Operator16 tree from `4b63ab62`
and its reviewed Runtime32–37 optional batch-read/manual clarifications.
Runtime35 (`513d7d42`) only clarifies alternative complete-result reads and
mutually exclusive batch forms; it does not remove action-reading obligations.
Runtime36 additionally documents same-frozen-Run batch expansion; it retains
those obligations and does not grant unsupported native reads observation credit.
Runtime37 makes the caller digest optional for that already-pinned Run only;
current Task selectors still require digests, and observation credit is unchanged.
Runtime38 names the complete original-result view as an alternative report read,
without changing action prerequisites, required originals or pagination duties.
Runtime39 clarifies input/refs/full as alternative discovery views; its reviewed
exact tree retains the same action, original and full-body obligations.
This carrier mapping does not grant native evidence credit to unsupported commands.
`plan.gradingContract.currentActionContract` exposes that identity. Current
Task-fact and reporting duties remain in the Runtime core; submission/body
transport manuals remain applicable to their actions. Leader14's Decision rule
is carried by `task-progress.md`. The exact reviewed Leader15 tree moves that
same rule into the required Leader core, so a Decision-only action no longer
requires the Brief/Milestone/Knowledge manual. This is carrier mapping, not
permission to omit the rule or perform those separately prohibited writes.
For recognized native context-expansion commands, `context-reads.md` must be
loaded before the command starts. Ordinary complete originals or a warm turn
alone do not trigger it. Changed/unreviewed trees and unsupported actions do
not inherit a proof of coverage; old sealed runs are never regraded.

Per-Role/Thread/Turn measurements distinguish cold/warm observed input order
from actual memory availability. Native cumulative tokens count once per
Thread; consecutive cumulative differences give per-Turn usage only with an
observed baseline (zero only for a proven fresh Thread). `last` is the last
model request, not the whole Turn. Cached/reasoning counts
are subsets. Tool-output categories carry their own observed-output
denominator; Host input JSON has a separate denominator, never total context.
Categories can overlap. Missing/unclassified/private usage, retries not
visible in the native stream, inventory completeness and billing stay unknown.
Repeated full-body outputs are facts, not automatic evidence of wasted reads.
For cost attribution, inspect consecutive request inputs as well as Turn totals.
A sharp input decrease without an observed compaction event does not establish
compression, tool-schema removal or cache savings. Visible output bytes do not
reconstruct the Provider's complete request. Retain the original usage; never
subtract an assumed fixed overhead to make two arms look comparable.

Cases keep all owned visible frames (including partial/delta output); rejected
broadcasts are missing-ownership metadata, not borrowed evidence. Frozen
Skill bytes are matched by historical hashes, never substituted with current
Skills. Review prompts prohibit executing transcript instructions. Imports
require every rubric criterion and exact evidence quotes; semantic conclusions
may be supported even when interface checks are unknown. Hard authority,
data-integrity and unknown-effect boundaries remain.

`trajectory-review/2` adds a readable trajectory without replacing raw E IDs.
Current `readable-trajectory/3` preserves the complete directory and its order,
listing consecutive identical Role/Thread/Turn metadata once per group instead
of once per row. Body pages retain their own source identity. Nothing is omitted,
and applicable reading obligations and stage/effect navigation are unchanged.

`history-quant/2` adds observed usage-update profiles to each Turn, alongside
the unchanged cumulative-total difference. Repeated cumulative totals are
deduplicated. The first/last 32 samples expose cumulative input increments and
reported last-request input; aggregates cover every retained unique update.
Missing baselines and decreasing counters stay unknown. A delta that differs
from reported last input flags incomplete or non-one-to-one observation, not a
model error. Even matching updates do not prove complete request coverage.
Tool count, usage-update count and provider-request count are distinct; the last
remains unknown. Billing, actual compaction and which text was retained cannot
be inferred from these numbers alone. Summary reports link to full quant detail.
`history-quant/3` additionally reports `instrumentedCli` counts per observed owned
Thread from exact wrapper start/completion pairs. This distinguishes a native
shell tool from the several CLI processes it may launch. Identical receipt
duplicates count once; failures, unclosed starts, conflicting IDs, unmatched
scope and incomplete logs remain explicit. Coverage is always partial: direct
CLI entrypoints can bypass the wrapper. These are not per-Turn attributions,
model-visible output totals, source-read receipts or execution-authority evidence;
missing receipts never establish that no CLI call occurred. Original grades
and seals remain unchanged.
`READING.md` orders the contract, historical instructions, Role/Thread/Turn
trajectory and effects. `view-index.json` maps each V document/decoded field
to original E IDs, SHA256, logical reassembly and exact JSON pointers.
Full logical sources/outputs are not split into thousands of arbitrary files.
The `read` helper prints one metadata header (UTF-16 offsets and nextOffset)
followed by **literal text**, not another escaped JSON envelope. File reads
may also use bounded `sed` slices; continue to EOF where required.

Only one successful complete terminal whose field equals the ordered deltas
byte-for-byte can replace those delta payloads in the reading view. Connection,
Role, Thread, Turn, item and timestamps must agree. Truncation, failure, late
or different content and missing terminal retain every record. Remaining
same-item deltas share a logical document with every boundary/ordinal/time
preserved, not deduplicated. Raw frames and all effect/transport snapshots
remain sealed and available. Full appendices are consulted per constraint;
one unread appendix is not a veto on every other evidence-supported judgment.
This is data projection, not a developer summary or Subject regrade.

V citations must match one original decoded field contiguously (or an exact
frozen source). E citations still match raw fragments. No fuzzy matching,
whitespace repair, ellipses or stitched fields. Original v1 packages and
judgments stay immutable/readable with their own frozen rubric; do not compare
different rubric versions. Fake-provider cases are only scripted observations,
never evidence of real-model constraint compliance.

`receipt-paths.json` contains exact `launchFile`, `transportFile`, `terminalFile`
paths outside the case, owned by the existing review launcher. The launch
receipt records `caseId`, `args`, `freshExec:true`, `resume:false`, `fork:false`;
transport must contain one native `thread.started` and a completed Turn, and
terminal must record successful exit. Import checks the launch's model/effort,
read-only mode, output path and actual native Session, retaining hashes of all
receipts and the original output. The model need not know its Session ID.
Binding is a separate record; never rewrite the model output to add identity
or fix quotes. Configured arguments are not a provider billing attestation,
and Leader still verifies ownership and case isolation. A declaration alone
remains explicitly unverified, not an independent-review pass.

Case labels omit the A/B mapping and program verdicts, kept outside first-pass
directories. Exact instruction content may reveal version clues. `launch.json`
specifies a new read-only `codex exec`, normal account, requested model/effort,
and separate output paths. Leader verifies real execution receipts: declared
freshness alone remains unverified. Reviews/costs stay separate from Subject
measurements; disagreements need adjudication, not retries until green.

This is the current **framework** entry, not the historical performance matrix.
It uses the selected product's real CLI, Controller, Host, SQLite and inbox
authority. Only the external Provider changes between `fake` (`offline` alias)
and `real`; both modes execute `worker.mjs`, the same three-input order,
public submission readback, exact receipt judges, independent observer,
stop/physical-exit checks and archive-before-release lifecycle.
This is a maintained execution path, **not a completed real-model or lossless
evaluation certification**. With the present collector, successful observed
chains remain `observation-unknown`; this entry cannot currently emit an
unqualified `valid-pass`. Do not advertise fake success as overall acceptance.

## Run

Use a supported Node (24 recommended), dependencies/native helpers and tmux.
From the source checkout:

```sh
make install-local
npm run eval:check
npm run eval:collaboration -- --mode fake --product /absolute/product \
  --out /existing-parent/new-output --concurrency 1
npm run eval:wiring -- --product /absolute/product --out /existing-parent/new-check
npm run eval:wiring -- --product /absolute/product --out /existing-parent/new-lifecycle --profile lifecycle
npm run eval:wiring -- --product /absolute/product --out /existing-parent/new-recovery --profile recovery
npm run eval:analyze -- /existing-parent/saved-invocation
npm run eval:analyze -- /saved-A /saved-B
```

The runner rebuilds the selected product once per invocation and records actual
source/build/Skill/lockfile/launcher/harness/material/configuration hashes before
the first fixture call. Public capability discovery is separate from managed
inbox help, which is checked inside the actual managed Turn. Each output is
exclusive; a stopped output is never overwritten or automatically replayed.
Each condition revalidates the frozen harness before setup. The plan contains
raw business data and instructions but no expected answers; only the evaluator
imports `judge.mjs`. Complete and missing-data responses use the same literal
`"unknown"` schema placeholder; it is not an unknown-record count.
The frozen input contract explicitly maps `effectKey` to Decision title and
requires a JSON-only rationale, defines count/total, and maps Operator routeKey
to the routed submission request-id. These are output/protocol rules, not
sample answers. Their hashes are included in preflight/input identity;
unchanged raw source hashes alone do not mean unchanged inputs.
`--source-contract original` (default) preserves the original input verbatim;
`conditional-reuse` selects the reviewed same-Thread conditional-reuse wording.
Both modes use the same runner and unchanged oracle. Configuration identity v2
excludes the business input contract, which belongs to `inputIdentity`, so an
explicit input-only comparison can freeze identical execution configuration and
two distinct exact input templates. Historical v1 identities are not rewritten.
Neither option establishes current model memory or forbids justified rereads.

To test a precise Git product without creating another managed worktree:

```sh
node scripts/collaboration-eval/framework/prepare-product.mjs \
  /absolute/checkout <exact-commit> /existing-parent/new-product-snapshot
```

This uses `git archive`, records source provenance, installs snapshot-owned
dependencies, builds a per-checkout launcher and never creates a Home or changes
global installations. Keep snapshot provenance separate from harness identity.

The opt-in wiring command first requires one complete normal chain, then runs
independent fault/recovery conditions with at most three isolated workers.
Same-chain source/input/terminal/receipt/quality steps remain serial. It proves
normal Draft initialization (no wake), Global OP routing, later exact Task wake
claim/handle/ACK, long-original pagination, delayed second-source material,
duplicate producer request idempotency, retained-claim Session recovery without
repeating the Decision, and cleanup. Lost-response recovery is **simulated**,
not native compaction or model understanding.
`--profile lifecycle` narrows a cleanup regression to the normal chain, unknown
launch fence and active-Turn signal; it does not repeat the unrelated fault
matrix. The default is `full`. Inbox discovery is bounded: this representative
fixture fails closed if its complete current/recovery window exceeds one page;
long business-original content pages are reassembled and verified separately.

Each negative condition keeps a failing result and the maintained runner exits
nonzero. The wiring checker separately asserts the intended failures:
missing ACK, cross-Task CLI read denial, forbidden artifact effect, partial core
load, wrong business total, actual owned collector exit, partial setup, unknown
execution fencing further launches, and a signal during an active native Turn.
An ordinary quality failure does not kill its independent normal/recovery peer.
Forbidden writes are business-contract negatives, not proof of an OS sandbox.

The runner saves `completion.json` and the same `ledger.completion` projection:
`execution` (`completed`, `incomplete`, `failed`), unchanged `grading`,
`cleanup`, and `exitCode`. A full chain with `observation-unknown` is
`execution: completed`, `grading: observation-unknown`. Legacy runs exit **1**;
new `agent-analysis` runs exit **0** only with released cleanup and successful
worker terminals, even when recorded objective checks fail.
Batch callers inspect this receipt and the actual process terminal separately;
they must not assert every historical nonzero exit is an execution exception or
turn unknown green. New exit zero is not quality acceptance. A signal, missing
receipt, inconsistent exit or failed worker remains an
execution problem. Preflight-only execution has no completion receipt; startup
exceptions remain exceptions. Saved-evidence analysis derives the same projection
without altering historical ledgers, grades, exits or seals.

## Real mode and authorization

Explicit `--permission-mode session-only` selects the existing structured
`configured`, `danger-full-access`, `never` configuration for fixture Subjects
only. This requires exact resource authorization just like any real run. It
omits workspace-write exclusions, verifies the actual full-access request and
native receipt, and preserves owned cwd/root, Thread attribution and cleanup
checks. OS sandboxing is explicitly disabled, not passed or proven. The mode
and permission arguments are frozen in the configuration identity; no fallback
from a failed workspace-write run is automatic.

Fixture Operator/Leader permissions now use the structured `configured`,
`workspace-write`, `never` configuration with explicit
`--exclude-tmpdir-env-var true --exclude-slash-tmp true`, not bypass.
The selected product must support these formal permission fields (the
`3250fb8ddb0c0cb3e7a778f18f02bb1bbbefa2fb` candidate uses storage 1.22);
always use a fresh fixture Home, never upgrade a real or historical Home.
This is a candidate
configuration, **not a proven containment boundary**. The real subject proxy
rejects mismatched startup requests/receipts, external writable roots, missing
temporary-directory exclusions, and model Turns without an acknowledged
matching receipt. Rejection never downgrades permissions or starts a replacement
native process. Detached metadata/control clients are not subject launches.
Fast local protocol fixtures exercise these refusals without an account/model.
Fake mode uses the same managed proxy request/receipt/Turn guard. Its synthetic
receipt projects the actual request configuration rather than asserting the
two exclusions unconditionally; fake success is still not OS containment.

The bounded model-free evidence in `evidence/run49-isolation` observed
`workspaceWrite` with both `excludeSlashTmp` and `excludeTmpdirEnvVar` false.
That historical product could not express those exclusions.
Native preflight therefore stopped before any command/model Turn;
CLI/write/escape probes are **not run**, not passed. Real conditions remain
paused pending an explicit structured compilation change, fresh isolation
preflight, separate freeze and Leader judgment. Do not work around this through
base/raw arguments, `-c`, account/global configuration or bypass.

The proxy is a launch refusal boundary, not a native Thread garbage collector.
A rejected receipt can already contain a newly created Thread: its exact
identity remains in owned transport evidence. After stopping owned writers,
fixture teardown checks the transport before deciding whether to remove Home.
An unresolved refusal, recorded invalid frame/JSONL tail or unreadable transport retains
Home and fences subsequent launches through the existing unknown-lifecycle stop.
Only this connection's exact successful `thread/start` request/response proves
a created Thread; a resume or foreign connection is not a new-Thread proof.
No automatic archive or new native connection is attempted. Rejected fixtures
require separate authorized resource settlement; proxy/process exit alone
cannot release them.
Tool filesystem restrictions do not replace Controller authorization: an
authorized CLI request may cause the Controller to write its own Home. Neither
this candidate nor workspace-write establishes full host/read/network isolation.

`--mode real` requires an explicit absolute `--provider-bin` and
`--authorization` source reference. The reference records human/Leader
provenance; it is **not** a new automatic permission gate or permission grant.
Use it only after a separate exact resource/condition freeze authorizes live
validation. No historical unused quota/budget is silently adopted. A preflight
can be produced with `--preflight true`; it invokes no Provider or account API.
It checks executable metadata only and reports `real-resource-unverified`,
never live readiness. Missing attributed full-read evidence is observation
unknown, not a fabricated model failure or a passing read.

The fake-only `--scenarios native-normal` emits completed native
`commandExecution` records from actual fixture CLI/cat calls and deliberately
writes **no participant file**. It exercises the evidence adapter selected
by real mode, not a second real orchestrator or a live Provider probe.

`--scenarios normal-warm` extends the same normal chain to four serial Leader
inputs, routing stages 2, 3 and 4 through the same Operator Session. This covers
Operator cold entry plus two later inputs without replacing a Thread; source
publication remains at stages 1 and 2. Each routed original/read/load/claim/ACK
is retained in `routes` and its stage, alongside the historical first `route`
view. Fake mode uses the native evidence adapter too. Real use requires its own
new paired freeze and authorization; it adds no recovery or security probes.

### Bounded Session replacement

Load deadlines are action-specific. Core/profile, Task/Global entry and business
references retain the Decision/routing effect (or successor ACK) deadline.
The Reporting obligation uses the exact native `item/started`
of the last nonempty agentMessage persisted by the product, or an earlier
durable Message command start. Operator reporting uses its durable route command
start. Missing/ambiguous report/item ownership or start, changed context epoch,
and equal-timestamp read/action order remain unknown; a terminal timestamp never
stands in for report output start. Exact prior-Turn bytes may be reused only in
the same owner/Thread/epoch. This changes new freezes, never historical grades.

For the explicitly reviewed Runtime22→23→24 products, `obligations.mjs` keeps
Reporting's semantic check: a frozen separate reference remains the carrier
when present; only declared exact Runtime23/24 VERSION/main-body hash pairs map it
to the full Runtime entry. Unknown versions/bodies do not waive the obligation.
The independent reporting action deadline still applies, including unknown
dynamic starts. `loads.reportingObligation` exposes its carrier and coverage
separately from base/core coverage; this is evaluator mapping, not subject guidance.
Any Role's recognized actual Task-fact read also requires `task-context.md`
before that native command's start (the enclosing start for a static compound).
No warm-turn counter triggers that reference. Unrecognized/hidden actions are
not declared unnecessary, and missing starts/late or partial bodies stay unknown.

The exact run77 Runtime20/25 main-body hashes also carry Reporting and Task
context inline. Task-fact reads still tighten the full Runtime body's deadline
to the first actual Task read; absence of an extracted file never waives the
obligation. Unknown version/body combinations stay unknown. Historical grades
and seals are not rewritten by these mappings.

The reviewed Runtime26 four-path overlay keeps Reporting and Task-fact loading
inline in its exact `7cf7eb69…a9bdd0b` entry. Its VERSION/body pair is mapped to
that same full-body obligation; shorter content does not waive profile,
applicable references, output completeness or original action deadlines.

For the Host-check candidate, source metadata may instead come from the actual
owned `turn/start` prefix with a matching accepted native response. Warm metadata
requires a prior accepted pointer notice on that same connection and Thread,
matching the frozen product's exact paths/versions and current Manifest. A model
claim or arbitrary notification text cannot provide it. This metadata feeds
only source binding, **never** instruction loads, original reads, authority or
memory availability. CLI metadata remains supported and observed mismatches
remain failures. `skillChecksByTurn` exposes recognized Agent checks, actual
Host prefix bytes and observed instruction reads separately; missing/unsupported
commands remain an inventory gap, not a proven zero.

New freezes also recognize Main `72e1dd5b`'s exact short ordinary marker and
current-working-set cold notice, with the same accepted connection/Thread and
frozen Manifest/profile/path/version binding. No marker supplies body or memory
credit. Historical notice formats remain read-only audit inputs.

The exact reviewed `9236798e` Runtime29/Leader13/Operator15 entries select this
planning fixture's actual action references instead of treating the presence of
`global-context.md` as a universal load trigger. Operator submission/nested-body
transport and Leader Decision maintenance remain required; successor inspection
does not create another Decision-maintenance obligation and adds retained-inbox
recovery. This is evaluator-only applicability, not subject loading guidance.
Runtime29's exact `35689259…a2e5` VERSION/body pair carries current Task-fact
duties in “Use the exact authority and originals” and truthful managed reporting
in its closing paragraphs. That full core is now mapped for both obligations;
the actual Task-read start and independent reporting deadline still apply.
The action references above remain required. Other Runtime29 bodies, unknown
versions or changed bytes do not inherit this mapping. This closes a declared
carrier gap, not lossless observation or model-compliance coverage. Independent
semantic review remains necessary; originals/claim/ACK/effect boundaries are
unchanged, and historical unknown grades, exits and seals are never rewritten.

`normal-warm` fake follows the actual Host notice when present and otherwise
uses the CLI check. This is scripted wiring, not real adoption. First/warm,
affected-only version changes and Host invalidation require separate component
evidence; the normal real chain does not inject a version change or compaction.
Do not infer that a repeated body was unnecessary without instruction-availability
evidence. Keep helper availability identical when comparing Host-check products.

`--scenarios session-recovery` is supported by the same fake/real runner and
native evidence adapter. Enabling real parsing is **not authorization to run
it**. Freeze the exact new product, harness, recovery input/configuration,
limits and resource authority separately before any live execution. For offline
validation, use `--mode fake --scenarios session-recovery`, or the wiring
`--profile recovery` above (normal baseline plus happy/stop-unknown pair).

The second input explicitly asks the predecessor to commit its one Decision,
retain its exact claim and end without ACK. This is a scheduled checkpoint,
not an actual lost-response or provider-crash claim. The coordinator verifies
the original, predecessor claim, committed business effect and exact completed
native Turn, calls the product's synchronous `task role session stop`, and
reads back that exact ended Session **before** `task role session new`.
An unknown or rejected stop fences replacement and the next input. The new
Session is established through the existing product lifecycle; no Session,
mailbox, receipt, Run or Store is patched by the evaluator.

The successor must establish a fresh Thread/start on a distinct connection.
It reloads current entries/profile plus the Runtime recovery reference,
reads the retained original and existing effect through CLI, preserves the
predecessor claim, and ACKs as successor without a new/revised Decision.
Original/claim/effect equality and the independent event/state oracle are both
checked. Predecessor checkpoint/business/read/load checks are retained
separately before replacement; later reads cannot repair its earlier Decision.
Successor read/load evidence uses only its own Thread/epoch before
its ACK; predecessor bodies and terminals cannot satisfy it. Stage 3 checks
ordinary continuation on this successor. The existing fake-only `recovery`
scenario and its original grading remain separate and unchanged.

Recovery inspection accepts the current CLI's direct `inbox show` wake,
the `task wake show` wrapper, and `{taskId, decision}` from `task decision show`.
Paged documents require complete offset-ordered, digest-verified JSON within
the same handling Turn/owner/epoch and before ACK. Missing or unsupported
inspection evidence is unknown and still fences continuation; an observed
wrong exact claim/Decision fails. Observer snapshots never substitute for reads.
The selected terminal must contain the exact successor ACK receipt time, not
merely be the first terminal on its Thread. The offline recovery fixture ends
initialization first, then sends a separate public discussion notification to
exercise later-Turn ACK handling without replaying the original/effect. This
extra notification is fake-only; it changes neither real inputs nor product
Skills. Fresh initialization load bytes may be reused on that successor's
Thread/epoch, never borrowed from the predecessor.

The fake-only `session-recovery-stop-unknown` injects one real native-protocol
background-inspection rejection after the predecessor completes. Wiring must
show the actual stop CLI failure, no replacement request and no third input;
teardown then performs a fresh owned-resource inspection, not a business retry.
Pure regressions also reject old/no-handshake identities and borrowed
predecessor bodies. Offline results prove wiring only. Native compaction,
unexpected provider loss, live model recovery/understanding, current model
memory, account readiness and lossless observation remain unproven.

Real mode uses the normal auth entry without reading/copying credentials,
creating an account, changing a model/account binding, or modifying shared
daemon configuration. Its proxy has no scripted business handler.
Native attribution accepts only successful completed `commandExecution` items
with exact Host-request/response-derived Task/Role/Thread/Turn ownership, recognized CLI read argv and
complete JSON output, or structured `cat` actions whose exact full UTF-8 output
matches the frozen source. It never executes shell text or credits agentMessage
read markers. Arbitrary compound shell, wrappers, segmented/truncated bodies,
bad frames and missing terminals retain explicit unknown inventory coverage.
A supported full read can be proven while the whole tool inventory is unknown.
Detached metadata/control connections intentionally lack managed Home/Role
identity. Their transport is logged as `detached-control` without subject
binding; they cannot satisfy original/Skill read evidence and receive no
injected managed authority. Fast proxy checks cover both environment shapes.

Loads are limited to the same Task/Role/Thread and context epoch before effect,
with exact current source hashes. Confirmed native compaction resets the epoch;
a successor cannot borrow predecessor bodies. Disposition originals must be
complete in the handling Turn after input and before Decision (or before successor
ACK when inspecting an existing effect without replay). Immutable source material
may reuse exact full output from a prior Turn in the same owner/Thread/epoch.
This is observed read coverage, not proof of present model memory: real reuse
adds a separate `reuseAvailability: unknown`. Changed bytes, Role, Thread or epoch
cannot borrow coverage. Late reads cannot repair an earlier Decision.
OP and LD are graded separately. Disposition-input originals
are separate checks from source materials. Exact Global/Task message-show reads
and single-command `-c`/`-lc` shells are supported; unsupported shell does not
become read credit. A CLI write failure may prove a subject error without
proving any read. Actual session Skill metadata must match frozen product
paths/versions, independently of full body loading.
The native proxy may receive broadcasts for unrelated account Threads. A
connection Role label alone is not ownership: the evaluator correlates exact
JSON-RPC ids for `thread/start`/`resume` and `turn/start` within each transport,
checks the requested owned cwd and resume Thread, and excludes unrelated or
unproven notifications from terminals, reads, loads, clocks and tokens.
Pre-fix mixed originals remain restricted and sealed for diagnosis; new capture
minimizes unproven bodies before persistence. Missing handshakes stay unknown; no
other Thread's terminal, tool or cumulative usage may be borrowed.
Literal `cat` and bounded `sed -n 'lo,hip'` reads receive byte-range credit
only when the complete native output equals the exact concatenation of frozen
source slices, including optional reference files. Full coverage requires the
union of verified slices to cover every byte before the effect; no substring,
summary, metadata or model self-report substitutes for missing bytes.
A single literal multi-file `cat` also supports direct-directory `*.md` matches
from the frozen inventory, only with exact whole-output equality. Literal read
sequences joined by `&&` or `;` (including one trailing semicolon) are supported.
Identity `jq .` on a frozen pretty-printed JSON profile requires byte-identical
whole output; projections never prove profile loading. Relative paths resolve
only against that completed command's absolute native `cwd`, never a derived
Role/Home or Thread-start default. Missing/invalid cwd cannot prove relative
identity; exact frozen absolute paths remain independently verifiable.
Identical output from a different path does not prove the requested path.
Native action descriptions are hints, not
path/coverage authority. Recursive/other globs, unknown shell atoms, non-frozen
paths and extra/truncated output remain unsupported; no shell is executed.
CLI content pages may be enveloped or the plain lossless JSON page printed
without `--json`. Bare pages must be the exact single-field `contentPage`
object, with matching source, digest, requested/next cursor offsets, lengths
and completion metadata; full document text still needs its final hash.
The observed five-field text-preserving `jq` page projection can inherit
source/digest only from its exact preceding returned cursor and identical
literal read in the same owner/Turn/epoch. Actual text, offsets and final
whole-document hash still prove completeness; command text cannot supply bytes.
Metadata-only projections, missing/reordered pages and unsupported pipelines
remain unknown. Raw stdout is retained separately from explicit page attribution.
The judge checks all five projected fields against actual stdout before using
the adapter's source attribution. The exact literal terminal projection
` | jq -r '.data.context.contentPage | {complete, nextCursor, text}'`
is also supported, only after a fully verified direct-page cursor chain:
each literal request follows the prior returned cursor in the same read
identity, source, digest and owner/Turn/epoch window. It must return exactly
those three fields, `complete: true`, `nextCursor: null` and actual remaining
text whose concatenation matches the original total length and full hash.
There is no general projection interpreter, dynamic-shell evaluation or
metadata-derived body. A sidecar cannot replace missing returned text.
The proxy reassembles bounded WS text/continuation frames (including interleaved
control frames) before UTF-8/JSON decoding, flags incomplete EOF payloads, and
waits for child stdio and forwarded stdout to drain. The 32 MiB message bound,
credential redaction and owned-only body capture remain explicit limits. These
checks apply only to the actual product `app-server proxy` entry (including
detached clients), not ordinary version/help processes. Ordinary subprocesses
forward stdin/stdout/stderr and exit status without WS decoding or body capture.
Transport records retain only command/protocol categories and exact child
PID/start custody, never argv or upgrade headers. Proxy upgrade evidence is
recorded separately. A metadata process exit is not a Subject native terminal;
an abnormal proxy exit or incomplete frame retains unknown native cleanup.
New freezes use one bounded static read grammar (at most 16 atoms), not
command-count-specific adapters: one or more exact read-only CLI JSON/page calls,
frozen literal `cat`/`sed`/identity `jq` reads, own-Manifest static `jq` object
fields/field aliases, and literal `pwd`, joined with `&&` or `;`. The adapter consumes
every stdout byte once, in command order; JSON documents must match the read
identity, and file slices/projection fields must match frozen source hashes.
Repeated indistinguishable JSON, noise, extra documents, unsupported failures,
wrong cwd/CLI/Home/Role/Thread/Turn and dynamic shell stay unsupported.
For a nonzero native terminal (`failed` or `completed`), only a preceding
all-frozen-file prefix followed by one exactly consumed final GNU `sed`
missing-path diagnostic or bound read-only CLI error envelope receives output
credit. Parent status/exit remain unchanged, per-atom exit status is explicitly
not observed, and the failure suffix receives no data credit. No historical
command runs, body substring hits or generic shell interpretation are used.
One narrow mixed shape also retains output-only file credit: frozen literal
file reads followed by a single exact bound `inbox claim <entry> --request-id
<id> --json` tail, whose complete output is either an identity-matched claim
envelope or a bound error diagnostic. The tail gets no trace, write-success,
authorization or intra-command timing credit; parent command/status/exit and
output hash remain attached. Unknown mutations, dynamic tails and additional
atoms remain unsupported. Exact Run `--view refs` documents can participate in
read-only sequences but their pointers never imply original/body reads.
This grammar does not expand the separate Reporting-action grammar or deadlines.
Manifest projections credit only displayed fields, not a profile/Skill body;
Manifest files/projections are metered separately from instruction bodies.
Static CLI message-send sequences may use the unique enclosing native command
start as a conservative reporting deadline, explicitly not the later
subcommand/save time or proof that a write was authorized/successful.
Planned SIGTERM closes are separate from unexpected exits only with exact
PID/start custody and observed stop signal, successful scoped control interval,
all owned native Turns terminal, no unresolved RPC, and same-Thread idle plus
empty-background response metadata. Missing proof keeps cleanup unknown.
Repeated SIGTERM receipts must all name that same child and scoped stop
interval. Exact per-connection append order disambiguates same-millisecond
RPCs; equal timestamps alone prove no order. These checks never turn a signal
or successful stop command alone into quiescence.
The proxy retains only tiny request-matched lifecycle metadata from detached
control responses, never unrelated Thread bodies or account credentials.
This is local execution quiescence, not account Thread deletion/settlement.
Continuation is separate from grading: observation-only read/load/Skill-metadata
coverage or memory-availability unknown may collect the next planned synthetic
input only after exact owned Turn/RPC/tool endpoints are proven, with business,
handling, routed input and observed authority checks passing. Missing identity,
pending operation, forbidden effect, provider refusal or technical failure still
fences the chain. This evidence bounds observed execution, not OS background
absence. Never replay the current input to fill a grade or promote unknown to pass.
This distinction changes new freezes only: old unclassified connections cannot
be retroactively declared metadata or their cleanup debt erased. These
deterministic checks do not prove historical raw-wire completeness: absent
model output, native-tool truncation and collector loss are separate unknowns.
The fixed normal planning scenario requires Leader planning/dispatched-Run
references in addition to full entries/profile. Context-ordering is conditional
on an actual intent conflict, stage handoff or incremental maintenance, never a
warm-turn number alone; the explicit Session-recovery handoff adds it. Leader
business stages 2 onward reconcile actual changed facts/requirements in the
frozen scenarios; their cold stage 1 does not inherit that requirement merely
because it is a business scenario. Operator forwarding does not reconcile them.
Leader
managed final reporting and Operator durable routed Messages make reporting
applicable, not the arrival of another Turn. Historical frozen oracle/results
are not rewritten by this new-freeze applicability correction. Operator has no
delivery/serial-delivery or temporal-conflict reference requirement in this
plain route. This applicability set is evaluator-only and frozen in `plan.json`,
not extra subject guidance; other conditional references are not declared
universally unnecessary. Original reports retain their old oracle unchanged.
When the frozen product contains Runtime21's extracted references, normal
Operator routing also requires Global context and Reporting; Leader planning
requires Task context and Reporting. These are the existing obligations moved
out of the entry, not a scripted subject loading policy. Missing extracted bytes
must not earn load credit merely because the entry became shorter.
The adapter has sealed-native replay, local native-protocol fixture coverage
and bounded live gpt-6-luna/medium three-input observations in `evidence/run38`.
Those observations retain read/load gaps and failed/partial comparison sides;
they do not establish an unqualified paired benefit, native compaction or
arbitrary Provider readiness. Offline preflight/fake success alone guarantees
neither live compatibility, availability, quality, authentication nor stop.

The subject prompt pins an absolute fixture entry that delegates to the frozen
product launcher and restores its Node/PATH, without changing inherited Home or
managed identity. `native-normal` also exercises a real login shell with PATH
deliberately missing that entry and Node; it checks the selected Skill paths and
versions against the managed CLI result. This is environment wiring evidence,
not evidence that a real model followed the instruction.
Environment-only `AGENTS.md` is also installed in the exact owned Operator and
planning Leader cwd before the first Thread. Role profile instructions alone
cannot constrain CLI selection before that profile is read. Its body/hash/bytes
are recorded separately; `native-normal` checks file availability at actual
`thread/start`, not automatic native inclusion or comprehension. This explicit
entry condition does not establish that the default bare-CLI path is fixed.
An opt-in new freeze may use `--cli-entry-mode owned-relative`. It offers the
same wrapper as `./bin/yui` at the owned root, or
`../../../../../bin/yui` at the planning Task cwd; other cwd changes require the
absolute entry. The adapter resolves slash-containing relative entries only
against the actual native command cwd. Login/non-login shell checks exercise
cwd changes, replaced PATH, spaces/quotes, Node, Home, managed identity and argv;
a wrong cwd fails, without a global fallback. Both arms and all cold/warm inputs
must use this same mode, configuration and collector. Default stays `absolute`;
the mode is included in the frozen configuration identity. Neither mode loads
Skills/materials on behalf of the model or supplies answer/read-policy hints.

Frozen real limits allow five minutes per awaited native terminal, separately
from a 90-second limit without a novel completed tool. Repeated identical
commands/results do not reset that idle clock. Fake limits remain 45 seconds.
Neither limit authorizes replay or changes resource ownership. Missing read/load
attribution alone may continue to the next normal input, with the unknown grade
retained; unknown protocol/effects, business or authority checks still stop it.
For `business-warm` only, a known single committed JSON planning answer that
differs from the business truth may continue to the next independent input if
it is the sole failed check, protocol/legal checks pass and the same native
endpoint/identity conditions hold. This preserves observation of the fourth
input instead of censoring it for an earlier answer omission. It never repairs
or replays that Decision: per-stage and whole-chain quality remain failed,
completion grading is `quality-fail`; new `agent-analysis` runs use the
collection-only exit contract above. With that policy, reading/load failures in
non-recovery business scenarios are retained for Agent analysis and can coexist
with the known planning-answer exception. Missing/duplicate effects, malformed
answers, wrong routing, forbidden writes and unresolved execution still stop.
Other scenarios retain their previous reading/load fences. Costs from such a chain are observations,
not a same-quality savings claim; all historical frozen grades remain unchanged.

## Evidence and interpretation

`preflight.json` and `plan.json` bind this invocation. Per-condition evidence
contains original CLI bytes, decoded native WS events, full independent SQLite/
owned-file snapshots, product event/watch journals, participant instrumentation
(fake only), exact stop/terminal/process identities, archived owned Home and
cleanup result. `ledger.json` retains every started/not-run/failing condition;
`seal.json` hashes the bundle. No retry, swallowed ECONNRESET, guessed terminal
or unconditionally global cleanup is provided.

Results distinguish framework invalid, quality fail, infrastructure failed,
interrupted, not-run, observation unknown and fully valid pass. A completed
Turn is not a completed chain. Three business stages must complete; each
protocol, full-original, cold-load and business check is separate. Endpoint
and `fs.watch`/event snapshots cannot prove arbitrary SQL write-and-restore
absence; lossless journal coverage remains unknown. Normal fake runs therefore
report `executionChecks: pass` but `status: observation-unknown`, **not** an
unqualified valid model/performance pass. No comparable A/B saving is emitted.

The read-only analyzer reports independent observed stage dimensions and, with
two sealed invocations, descriptive common-stage comparisons under matching
input/harness/configuration identities and scenario. Unknown memory availability
does not erase a business or constraint-behavior result. Known failures remain
failures; missing dimensions/terminals and mismatched freezes cannot compare.
Route fidelity/handling, actual model identity and cleanup remain separate facts.
This does not loosen full-quality `comparable()`, modify old grades, establish
arbitrary unjournaled-effect absence, or emit a causal savings claim.
Reported reuse availability is unknown even when an original cold-stage check
says pass because no prior-output reuse was identified; its source status is
retained, not interpreted as proof of memory.

The same analyzer exposes recorded `skillChecksByTurn`, `recovery` and `account`
without regrading them. These are read/metadata observations, scheduled recovery
checks and billing evidence respectively, not new proof of comprehension,
native compaction or complete cost. Absent records stay unknown/not-recorded.

Visible costs separate CLI output, metadata, Manifest, core/topic/profile
bodies, repeats, fragments and notification bytes. Native token totals use the
last cumulative usage per Thread; cached input and reasoning output are subsets,
never added twice. Missing usage/account/hidden inputs are unknown, not zero.
`repeatedFullBodyUtf8` retains the historical cross-context raw repetition count;
it is not avoidable loading. `fullBodyContexts` separately counts full-body reads
and bytes first observed or repeated within the same Task/Role/Thread/epoch and
source path/hash, plus unattributed bytes. A new Turn alone permits reuse; a
different role, Thread, epoch or source starts a separate context. Fragments do
not establish a prior full load. Even a same-context repeat is only an observed
read, not proof that earlier instructions remained available or the read was
unnecessary. These byte metrics are not model tokens or complete context shares.
`fullBodyContexts.firstObservedReads`, `repeatedReads` and `unattributedReads`
count those same observed complete body outputs, not tool calls, recovered
fragments or avoidable rereads. Historical results lacking these fields have
unknown counts; do not infer them from byte totals or rewrite old seals.
Concurrent wall times include resource contention and cannot be labeled context
cost improvements.
Recognized native read totals are lower bounds; unknown command, Manifest and
total CLI costs are not zero. Observed subject ACK/read/load/authority violations
are `quality-fail` with per-check facts; `framework-invalid` is reserved for
actual plan, binding or fixture contract failures.
Routed JSON is compared as an object: whitespace/key ordering is immaterial,
but changed string values, target or request key are subject failures, not a
fixture-identity failure. The exact saved body remains the handling/read and
duplicate-submission identity.
An absent routed original is instead unknown delivery/effects and stops the
chain without replay. It is not evidence of changed scalar values, and a
runtime error before submission must not be mislabeled as quote loss. Regular
body files and stdin remain product behaviors, not evaluator rewrites; a
component roundtrip alone does not prove an asynchronous stdin pipeline works.
Decision state/event deltas must match the one allowed Leader-created effect;
extra, changed or journaled reverted effects fail without claiming arbitrary
unjournaled restore is observable.

Live JSONL readers consume newline-committed records. An unfinished append tail
remains unknown inventory until complete; malformed complete records are not
silently ignored. Final parse errors retain a failure report and raw evidence.

Teardown is registered before setup/owner/collector. It first stops registered
owned Tasks through `task execution stop`; `session stop --all` is an idle
maintenance operation and must not substitute for cancelling active Runs.
It then stops exact sessions
through existing CLI, records control results separately from native terminals,
captures PID/start identities, stops only that Home's Controller/tmux namespace,
finalizes its collector and archives before deleting its own root. Unknown
writers retain the Home and owner evidence; no hard-kill or old-resource sweep.
The historical performance count stays **59**; framework scenario counts have
their own ledger and do not establish original Task acceptance.

## Entry routing and integration

The evaluator-local [bound original page forwarder](original-reader.md)
offers explicitly selected Run/Task/Global original routes through the existing
fixture CLI/Home binding and inherited managed identity, without manual identity
arguments. One invocation forwards exactly one authorized CLI page's whole stdout,
with no extra wrapper, full-download loop, padding removal or cache.
`--original-tool available` installs its fixed evaluator-only executable and
optional usage in the owned startup guidance; default `absent` preserves the
old subject tool environment. This factor is frozen separately from unchanged
business inputs and common configuration. Both arms share the native adapter.
Only a static absolute Node/tool invocation with exact native owner/cwd/start,
frozen file hashes, captured actual CLI outputs and exact native stdout can
feed the existing page continuity/full-document hash judge before the action
deadline. A single page, internal download, summary,
metadata and unsupported dynamic shell cannot fill a gap or load other fields/
Skills. The append-only audit is experiment evidence, not a cache, authority or
OS-tamper guarantee. `normal-warm` fake B exercises the same actual product
Run/current-Task/Global inbox entries in actual login shells and expected bounded
rejections. The old range/refetch path is audit-only, not an active fallback.
New review exports include `manifest.subjectRunFacts`: only matching `mode`
values from the frozen plan and its hash-bound preflight establish configured
`real` or `fake`. Source hashes/pointers are retained without provider paths,
A/B labels or grades. Missing/conflicting facts remain `unknown`; reprojecting
an old package cannot reconstruct missing facts from a model narrative or its
old unproven `subjectMode` label. Configured real does not prove execution,
compliance, billing or absence of side effects. Reviewer conclusions about
effects need commands/results and saved observations, not final self-report
alone. Original packages and judgments are never rewritten by this addition.

No product CLI/Skill changes or model-load receipts are introduced; real
availability-only experiments still require their exact resource/freeze authority.

| Entry family | Current purpose / route |
| --- | --- |
| `framework/run.mjs`, `eval:collaboration` | Maintained unified orchestration; fake validated, real explicitly limited above |
| `framework/*.check.mjs`, `check.mjs`, `eval:check` | Fast contracts plus local Node stdio proxy check; no Yui Home, model or account |
| `framework/wiring-check.mjs`, `eval:wiring` | Opt-in framework wiring/fault verification, not default `npm test` |
| `framework/analyze.mjs`, `eval:analyze` | Read-only sealed invocation analysis; no Home or rerun |
| parent `run.mjs`, `cases/*`, context proxy, compare/analyze | Legacy deterministic business/context research and saved-record analysis; not the unified real runner |
| native session/worker probes | Historical bounded calibration, not full-chain acceptance |
| offline/replay/shared/dynamic/native experiment runners | Historical budget/freeze-specific experiments; no current authorization or fallback route |
| `evidence/*` execution scripts | Immutable historical reproductions only; **never** a maintained execution dependency |
| `reuse-fixture/component.check.mjs` | run33 narrow historical component (old output binding); not the new entry |

For main integration take `framework/*`, package scripts/docs and these reusable
parent modules only: `turn-reader.mjs`, `replay-observer.mjs`,
`role-boundary.mjs`, `evidence.mjs`, `shared-collector.mjs`,
`reuse-fixture/handling.mjs`, plus `test/fixtures/fake-codex-cli.mjs`.
Their hashes are in preflight. None imports historical `evidence/*`.
Do not cherry-pick the whole research branch or large historical evidence tree.
Existing package smoke retains package/OS lifecycle coverage; this opt-in command
adds the evaluation chain and must not be multiplied across the ABI matrix.
Leader independent review and legal Integration are still required.

## Evidence privacy

The proxy forwards protocol bytes unchanged, but persists native bodies only
after exact connection-local Thread/Turn ownership is established. Unattributed
messages retain minimal IDs/status plus omitted-body byte count/hash, not tool
commands, output or agent text. A subsequently proven subject message whose body
was minimized remains an explicit observation gap, never a pass or zero cost.
Failure attribution retains owned tool IDs/status/exit codes and the original
native terminal even when command/output bytes are absent. Only an established
CLI command and observed rejection envelope prove a subject CLI error; missing
or unsupported command/output remains unknown, not an empty failure inventory.
An owned CLI's typed `CONTROLLER_ACCESS_DENIED` with `delivery=not-sent` is
infrastructure failure when the required business effect is absent, even if the
model ends its Turn as completed. A free-text EPERM, unknown command attribution,
or unknown delivery cannot establish that classification. Preserve prior sealed
grades and record any corrected attribution separately; do not rerun the model
to repair a report or relax the socket/sandbox boundary automatically.
Pre-fix mixed originals must remain restricted; derived shared bundles filter
subject events and carry separate hashes/seals rather than copying foreign bodies.

## Offline read attribution

The native adapter can partition one exact bound claim receipt between static
CLI reads, without treating the claim as a read, effect, authority receipt or
per-atom timestamp. Inbox and Task-wake output wrappers remain distinct.
Unpartitioned dynamic shell, projected original bodies and truncated output
remain unsupported. Offline re-adjudication must preserve original grades and
identify the adapter version; it never executes captured command text or fills
missing bytes with internal downloads, correct answers or Host metadata.

The exact non-JSON Run-expand `{ref,value,digest}` view and non-JSON
`session skills` value are also lossless CLI outputs. They retain raw stdout;
source/argv identity and actual original equality or frozen metadata still
apply. A literal bound help call may delimit a static read sequence using its
complete `Yui <path>`/Usage/Examples text layout. Help receives no read/load or
metadata credit and is metered separately; strings mentioning `session skills`
inside help are not calls. Noise, truncated values, mismatched help paths and
non-read tails stay unsupported. Arbitrary body-file scripts do not acquire
Reporting-action attribution from this output grammar.

Frozen Run batch expansion is recognized in new freezes for the exact repeated
`--context-ref store/refId[@digest]` grammar, with 1–8 unique ordered selections.
Plain and JSON-enveloped complete outputs must bind Task/Run and every selected
store/refId, optional supplied digest, actual value hash and entry hash.
Paged outputs additionally retain the exact ordered-selector source, returned
cursor chain and complete-document hash before any item receives read credit.
Directory headers or arbitrary `items` arrays do not prove original reads.
The same native owner/Thread/epoch/deadline checks apply; no historical grades
are changed.

Current Task `context inspect` batches are also recognized for exact repeated
`--context-ref store/refId@digest` or the mutually exclusive `--refs` JSON array.
Every mutable original still needs its digest; optional revision is metadata.
Task, ordered selectors and each actual value hash must match. Pagination uses
the normalized selector source and the same complete-response checks. Only the
selected `{ref,value}` originals receive credit: derived `result`/`execution`
projections are not authenticated by the original's digest and are not flattened
into additional evidence. This observes the existing independently pinned reads,
not a new cross-record snapshot or a change to authorization or historical grades.

### Exact CLI process receipts

New fixtures instrument their existing absolute CLI wrapper with
`cli-process-receipts.jsonl`. It records invocation start/terminal identity,
arguments, launcher hash, stdout hash and a bounded JSON envelope, while forwarding
the actual stdout and exit code. No product installation or authority changes.
These records are evaluator telemetry, **not model-visible read or Skill credit**:
shell redirection can hide captured output from the Subject.

A single successful effect receipt can be correlated to the exact owned
Home/Thread, frozen launcher, native command interval and durable effect
ID/request ID/time. Missing, partial, duplicate or mismatched evidence remains
unknown. The original CLI inventory grade stays unknown when shell commands
cannot be parsed; the receipt does not prove all commands or OS isolation.
For future runs only, that exact effect identity plus a matching native version
probe, no observed wrong/unresolved CLI entry, known-good business/handling/
authority checks and settled native endpoints permits observing the next input.
It does not upgrade the grade or replay the previous effect. Old seals and
grades are unchanged.

`item/started` is a native notification, not an OS spawn timestamp. The complete
process receipt must remain inside the selected native Turn; the exact durable
effect must fall inside one command's start/completion interval with matching
cwd. The receipt may begin before that command notification. No arbitrary
clock tolerance is added; an effect before notification, missing Turn start,
ambiguous interval or different cwd still supplies no continuation proof.
