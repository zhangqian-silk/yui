import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { cases } from "./cases.mjs";

// Scorer-side contract probes. Never ship these in a participant export.
// Each expected observation is independent of candidate/repair implementation.
const probes = {
  E01: [
    ["upper-bound", m => assert.deepEqual(m.select([{ time: 2 }, { time: 3 }, { time: 4 }], 2, 4),
      [{ time: 2 }, { time: 3 }])],
    ["upper-bound", m => assert.deepEqual(m.select([{ time: 2 }], 2, 2), [])],
    [null, m => assert.deepEqual(m.select([{ time: 1 }, { time: 3 }], 2, 4), [{ time: 3 }])]
  ],
  E02: [
    ["failed-ack", async m => {
      const cache = m.create({ write: async () => { throw new Error("disk"); } });
      await assert.rejects(cache.put("a", 3), /disk/);
      assert.equal(cache.used(), 0);
    }],
    ["duplicate-usage", async m => {
      let writes = 0;
      const cache = m.create({ write: async () => { writes++; } });
      await cache.put("a", 3); await cache.put("a", 3);
      assert.equal(cache.used(), 3); assert.equal(writes, 1);
    }],
    [null, async m => {
      const cache = m.create({ write: async () => {} });
      assert.deepEqual(await cache.put("a", 3), { ok: true });
      await cache.put("b", 2); assert.equal(cache.used(), 5);
    }]
  ],
  E03: [
    ["cursor-coercion", async (m, directory) => {
      const { fetchPage } = await import(pathToFileURL(join(directory, "page.mjs")));
      assert.deepEqual(await m.collect(fetchPage), ["a", "b"]);
    }],
    [null, async m => assert.deepEqual(await m.collect(async cursor => {
      assert.equal(cursor, null); return { items: [], nextCursor: null };
    }), [])],
    [null, async m => {
      let release;
      let requests = 0;
      const waiting = new Promise(resolve => { release = resolve; });
      const failure = new Error("page unavailable");
      const result = m.collect(async () => {
        if (++requests === 1) {
          await waiting;
          return { items: ["a"], nextCursor: "1" };
        }
        throw failure;
      });
      let settled = false;
      const observed = result.finally(() => { settled = true; });
      const rejection = assert.rejects(observed, error => error === failure);
      await Promise.resolve();
      assert.equal(settled, false);
      assert.equal(requests, 1);
      release();
      await rejection;
      assert.equal(requests, 2);
    }]
  ],
  E04: [
    ["double-release", m => {
      const r = m.create(1);
      assert.equal(r.reserve("a"), true); r.cancel("a"); r.cancel("a");
      assert.equal(r.available(), 1);
      assert.equal(r.reserve("b"), true); assert.equal(r.reserve("c"), false);
    }],
    [null, m => {
      const r = m.create(1); r.cancel("unknown");
      assert.equal(r.reserve("a"), true); assert.equal(r.reserve("a"), false);
      assert.equal(r.reserve("b"), false); r.cancel("a"); assert.equal(r.available(), 1);
    }]
  ],
  E05: [
    ["positional-rejoin", m => assert.deepEqual(m.validate([
      { id: "a", value: 3 }, { id: "b", value: NaN }, { id: "c", value: 4 }
    ]), [{ id: "a", ok: true }, { id: "b", ok: false }, { id: "c", ok: true }])],
    [null, m => {
      assert.deepEqual(m.validate([]), []);
      assert.deepEqual(m.validate([{ id: "a", value: 0 }]), [{ id: "a", ok: true }]);
    }]
  ],
  E06: [
    ["write-before-auth", async m => {
      for (const user of [{ id: "u", tenant: "other" }, { id: "x", tenant: "t" }]) {
        const writes = [];
        assert.deepEqual(await m.exportDoc(user, { id: "d", tenant: "t", readers: ["u"], body: "text" },
          { write: async (...args) => { writes.push(args); } }), { status: 403 });
        assert.deepEqual(writes, []);
      }
    }],
    [null, async m => {
      const user = { id: "u", tenant: "t" };
      const doc = { id: "d", tenant: "t", readers: ["u"], body: "text" };
      const writes = [];
      assert.deepEqual(await m.exportDoc(user, doc, { write: async (...args) => { writes.push(args); } }),
        { status: 200 });
      assert.deepEqual(writes, [["d", "text"]]);
      await assert.rejects(m.exportDoc(user, doc, { write: async () => { throw new Error("disk"); } }), /disk/);
    }]
  ],
  E07: [[null, m => {
    const c = m.create(2);
    c.set("a", 1); c.set("b", 2); assert.equal(c.get("a"), 1);
    c.set("c", 3); assert.equal(c.get("b"), undefined);
    c.set("a", 4); c.set("d", undefined);
    assert.equal(c.get("c"), undefined); assert.equal(c.get("a"), 4);
    assert.equal(c.get("d"), undefined);
  }]],
  E08: [[null, m => {
    const entries = [{ id: "a", status: "success", value: 1 }, { id: "b", status: "pending" },
      { id: "c", status: "failure" }];
    assert.deepEqual(m.view(entries), { visible: [1], errors: ["c"], settled: false });
    assert.deepEqual(m.view(entries.filter(e => e.status !== "pending")),
      { visible: [1], errors: ["c"], settled: true });
    assert.deepEqual(m.view([]), { visible: [], errors: [], settled: true });
  }]]
};

export async function verifyCases() {
  const directory = await mkdtemp(join(tmpdir(), "yui-review-cases-"));
  const evidence = [];
  try {
    for (const c of cases) {
      for (const [variant, files] of [["candidate", c.files], ["repaired", c.repaired]]) {
        const target = join(directory, c.id, variant);
        await mkdir(target, { recursive: true });
        for (const [name, source] of Object.entries(files)) await writeFile(join(target, name), source);
        const module = await import(pathToFileURL(join(target, "main.mjs")));
        const failedRoots = new Set();
        for (const [root, check] of probes[c.id]) {
          let failure;
          try { await check(module, target); } catch (error) { failure = error; }
          if (variant === "candidate" && root !== null) {
            assert.ok(failure, `${c.id}/${root} must be observable in the candidate`);
            failedRoots.add(root);
          } else if (failure) throw failure;
        }
        if (variant === "candidate") assert.deepEqual([...failedRoots].sort(), c.gold.map(r => r.id).sort());
        evidence.push({ caseId: c.id, variant, checks: probes[c.id].length, failedRoots: [...failedRoots] });
      }
    }
    return { kind: "deterministic-contract-controls", evidence,
      limitation: "Constructed development examples; no independent human/model review or exhaustive correctness claim." };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
