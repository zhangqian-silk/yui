import { FileSchedulerStoreAdapter as Adapter } from "../../dist/controller/fileSchedulerStoreAdapter.js";
import { snapshotExecutionLaneWorkspaceSync } from "../../dist/repository/executionLaneGitSnapshot.js";

// Fault seam only: retain the real persistence worker, SQLite transaction and
// observer folds, while the test controls when its writer releases the lock.
export class FileSchedulerStoreAdapter extends Adapter {
  observeFixtureTerminal(input, now, buffer, host) {
    const gate = new Int32Array(buffer);
    const original = this.snapshotExecutionLaneWorkspace;
    this.snapshotExecutionLaneWorkspace = (store, workspace) => {
      const result = snapshotExecutionLaneWorkspaceSync(store, workspace);
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0);
      if (Atomics.wait(gate, 0, 1, 10_000) === "timed-out") throw new Error("Fixture inspection not released");
      return result;
    };
    try {
      return host ? this.observeAgentHostObservation(input, now) : this.observeRuntimeObservation(input, now);
    } finally {
      this.snapshotExecutionLaneWorkspace = original;
    }
  }

  holdFixtureWriteLock(buffer, taskId) {
    const gate = new Int32Array(buffer);
    return this.store.transaction(() => {
      if (taskId !== undefined) {
        this.store.saveTask({ ...this.store.getTask(taskId), title: "Uncommitted fixture write" });
      }
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0);
      if (Atomics.wait(gate, 0, 1, 10_000) === "timed-out") throw new Error("Fixture lock not released");
    });
  }
}
