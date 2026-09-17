import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { inspectAgentCapabilities } from "../../dist/executor/agentAdapter.js";
import { configurationHelpChoices } from "../../dist/executor/agentConfigurationFields.js";
import {
  AgentConfigurationCatalogService, configurationField, fallbackAgentConfigurationCatalog
} from "../../dist/executor/agentConfigurationCatalog.js";
import { selectAgentPermission } from "../../dist/cli/agentConfigurationPicker.js";
import { renderAgentConfigurationCatalog } from "../../dist/output/agentConfigurationPresentation.js";
import { resolveGlobalRoleAgentConfigurationArguments } from "../../dist/cli/roleWizard.js";

const at = new Date("2026-09-17T00:00:00Z");
const help = `  --sandbox <MODE>
    Possible values:
    - read-only: Read files
    - workspace-write: Write workspace
  --ask-for-approval <POLICY>
    [possible values: on-request, never]
  --config <KEY=VALUE>
  resume
`;

test("help and Doctor distinguish observed options from static inputs and absent enumeration", () => {
  assert.deepEqual(configurationHelpChoices("no options", "--sandbox"), [],
    "A missing help field must not return invented native choices.");
  assert.deepEqual(configurationHelpChoices("  --model <MODEL> (example)", "--model"), []);
  assert.deepEqual(configurationHelpChoices(help, "--sandbox"), ["read-only", "workspace-write"]);
  assert.deepEqual(configurationHelpChoices("  --sandbox-extra <X> [possible values: wrong]",
    "--sandbox"), [], "Flag substrings are not declarations.");
  const agent = createConfiguredAgent("codex", "codex", "unused", ["wrapper-argument"], [], at);
  const inspect = text => inspectAgentCapabilities(agent, {
    now: at, run: (_command, args) => {
      assert.equal(args[0], "wrapper-argument", "Doctor must inspect the configured command identity.");
      return { status: 0, stdout: args.includes("--version") ? "codex 0.153.4" : text, stderr: "" };
    }
  });
  const complete = inspect(help);
  assert.deepEqual(complete.fields.find(f => f.key === "permission.sandbox").choices,
    ["read-only", "workspace-write"]);
  const missing = inspect("  --config <KEY=VALUE>\n  resume\n");
  assert.equal(missing.fields.find(f => f.key === "permission.sandbox").status, "unavailable");
  assert.match(missing.warnings.join(" "), /sandbox/);
  assert.doesNotMatch(complete.warnings.join(" "), /newer than.*0\.150\.1/);
  const claude = inspectAgentCapabilities({ ...agent, adapterId: "claude" }, {
    now: at, run: () => ({ status: null, stdout: "", stderr: "", error: new Error("offline") })
  });
  assert.deepEqual(claude.fields.find(f => f.key === "model").choices ?? [], []);
  assert.match(claude.warnings.join(" "), /static/i);
});

// A disposable native producer: only metadata methods are implemented; any model
// work or unexpected request fails. No installed provider or account is used.
const producer = `
const help = ${JSON.stringify(help.replace(/  --sandbox[\s\S]*?  --ask-for-approval/, "  --ask-for-approval"))};
if (process.argv.includes("--version")) console.log("codex 0.153.4");
else if (process.argv.includes("--help")) console.log(help);
else require("node:readline").createInterface({input:process.stdin}).on("line", line => {
  const req = JSON.parse(line);
  if (req.type === "control_request") {
    console.log(JSON.stringify({type:"control_response",response:{request_id:req.request_id,
      subtype:"success",response:{models:[{value:"native",displayName:"Native",
        supportedEffortLevels:["low"]}]}}}));
    return;
  }
  if (req.method === "initialize" && req.jsonrpc === "2.0") {
    console.log(JSON.stringify({jsonrpc:"2.0",id:req.id,result:{protocolVersion:1,
      agentCapabilities:{loadSession:true,sessionCapabilities:{additionalDirectories:{}}},
      agentInfo:{name:"fixture",version:"1.0.0"},authMethods:[]}}));
    return;
  }
  if (req.method === "initialized") return;
  const results = {
    initialize: {},
    "model/list": {data:[{id:"native",model:"native",displayName:"Native",isDefault:true,
      supportedReasoningEfforts:[],defaultReasoningEffort:"low"}],nextCursor:null},
    "configRequirements/read": process.argv.includes("missing-requirements") ? {} : {
      requirements:{allowedApprovalPolicies:["on-request", {granular:{
        sandbox_approval:true,rules:true,skill_approval:true,request_permissions:true,mcp_elicitations:true
      }}]}},
    "modelProvider/capabilities/read": {webSearch:false}
  };
  console.log(JSON.stringify(Object.hasOwn(results,req.method)
    ? {id:req.id,result:results[req.method]} : {id:req.id,error:{message:"Forbidden method"}}));
});
`;

