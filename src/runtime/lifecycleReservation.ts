import {
  mailboxHasWork,
  type MailboxTarget,
  type WorkMailbox
} from "../coordination/workMailbox.js";

export const RUNTIME_LIFECYCLE_OWNER = "runtime-lifecycle";
export const RUNTIME_CLEANUP_REQUIRED_REASON = "runtime-cleanup-required";
export const RUNTIME_HOST_DETACH_REQUIRED_REASON = "runtime-host-detach-required";
export const RUNTIME_SESSION_REPLACE_REQUIRED_REASON = "runtime-session-replace-required";
export const RUNTIME_HOST_UPGRADE_REASON = "runtime-host-upgrade-required";
export const RUNTIME_HOST_UPGRADE_DRAINED = "runtime-host-upgrade-drained";
export const RUNTIME_HOST_UPGRADE_FAILED = "runtime-host-upgrade-failed";

/**
 * A Role runtime lifecycle lane already holds an explicit cleanup obligation.
 * This is scheduler
 * backpressure: the equivalent wake/AgentRun must be retried after the lane
 * settles. It is never grounds to terminalize a AgentRun, because the contention
 * happens before (or outside) any semantic AgentRun launch.
 */
export class RuntimeLifecycleBusyError extends Error {
  readonly name = "RuntimeLifecycleBusyError";

  constructor(message: string) {
    super(message);
  }
}

export type RuntimeRoleOwner =
  | Readonly<{
      scope: "task";
      taskId: string;
      roleName: string;
    }>
  | Readonly<{
      scope: "global";
      roleName: string;
    }>;

export type RuntimeLifecycleTarget = Extract<
  MailboxTarget,
  { kind: "role-runtime" | "global-role-runtime" }
>;

export function runtimeLifecycleTarget(
  owner: RuntimeRoleOwner
): RuntimeLifecycleTarget {
  return owner.scope === "task"
    ? {
        kind: "role-runtime",
        taskId: owner.taskId,
        roleName: owner.roleName
      }
    : {
        kind: "global-role-runtime",
        roleName: owner.roleName
      };
}

export function runtimeLifecycleSignalKey(owner: RuntimeRoleOwner): string {
  return owner.scope === "task"
    ? `role:${encodeURIComponent(owner.taskId)}/${encodeURIComponent(owner.roleName)}`
    : `global-role:${encodeURIComponent(owner.roleName)}`;
}

export function hasRuntimeCleanupObligation(
  mailbox: WorkMailbox | null
): boolean {
  return runtimeCleanupDisposition(mailbox) !== null;
}

/** Explicit Session end dominates a coalesced physical Host detach request. */
export function runtimeCleanupDisposition(
  mailbox: WorkMailbox | null
): "replace-session" | "end-session" | "detach-host" | "upgrade-host" | null {
  const reasons = [
    ...(mailbox?.pending?.reasons ?? []),
    ...(mailbox?.processing?.batch.reasons ?? [])
  ];
  if (reasons.includes(RUNTIME_SESSION_REPLACE_REQUIRED_REASON)) return "replace-session";
  if (reasons.includes(RUNTIME_CLEANUP_REQUIRED_REASON)) return "end-session";
  if (reasons.includes(RUNTIME_HOST_DETACH_REQUIRED_REASON)) return "detach-host";
  if (reasons.includes(RUNTIME_HOST_UPGRADE_REASON)) return "upgrade-host";
  return null;
}

export function isRuntimeCleanupReason(reason: string): boolean {
  return reason === RUNTIME_CLEANUP_REQUIRED_REASON
    || reason === RUNTIME_SESSION_REPLACE_REQUIRED_REASON
    || reason === RUNTIME_HOST_DETACH_REQUIRED_REASON
    || reason === RUNTIME_HOST_UPGRADE_REASON
    || reason === RUNTIME_HOST_UPGRADE_DRAINED
    || reason === RUNTIME_HOST_UPGRADE_FAILED;
}

export function hasRuntimeLifecycleWork(
  mailbox: WorkMailbox | null
): boolean {
  return mailbox !== null && mailboxHasWork(mailbox);
}
