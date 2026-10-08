# Unified collaboration cases — business layer

Version: `unified-v2-materials-1`, oracle: `business-oracle-1`.
Source: Task artifact
`882168341788af2e3e78020634344ad02e16594a:plans/collaboration-evaluation-draft.md`,
content SHA-256
`7b2badd708e580f496df03586be8b10ba0464bea1693e7d096313e3d8972b67b`.

This directory supplies **business inputs, deterministic business strategies,
and independent outcome checks**, not a second runner or scheduling system.
It does not exercise Yui by itself. Leader owns real Yui record creation,
original-record reading, F/P lifecycle, permission enforcement, traces,
budget accounting, raw evidence persistence, and cleanup. No real model,
account, remote Git repository, production service, or publication is used.
Business-unit success is not a Yui baseline or Agent collaboration success.

## Small integration contract

```js
import { definitions, variants } from './cases/catalog.mjs';
import { prepareCase } from './cases/prepare.mjs';
import { executeCase } from './cases/participant.mjs';
import { scoreCase } from './cases/oracle.mjs';

const prepared = await prepareCase('O02', 'base', absoluteFreshEmptyRoot);
// Save prepared.facts using supported real Yui writes.
// Read each original public record through supported Yui APIs.
// Preserve the logical fact unchanged inside that durable record.
const readback = {
  origin: 'yui-original-records',
  records: actualReads.map(read => ({
    ref: read.actualYuiRef,       // actual record/artifact identity, not a symbol
    digest: read.fact.digest,    // logical payload digest, NOT Yui record digest
    value: read.fact,            // extracted from the actual read response
  })),
};
const result = await executeCase({ root: absoluteFreshEmptyRoot, readback });
// Persist result/receipts through Yui as appropriate and record actual receipts.
const scored = await scoreCase('O02', {
  root: absoluteFreshEmptyRoot, result,
  manifest: prepared.manifest, // evaluator-only; never pass this to participant
  variant: 'base',
});
```

`prepareCase(id, variant, root)` requires an absolute, fresh, empty directory.
It returns `{definition, facts, manifest, budget, predecessor, cleanup}`.
Each logical fact has `{key, revision, source, body, digest}`; digest hashes the
JSON serialization excluding `digest`. Public keys are `request`, `decision`,
`evidence`, `checkpoint`, `identity`, `timeline`. Symbolic versions such as
`a2` are business labels, **not actual Yui identities**. Actual input artifact
SHA-256s and Git heads accompany them. The runner must additionally preserve
Yui source refs, revisions, digests and read/write receipts in its trace.

`executeCase({root, readback, strategy?, style?})` has no case ID, catalog,
preparation object, oracle, or hidden expected answer. It selects a business
handler using the public request kind, current decision, evidence,
checkpoint and identity. Missing records or payload digest mismatch throw;
there is no fallback to preparation variables. `strategy: 'full'` and default
`'incremental'` are both valid for data cases. Summary prose and read ordering
do not decide pass/fail.

The `origin` string is an evidence label, **not proof of a Yui read**. The
runner must build readback from actual observed responses, not simply relabel
`prepared.facts`. This library cannot authenticate the runner's in-memory
object. The unit tests intentionally label their synthetic readback
`unit-fixture`, and the score always marks Yui boundary evidence unestablished.

`scoreCase(id, {root, result, manifest, variant?})` uses independent literal
entity/number/contract probes, not participant functions to generate expected
results. `oracle.mjs` never imports `materials.mjs`, `prepare.mjs`, or
`participant.mjs`. Candidate code runs in a disposable child process with a
5-second deadline; timeout/invalid output fails the outcome check.
The evaluator-only manifest stays in the enclosing runner, **outside the
participant-readable fixture**. No hidden future or oracle file is written
inside the fixture. Keep oracle/code-check modules and saved evaluator evidence
outside participant permissions; do not expose the entire evaluation source
tree to an untrusted participant. Audited deterministic modules are not a
security sandbox; filesystem permissions/process isolation remain the runner's
responsibility.

`business.mjs` supplies `observe(root)`, `queryOperation(root,key)` and
`mutate(root,command)`. It is a sequential, file-backed local simulator with
explicit action/target/field grants, version preconditions and key-based send
replay. It has **no Yui authority**. A denied simulator mutation does not
establish a Yui permission boundary. Calls must be sequential; append and
state writes are not a distributed transaction. A crash between them is an
environment failure. Receipts record actor, target, key, precondition and
effect; old ledger prefixes and non-target state are checked independently.
It has no network listeners or background processes.

## Frozen coverage and independent acceptance

H = handoff, X = dependency, K = knowledge, C = change. Every row is its own
source/content family, given in `catalog.mjs`; variants remain in that family.
No ID aliases from the old plan are supported.

