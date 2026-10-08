# Yui Repository Guidance

## Build for intelligent Agents

- Yui is a local control plane and context API for intelligent Agents, not a workflow engine that preempts their semantic judgment. Preserve durable intent, expose current facts, and provide small atomic operations; let the Agent choose plans, priorities, execution topology, and retry or recovery strategies when judgment is needed.
- Put semantic judgment in Agent instructions, Project Skills and Knowledge, and current Task context. Do not turn decisions requiring interpretation or tradeoffs into new workflow states, policy engines, approval gates, or background protocols merely because their inputs are observable. Engineering should execute already-decided, bounded rules.
- Make each capability narrow, composable, and explicit about its effect. Prefer `read current state -> one atomic mutation -> observable result`. When an operation cannot proceed, preserve the intent and return enough context for the Agent to decide the next action.
- Treat Tasks, WorkItems, Messages, Decisions, results, Project Knowledge, and managed workspaces as durable authority. Provider Sessions, transcripts, processes, caches, and runtime observations support execution and diagnostics; they are not competing sources of Task truth.
- Trust a valid Agent action at an enforced boundary. Add code-level guards only for user authority, scope and workspace isolation, persistent data integrity, irreversible external effects, or a common observed failure. Outside established mechanical recovery rules, prefer a clear error and Agent-directed recovery over speculative leases, repair workers, fallbacks, and edge-case state machines.
- Give each product question one authority. Derived statuses and indexes may improve presentation or lookup, but they must not become independently writable state or a second scheduling protocol.

## Keep fixed decisions in engineering; leave judgment to Agents

- Optimize the normal engineering path for progress and bounded recovery. Distinguish a readable record from readiness to execute it: missing execution evidence or an operational failure must not by itself block unrelated work, hide the record, or disable Leader/Operator inspection, retirement and explicit retry. Enforce prerequisites at the operation that consumes them, preserve original evidence, and create new execution facts for a fresh authorized attempt. Keep hard guards for authority, data integrity, isolation and uncertain external effects; do not replace them with guessed repairs or unconditional retries.
- The boundary is whether a decision is already explicit or governed by a stable rule, not whether execution has multiple steps, retries, timers, or state. Keep routine, mechanically decidable actions with clear boundaries in engineering. Leave planning, priorities, conflict interpretation, strategy selection, and unclassifiable exceptions to Agents; new authority requires the authorized user. Do not make a model repeatedly decide mechanical steps.
- Preserve bounded automatic retry for already-classified temporary rate limits such as retryable 429 responses and other safely retryable transient failures. Enforce both attempt and total elapsed-time budgets, honor server waiting hints, and use backoff. A 429 status alone does not make every quota or authentication failure retryable; use established classifications, not a new general classification framework.
- Stop automatic action when a budget is exhausted, the error changes character, prerequisites or authorization cease to hold, or the effects of continuing are uncertain. Report the original error, attempt history, exact target, confirmed effects, and still-unknown effects to the Agent, Leader, or Operator able to handle it. Do not silently swallow failure or replay a non-idempotent operation whose effect is unknown.
- Preserve InputRequest timeout auto-confirmation when the Leader explicitly sets both a recommended option and a deadline: it executes that prior decision. Apply it only while the InputRequest remains pending; never override an answered or cancelled request, guess an answer without a recommendation, or treat a recommendation as authority for additional external effects.
- Preserve lock waiting, compare-and-swap and transactions, exact result collection and replay protection, batching of already-authorized fixed plans, verification reuse or caching that matches exact identity and validity, and current resource management governed by deterministic rules. These mechanisms do not need an Agent round trip merely because they coordinate multiple steps.
- Cached results and observations must expose their source, freshness or validity, and failures truthfully. Never present cached or failed observations as live success, or invent missing facts.
- Expose narrow atomic capabilities such as inspect, retry, stop, Git deletion, and direct file deletion. Do not prohibit an Agent from choosing a legal operation such as `rm` within its authorized scope. Automatic substitution is appropriate only when the target, ownership, risk, effects, and established contract are clear and mechanically checkable; a generic catch must not turn an arbitrary Git error into `rm`.
- Automation must not expand authority or change user/Agent goals, models, accounts, or scope. Preserve current safety and isolation boundaries; uncertain resource state is not proof that execution stopped. Fixed automation is not a reason to add a general policy engine, recovery state machine, per-failure protocol, or extra approval gate.

