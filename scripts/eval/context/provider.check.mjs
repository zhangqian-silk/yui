import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { fixtureCliScript, shellQuote, groupStopFor } from "./common.mjs";
import { FrameworkFixture } from "./fixture.mjs";
import { attributeNativeEvents, rejectedNativeCleanup } from "./native-ownership.mjs";
import { nativeEvidence, nativeCommandFailures } from "./native-evidence.mjs";
import { subjectFailure } from "./judge.mjs";
for (const category of ["version", "help", "signal"]) test(`ordinary ${category} preserves stdio and exit without WS or native-lifecycle claims`, async t => {
  const root = mkdtempSync(join(tmpdir(), "yui-native-metadata-"));
  let child, terminal;
  t.after(async () => {
    if (child && child.exitCode === null) { child.kill("SIGTERM"); await terminal; }
    rmSync(root, { recursive: true });
  });
  const producer = join(root, "producer"), descriptor = join(root, "config.json");
  writeFileSync(producer, `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>{
    process.stdout.write('ordinary output\\n');process.stderr.write('ordinary diagnostic\\n');
    ${category === "signal" ? "process.kill(process.pid,'SIGTERM')" : "process.exitCode=7"};});`, { mode: 0o755 });
  writeFileSync(descriptor, JSON.stringify({ mode: "real", providerBin: producer, product: root, evidence: root }));
  child = spawn(process.execPath, [fileURLToPath(new URL("./provider.mjs", import.meta.url)),
    ...(category === "version" ? ["--version"] : category === "help" ? ["app-server", "proxy", "--help"] : ["ordinary"])], {
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, COLLAB_EVAL_CONFIG: descriptor,
      YUI_HOME: join(root, "state"), YUI_ROLE: "leader", YUI_SESSION_MANIFEST: "/not-read" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  terminal = once(child, "close");
  const stdout = [], stderr = [];
  child.stdout.on("data", b => stdout.push(b)); child.stderr.on("data", b => stderr.push(b));
  child.stdin.end("synthetic input not recorded");
  const [code, signal] = await terminal;
  assert.equal(code, category === "signal" ? null : 7); assert.equal(signal, category === "signal" ? "SIGTERM" : null);
  assert.equal(Buffer.concat(stdout).toString(), "ordinary output\n");
  assert.equal(Buffer.concat(stderr).toString(), "ordinary diagnostic\n");
  const records = readdirSync(root).filter(n => n.startsWith("transport-"))
    .flatMap(n => readFileSync(join(root, n), "utf8").trim().split("\n").map(JSON.parse));
  assert(!records.some(e => e.invalidFrame || e.message || e.binding));
  assert(records.some(e => e.direction === "custody" && e.child.start));
  assert(records.some(e => e.protocol === "ordinary-stdio" && e.commandClass === (category === "signal" ? "ordinary" : category)));
  assert(records.some(e => e.direction === "exit" && e.code === code && e.signal === signal && e.nativeLifecycle === "not-observed"));
  assert(!JSON.stringify(records).includes("ordinary output"));
  assert(!JSON.stringify(records).includes("ordinary diagnostic"));
  assert(!JSON.stringify(records).includes("synthetic input"));
});
test("absolute fixture entry survives login PATH replacement without losing managed identity", t => {
  const root = mkdtempSync(join(tmpdir(), "yui-cli 'binding-"));
  t.after(() => rmSync(root, { recursive: true }));
  const bin = join(root, "bin"), product = join(root, "product");
  mkdirSync(bin); mkdirSync(product);
  const cli = join(product, "yui"), program = join(product, "probe.mjs"), entry = join(bin, "yui");
  writeFileSync(program, `console.log(JSON.stringify({node:process.execPath,home:process.env.YUI_HOME,role:process.env.YUI_ROLE,thread:process.env.CODEX_THREAD_ID,args:process.argv.slice(2)}));`);
  writeFileSync(cli, `#!/bin/sh\nexec node ${shellQuote(program)} "$@"\n`, { mode: 0o755 });
  writeFileSync(entry, fixtureCliScript(cli, process.execPath, bin), { mode: 0o755 });
  const result = spawnSync("/usr/bin/zsh", ["-lc",
    `PATH=/usr/bin:/bin ${shellQuote(entry)} session skills --json`], {
    env: { HOME: root, PATH: "/usr/bin:/bin", YUI_HOME: join(root, "state"),
      YUI_ROLE: "leader", CODEX_THREAD_ID: "synthetic-thread" },
    encoding: "utf8", timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { node: process.execPath, home: join(root, "state"),
    role: "leader", thread: "synthetic-thread", args: ["session", "skills", "--json"] });
  const nested = join(root, "runtime", "planning");
  mkdirSync(nested, { recursive: true });
  for (const cwd of [root, nested]) for (const shellMode of ["-c", "-lc"]) {
    const shortEntry = relative(cwd, entry);
    const short = spawnSync("/usr/bin/zsh", [shellMode,
      `PATH=/usr/bin:/bin ${shellQuote(shortEntry)} session skills --json`], {
      cwd, env: { HOME: root, PATH: "/usr/bin:/bin", YUI_HOME: join(root, "state"),
        YUI_ROLE: "leader", CODEX_THREAD_ID: "synthetic-thread" },
      encoding: "utf8", timeout: 5000,
    });
    assert.equal(short.status, 0, short.stderr);
    assert.equal(short.stdout, result.stdout, "Actual-cwd-relative entry must preserve Node, Home, identity and argv");
  }
  const wrongCwd = spawnSync("/usr/bin/zsh", ["-c", "bin/yui session skills --json"], {
    cwd: nested, env: { HOME: root, PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 5000,
  });
  assert.notEqual(wrongCwd.status, 0, "A fixed relative entry is not valid after arbitrary cwd changes");
});
for (const isolated of [true, false]) test(`actual proxy ${isolated ? "handshake preserves owned evidence" : "rejects a weaker sandbox receipt without forwarding/fallback"}`, { timeout: 5000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "yui-native-handshake-"));
  let child, terminal, fixture;
  t.after(async () => {
    if (child && child.exitCode === null) { child.kill("SIGTERM"); await terminal; }
    // Only Node's local byte producer was used; no real native Thread exists.
    if (fixture && existsSync(fixture.root)) rmSync(fixture.root, { recursive: true });
    rmSync(root, { recursive: true });
  });
  fixture = new FrameworkFixture(root, root, "fake", "proxy-cleanup", undefined);
  const home = fixture.home, descriptor = join(root, "config.json");
  const frame = (message, opcode = 1, fin = true) => {
    const body = Buffer.isBuffer(message) ? message : Buffer.from(JSON.stringify(message));
    const wide = body.length > 65535, header = Buffer.alloc(wide ? 10 : 4);
    header[0] = (fin ? 0x80 : 0) | opcode; header[1] = wide ? 127 : 126;
    if (wide) header.writeBigUInt64BE(BigInt(body.length), 2); else header.writeUInt16BE(body.length, 2);
    return Buffer.concat([header, body]);
  };
  const tool = (id, threadId, command, aggregatedOutput, exitCode = 0) => ({
    method: "item/completed", params: { threadId, turnId: "turn", item: {
      id, type: "commandExecution", status: exitCode ? "failed" : "completed",
      exitCode, command, aggregatedOutput } },
  });
  const longOutput = "exact UTF-8 完整🌙\n".repeat(12000);
  const longTool = tool("long", "owned", "cat /frozen/long.md", longOutput);
  longTool.params.item.cwd = "/changed-command-cwd";
  const longBody = Buffer.from(JSON.stringify(longTool));
  const incoming = Buffer.concat([Buffer.from("HTTP/1.1 101 Switching Protocols\r\n\r\n"),
    ...[
      { id: "s", result: { thread: { id: "owned" },
        cwd: join(home, "runtime/task-runtimes/planning/task-1"), approvalPolicy: "never",
        sandbox: { type: "workspaceWrite", writableRoots: [], excludeSlashTmp: isolated, excludeTmpdirEnvVar: true } } },
      tool("early", "owned", "yui EARLY_PRIVATE", "EARLY_PRIVATE", 2),
      { id: "t", result: { turn: { id: "turn" } } },
      tool("later", "owned", "yui session skills --json", '{"data":{"skills":[]}}'),
      // Legal fragmented text, an interleaved ping and a >64 KiB frame.
      // The process pipe also splits this buffer into separate data chunks.
      tool("foreign", "foreign", "cat FOREIGN_PRIVATE", "FOREIGN_PRIVATE", 3),
      { method: "turn/completed", params: { threadId: "owned", turn: { id: "turn", status: "failed" } } },
    ].flatMap(m => m.params?.item?.id === "foreign" ? [
      frame(longBody.subarray(0, 37), 1, false), frame(Buffer.from("ping"), 9),
      frame(longBody.subarray(37, longBody.length - 17), 0, false),
      frame(longBody.subarray(longBody.length - 17), 0), frame(m)] : [frame(m)])]);
  // A deterministic local byte producer exercises the real proxy executable,
  // not a live account, Provider model, Home, Controller or product daemon.
  const receiptBytes = 4 + incoming.readUInt16BE(Buffer.byteLength("HTTP/1.1 101 Switching Protocols\r\n\r\n") + 2);
  const split = Buffer.byteLength("HTTP/1.1 101 Switching Protocols\r\n\r\n") + receiptBytes;
  const incomingFile = join(root, "incoming.bin");
  writeFileSync(incomingFile, incoming);
  const producer = join(root, "producer");
  writeFileSync(producer, `#!${process.execPath}\nconst body=require('node:fs').readFileSync(${JSON.stringify(incomingFile)});
    process.stdin.resume();process.stdin.once('data',()=>{
      process.stdout.write(body.subarray(0,${split}));
      process.stdin.on('end',()=>process.stdout.write(body.subarray(${split})));
    });`, { mode: 0o755 });
  writeFileSync(descriptor, JSON.stringify({ mode: "real", providerBin: producer, product: root, evidence: root }));
  child = spawn(process.execPath, [fileURLToPath(new URL("./provider.mjs", import.meta.url)),
    "app-server", "proxy"], {
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root,
      COLLAB_EVAL_CONFIG: descriptor, YUI_HOME: home, YUI_ROLE: "leader",
      YUI_TASK_ID: "task-1", YUI_SESSION_MANIFEST: join(root, "manifest.json") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  terminal = once(child, "close");
  const output = [], errors = [];
  let turnSent = false;
  child.stdout.on("data", b => {
    output.push(b);
    if (!turnSent) {
      turnSent = true;
      child.stdin.end(frame({ id: "t", method: "turn/start", params: { threadId: "owned" } }));
    }
  });
  child.stderr.on("data", b => errors.push(b));
  child.stdin.write(Buffer.concat([Buffer.from("GET / HTTP/1.1\r\n\r\n"),
    frame({ id: "s", method: "thread/start", params: { cwd: join(home, "runtime/task-runtimes/planning/task-1"),
      approvalPolicy: "never", sandbox: "workspace-write", runtimeWorkspaceRoots: [home],
      config: { sandbox_workspace_write: { exclude_tmpdir_env_var: true, exclude_slash_tmp: true } } } })]));
  const [code, signal] = await terminal;
  const records = readdirSync(root).filter(n => n.startsWith("transport-"))
    .flatMap(n => readFileSync(join(root, n), "utf8").trim().split("\n")
      .map(s => ({ ...JSON.parse(s), sourceConnection: n })));
  assert.equal(signal, null);
  if (!isolated) {
    assert.equal(code, 1, Buffer.concat(errors).toString());
    assert.equal(Buffer.concat(output).length, 0, "Rejected receipt must not reach Host");
    const rejection = records.find(e => e.direction === "isolation-rejected");
    assert.match(rejection.error, /Isolation native policy allows shared \/tmp/);
    assert.equal(rejection.fallback, "none");
    assert.equal(records.filter(e => e.direction === "custody").length, 1, "No new bypass child");
    const cleanup = await fixture.close();
    assert.equal(cleanup.status, "retained",
      "Successful native Thread creation rejected before Host binding must prevent release even after proxy exit");
    assert.equal(cleanup.rootAbsent, false);
    assert.equal(cleanup.nativeCleanup.unresolved[0].status, "created-unsettled");
    assert.equal(cleanup.nativeCleanup.unresolved[0].proof.threadId, "owned");
    assert.equal(groupStopFor({ cleanup }).kind, "unknown-lifecycle", "Fence subsequent independent launches");
    return;
  }
  assert.equal(code, 0, Buffer.concat(errors).toString());
  assert.deepEqual(Buffer.concat(output), incoming, "Observation must not alter valid forwarding");
  const find = id => records.find(e => e.direction === "native" && e.message?.params?.item?.id === id);
  assert.equal(find("later").nativeContent, "owned-full");
  assert.equal(find("later").message.params.item.command, "yui session skills --json");
  assert.equal(find("later").message.params.item.aggregatedOutput, '{"data":{"skills":[]}}');
  assert.ok(find("long")?.message.params.item.aggregatedOutput === longOutput,
    "Completed aggregatedOutput must survive WS fragmentation and pipe chunking without truncation");
  assert.equal(find("long").message.params.item.cwd, "/changed-command-cwd");
  assert(records.some(e => e.protocolEvidence === "upgrade-request"));
  assert(records.some(e => e.protocolEvidence === "upgrade-response"));
  for (const id of ["early", "foreign"]) {
    assert.equal(find(id).nativeContent, "unattributed-metadata");
    assert.equal(find(id).message.params.item.command, undefined);
    assert.equal(find(id).message.params.item.aggregatedOutput, undefined);
    assert(find(id).message.omittedBody.sha256);
  }
  assert(!JSON.stringify(records).includes("FOREIGN_PRIVATE"));
  assert(!JSON.stringify(records).includes("EARLY_PRIVATE"));
  const owned = attributeNativeEvents(records).events;
  assert(owned.includes(find("early"))); assert(!owned.includes(find("foreign")));
  const failures = nativeCommandFailures(owned, { taskId: "task-1", roleName: "leader",
    threadId: "owned", turnId: "turn" });
  assert.equal(subjectFailure(failures).observation.status, "unknown");
  assert.equal(subjectFailure(failures).nativeFailures[0].nativeItemId, "early");
  const evidence = nativeEvidence(owned);
  assert.equal(evidence[0].trace.length, 1);
  assert.equal(evidence[0].complete, false);
  const cleanup = await fixture.close();
  assert.equal(cleanup.status, "released", "A valid startup does not create a rejected-Thread cleanup debt");
  assert.equal(cleanup.rootAbsent, true);
});
test("real proxy forwards post-start naming/Goal requests, replies and WS controls byte-for-byte", { timeout: 5000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "yui-native-post-start-"));
  let child, terminal;
  t.after(async () => {
    if (child && child.exitCode === null) { child.kill("SIGTERM"); await terminal; }
    rmSync(root, { recursive: true });
  });
  // An interactive local byte producer, not Codex or a daemon. Both endpoints
  // assert bytes, so logging a parsed request alone cannot satisfy the test.
  const frame = (body, opcode = 1, fin = true, masked = false) => {
    body = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    assert(body.length < 126);
    const header = Buffer.from([(fin ? 128 : 0) | opcode, body.length | (masked ? 128 : 0)]);
    const mask = Buffer.from([11, 23, 37, 49]);
    return Buffer.concat([header, ...(masked ? [mask] : []),
      masked ? body.map((b, i) => b ^ mask[i % 4]) : body]);
  };
  const request = (id, method, params) => frame({ id, method, params }, 1, true, true);
  const home = join(root, "state"), cwd = join(root, "state/runtime/task-runtimes/planning/task-1");
  // The start request is wider than a short frame; reuse a normal 16-bit WS
  // length here while subsequent method frames exercise the short path.
  const startBody = Buffer.from(JSON.stringify({ id: "s", method: "thread/start",
    params: { cwd, approvalPolicy: "never", sandbox: "danger-full-access", runtimeWorkspaceRoots: [cwd] } }));
  const startHeader = Buffer.alloc(4);
  startHeader[0] = 129; startHeader[1] = 126; startHeader.writeUInt16BE(startBody.length, 2);
  const firstInput = Buffer.concat([Buffer.from("GET / HTTP/1.1\r\n\r\n"), startHeader, startBody]);
  const receipt = Buffer.from(JSON.stringify({ id: "s", result: {
    thread: { id: "owned" }, cwd, approvalPolicy: "never", sandbox: { type: "dangerFullAccess" } } }));
  const receiptHeader = Buffer.alloc(4);
  receiptHeader[0] = 129; receiptHeader[1] = 126; receiptHeader.writeUInt16BE(receipt.length, 2);
  const firstOutput = Buffer.concat([Buffer.from("HTTP/1.1 101 Switching Protocols\r\n\r\n"),
    receiptHeader, receipt]);
  const name = Buffer.from(JSON.stringify({ id: "n", method: "thread/name/set",
    params: { threadId: "owned", name: "synthetic 名称" } }));
  const nextInput = Buffer.concat([frame(name.subarray(0, 31), 1, false, true),
    frame(Buffer.from("client ping"), 9, true, true), frame(name.subarray(31), 0, true, true),
    request("g", "thread/goal/get", { threadId: "owned" }),
    frame(Buffer.from("client pong"), 10, true, true)]);
  const goal = Buffer.from(JSON.stringify({ id: "g", result: { goal: null } }));
  const nextOutput = Buffer.concat([frame(Buffer.from("server ping"), 9),
    frame({ id: "n", result: {} }), frame(goal.subarray(0, 13), 1, false),
    frame(Buffer.from("server pong"), 10), frame(goal.subarray(13), 0),
    frame(Buffer.from([3, 232]), 8)]);
  const expectedInput = Buffer.concat([firstInput, nextInput]), expectedOutput = Buffer.concat([firstOutput, nextOutput]);
  for (const [name, bytes] of [["first-input", firstInput], ["next-input", nextInput],
    ["first-output", firstOutput], ["next-output", nextOutput]]) writeFileSync(join(root, name), bytes);
  const producer = join(root, "producer"), received = join(root, "received");
  writeFileSync(producer, `#!${process.execPath}\nconst fs=require("node:fs"),path=${JSON.stringify(root)};
    const first=fs.readFileSync(path+"/first-input"),next=fs.readFileSync(path+"/next-input");
    let all=Buffer.alloc(0),stage=0;
    const send=name=>{const b=fs.readFileSync(path+"/"+name);
      process.stdout.write(b.subarray(0,3));setImmediate(()=>process.stdout.write(b.subarray(3)));};
    process.stdin.on("data",b=>{all=Buffer.concat([all,b]);
      if(stage===0&&all.length>=first.length){if(!all.subarray(0,first.length).equals(first))process.exit(8);
        stage=1;send("first-output");}
      if(stage===1&&all.length>=first.length+next.length){if(!all.subarray(first.length).equals(next))process.exit(9);
        stage=2;send("next-output");}});
    process.stdin.on("end",()=>{fs.writeFileSync(${JSON.stringify(received)},all);if(stage!==2)process.exitCode=10;});`,
  { mode: 0o755 });
  const descriptor = join(root, "config.json");
  writeFileSync(descriptor, JSON.stringify({ mode: "real", providerBin: producer,
    product: root, evidence: root, permissionMode: "session-only" }));
  child = spawn(process.execPath, [fileURLToPath(new URL("./provider.mjs", import.meta.url)), "app-server", "proxy"], {
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, COLLAB_EVAL_CONFIG: descriptor,
      YUI_HOME: home, YUI_ROLE: "leader", YUI_TASK_ID: "task-1", YUI_SESSION_MANIFEST: join(root, "manifest.json") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  terminal = once(child, "close");
  const output = [], errors = []; let size = 0, nextSent = false, ended = false;
  child.stdout.on("data", b => {
    output.push(b); size += b.length;
    if (!nextSent && size >= firstOutput.length) { nextSent = true; child.stdin.write(nextInput); }
    if (!ended && size >= expectedOutput.length) { ended = true; child.stdin.end(); }
  });
  child.stderr.on("data", b => errors.push(b));
  child.stdin.write(firstInput);
  const [code, signal] = await terminal;
  assert.equal(code, 0, Buffer.concat(errors).toString()); assert.equal(signal, null);
  assert.deepEqual(readFileSync(received), expectedInput, "Native endpoint receives every original Host/control byte");
  assert.deepEqual(Buffer.concat(output), expectedOutput, "Host receives every native reply/control byte");
  const records = readdirSync(root).filter(n => n.startsWith("transport-"))
    .flatMap(n => readFileSync(join(root, n), "utf8").trim().split("\n").map(JSON.parse));
  assert(!records.some(e => e.invalidFrame || e.direction === "isolation-rejected"));
  for (const [id, method] of [["n", "thread/name/set"], ["g", "thread/goal/get"]]) {
    assert(records.some(e => e.direction === "host" && e.message?.id === id && e.message.method === method));
    assert(records.some(e => e.direction === "native" && e.message?.id === id),
      "Ownership redaction must not make a received response disappear");
  }
});
for (const mode of ["managed", "detached", "unacknowledged-turn", "truncated-frame", "detached-truncated", "abnormal-exit"]) test(`real proxy child-stdio ${mode} without an account/model`, { timeout: 5000 }, async t => {
  const managed = !mode.startsWith("detached");
  const root = mkdtempSync(join(tmpdir(), "yui-native-stdio-"));
  let child, terminal;
  // Registered before the first process or config write. No Yui Home/setup,
  // Controller, external executable, network or account is exercised.
  t.after(async () => {
    if (child && child.exitCode === null) { child.kill("SIGTERM"); await terminal; }
    rmSync(root, { recursive: true });
  });
  const descriptor = join(root, "config.json");
  const producer = join(root, "producer");
  writeFileSync(producer, `#!${process.execPath}\nprocess.stdin.pipe(process.stdout);process.exitCode=${mode === "abnormal-exit" ? 9 : 0};`, { mode: 0o755 });
  writeFileSync(descriptor, JSON.stringify({ mode: "real", providerBin: producer,
    product: root, evidence: root }));
  child = spawn(process.execPath, [fileURLToPath(new URL("./provider.mjs", import.meta.url)),
    "app-server", "proxy"], {
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root,
      COLLAB_EVAL_CONFIG: descriptor, ...(managed ? { YUI_HOME: join(root, "state"),
        YUI_SESSION_MANIFEST: join(root, "manifest.json"), YUI_ROLE: "leader", YUI_TASK_ID: "local-stdio-only" } : {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  terminal = once(child, "close");
  const output = [], errors = [];
  child.stdout.on("data", b => output.push(b)); child.stderr.on("data", b => errors.push(b));
  const message = mode === "unacknowledged-turn"
    ? { id: "early-turn", method: "turn/start", params: { threadId: "fixture" } }
    : { method: "item/completed", params: { threadId: "fixture", turnId: "turn",
    item: { type: "commandExecution", id: "one", status: "completed", exitCode: 0,
      aggregatedOutput: "FULL", command: "cat /fixture" } } };
  const body = Buffer.from(JSON.stringify(message)), header = Buffer.alloc(4);
  header[0] = 0x81; header[1] = 126; header.writeUInt16BE(body.length, 2);
  const input = Buffer.concat([Buffer.from("HTTP/1.1 101 Switching Protocols\r\n\r\n"), header,
    ["truncated-frame", "detached-truncated"].includes(mode) ? body.subarray(0, body.length - 5) : body]);
  child.stdin.end(input);
  const [code, signal] = await terminal;
  if (mode === "unacknowledged-turn") {
    assert.equal(code, 1, Buffer.concat(errors).toString());
    assert.equal(Buffer.concat(output).length, 0);
    const records = readdirSync(root).filter(n => n.startsWith("transport-"))
      .flatMap(n => readFileSync(join(root, n), "utf8").trim().split("\n").map(JSON.parse));
    assert.match(records.find(e => e.direction === "isolation-rejected").error,
      /Isolation model Turn requires an acknowledged matching sandbox receipt/);
    return;
  }
  assert.equal(code, mode === "abnormal-exit" ? 9 : 0, Buffer.concat(errors).toString()); assert.equal(signal, null);
  assert.deepEqual(Buffer.concat(output), input);
  const events = readdirSync(root).filter(n => n.startsWith("transport-"))
    .flatMap(n => readFileSync(join(root, n), "utf8").trim().split("\n").map(JSON.parse));
  if (mode === "abnormal-exit") {
    assert(!events.some(e => e.invalidFrame), "Abnormal exit alone, not an injected broken frame");
    assert.equal(rejectedNativeCleanup(events).status, "unknown");
    return;
  }
  if (["truncated-frame", "detached-truncated"].includes(mode)) {
    assert(events.some(e => e.invalidFrame?.reason === "incomplete WS payload at stream end"));
    assert(!events.some(e => e.message?.params?.item?.id === "one"));
    assert.equal(rejectedNativeCleanup(events).status, "unknown", "Proxy exit never settles missing protocol evidence");
    return;
  }
  for (const direction of ["native", "host"])
    assert(events.some(e => e.direction === direction && e.message?.params?.item?.id === "one"));
  const native = events.filter(e => e.direction === "native" && e.message);
  assert(native.every(e => e.nativeContent === "unattributed-metadata"));
  assert(native.every(e => !e.message?.params?.item?.aggregatedOutput && !e.message?.params?.item?.command));
  assert(native.every(e => e.message.omittedBody.sha256 && e.message.omittedBody.utf8 > 0));
  assert(events.some(e => e.direction === "custody" && e.child.start));
  if (!managed) assert(events.every(e => !e.binding), "Detached control must not impersonate a managed subject");
});
