import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { agentHostControlSocketPath, reconcileAgentHostTurn } from "../../dist/runtime/agentHost.js";
import { builtinAgentEndpointImplementation, requireBuiltinAgentEndpointImplementation } from "../../dist/runtime/agentEndpointIdentity.js";

test("compatible Endpoint build changes preserve native identity without pinning historical code", () => {
  const original = { id: "yui.agent-endpoint.codex", generation: "previous-supported-build" };
  assert.deepEqual(requireBuiltinAgentEndpointImplementation("codex", original),
    builtinAgentEndpointImplementation("codex"));
  assert.equal(original.generation, "previous-supported-build", "Historical launch evidence remains unchanged.");
  assert.throws(() => requireBuiltinAgentEndpointImplementation("claude", original), /incompatible|unavailable/);
});

test("new Controller does not send unsupported reconciliation to a running old v1 Host", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-old-host-"));
  const target = { home, scope: "global", roleName: "operator" };
  const path = agentHostControlSocketPath(target);
  mkdirSync(dirname(path), { recursive: true });
  let host;
  t.after(async () => {
    if (host && host.exitCode === null && host.signalCode === null) {
      host.kill("SIGTERM");
      await once(host, "exit");
    }
    rmSync(home, { recursive: true, force: true });
  });
  host = fork(new URL("../fixtures/old-host-control.mjs", import.meta.url), [path],
    { stdio: ["ignore", "pipe", "pipe", "ipc"], env: { PATH: process.env.PATH } });
  const commands = [];
  host.on("message", command => commands.push(command));
  await once(host, "message");
  for (let pass = 0; pass < 2; pass++) {
    const result = await reconcileAgentHostTurn({ ...target, control: {
      protocol: "yui-agent-host-control/v1", type: "reconcile-turn",
      nativeSessionId: "old-session", attemptId: "already-accepted",
      nativeTurnId: "original-turn", authority: { epoch: 1, owner: "controller", holderId: "original-owner" }
    } });
    assert.equal(result.reconciliation, "unsupported");
    assert.equal(result.snapshot.eventDelivery, undefined, "Unreported never means healthy.");
    assert.equal(result.snapshot.nativeSessionId, "old-session");
  }
  assert.deepEqual(commands, ["ready", "status", "status"], "No input replay or invalid control probe.");
});
