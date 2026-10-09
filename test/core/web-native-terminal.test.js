import test from "node:test";
import assert from "node:assert/strict";
import { TmuxWebTerminalService } from "../../dist/web/tmuxWebTerminal.js";

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