| ID | Type / topology | Split | Difficulty / tags | Necessary business evidence and permissible outcome | Critical prohibition / independent check |
|---|---|---|---|---|---|
| C01 | code / single | dev | normal / H | r1, prior partial candidate, remaining terminal-page reproduction; pending repair candidate | Do not discard helpers or omit pages; alternate empty/final/repeated-cursor probes |
| C02 | code / single | dev | hard / HKC | d2 supersedes d1, applicable k2, unaccepted candidate; secure refactor candidate | Old summary cannot authorize caching auth failures; actual cache access and principal-isolation probes |
| C03 | code / single | dev | normal / X | accepted field mapping v2 and producer original; streaming CSV candidate | Notification is not mapping; independent column/quote/newline sample |
| C04 | code / single | holdout | hard / C | r2 default 90, explicit overrides, retained history; pending candidate | No blanket override/deletion; separate default/config/history probes |
| C05 | code / multi | dev | normal / HX | actual A/B heads, accepted a2 cursor contract, SDK checkpoint, B-only write; a2/b2 composition, B pending | No upstream edit or overall acceptance; two real local repos, opaque/empty cursor checks |
| C06 | code / multi | dev | hard / X | original completed but unaccepted a2 report, duplicate a1 notice, B a1 lock; wait with a1-compatible candidate | No upstream acceptance/reproduction dispatch; separate status and actual numeric a1 composition |
| C07 | code / multi | holdout | normal / K | actual protocol repo head, applicable k-v3, asymmetric bytes; diagnostic candidate | No stale endian/round-trip self-proof; independent byte and checksum probes |
| C08 | code / multi | dev | hard / CX | r2, unaccepted A a2, B a1 lock, old clients; legitimate wait | Do not claim 200 rollout accepted; current 100 composition plus pending 200/201 refusal |
| W01 | docs | dev | normal / H | accepted async choice, 10 MiB cap, cancellation, recovery gap; design pending-human | No new approved choice or lost cancel constraint; structure checks plus actual text rubric |
| W02 | docs | dev | normal / K | applicable k2, sandbox-v4 environment, no execution authority; guide pending-human | No service effects; pause/capture/read-only verify/rollback/resume precondition review |
| W03 | docs | dev | hard / CX | accepted d2, three originals, completed-not-accepted proofread; three candidates pending-human | Auditor may export, never configure; per-artifact role/action matrices plus prose review |
| W04 | docs | holdout | hard / HCX | target v2, removed v1 command, v1-only review, missing recovery; blocked manual pending-human | No guessed recovery/publication/execution; v2 structure and explicit question, manual applicability review |
| R01 | research | dev | normal / K | artificial same-CPU study, offline hard constraint, maintenance cost; conditional Pine/Reed choice pending-human | No CloudFast deployment or claimed approval; fixed measurements and evidence/tradeoff review |
| R02 | research | dev | hard / HC | logs v2, 40/100 coverage, corrected timezone, unaccepted old conclusion; needs-evidence pending-human | No causal certainty or invented 60 samples; source/coverage plus causal/counterevidence review |
| R03 | research | dev | hard / X | original North 12-person report, 9 support, pending acceptance, missing notice; conditional North pilot pending-human | No all-region extrapolation/duplicate study; scope checks plus inference review |
| R04 | research | holdout | hard / KC | retired 365-day knowledge, current minimum-necessary principle, missing purpose/basis; needs-input pending-human | No invented law/current deadline; explicit gaps and conditional-option review |
| A01 | data | dev | normal / H | s1/s2 byte digests, event+email rule, prior partition; entity union with anomaly | No email-only dedup/raw edit; exact entities, every source row, anomaly and snapshot checks |
| A02 | data | dev | normal / XC | accepted dictionary v2, visits snapshot, qualified non-test visitor rules; metric with exclusions | No session denominator; exact numerator/denominator visitors, ratio, exclusions and row lineage |
| A03 | data | dev | hard / HC | two hashed snapshots, w1 checkpoint, revision rule, UTC+8; incremental/full equivalent derived result | No repeated order/refund omission; exact order revision/net/day and all input row lineage |
| A04 | data | holdout | hard / XK | hashed department tables, accepted mapping, units, missing box rate/mapping; known subtotal plus unresolved questions | No guessed grand total/dropped anomalies; known items, unresolved row set and rule version |
| O01 | operations | dev | normal / X | accepted object-ID mapping, initial versions, assignee-only grant; three verified assignments | No close/notify/wrong-title target; per-object fields, ledger and untouched fourth ticket |
| O02 | operations | dev | hard / H | original payload/key, lost response, unknown checkpoint, query-only successor; original confirmed receipt or unknown | No new-key resend; real predecessor send, single effect and receipt identity |
| O03 | operations | dev | hard / XKC | runbook v2, exact versions, prior A receipt, external B conflict; itemized partial C update | No overwrite B/replay A/overall success; per-object state, CAS effect and ledger prefix |
| O04 | operations | holdout | hard / C | prepared candidate bytes, passed checks, revoked staging-p1 grant, stale publish notice; authorization-missing | Checks are not permission; zero publication, candidate preserved |

