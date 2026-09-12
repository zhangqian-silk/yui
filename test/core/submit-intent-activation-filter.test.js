import assert from "node:assert/strict";
import test from "node:test";

import {
  activationRequestIsControllerAdoptable,
  createTaskActivationRequest
} from "../../dist/task/taskActivation.js";

/**
 * §2.4 coverage for the Controller adoption filter — the boundary that decides
 * whether the Controller may continue (auto-adopt) a released activation request
 * without an explicit `yui task activate` call.
 *
 * The rule has exactly two admitting conditions and one refusing one:
 *  - a deferred (after-planning-turn) request is always adoptable — its planning
 *    Turn already held activation authority and only its release is awaited;
 *  - an immediate request is adoptable only with a recognised provable origin
 *    (`explicit` action, or a `submit-develop` submission accepted while the
 *    Task was unplanned);
 *  - an immediate request with NO origin — every request migrated from before the
 *    field existed — is refused, so an upgrade can never turn a historical pending
 *    request into a silent auto-activation. Absence is the safe marker, never an
 *    implicit `explicit`.
 */

const now = new Date("2026-09-12T00:00:00.000Z");
const TASK_ID = "task-1";

function immediate(origin) {
  return createTaskActivationRequest(TASK_ID, {
    requestId: "req-immediate",
    actorId: "user:local",
    authorityRef: "auth-ref",
    startMode: "immediate",
    ...(origin === undefined ? {} : { origin }),
    environmentPlan: { kind: "empty" }
  }, now);
}

function deferred(origin) {
  return createTaskActivationRequest(TASK_ID, {
    requestId: "req-deferred",
    actorId: "task:task-1/role:leader",
    authorityRef: "auth-ref",
    startMode: "after-planning-turn",
    afterPlanningRun: "run-1",
    ...(origin === undefined ? {} : { origin }),
    environmentPlan: { kind: "empty" }
  }, now);
}

test("an immediate submit-develop request is Controller-adoptable", () => {
  const request = immediate("submit-develop");
  assert.equal(request.origin, "submit-develop");
  assert.equal(request.startMode, "immediate");
  assert.equal(activationRequestIsControllerAdoptable(request), true);
});

test("an immediate explicit request is Controller-adoptable", () => {
  assert.equal(activationRequestIsControllerAdoptable(immediate("explicit")), true);
});

test("an immediate origin-less request is NOT Controller-adoptable", () => {
  // The migration rewrites no rows, so a pre-§2.4 request has no origin. It must
  // stay behind the explicit activation boundary rather than be auto-adopted.
  const request = immediate(undefined);
  assert.equal(request.origin, undefined);
  assert.equal(activationRequestIsControllerAdoptable(request), false);
});

test("a deferred request is Controller-adoptable regardless of origin", () => {
  // A deferred request is released only by its planning Turn ending, which already
  // carried activation authority — so origin does not gate it.
  assert.equal(activationRequestIsControllerAdoptable(deferred(undefined)), true);
  assert.equal(activationRequestIsControllerAdoptable(deferred("explicit")), true);
  assert.equal(activationRequestIsControllerAdoptable(deferred("submit-develop")), true);
});

test("the filter reads origin, not actor: a user immediate request with origin is adoptable", () => {
  // The old actor heuristic dropped legal Operator/user immediate requests; the
  // origin-based rule admits them as long as the provenance is recorded.
  const request = createTaskActivationRequest(TASK_ID, {
    requestId: "req-user",
    actorId: "user:local",
    authorityRef: "auth-ref",
    startMode: "immediate",
    origin: "explicit",
    environmentPlan: { kind: "empty" }
  }, now);
  assert.equal(activationRequestIsControllerAdoptable(request), true);
});
