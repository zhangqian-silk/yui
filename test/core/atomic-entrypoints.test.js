import assert from "node:assert/strict";
import test from "node:test";
import { routeInvocation } from "../../dist/cli/invocationRouter.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import { createIntegrationAttempt, recordIntegrationConflict } from "../../dist/integration/integrationAttempt.js";
import { projectCompletionReadiness } from "../../dist/task/completionReadiness.js";
import { createReviewRound, createTaskReviewRound, validateReviewRound } from "../../dist/review/reviewRound.js";
import { TASK_PLANNING_ENTERED_EVENT, draftHasEnteredPlanning } from "../../dist/task/taskSubmission.js";

test("atomic Integration and Review contracts do not fabricate acceptance or scope", () => {
  assert.equal(routeInvocation(["task", "integration", "queue", "process", "task-1"]).kind, "path-error");
  const now = new Date("2026-09-18T00:00:00Z");
  const task = activateTask(createTask("task-1", "Preserve delivery", now), now);
  const attempt = createIntegrationAttempt({
    id: "integration-1", taskId: task.id, projectId: "project-1", targetRef: "main",
    beforeCommit: "a".repeat(40), source: {
      kind: "work-item", workItemId: "work-item-1", startCommit: "a".repeat(40),
      resultCommit: "b".repeat(40), strategy: "cherry-pick"
    }
  }, now);
  const readiness = projectCompletionReadiness({
    task, workItems: [], changeSets: [], integrations: [
      recordIntegrationConflict(attempt, { affectedPaths: ["file"], summary: "Resolve conflict" }, now)
    ], reviewRounds: [], reviewConfig: null, openInputRequests: [], activeRuns: [],
    leaderRuns: [], managedWorkspaces: [], durableJobs: []
  });
  assert.ok(readiness.blockers.some(blocker => blocker.code === "unresolved-integration"));
  const work = createReviewRound("review-round-1", task.id, "work-item-1", "candidate-1",
    "reviewer", "leader", "a".repeat(40), now);
  const final = createTaskReviewRound("review-round-2", task.id, "reviewer", "leader",
    { schemaVersion: 1, projects: [{ projectId: "project-1", commit: "b".repeat(40) }] }, now);
  assert.equal(validateReviewRound(work).scope, "work-item");
  assert.equal(validateReviewRound(final).scope, "task");
  const { scope, ...missingScope } = work;
  assert.throws(() => validateReviewRound(missingScope), /scope/i);
  assert.equal(TASK_PLANNING_ENTERED_EVENT, "task.planning-entered");
  assert.equal(draftHasEnteredPlanning({
    listEvents: () => [{ type: TASK_PLANNING_ENTERED_EVENT }],
    listRuns: () => [], getTaskRoleSessionSet: () => null
  }, { id: task.id, status: "draft" }), true);
});