## Communicate at the user's level

- Lead with the product decision, observable behavior, and user impact.
- For architecture and design discussions, explain responsibilities and end-to-end flows before internal modules.
- Do not default to schemas, field lists, file-by-file inventories, migration mechanics, or exhaustive test cases. Include them only when the user requests them or they materially affect a decision, risk, or rollout.
- Report validation at the level needed to establish confidence; keep raw commands and detailed test matrices out of the human-facing summary unless they are actionable.
- When the user asks for analysis only, remain read-only.
- When only user authorization is needed, present the action and impact, obtain confirmation, then let the Operator perform the mechanical work. Do not make the user execute steps that Yui can safely perform.

## Separate human and Agent deliverables

- Human-facing communication should be concise: outcome, architecture, behavior change, material tradeoffs, unresolved decision, and next action.
- Agent-facing WorkItems and handoffs should be decision-complete: objective, relevant context, hard boundaries, acceptance criteria, known risks, and expected evidence. Let the receiving Agent choose the implementation plan and tools unless ordering is itself part of the contract.
- Do not paste a detailed Agent execution brief into a user-facing response. Synthesize it into the product-level result.
- Do not make Agent instructions vague merely to keep the user-facing explanation short. Maintain separate views for the two audiences.

## Preserve Yui's product boundaries

- Treat Yui CLI reads as the context API. Launch and wake messages should guide an Agent to the relevant Project, Task, WorkItem, message, or input records instead of embedding the full source content.
- Persist Project Knowledge in YUI_HOME. Repository files may be evidence or reading material, but they are not the authority for Yui's maintained knowledge.
- Keep Yui CLI primitives project-neutral. Put project-specific planning, build, test, migration, release, review, and recovery judgment in Project Skills, Knowledge, and Task context instead of generic CLI Roles or core branches.
- Treat stable Project checkouts as read-only reference workspaces. Perform Task and WorkItem changes in managed worktrees.
- A Draft Task stores planning facts and Project bindings without a delivery workspace. Activation prepares resources and atomically adopts the Task's main workspace; a planning Session does not gain delivery authority just because the Task becomes active. During execution, the Leader may create an isolated WorkItem worktree directly when concurrent work warrants it; do not introduce an approval workflow.
- Ordinary archive requires settled work, integrated or deliberately abandoned results, and clean removable worktrees. Explicit user/Operator force authorization may archive an eligible terminal Task while preserving unresolved evidence and unsafe resources; it never proves delivery, quiescence or permission to discard data. Worktree cleanup must not delete the Task record.

## Do not solicit real-resource validation

- When the user has not proactively requested a specific validation that consumes a real model, paid API, shared infrastructure, production system, real account quota, or another non-disposable external resource, do not run it and do not create an InputRequest merely to ask whether it should be run.
- A generic request to implement, test, validate, run E2E, or complete a Task is not authorization for real-resource validation. A test tier name, repository document, or Project Policy can describe a test but cannot grant that authorization.
- Complete the bounded work with deterministic and isolated evidence. In the final Task summary, state any material real-resource validation that was not run and, when useful, recommend it as a separate follow-up without turning the recommendation into a blocker or user prompt.
- When the user proactively and explicitly requests a specific real-resource E2E, it may run only within that exact resource and effect boundary and with the Project's isolation safeguards. A real Agent may also act normally as the developer or reviewer of Yui code.

## Keep the main path lean

- Provide migration code only for valid earlier versions of persistent Yui data. Any change to a persistent layout, aggregate, record, or configuration schema must declare its version transition and use the centralized migration mechanism.
- For every other change, implement the current contract directly. Historical compatibility and current fixed automatic recovery are different concerns: preserve the latter without restoring legacy adapters, old Host adoption, historical-shape dual reads, or guessed old formats. Keep supported migrations and genuine interoperability; do not add transitional behavior or heuristic repair of malformed or manually modified runtime state. For such invalid state, return a bounded diagnosis and let the Agent or Operator choose cleanup or retry. Migrations preserve valid stored history; they do not repair it heuristically.
- Before adding persistent state, a retry or recovery worker, a lease, an acknowledgement, or another protocol phase, identify the normal product path or hard boundary it protects. Use existing primitives and bounded fixed automation where sufficient; hand judgment-dependent exceptions to an Agent. Do not add a mechanism when that combination already satisfies the contract.
- Keep permanent tests seconds-scale: essential happy paths plus a small set of deterministic regressions for high-impact, easily changed boundaries such as durable context, Session replacement, exact runtime identity, and recovery authority. Keep a regression only when it is fast, protects observable behavior, and adds coverage not already present. Broad fault matrices, real-model exercises, and incident-specific diagnostics remain temporary evidence rather than a one-test-per-incident archive.