test("partial native metadata stays truthful through presentation, exact cache reuse and failed refresh", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-catalog-provenance-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const command = join(home, "producer.cjs");
  writeFileSync(command, producer);
  const agent = createConfiguredAgent("codex", "codex", process.execPath,
    [command], [], at);
  const service = new AgentConfigurationCatalogService(home, { environment: { HOME: home }, now: () => at });
  const input = { agent, cwd: home };
  const live = await service.resolve(input);
  assert.equal(live.source, "live");
  assert.equal(live.catalog.models[0].value, "native");
  const sandbox = configurationField(live.catalog, "permission.sandbox");
  assert.deepEqual(sandbox.choices, []);
  assert.equal(sandbox.available, false);
  assert.match(sandbox.reason, /unavailable|not reported/i);
  assert.deepEqual(configurationField(live.catalog, "permission.approval").choices.map(c => c.value),
    ["on-request"]);
  assert.match(configurationField(live.catalog, "additionalDirectories").reason, /static/i);
  assert.match(renderAgentConfigurationCatalog(live), /static/i);
  const memory = await service.resolve(input);
  assert.equal(memory.source, "cache");
  assert.deepEqual(memory.catalog, live.catalog);
  const failed = new AgentConfigurationCatalogService(home, {
    environment: { HOME: home }, now: () => new Date("2026-09-17T00:01:00Z"),
    discover: async () => { throw new Error("metadata unavailable"); }
  });
  const cached = await failed.resolve(input);
  assert.equal(cached.source, "cache");
  assert.deepEqual(cached.catalog, live.catalog);
  assert.equal(cached.fetchedAt, live.fetchedAt);
  assert.notEqual(cached.attemptedAt, live.attemptedAt);
  assert.match(renderAgentConfigurationCatalog(cached), /metadata unavailable/);
  const mismatch = await failed.resolve({ ...input, cwd: join(home, "different") });
  assert.equal(mismatch.source, "fallback");
  assert.deepEqual(mismatch.catalog.models, []);
  assert.match(renderAgentConfigurationCatalog(mismatch), /static/i);
  const incomplete = await service.resolve({
    ...input, agent: { ...agent, baseArgs: [command, "missing-requirements"] }
  });
  assert.equal(incomplete.source, "fallback", "An absent requirements envelope is not an unconstrained policy.");
  assert.match(incomplete.failure.message, /requirements/i);
  const anotherAgent = { ...agent, id: "another-codex" };
  const separate = await service.resolve({ ...input, agent: anotherAgent });
  assert.equal(separate.catalog.agentId, "another-codex", "Memory reuse must preserve Agent identity too.");

  // Both other native contracts use the same fake executable; only initialize
  // is implemented. ACP must not open a Session to manufacture an enumeration.
  for (const adapter of ["claude", "acp"]) {
    const other = createConfiguredAgent(adapter, adapter, process.execPath, [command], [], at);
    const result = await service.resolve({ agent: other, cwd: home });
    assert.equal(result.source, "live");
    const mode = configurationField(result.catalog, "permission.mode");
    assert.deepEqual(mode.choices, []);
    assert.equal(mode.allowCustom, true);
    if (adapter === "claude") {
      assert.equal(mode.available, false);
      assert.match(configurationField(result.catalog, "settingsSources").reason, /static/i);
      assert.deepEqual(result.catalog.models.map(m => m.value), ["native"]);
    } else {
      assert.equal(result.catalog.handshake.status, "observed");
      assert.equal(mode.available, true, "ACP deliberately defers values to a real Session.");
      assert.match(mode.reason, /per Session/);
      assert.equal(configurationField(result.catalog, "additionalDirectories").available, true);
    }
  }
});

