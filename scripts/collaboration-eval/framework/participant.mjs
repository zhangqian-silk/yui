// Deterministic Provider implementation only. Does NOT import plan/oracle,
// observer, scorer, runner or a Store. All business mutations use the real CLI.
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client, hash, save, now, shellQuote, treeHashes, planningReferences, lifecycleWorkingSet, isSessionRecovery, isBusinessScenario } from "./common.mjs";
import { allocationPlan } from "./business-participant.mjs";
import { TurnOriginalReader, waitForGlobalAcceptance } from "../turn-reader.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { spawnSync } from "node:child_process";
const loaded = new Map();
export async function handleTurn({ threadId, turnId, environment, input, config, cancelled, command, initializationOnly = false }) {
  const root = join(environment.YUI_HOME, ".."), trace = [];
  const client = new Client(join(root, "bin/yui"), environment, trace, Date.now() + 80000);
    const nativeFixture = ["native-normal", "normal-warm"].includes(config.scenario) || isSessionRecovery(config.scenario) || isBusinessScenario(config.scenario);
  const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
  if (nativeFixture) client.onStart = args => command({ command: `${quote(client.cli)} ${args.map(quote).join(" ")}` }, "started");
  if (nativeFixture) client.onCall = e => command({ id: e.observationId, command: `${quote(client.cli)} ${e.args.map(quote).join(" ")}`,
    commandActions: [{ type: "unknown", command: `${quote(client.cli)} ${e.args.map(quote).join(" ")}` }],
    aggregatedOutput: e.stdout, exitCode: e.code, durationMs: e.elapsedMs });
  const result = { threadId, turnId, role: environment.YUI_ROLE, handled: [], loads: [],
    scope: { taskId: environment.YUI_TASK_ID, roleName: environment.YUI_ROLE, threadId, turnId, epoch: 0 },
    complete: true, evidence: "deterministic-instrumentation" };
  const interruptBoundary = async () => { await delay(0); if (cancelled?.()) throw Error("Exact fixture Turn interrupted; no new effect"); };
  let memory = loaded.get(threadId);
  if (!memory) { memory = new Map(); loaded.set(threadId, memory); }
  try {
    // Explicit fake adoption only. Real mode has no scripted participant.
    // Every page is a real subprocess through the frozen fixture tool and
    // product CLI with the original inherited environment.
    const helperCall = (request, negativeEnvironment) => {
      const toolCwd = environment.YUI_TASK_ID
        ? join(environment.YUI_HOME, "runtime/task-runtimes/planning", environment.YUI_TASK_ID) : root;
      const argv = [config.originalTool.entry, JSON.stringify(request)];
      const shell = [process.execPath, ...argv].map(shellQuote).join(" ");
      const text = `/usr/bin/zsh -lc ${shellQuote(shell)}`;
      const id = command({ command: text, cwd: toolCwd }, "started");
      // Native exec need not propagate evaluator logging variables. Preserve
      // every managed identity hint; only drop this nonidentity test setting.
      const toolEnvironment = { ...environment };
      delete toolEnvironment.COLLAB_EVAL_CONFIG;
      if (negativeEnvironment === "missing-role") delete toolEnvironment.YUI_ROLE;
      if (negativeEnvironment === "foreign-home") toolEnvironment.YUI_HOME += "-foreign";
      const r = spawnSync("/usr/bin/zsh", ["-lc", shell], { env: toolEnvironment, cwd: toolCwd,
        encoding: "utf8", timeout: 22000, maxBuffer: 65536 });
      command({ id, command: text, cwd: toolCwd, aggregatedOutput: r.stdout + (r.status ? r.stderr : ""),
        exitCode: r.status, durationMs: 0 });
      return r;
    };
    const helperOriginal = operation => {
      let cursor, digest, source, totalBytes, totalCharacters, text = "", value;
      do {
        const request = { ...operation, ...(cursor ? { cursor } : {}) };
        const r = helperCall(request);
        if (r.error || r.status !== 0) throw Error(`Actual original tool rejected: ${r.stderr}`);
        const data = JSON.parse(r.stdout).data;
        value = data.context ?? data;
        const page = value.contentPage;
        if (!page) return value.value ?? value;
        if (!digest) { digest = page.digest; source = page.source;
          totalBytes = page.totalBytes; totalCharacters = page.totalCharacters; }
        if (page.digest !== digest || page.source !== source || page.offset !== text.length
          || page.totalBytes !== totalBytes || page.totalCharacters !== totalCharacters)
          throw Error("Actual tool page identity/continuity mismatch");
        text += page.text; cursor = page.nextCursor;
      } while (cursor !== null);
      if (text.length !== totalCharacters || Buffer.byteLength(text) !== totalBytes || hash(text) !== digest)
        throw Error("Actual tool document hash/length mismatch");
      value = JSON.parse(text);
      return value.value ?? value;
    };
    // Fake obeys the actual delivered notice. It is wiring, not model adoption.
    const hostChecked = input.input?.[0]?.text?.startsWith("Yui Host checked current Skills;");
    const boundManifest = JSON.parse(readFileSync(environment.YUI_SESSION_MANIFEST, "utf8"));
    const skills = hostChecked ? { skills: boundManifest.skills } : client.call(["session", "skills"]);
    if (!memory.has("cli-version")) {
      client.call(["version"], "environment");
      memory.set("cli-version", true);
    }
    if (nativeFixture && !hostChecked) {
      // Replay the actual real-model login-shell shape with PATH deliberately
      // missing both the fixture and the supported Node. No account is used.
      const loginCommand = `PATH=/usr/bin:/bin ${shellQuote(join(root, "bin/yui"))} session skills --json`;
      const login = spawnSync("/usr/bin/zsh", ["-lc", loginCommand],
      { env: environment, encoding: "utf8", timeout: 10000 });
      if (login.status !== 0) throw Error(`Login-shell CLI binding failed: ${login.stderr}`);
      const checked = JSON.parse(login.stdout).data;
      if (JSON.stringify(checked.skills) !== JSON.stringify(skills.skills)
        || checked.skills.some(s => !s.path.startsWith(config.product + "/skills/")))
        throw Error("Login shell selected another product/Skill/version");
      command({ command: `/usr/bin/zsh -lc ${shellQuote(loginCommand)}`,
        commandActions: [{ type: "unknown" }], aggregatedOutput: login.stdout, exitCode: login.status });
    }
    client.call(["help", "inbox", "claim"], "capability", { json: false });
    const manifestBody = readFileSync(environment.YUI_SESSION_MANIFEST, "utf8");
    const manifest = JSON.parse(manifestBody);
    result.manifest = { body: manifestBody, bytes: Buffer.byteLength(manifestBody), sha256: hash(manifestBody) };
    const files = [...skills.skills.map(s => ({ path: join(s.path, "SKILL.md"), kind: "core", version: s.version })),
      { path: manifest.roleProfileRef.path, kind: "profile" },
      ...[...planningReferences(environment.YUI_ROLE, treeHashes(join(config.product, "skills")),
        (isSessionRecovery(config.scenario) || isBusinessScenario(config.scenario)) && environment.YUI_ROLE === "leader"), ...(isSessionRecovery(config.scenario)
        && environment.YUI_ROLE === "leader" ? ["yui-runtime/references/recovery.md",
          ...(lifecycleWorkingSet(treeHashes(join(config.product, "skills"))) ? ["yui-runtime/references/inbox-recovery.md"] : [])] : [])]
        .map(p => ({ path: join(config.product, "skills", p), kind: "topic" }))];
    for (const f of files) {
      const body = readFileSync(f.path, "utf8"), identity = hash(body);
      if (memory.get(f.path) === identity) continue;
      const read = config.scenario === "partial-load" && f.kind === "core" ? body.slice(0, 100) : body;
      if (nativeFixture) {
        const cat = spawnSync("cat", [f.path], { env: environment, encoding: "utf8" });
        command({ command: `cat ${quote(f.path)}`,
          commandActions: [{ type: "read", command: `cat ${quote(f.path)}`, path: f.path }],
          aggregatedOutput: cat.stdout, exitCode: cat.status });
      }
      result.loads.push({ ...f, body: read, bytes: Buffer.byteLength(read), sha256: hash(read),
        complete: read === body, at: now() });
      memory.set(f.path, identity);
    }
    const notification = (input.input ?? []).map(x => x.text ?? "").join("\n");
    await interruptBoundary();
    if (environment.YUI_SESSION_SCOPE === "global") {
      client.detail(["session", "context", "operator"]);
      const entries = client.call(["inbox", "list", "--view", "current"]);
      if (entries.complete !== true) throw Error("Fixture Global inbox exceeds bounded complete input window");
      for (const entry of entries.items) {
        const original = client.detail(["inbox", "show", entry.id]);
        if (config.originalTool && helperOriginal({ kind: "inbox-message", messageId: entry.id }).body !== original.body)
          throw Error("Actual Global/inbox helper body mismatch");
        let body; try { body = JSON.parse(original.body); } catch { continue; }
        if (body.kind !== "eval-route") continue;
        await waitForGlobalAcceptance(client, entry.id, original);
        await interruptBoundary();
        client.call(["inbox", "claim", entry.id, "--request-id", `claim-${entry.id}`], "write");
        const routed = client.call(["task", "message", "send", body.taskId, JSON.stringify(body.input),
          "--intent", "discuss", "--request-id", body.routeKey], "write");
        client.call(["inbox", "ack", entry.id, "--request-id", `ack-${entry.id}`,
          "--reason", `Routed exact input to ${body.taskId}/${routed.message.id}; no business acceptance`], "write");
        result.handled.push({ inboxId: entry.id, routedTask: body.taskId, routedMessage: routed.message.id, at: now() });
      }
    } else {
      const task = environment.YUI_TASK_ID;
      if (!task || environment.YUI_ROLE !== "leader") throw Error("Wrong fixture identity");
      const reader = new TurnOriginalReader(client, task);
      const runMatch = /task=(task-\d+) run=(run-\d+)/.exec(notification);
      const requests = [];
      if (runMatch) {
        if (runMatch[1] !== task) throw Error("Cross-Task Run");
        const base = ["task", "run", "context", `${task}/${runMatch[2]}`];
        const pack = client.detail(base).context;
        if (pack.identity.taskId !== task || pack.identity.runId !== runMatch[2]) throw Error("Wrong exact Run");
        if (pack.input.directiveOmitted) client.detail([...base, "--view", "input"]);
        let pointers = pack.pointers, page = pack.pointerPage;
        while (!page.complete) {
          const next = client.detail([...base, "--view", "refs", "--cursor", page.nextCursor]).context;
          pointers = [...pointers, ...next.refs]; page = next.pointerPage;
        }
        for (const p of pointers.filter(p => ["task", "task-message"].includes(p.store))) {
          if (config.originalTool && p.store === "task-message") {
            const operation = { kind: "run-message", runId: runMatch[2], messageId: p.refId };
            const body = helperOriginal(operation).body;
            if (Buffer.byteLength(body) > 32768 && !memory.has("helper-precheck")) {
              memory.set("helper-precheck", true);
              const first = helperCall(operation);
              if (first.status !== 0) throw Error("Original first-page precheck failed");
              const page = JSON.parse(first.stdout).data.context.contentPage;
              const changed = JSON.parse(Buffer.from(page.nextCursor, "base64url").toString());
              changed.digest = "0".repeat(64);
              const cases = [
                ["wrong-route", { kind: "inbox-message", messageId: operation.messageId }],
                ["cross-owner", operation, "foreign-home"],
                ["missing-identity", operation, "missing-role"],
                ["denied", { ...operation, runId: "run-999999" }],
                ["changed-source", { ...operation, cursor: Buffer.from(JSON.stringify(changed)).toString("base64url") }],
                ["wrong-cursor", { ...operation, cursor: "wrong" }],
                ["output-budget", { ...operation, maxOutputBytes: 1024 }],
                ["time-budget", { ...operation, maxMs: 1 }],
              ];
              const checks = cases.map(([name, r, negativeEnvironment]) => {
                const actual = helperCall(r, negativeEnvironment);
                if (actual.status !== 1 || actual.stdout !== "") throw Error(`Helper precheck false success: ${name}`);
                return { name, code: actual.status, stdout: actual.stdout, stderr: actual.stderr };
              });
              save(join(config.evidence, "original-entry-precheck.json"), { threadId, checks,
                scope: "Actual fixed tool, inherited managed environment, same owned product entry; no identity clearing or replay" });
            }
          }
          else client.detail(["task", "run", "context", "expand", `${task}/${runMatch[2]}`,
            p.refId, "--store", p.store, "--mode", "full"]);
        }
        const inventory = reader.references("task-message");
        for (const p of pointers.filter(p => p.store === "task-message")) {
          const original = reader.message(p.refId, inventory);
          try { if (JSON.parse(original.value.body).kind === "eval-input") requests.push({ original }); } catch { /* unrelated original */ }
        }
      } else client.detail(["task", "context", task]);
      const entries = client.call(["inbox", "list", "--view", "current"]);
      if (entries.complete !== true) throw Error("Fixture Task inbox exceeds bounded complete input window");
      // A replacement initialized before old handling is settled. Only in that
      // explicit recovery does historical claimed handling need inspection;
      // routine turns do not scan old debt or replay it as new work.
      const recovering = !initializationOnly && !runMatch && !loaded.has(`${threadId}:entered`) && entries.historyCount > 0;
      const history = recovering ? client.call(["inbox", "list", "--view", "history"]) : null;
      if (history && history.complete !== true) throw Error("Fixture recovery history incomplete; no effect replay");
      const retained = history ? history.items.filter(e => e.inbox?.claim && !e.inbox?.ack) : [];
      if (!initializationOnly) loaded.set(`${threadId}:entered`, true);
      const windows = [...new Map([...entries.items, ...retained].map(e => [e.id, e])).values()];
      for (let entry of windows) {
        if (entry.blocked && entry.blocked !== "claimed-by-previous-session") continue;
        const shown = client.detail(["inbox", "show", entry.id]);
        if (!entry.inbox?.claim)
          entry = client.call(["inbox", "claim", entry.id, "--request-id", `claim-${entry.id}`], "write");
        // Exercise the product's direct inbox wake, not only task-wake's wrapper.
        const window = isSessionRecovery(config.scenario) && shown.id === entry.id && shown.refs
          ? { wake: shown } : client.detail(["task", "wake", "show", task, entry.id]);
        if (window.wake.taskId !== task || window.wake.id !== entry.id) throw Error("Wrong exact wake");
        const inventory = reader.references("task-message");
        let found = false;
        for (const ref of window.wake.refs) {
          if (ref.taskId !== task) throw Error("Cross-Task window original");
          if (ref.type === "event") { client.detail(["task", "event", "show", task, ref.id]); continue; }
          const original = reader.message(ref.id, inventory);
          if (config.originalTool && helperOriginal({ kind: "task-message", messageId: ref.id }).body !== original.value.body)
            throw Error("Actual current Task Message helper mismatch");
          let body; try { body = JSON.parse(original.value.body); } catch { continue; }
          if (body.kind === "eval-input") { requests.push({ original, entry }); found = true; }
        }
        if (!found) client.call(["inbox", "ack", entry.id, "--request-id", `ack-${entry.id}`,
          "--reason", "Read exact window originals; no evaluation business effect"], "write");
      }
      for (const { original, entry } of requests) {
        await interruptBoundary();
        const body = JSON.parse(original.value.body);
        const inventory = reader.references("task-message");
        const sources = body.sources.map(s => {
          // Negative injection uses a real unauthorized CLI read, not a mocked
          // rejection or a fixture-only guard mistaken for product enforcement.
          if (s.taskId !== task) {
            client.call(["task", "context", s.taskId]);
            throw Error("Cross-Task read unexpectedly allowed");
          }
          return reader.message(s.id, inventory);
        });
        if (config.originalTool) for (const s of sources) {
          if (helperOriginal({ kind: "task-message", messageId: s.value.id }).body !== s.value.body)
            throw Error("Actual Task source helper mismatch");
        }
        const documents = sources.map(s => JSON.parse(s.value.body));
        const rows = body.business ? [] : documents.flatMap(d => d.records);
        const value = body.business === "workshop-allocation" ? allocationPlan(documents, body.request)
          : { count: rows.length, total: rows.reduce((s, r) => s + r.units, 0), unknown: "unknown" };
        if (config.scenario === "quality-fail") value.total++;
        if (config.scenario === "unauthorized-write") client.call(["task", "artifact", "save", task,
          "forbidden-analysis.json", JSON.stringify(value), "--message", "Deliberate fixture forbidden analysis write"], "write");
        const existing = isSessionRecovery(config.scenario)
          ? reader.references("task-decision").map(({ ref }) => {
            // Use the public Decision-show shape through the native adapter.
            const d = client.detail(["task", "decision", "show", task, ref.refId]);
            if (d.taskId !== task || d.decision?.taskId !== task || d.decision.id !== ref.refId)
              throw Error("Wrong exact Decision original");
            return d.decision;
          }).filter(d => d.title === body.effectKey) : reader.effects(body.effectKey);
        if (existing.length > 1) throw Error("Ambiguous effect; no replay");
        await interruptBoundary();
        if (!existing.length) client.call(["task", "decision", "record", task, "--title", body.effectKey,
          "--rationale", JSON.stringify(value)], "write");
        const at = now();
        const dropAck = config.scenario === "missing-ack"
          || (config.scenario === "recovery" || isSessionRecovery(config.scenario)) && body.stage === 2 && !existing.length;
        if (entry && !dropAck) client.call(["inbox", "ack", entry.id, "--request-id", `ack-${entry.id}`,
          "--reason", existing.length ? `Read original/effect ${body.effectKey}; no replay`
            : `Handled exact original ${task}/${original.value.id}; effect ${body.effectKey}`], "write");
        result.handled.push({ original: original.ref, sources: sources.map(s => s.ref), value, at,
          recoveredWithoutReplay: existing.length === 1, ackDropped: dropAck, wakeId: entry?.id });
      }
    }
    return JSON.stringify(result);
  } finally {
    result.finishedAt = now();
    if (!nativeFixture) {
      const dir = join(config.evidence, "participant"); mkdirSync(dir, { recursive: true });
      save(join(dir, `${hash(`${threadId}/${turnId}`)}.json`), { ...result, trace });
    }
  }
}
