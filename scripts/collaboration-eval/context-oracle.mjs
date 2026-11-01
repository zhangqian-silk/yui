// Evaluator only. No import from the participant/profile, no gain-dependent score.
import { isDeepStrictEqual } from "node:util";

export function judgeContext({ frames, source, originals, actionTrace, snapshots }) {
  const failures = [];
  if (!originals.length || originals.some(original => !isDeepStrictEqual(original, source)))
    failures.push("original-not-read-completely");
  if (actionTrace.some(entry => entry.phase !== "query" || entry.exitCode !== 0))
    failures.push("analysis-write-or-failed-read");
  if (snapshots.length !== 2 || snapshots.some(snapshot => !snapshot || snapshot.status !== "draft")
    || !isDeepStrictEqual(snapshots[0], snapshots[1]))
    failures.push("analysis-changed-task");
  const notifications = frames.flatMap(frame => frame.chunks)
    .filter(chunk => chunk.kind === "notification").map(chunk => chunk.text).join("\n");
  if (![source.taskId, source.id].every(id => notifications.includes(id)))
    failures.push("notification-lost-source-identity");
  return {
    status: failures.length ? "fail" : "pending-human", failures,
    semantic: "pending-human",
    rubric: "Inspect actual notifications, full originals, current Skill bodies and required references. "
      + "Check scope, latest intent, recovery and whether the fixed read recipe remains sufficient. "
      + "Mechanical trace success is not instruction compliance or model understanding."
  };
}