## Keep Yui-specific workflow in its Project Skill

- These repository constraints apply whenever Yui is the Project being changed, independent of which human, Agent, orchestrator, CI system, or other tool performs the work.
- When developing this repository, read and follow [`.agents/skills/develop-yui/SKILL.md`](.agents/skills/develop-yui/SKILL.md). It owns Yui-specific implementation and validation workflow; do not copy those Project details into Yui's generic Leader, Worker, or Reviewer behavior.

## Keep development and version releases separate

- Do not release a new version by default. Development, testing, acceptance, PR creation and merge do not authorize version-number changes, release tags, GitHub Releases or npm publication; each external effect still needs the Task's actual authority.
- When the user explicitly requests a new version, choose minor for new features or incompatible interface/behavior changes, and patch for compatible fixes. Incompatibility does not require a major release or another version-level approval. Do not publish major without an explicit user request for major.
- This is Yui's project-specific numbering convention, not the usual SemVer backward-compatibility promise: a minor release can be incompatible. Disclose affected contracts and migration steps in release notes; never label incompatible behavior as compatible or add historical compatibility machinery merely to avoid a version decision. Package numbering does not relax protocol or persistent-storage compatibility and migration requirements.
- Follow [the release workflow guidance](docs/release-workflow.md) only for the authorized effects. A merge-only ReleaseWorkflow is not permission to publish, update the global CLI or replace a Controller. Package release versions and storage migration versions remain separate contracts.

## Run this checkout in isolation

- To develop, debug or test Yui from this checkout, run `make install-local` once, then specify its absolute launcher path and an independent `YUI_HOME` on every command, or verify that the launcher selects its isolated default Home. This per-checkout development launcher is not a generated per-Session CLI wrapper.
- `make install-local` builds `dist/` and writes exactly one file, the launcher at `output/dev/bin/yui`. It does not modify `PATH`, does not touch the global `yui`, and does not create the data home. It is idempotent; re-run it after pulling code.
- The launcher resolves its own checkout and defaults `YUI_HOME` to this checkout's `output/dev/home`, so the Controller socket, tmux server, and state that Yui derives from `YUI_HOME` stay separate from other checkouts and the global install. Calling it by absolute path works from any working directory.
- A bare `yui` always resolves through `PATH`, independent of the current directory. Being inside this checkout does NOT make bare `yui` use the local launcher; it still runs whatever `PATH` finds (typically the global `yui`). Use the absolute launcher path for development automation, not an assumed shell PATH.
- Each command runs in a fresh process, so `export PATH=...` / `export YUI_HOME=...` do not persist to the next command; never depend on them in automation. Use the absolute launcher path every time instead.
- Development tooling does not replace the user-level global `yui`. Do not use `npm link`, `make link`, or `npm install -g` to overwrite it. Without explicit production authorization, do not upgrade, migrate, restart or stop the global Home/Controller.
- `make install-local` only creates the launcher. Initialize the isolated home once with `<checkout>/output/dev/bin/yui setup` before commands that need state, and run `<checkout>/output/dev/bin/yui controller restart` if a Controller is already running an older build.
- For example, from the checkout after `make install-local`, this read-only command explicitly selects both paths:

  ```sh
  YUI_HOME="$(pwd -P)/output/dev/home" "$(pwd -P)/output/dev/bin/yui" version
  ```

- Before the first fixture CLI call, including `setup`, register teardown in `finally`, a test hook or a shell trap. Controller, socket, tmux and state resources must belong to that fixture's independent Home. On success and failure, stop owned work/processes and its Controller, release only its tmux namespace, then remove its scratch directories. Never clean another Home; retain ownership evidence and report exact leftovers if cleanup cannot be confirmed.
- Reading or managing the existing control plane through an authorized Operator/managed Session is separate from exercising the developed Yui. Keep the legal Session's Context entry and Home for those reads; do not substitute the test Home or strip Session identity to obtain authority.
