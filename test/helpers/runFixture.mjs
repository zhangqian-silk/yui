import { createRun } from "../../dist/agentRun/agentRun.js";
import { createRunInput } from "../../dist/context/runInputContract.js";
import { contextSnapshotRef, createContextSnapshot } from "../../dist/context/contextSnapshot.js";

/** Minimal frozen evidence for tests that exercise Run lifecycle, not dispatch
 * context assembly. Context tests use the real dispatch paths instead. */
export function createFixtureRun(store, id, taskId, roleName, mode, input, now, context) {
  const snapshot = createContextSnapshot({
    id: store?.nextContextSnapshotId(taskId) ?? "snapshot-1", taskId, scope: "task",
    sequence: 1 + Math.max(0, ...(store?.listContextSnapshots(taskId) ?? [])
      .filter(snapshot => snapshot.scope === "task").map(snapshot => snapshot.sequence)),
    refs: [], resources: [], acceptRefs: [], frozenAt: now, frozenBy: "controller"
  });
  store?.saveContextSnapshot(snapshot);
  return createRun(id, taskId, roleName, mode, createRunInput({
    ...input, contextSnapshotRef: contextSnapshotRef(snapshot)
  }), now, context);
}
