import assert from "node:assert/strict";
import test from "node:test";
import {
  buildControllerResourceInventory,
  runtimeRoleProtectsDomain
} from "../../dist/controller/resourceInventory.js";
import { reconcileSessionOwners } from "../../dist/runtime/sessionReconciliation.js";

const home = "/isolated/archive-resource-safety";
const target = "yui-test:task-1.leader";
const role = {
  ownerKind: "task-role",
  taskId: "task-1",
  taskStatus: "archived",
  roleName: "leader",
  agentId: "agent-1",
  adapterId: "codex",
  nativeSessionId: "native-original",
  runId: "run-original"
};

function paneResource(taskRole, domain) {
  return buildControllerResourceInventory({
    schemaVersion: 1,
    observedAt: "2026-09-12T00:00:00Z",
    currentHome: home,
    scope: "current",
    processes: [{
      pid: 4321, ppid: 1, uid: 1000, startIdentity: "original-process",
      yuiHome: home, kind: "agent", command: "agent-host", args: [],
      rssBytes: 1024, cpuTimeMs: 1, ageMs: 100
    }],
    homes: [{
      yuiHome: home, exists: true, storageStatus: "current",
      discovery: { status: "absent" },
      panes: [{
        taskId: "task-1", roleName: "leader", target, dead: false,
        pid: 4321, currentCommand: "agent-host"
      }],
      roles: [taskRole],
      artifacts: [],
      ...(domain === undefined ? {} : { domain })
    }],
    globalArtifacts: []
  }).resources.find(resource => resource.kind === "agent-session");
}

test("archived live panes stay protected even in expired domains; isolated retirement stays releasable", () => {
  const domain = {
    kind: "ephemeral-test", liveness: "expired", disposition: "safe",
    reasonCode: "ephemeral-host-dead", fingerprint: "expired-domain",
    tmuxTargets: [target], ageMs: 100_000, graceMs: 1_000
  };
  for (const observation of [
    undefined,
    { ...domain, liveness: "active", disposition: "protected" },
    domain
  ]) {
    const archived = paneResource(role, observation);
    assert.equal(archived.disposition, "protected", `archived pane with ${observation?.liveness ?? "no"} domain`);
    assert.equal(archived.owner.runId, "run-original");
    assert.equal(archived.owner.nativeSessionId, "native-original");
    assert.equal(archived.processes[0].pid, 4321);
    const retired = paneResource({
      ...role, taskStatus: "cancelled", taskRetirementIsolated: true
    }, observation);
    assert.equal(retired.disposition, "safe", "existing isolated-retirement cleanup behavior is unchanged");
  }
});

test("archived runtime observations protect their domain without treating retirement as active", () => {
  assert.equal(runtimeRoleProtectsDomain(role), true);
  assert.equal(runtimeRoleProtectsDomain({ ...role, runId: undefined }), true);
  assert.equal(runtimeRoleProtectsDomain({ ...role, nativeSessionId: undefined }), true);
  assert.equal(runtimeRoleProtectsDomain({
    ...role, runId: undefined, nativeSessionId: undefined
  }), true, "missing execution evidence is not proof that an archived Role is safe");
  assert.equal(runtimeRoleProtectsDomain({
    ...role, taskStatus: "cancelled", taskRetirementIsolated: true
  }), false, "isolated retirement keeps its existing domain behavior");
});

test("archived owner cleanup requires exact physical absence, even when the Session still says active", () => {
  const record = { owner: { scope: "task", taskId: "task-1", roleName: "leader" },
    agentId: "agent-1", adapterId: "codex", nativeSessionId: "native-original" };
  const absent = { alive: false, identityConflict: false, pid: 4321, startIdentity: "original",
    rssBytes: 0, ageMs: 100, childCount: 0 };
  for (const physical of [undefined, { ...absent, alive: true }, { ...absent, identityConflict: true }, absent]) {
    const report = reconcileSessionOwners({
      records: [record], durable: [{ ...record.owner, agentId: record.agentId,
        adapterId: record.adapterId, nativeSessionId: record.nativeSessionId, status: "active", inHistory: false }],
      taskStatus: () => "archived", observe: () => physical,
      inspectPane: () => undefined, lastStopOutcome: () => undefined, now: new Date("2026-09-12T00:00:00Z")
    });
    assert.equal(report.entries[0].archiveBlocked, physical !== absent);
  }
});
