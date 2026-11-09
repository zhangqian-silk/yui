import test from "node:test";
import assert from "node:assert/strict";
import { fixturePermissionArguments, assertIsolationRequest, assertIsolationReceipt,
  startIsolatedThread } from "./isolation.mjs";

test("session-only mode explicitly verifies full native policy without claiming OS isolation", () => {
  assert.deepEqual(fixturePermissionArguments("session-only"), [
    "--permission-strategy", "configured", "--sandbox", "danger-full-access", "--approval", "never",
  ]);
  const request = { cwd: "/owned/work", sandbox: "danger-full-access", approvalPolicy: "never",
    runtimeWorkspaceRoots: ["/owned/work"] };
  const receipt = { cwd: request.cwd, approvalPolicy: "never", thread: { id: "new" },
    sandbox: { type: "dangerFullAccess" } };
  assertIsolationRequest(request, "/owned", "session-only");
  assertIsolationReceipt(receipt, request, "/owned", "session-only");
  assert.throws(() => assertIsolationReceipt({ ...receipt, sandbox: { type: "workspaceWrite" } },
    request, "/owned", "session-only"));
  assert.throws(() => assertIsolationRequest({ ...request,
    config: { sandbox_workspace_write: { exclude_slash_tmp: true } } }, "/owned", "session-only"));
  assert.throws(() => assertIsolationRequest({ ...request, cwd: "/foreign" }, "/owned", "session-only"));
  assert.throws(() => assertIsolationRequest({ ...request, runtimeWorkspaceRoots: ["/foreign"] },
    "/owned", "session-only"));
  assert.throws(() => fixturePermissionArguments("typo"));
});

test("fixture permissions and native startup fail closed without bypass fallback", async () => {
  assert.deepEqual(fixturePermissionArguments(), [
    "--permission-strategy", "configured", "--sandbox", "workspace-write", "--approval", "never",
    "--exclude-tmpdir-env-var", "true", "--exclude-slash-tmp", "true"
  ]);
  const request = { cwd: "/owned/work", sandbox: "workspace-write", approvalPolicy: "never",
    runtimeWorkspaceRoots: ["/owned/work"], config: { sandbox_workspace_write: {
      exclude_tmpdir_env_var: true, exclude_slash_tmp: true } } };
  const receipt = { cwd: request.cwd, approvalPolicy: "never", thread: { id: "new-thread" },
    sandbox: { type: "workspaceWrite", writableRoots: ["/owned/work"],
      excludeTmpdirEnvVar: true, excludeSlashTmp: true, networkAccess: false } };
  assertIsolationRequest(request, "/owned");
  assertIsolationReceipt(receipt, request, "/owned");
  const calls = [];
  const start = async response => startIsolatedThread(async (method, params) => {
    calls.push({ method, params });
    return response;
  }, request, "/owned");
  assert.equal((await start(receipt)).thread.id, "new-thread");
  for (const response of [
    { ...receipt, sandbox: { type: "dangerFullAccess" } },
    { ...receipt, sandbox: { ...receipt.sandbox, excludeSlashTmp: false } },
    { ...receipt, sandbox: { ...receipt.sandbox, excludeTmpdirEnvVar: false } },
    { ...receipt, sandbox: { ...receipt.sandbox, writableRoots: ["/other"] } },
    { ...receipt, sandbox: { type: "workspaceWrite", writableRoots: [] } },
    { ...receipt, cwd: "/other" },
    { ...receipt, approvalPolicy: "on-request" }
  ]) await assert.rejects(start(response), /Isolation/);
  assert.equal(calls.length, 8, "One startup per explicit test; no retry or fallback");
  assert.ok(calls.every(c => c.method === "thread/start" && c.params === request));
  let count = 0;
  await assert.rejects(startIsolatedThread(async () => { count++; },
    { ...request, sandbox: "danger-full-access" }, "/owned"), /Isolation/);
  assert.equal(count, 0, "Reject bad request before native effect");
  for (const config of [undefined, { sandbox_workspace_write: {
    exclude_tmpdir_env_var: true, exclude_slash_tmp: false } }, { sandbox_workspace_write: {
    exclude_tmpdir_env_var: false, exclude_slash_tmp: true } }]) {
    await assert.rejects(startIsolatedThread(async () => { count++; },
      { ...request, config }, "/owned"), /Isolation/);
  }
  assert.equal(count, 0, "Both explicit request exclusions required before native effect");
  await assert.rejects(startIsolatedThread(async () => { count++; throw Error("native refused"); },
    request, "/owned"), /native refused/);
  assert.equal(count, 1, "Native failure is not retried with weaker permissions");
  assert.throws(() => assertIsolationRequest({ ...request, config: {
    sandbox_workspace_write: { ...request.config.sandbox_workspace_write, network_access: true }
  } }, "/owned"), /networking/);
  const networkBound = { ...request, config: {
    sandbox_workspace_write: { ...request.config.sandbox_workspace_write, network_access: false }
  } };
  for (const networkAccess of [true, undefined]) {
    assert.throws(() => assertIsolationReceipt({ ...receipt, sandbox: { ...receipt.sandbox, networkAccess } },
      networkBound, "/owned"), /network restriction/);
  }
});
