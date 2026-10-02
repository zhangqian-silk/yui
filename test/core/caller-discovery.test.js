import assert from "node:assert/strict";
import test from "node:test";
import { CapabilityRegistry } from "../../dist/kernel/capabilityRegistry.js";
import { InstanceHost } from "../../dist/kernel/instanceHost.js";
import { discoveryCommandTree, discoveryAudience } from "../../dist/cli/commandDiscovery.js";
import { findCommandNode, listPublicCommandPaths } from "../../dist/cli/commandCatalog.js";
import { resolveCompletionCandidates } from "../../dist/cli/dynamicCompletion.js";
import { routeInvocation } from "../../dist/cli/invocationRouter.js";
import { renderCommandHelp } from "../../dist/cli/helpRenderer.js";

test("one caller projection drives help and completion without restricting direct parsing", async () => {
  const publicTree = discoveryCommandTree({});
  const worker = discoveryCommandTree({ YUI_SESSION_SCOPE: "task", YUI_TASK_ID: "task-1",
    YUI_ROLE: "implementer", YUI_NATIVE_SESSION_ID: "native" });
  assert.equal(discoveryAudience({ TERM: "xterm", CODEX_HOME: "/unused" }), "public");
  assert.equal(discoveryAudience({ YUI_ROLE: "leader" }), "unbound");
  assert.ok(listPublicCommandPaths(publicTree).includes("operator submit"));
  assert.ok(!listPublicCommandPaths(publicTree).includes("task work dispatch"));
  assert.ok(!listPublicCommandPaths(publicTree).some(path => path.startsWith("internal")));
  assert.ok(!listPublicCommandPaths(worker).some(path => path.startsWith("operator")));
  assert.ok(!listPublicCommandPaths(worker).includes("task artifact save"));
  assert.ok(listPublicCommandPaths(worker).includes("task artifact read"));
  const task = findCommandNode(["task"], worker);
  assert.doesNotMatch(renderCommandHelp(task, "test"), /work dispatch|task create/);
  assert.doesNotMatch(renderCommandHelp(findCommandNode(["task", "message", "send"], worker), "test"), /--intent/);
  const ports = { call() { throw new Error("Static discovery must not read runtime state"); } };
  const candidates = await resolveCompletionCandidates({ words: ["task"], current: "", ports, root: worker });
  assert.ok(candidates.includes("context"));
  assert.ok(!candidates.includes("create"));
  assert.equal(routeInvocation(["task", "work", "dispatch", "work-1"], worker).kind, "execute");
  assert.equal(routeInvocation(["help", "task", "work", "dispatch"], worker).kind, "path-error");
});

test("exact discovery is pure, runtime-independent and never an execution credential", async t => {
  const host = new InstanceHost();
  t.after(() => host.close());
  const provider = { id: "yui:discovery-test", generation: "1" };
  const descriptor = { name: "resource.read", contractVersion: "1", summary: "Read exact resource",
    provider, scope: { kind: "global" }, source: "test", effect: "query", requiredPermissions: [],
    inputSchema: { type: "object", required: ["resourceId"], properties: { resourceId: { type: "string" } } },
    outputSchema: { type: "object" } };
  let granted = false;
  let calls = 0;
  host.attach(provider, { invoke() { calls++; return {}; } });
  const registry = new CapabilityRegistry(host, () => ({ taskIds: ["task-1"], projectIds: [] }),
    [descriptor], (_context, _descriptor, input) => input === undefined ? undefined : input.resourceId !== "known"
      ? { state: "hidden" }
      : granted ? { state: "authorized" } : { state: "requestable",
        request: { taskId: "task-1", action: "resource.local.read", bounds: { resourceId: ["known"] },
          via: "leader-input", explanation: "Existing grant required" } });
  const context = { actorId: "test", targetId: "task-1" };
  const request = { name: descriptor.name, input: { resourceId: "known" } };
  assert.equal(registry.describe(context, { name: descriptor.name }).value.access, undefined);
  assert.equal(registry.describe(context, request).value.access.state, "requestable");
  assert.equal(registry.describe(context, { ...request, input: {} }).kind, "invalid");
  assert.equal(registry.describe(context, { ...request, input: { resourceId: "unknown" } }).kind, "unavailable");
  assert.equal((await registry.call(context, request)).kind, "denied");
  granted = true;
  assert.equal(registry.describe(context, request).value.access.state, "authorized");
  assert.equal(registry.search(context)[0].unavailable, undefined);
  assert.equal((await registry.call(context, request)).kind, "value");
  granted = false;
  assert.equal((await registry.call(context, request)).kind, "denied");
  granted = true;
  await host.detach(provider);
  assert.equal(registry.describe(context, request).value.access.state, "authorized");
  assert.equal((await registry.call(context, request)).kind, "unavailable");
  assert.equal(calls, 1);
});
