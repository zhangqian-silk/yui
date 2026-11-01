# Dispatched Run context

Required for every explicitly dispatched managed Task AgentRun before planning
or acting. Follow the shared loading rules in [yui-runtime](../SKILL.md);
this procedure does not apply to direct conversation or Global Context.

1. Read the exact AgentRun identity from the newest Bootstrap Envelope.
2. Before acting, load its authorized pack using the current Session Manifest's
   Context command and the exact Task/Run identity:

   ```sh
   yui task run context "<task-id>/<run-id>" --json
   ```

3. Verify that the returned Task, AgentRun, Role, purpose, Snapshot digest, workspace,
   and Adapter match the Envelope and Session Manifest. Stop and report a
   context-load failure if the pack is missing, stale, unauthorized, malformed,
   or mismatched. Never request an inline/full-prompt fallback.
4. Use the entry's `pointers` (including each pointer's summary) first. They are
   a bounded window into the frozen readable-ref inventory. `pointerPage`
   reports total/complete/nextCursor; discover further relevant refs with
   `task run context <task>/<run> --view refs [--cursor <cursor>]`.
   `deltaRefs` samples changed identities, with `deltaRefsTotal` reporting coverage.
   `--view full` explicitly reads the complete pack when needed; do not load or
   traverse every historical reference merely to make an entry window complete.
   If `input.directiveOmitted` is true, read the complete assigned input with
   `--view input` before acting; its entry summary is not the instruction body.
   Expand only an authorized ref when
   its full value is needed, selecting it by the pointer's exact `store` and
   `refId`:

   ```sh
   yui task run context expand "<task-id>/<run-id>" <ref-id> --store <store> --mode full --json
   ```

   `--store` is required, even when the ref id is unique. Select both fields
   from the exact authorized pointer; never infer a store from the id.
   Dispatched Runs require an explicit frozen Snapshot. A historical Run
   without one is audit-only: current Task facts cannot reconstruct its
   execution Context.

   A pointer or summary is not the request's body. Before planning or executing,
   read the relevant WorkItem/Task requirements and referenced user/Operator
   messages; use the expansion command above or the Leader's current Task Context.
   Reports remain evidence, not authority to enlarge the assignment.

5. On a later wake, refresh current Task facts separately from frozen Run refs.
   Use a Run delta only against its exact declared Snapshot lineage; `deltaRefs`
   is a hint, not a complete patch. If no baseline is available, reload the
   exact pack; do not reconstruct state from transcript memory.