test("permission picker offers only catalog choices or explicitly retained current values", async () => {
  const catalog = fallbackAgentConfigurationCatalog({ id: "codex", adapterId: "codex" });
  const current = { strategy: "configured", sandbox: "read-only", approval: "never" };
  const before = structuredClone(current);
  const output = [];
  const answers = ["configured", "", ""];
  const selected = await selectAgentPermission({
    source: "live", attemptedAt: at.toISOString(), catalog: { ...catalog, fields: [] }
  }, { width: 160, write: text => output.push(text), question: async () => answers.shift() }, current);
  assert.deepEqual(selected, { kind: "selected", permission: current });
  assert.deepEqual(current, before);
  assert.doesNotMatch(output.join(""), /danger-full-access|workspace-write|on-request|bypass/);
  const emptyAnswers = ["configured", "", ""];
  const empty = await selectAgentPermission({
    source: "live", attemptedAt: at.toISOString(),
    catalog: { ...catalog, fields: [{ key: "permission.strategy", allowCustom: false,
      choices: [{ value: "configured", label: "configured" }] }] }
  }, { width: 160, write: () => {}, question: async () => emptyAnswers.shift() }, { strategy: "default" });
  assert.deepEqual(empty, { kind: "cancelled" },
    "Unavailable fields must not manufacture an invalid empty configured permission.");
  const acpAnswers = ["configured", "native-mode"];
  const acp = await selectAgentPermission({
    source: "fallback", attemptedAt: at.toISOString(),
    catalog: fallbackAgentConfigurationCatalog({ id: "acp", adapterId: "acp" })
  }, { width: 160, write: () => {}, question: async () => acpAnswers.shift() }, { strategy: "default" });
  assert.deepEqual(acp, { kind: "selected", permission: { strategy: "configured", mode: "native-mode" } });
});

test("Role wizard displays query failures, does not add permission choices, and keeps ACP custom modes", async () => {
  const run = async (adapterId, catalog, answers) => {
    const output = [];
    const role = { name: "fixture", activeAgentId: adapterId, agentBindings: {
      [adapterId]: { agentId: adapterId, adapterId, config: { adapterId, permission: { strategy: "default" } } }
    } };
    const before = structuredClone(role);
    const result = await resolveGlobalRoleAgentConfigurationArguments("fixture", adapterId, {
      call: method => {
        if (method === "role.show") return role;
        assert.equal(method, "agent.capabilities", "A wizard query must not mutate configuration.");
        return { source: "fallback", attemptedAt: at.toISOString(), catalog,
          failure: { code: "probe-failed", message: "metadata down" } };
      }
    }, { interactive: true, json: false, width: 160, write: text => output.push(text),
      question: async () => answers.shift() });
    assert.deepEqual(role, before);
    return { result, output: output.join("") };
  };
  const missing = await run("codex", {
    ...fallbackAgentConfigurationCatalog({ id: "codex", adapterId: "codex" }), fields: []
  }, ["permission-strategy", "bypass"]);
  assert.equal(missing.result.kind, "cancelled");
  assert.doesNotMatch(missing.output, /bypass|danger-full-access/);
  assert.match(missing.output, /metadata down/);
  const acp = await run("acp", fallbackAgentConfigurationCatalog({ id: "acp", adapterId: "acp" }),
    ["permission-strategy", "configured", "1", "native-mode"]);
  assert.equal(acp.result.kind, "resolved");
  assert.deepEqual(acp.result.args.slice(-4),
    ["--permission-strategy", "configured", "--permission-mode", "native-mode"]);
});
