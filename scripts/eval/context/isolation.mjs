// Fixture-only policy. This is not a change to user/default Agent permissions.
import assert from "node:assert/strict";
import { isAbsolute, relative } from "node:path";
export const fixturePermissionArguments = (mode = "workspace-write") => {
  assert.ok(["workspace-write", "session-only"].includes(mode), "Unknown fixture permission mode");
  if (mode === "session-only") return [
    "--permission-strategy", "configured", "--sandbox", "danger-full-access", "--approval", "never",
  ];
  return [
  "--permission-strategy", "configured", "--sandbox", "workspace-write", "--approval", "never",
  "--exclude-tmpdir-env-var", "true", "--exclude-slash-tmp", "true"
  ];
};
function inside(root, path) {
  if (!isAbsolute(root) || typeof path !== "string" || !isAbsolute(path)) return false;
  const child = relative(root, path);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith("../"));
}
export function assertIsolationRequest(params, root, mode = "workspace-write") {
  fixturePermissionArguments(mode);
  assert.equal(params.sandbox, mode === "session-only" ? "danger-full-access" : "workspace-write",
    "Isolation request must match frozen permission mode");
  assert.equal(params.approvalPolicy, "never", "Isolation request must use approval never");
  const config = params.config?.sandbox_workspace_write;
  if (mode === "session-only") assert.equal(config, undefined, "Session-only request must omit legacy workspace policy");
  else {
    assert.equal(config?.exclude_tmpdir_env_var, true, "Isolation request must exclude TMPDIR");
    assert.equal(config?.exclude_slash_tmp, true, "Isolation request must exclude shared /tmp");
  }
  assert.ok(inside(root, params.cwd), "Isolation cwd must belong to fixture");
  assert.ok(Array.isArray(params.runtimeWorkspaceRoots)
    && params.runtimeWorkspaceRoots.length > 0
    && params.runtimeWorkspaceRoots.every(path => inside(root, path)),
  "Isolation requested roots must belong to fixture");
}
export function assertIsolationReceipt(startup, params, root, mode = "workspace-write") {
  assertIsolationRequest(params, root, mode);
  assert.equal(startup.cwd, params.cwd, "Isolation native cwd changed");
  assert.equal(startup.approvalPolicy, "never", "Isolation native approval changed");
  assert.ok(startup.thread?.id, "Isolation native Thread receipt missing");
  const sandbox = startup.sandbox;
  if (mode === "session-only") {
    assert.equal(sandbox?.type, "dangerFullAccess", "Session-only native policy must acknowledge full access");
    return;
  }
  assert.equal(sandbox?.type, "workspaceWrite", "Isolation native policy is not workspaceWrite");
  assert.equal(sandbox.excludeSlashTmp, true, "Isolation native policy allows shared /tmp or is unknown");
  assert.equal(sandbox.excludeTmpdirEnvVar, true, "Isolation native TMPDIR exclusion is absent or unknown");
  assert.ok(Array.isArray(sandbox.writableRoots)
    && sandbox.writableRoots.every(path => inside(root, path)),
  "Isolation native policy has external or unknown writable roots");
}
export async function startIsolatedThread(request, params, root) {
  assertIsolationRequest(params, root);
  const startup = await request("thread/start", params);
  assertIsolationReceipt(startup, params, root);
  return startup;
}
