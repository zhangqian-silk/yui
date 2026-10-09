import test from "node:test";
import assert from "node:assert/strict";
import { TmuxWebTerminalService } from "../../dist/web/tmuxWebTerminal.js";
import { TmuxManager, yuiTmuxSessionName } from "../../dist/tmux/tmuxManager.js";

test("Task Web writer fences its Role only; Global writer retains host scope", async () => {
  const home = "/fixture", sessions = new Map();
  for (const host of ["task-1", "operator"]) sessions.set(yuiTmuxSessionName(home, host), "");
  const run = (_command, args) => {
    const command = args[2], option = name => args[args.indexOf(name) + 1];
    if (command === "new-session") { sessions.set(option("-s"), option("-t")); return ""; }
    if (command === "kill-session") { sessions.delete(option("-t")); return ""; }
    if (command === "set-option" || command === "set-hook") return "";
    if (command === "list-sessions") return [...sessions].map(([id, group]) => `${id}\x1f${group}\n`).join("");
    if (command === "list-clients") return "";
    assert.fail(`Unexpected tmux call: ${args.join(" ")}`);
  };
  const tmux = new TmuxManager("fixture", { run, runAsync: async (...args) => run(...args) }, { yuiHome: home });
  const service = new TmuxWebTerminalService({
    yuiHome: home, tmuxBin: "fixture",
    tmux: {
      createInteractiveClientSession: (...args) => tmux.createInteractiveClientSession(...args),
      destroyInteractiveClientSession: (...args) => tmux.destroyInteractiveClientSession(...args),
      hasWritableClient: (...args) => tmux.hasWritableClient(...args)
    },
    async prepareGlobalRole() {}, async prepareNative() { return true; },
    spawnPty() { return {
      onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; },
      write() {}, resize() {}, kill() {}
    }; }
  });
  const task = await service.open({ scope: "task", taskId: "task-1", roleName: "leader", nativeSessionId: "thread", columns: 80, rows: 24 });
  try {
    assert.equal(task.readOnly, false);
    assert.equal(await tmux.hasWritableClientAsync("task-1", "leader"), true);
    for (const role of ["worker", "reviewer"]) assert.equal(await tmux.hasWritableClientAsync("task-1", role), false);
  } finally { task.close(); }
  const global = await service.open({ scope: "global", roleName: "operator", nativeSessionId: "global-thread", columns: 80, rows: 24 });
  try {
    assert.equal(global.readOnly, false);
    assert.equal(tmux.hasWritableClient("operator", "other-role"), true);
  } finally { global.close(); }
  assert.equal(sessions.size, 2, "only persistent host sessions remain");
});

test("current native terminal has one writer, stale selection cannot write, closing only detaches its PTY", async () => {
  let seq = 0, current = "thread";
  const leases = new Map(), processes = [];
  const service = new TmuxWebTerminalService({
    yuiHome: "/fixture", tmuxBin: "unused",
    async prepareGlobalRole() {},
    async prepareNative(request) { return request.nativeSessionId === current && request.roleName === "leader"; },
    validateWrite(request) { if (request.nativeSessionId !== current) throw new Error("Session changed"); },
    tmux: {
      createInteractiveClientSession(_host, _notice, access) { const id = "client-" + ++seq; leases.set(id, access); return id; },
      destroyInteractiveClientSession(id) { leases.delete(id); },
      hasWritableClient(_host, _role, except) { return [...leases].some(([id, access]) => id !== except && access === "read-write"); }
    },
    spawnPty(_command, args) {
      const state = { args, written: [], killed: 0, dimensions: null };
      processes.push(state);
      return {
        onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; },
        write(data) { state.written.push(data); }, resize(...size) { state.dimensions = size; }, kill() { state.killed++; }
      };
    }
  });
  const target = { scope: "task", taskId: "task-1", roleName: "leader", nativeSessionId: current, columns: 80, rows: 24 };
  const first = await service.open(target), second = await service.open(target);
  try {
    assert.equal(first.readOnly, false);
    assert.equal(second.readOnly, true);
    first.write("paste\n");
    second.write("must not write");
    assert.deepEqual(processes[0].written, ["paste\n"]);
    assert.deepEqual(processes[1].written, []);
    first.resize(100, 30);
    assert.deepEqual(processes[0].dimensions, [100, 30]);
    current = "replacement";
    assert.throws(() => first.write("stale"), /changed/);
  } finally { first.close(); second.close(); }
  assert.equal(leases.size, 0);
  assert.ok(processes.every(p => p.killed === 1));
  const third = await service.open({ ...target, nativeSessionId: current });
  assert.equal(third.readOnly, false);
  third.close();
});
