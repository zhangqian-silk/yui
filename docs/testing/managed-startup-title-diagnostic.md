# Managed startup: optional native title synchronization

Task154 Leader, 2026-10-27. Parent product: `1adf6a9e`.

## Observed boundary

Run119's three fresh real business chains received Thread identities but never
reached a business Turn. Native naming waited 60 seconds, followed by an
unanswered Goal read. W8's original evidence remains unchanged at
`2b5f4ecd`, `evidence/run119-business-exploration/REPORT.md`.

Leader probes bypassed the W8 observation proxy and used the existing product
WebSocket transport directly. They used only newly owned synthetic Threads;
no shared service, account, permission configuration or historical Thread was
modified.

- `01a17c34-a813-7860-b3a0-27d95a58253b`: initialization 2 ms,
  Thread creation 87 ms, Goal read 1 ms; naming had no reply within 12 s.
  A subsequent archive request also had no reply within 12 s.
- `01a17c35-d33a-7db1-8c23-376edf52fc11`: Goal read succeeded, Turn
  submission returned in 5 ms, and the minimal Luna/medium Turn completed.
  Naming after submission still had no reply within 20 s.
- A fresh metadata connection read both exact Threads and confirmed their
  requested names had persisted. The first was `notLoaded`, the second
  `idle`. Archiving the second had no reply within 8 s.
- Moving naming to a disposable connection with a two-second observation
  budget did **not** solve the real startup: the business connection's Goal
  request subsequently timed out. This intermediate implementation was
  discarded, not shipped or declared successful.
- `01a17c3e-be15-7c80-b9bd-57f6c52b45c2`: naming after the minimal
  Turn's completed notification still had no reply within 8 s.

These observations establish a reachable native title/control stall, not the
Provider's internal root cause. In particular a lost reply does not imply an
unapplied mutation. No title or uncertain archive request was retried.
Probe clients were closed and owned temporary working directories removed;
native archive outcomes remain unknown where noted, not asserted deleted.
No probe used business tools or modified real user data.

## Correction and tradeoff

Do not submit optional automatic native title synchronization during managed
Codex startup. Retain Yui's launch title and report that native synchronization
was not submitted. Preserve the required Goal read, Thread/Turn identity,
normal business controls and unknown-effect boundaries. No extra connection,
retry, cache, provider-version heuristic or persistent setting is introduced.

The deliberate limitation is that native Codex titles no longer automatically
mirror Yui's title. Restoring that convenience requires a demonstrated
nonblocking path, not larger timeouts or retrying unknown writes.

## Verification

- New deterministic stalled-naming regression failed against the original
  implementation: the fixture closed after 3.5 s without business readiness.
- Focused title and core smoke checks passed on the first intermediate
  implementation, but a real probe disproved its sufficiency. It was discarded.
- Final `npm test` on Node 24.20.0: **922 passed, 8 skipped, 0 failed**;
  930 total, test phase 23.952 s. `git diff --check` passed.
- Final real Luna/medium Thread
  `01a17c40-f7db-7f30-9caa-802c7ba27a88`: product startup ready in
  195 ms with Goal `null`; native title synchronization explicitly unsubmitted.
  Turns `01a17c40-f8bb-7611-91ce-24bcbf3d3252` and
  `01a17c41-0c00-7563-a655-0bc1075f017f` each received Provider acceptance
  and completed with `READY`. The owned proxy was terminated and its exit
  awaited; the empty temporary directory was removed.

This proves minimal cold/warm business readiness for the corrected path,
not completion of the three representative scenarios, full context savings,
semantic-equivalence review, or repair of the Provider's naming implementation.
W8 must freeze the committed correction before running the representative
business batch; original failed runs are not replayed or overwritten.