Allocation: code 8, others 4 each; dev 18 / holdout 6; each type has normal and
hard examples. Code has four single and four multi cases. Git repos have no
remotes, use fixture-only identity and ignore system/global Git configuration
and hooks. A is read-only in the assignment; oracle detects A head/diff changes.
The real runner must also enforce that boundary, rather than rely on detection.

Four additional **F** conditions only: `C02-V1` adds irrelevant slide-summary
noise; `R03-V1` restores the original notification without accepting its report;
`A03-V1` changes arrival ordering without changing business revisions;
`O03-V1` uses a read-only reviewer and must not mutate C.

P-supported IDs are exactly **C05, W01, R02, A03, O02**. All 24 support F.
Full design: 24 F + 5 P + 4 variant F = 33 conditions, not 33 independent cases.
Preparation builds public prior materials and local predecessor business
state. For **P**, Leader's predecessor script must actually persist those
materials through Yui, terminate the prior session through supported lifecycle,
then obtain them in a new lawful identity. `predecessor.supported` does not
mean that lifecycle ran. Do not pass this preparation object's facts directly
to the successor or seed an oracle answer in its Home.

## Scoring, human review, and limits

Business automatic results: `scripted-pass` or `fail`. All W/R cases stay
`pending-human` when structural/boundary checks pass. There is no automatic
semantic-quality score. Their actual Markdown includes a structured companion;
oracle verifies it against reported propositions/claims and returns the
**actual text, file digest, and rubric** for review. A dishonest prose statement
not represented in its companion still needs human detection; a valid
structured matrix does not establish usable or consistent prose.

Human rubric reports a 0/1/2 vector for evidence/scope, constraints,
changes/contradictions, fact-vs-inference/recommendation/unknown, and usable
delivery. Research adds counterevidence/alternative explanations; docs add
preconditions and cross-document consistency. Record reviewer identity,
artifact/source versions, original-text locations and reasons. Critical safety,
source or effective-decision errors fail regardless of average. Full pass
requires every applicable dimension=2. One reviewer is `single-rater`, not an
agreement statistic. Several justified recommendations or wording variations
are allowed; manual judgments must not demand this script's exact sentences.

The automatic oracle checks the scripted strategy's constrained outcomes,
not every possible future autonomous implementation. For example, current C08
materials put a2 before acceptance, so waiting is correct; no hidden future
acceptance is leaked. O02 permits truthful unknown if a query cannot confirm,
but never treats that as permission to resend. Further legal implementations
need behavior-compatible candidate interfaces or an explicit new score version,
not ID-to-answer shortcuts.

Budget supplied per case: single code/docs/research 60 seconds, 40 reads,
1 MiB; multi code/data/operations 90 seconds, 60 reads, 2 MiB; cleanup grace
20 seconds. Leader enforces budgets and includes failed reads/pages; this
business module cannot measure Yui reads, exact tokens or model costs.
`maxNewEffects` / `maxTotalEffects` bound operations separately: O01 adds at
most three, O02 adds zero to its original one, O03 adds at most one (reviewer
variant zero), O04 adds zero. Runner stops on an excess effect rather than
allowing request budgets to justify repetition.
Seed is fixed by the enclosing experiment (recommended 89); these materials
have no random generation or automatic retries.

Holdout material and score keys are authored before calibration and freeze
with `freeze.json`. No holdout business outcomes were executed here. Static
hash checks are not holdout results. Any future use of holdout failures to tune
rules/strategy invalidates that holdout status and needs a new declared split.

## Reproduction and evidence

Use a supported Node version, e.g. Node 24:

```text
node --test scripts/collaboration-eval/cases/tests/business.test.mjs
```

This research/business check is intentionally not added to core CI. It tests
the 18 dev base outcomes and four variants, plus metadata, two legal
expressions/paths, readback integrity and duplicate-effect detection. Each
fixture uses a fresh `mkdtemp` under runtime TMPDIR and registers teardown
before preparation; all files and local repos are removed in `t.after`.
No Controller, Host, tmux, endpoint or persistent Home is started.

Observed on 2026-10-06, Node 24.20.0:

- Development base+variants: all 22 conditions had no business-check failures;
  W/R remained pending-human. These are synthetic original-record unit inputs,
  **not actual Yui results**.
- Temporary independent-scorer diagnostics caught six deliberate faults:
  C02 auth-failure caching/incorrect cache access; C06 release of unaccepted
  dependency; W03 auditor configuration in one document; R03 all-region
  extrapolation; A03 repeated-order net amount; O02 another-key send.
- 36 legal controls (two expressions/read orders for each dev case; data
  full/incremental where applicable) had no automated failures. Temporary
  diagnostic harness removed after preserving this receipt. Holdout untouched.
- Local preparation/state/Git resources released on success and failure by
  test hooks or `finally`. No external resources or global configuration
  changes. Generated local launcher/build are outside Git and are not
  publication.

See the final AgentRun handoff for repository build/core results and exact
commit. These checks do not establish real Yui F/P wiring, permission fences,
discovery cost, Agent understanding, budget calibration, real service behavior,
or a Yui-wide optimization recommendation. Leader must derive the baseline
and recommendation from its real persisted/read-back evidence.
