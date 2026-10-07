import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareCase } from "./cases/prepare.mjs";
import { stagePredecessor, publishAfterPredecessor } from "./predecessor-setup.mjs";
import { producePredecessor } from "./native-predecessor.mjs";
import { executeCase } from "./cases/participant.mjs";
import { scoreCase } from "./cases/oracle.mjs";

test("P predecessor cannot see corrected logs or the later order snapshot", async () => {
  for (const id of ["R02", "A03"]) {
    const root = await mkdtemp(join(tmpdir(), "yui-eval-staging-"));
    try {
      const prepared = await prepareCase(id, "base", root);
      const staged = await stagePredecessor(root, prepared);
      assert.deepEqual(await readdir(join(root, "source")), ["predecessor.json"]);
      assert.equal(JSON.stringify(staged.operation).includes("logs-v2"), false);
      assert.equal(JSON.stringify(staged.operation).includes("orders-s2"), false);
      if (id === "A03") assert.deepEqual(staged.operation.rows.map(r => r.row), ["o1:1", "o2:1"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("actual predecessor artifacts and computed checkpoints survive into scored successor work", async () => {
  for (const id of ["C05", "W01", "R02", "A03"]) {
    const root = await mkdtemp(join(tmpdir(), "yui-eval-predecessor-work-"));
    try {
      const prepared = await prepareCase(id, "base", root);
      const staged = await stagePredecessor(root, prepared);
      const checkpoint = await producePredecessor(root, staged.operation);
      assert.ok(checkpoint.artifacts.length);
      for (const artifact of checkpoint.artifacts) {
        assert.equal(await readFile(join(root, artifact.path), "utf8"), artifact.content);
      }
      if (id === "A03") {
        assert.deepEqual(JSON.parse(checkpoint.artifacts[0].content).days,
          { "2026-02-02": 1000, "2026-02-01": 500 });
        assert.deepEqual(checkpoint.businessCheckpoint.processed, ["o1:1", "o2:1"]);
      }
      if (id === "R02") {
        assert.equal(checkpoint.businessCheckpoint.sourceVersion, "logs-v1");
        assert.equal(checkpoint.artifacts[0].content.includes("logs-v2"), false);
      }
      await publishAfterPredecessor(root, prepared, staged, {
        ...checkpoint, recordRef: { store: "task-message", refId: "unit-only" }
      });
      const readback = { origin: "unit-fixture", records: prepared.facts.map(value =>
        ({ ref: `unit:${value.key}`, digest: value.digest, value })) };
      assert.deepEqual(prepared.facts.find(f => f.key === "checkpoint").body, checkpoint.businessCheckpoint);
      const result = await executeCase({ root, readback });
      const score = await scoreCase(id, { root, result, manifest: prepared.manifest });
      assert.deepEqual(score.failures, []);
      assert.equal(score.status, ["W01", "R02"].includes(id) ? "pending-human" : "scripted-pass");
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
