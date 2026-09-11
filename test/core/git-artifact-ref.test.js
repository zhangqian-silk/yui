import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openTaskArtifactRepository } from "../../dist/artifacts/taskArtifactRepository.js";
import {
  formatGitArtifactRef,
  isGitArtifactRefString,
  listCurrentArtifacts,
  parseGitArtifactRef,
  pinCurrentArtifacts,
  readCurrentArtifact,
  resolveGitArtifact,
  validateGitArtifactRef
} from "../../dist/artifacts/gitArtifactRef.js";

function makeHome() {
  return mkdtempSync(join(tmpdir(), "yui-gitref-home-"));
}

const TASK_ID = "task-ref-1";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const DIGEST = "a".repeat(64);

test("git artifact ref: format/parse round-trips a same-Task pinned reference", () => {
  const ref = validateGitArtifactRef({ taskId: TASK_ID, commit: COMMIT, relativePath: "design/plan.md" });
  const asString = formatGitArtifactRef(ref);
  assert.equal(asString, `git:${COMMIT}:design/plan.md`);
  assert.ok(isGitArtifactRefString(asString));
  const parsed = parseGitArtifactRef(asString, TASK_ID);
  assert.equal(parsed.taskId, TASK_ID);
  assert.equal(parsed.commit, COMMIT);
  assert.equal(parsed.relativePath, "design/plan.md");
});

test("git artifact ref: validation rejects bad commit, path, and digest", () => {
  assert.throws(() => validateGitArtifactRef({ taskId: TASK_ID, commit: "nothex", relativePath: "a.md" }), /commit/);
  assert.throws(() => validateGitArtifactRef({ taskId: TASK_ID, commit: COMMIT, relativePath: "../escape" }), /relativePath|escape|forbidden/);
  assert.throws(() => validateGitArtifactRef({ taskId: "", commit: COMMIT, relativePath: "a.md" }), /taskId/);
  assert.throws(() => validateGitArtifactRef({ taskId: TASK_ID, commit: COMMIT, relativePath: "a.md", digest: "short" }), /digest/);
  // A digest-less ref is valid: the commit is the freeze.
  const ref = validateGitArtifactRef({ taskId: TASK_ID, commit: COMMIT, relativePath: "a.md" });
  assert.equal(ref.digest, undefined);
});

test("git artifact ref: parse rejects malformed strings", () => {
  assert.equal(isGitArtifactRefString("artifact-123"), false);
  assert.throws(() => parseGitArtifactRef("artifact-123", TASK_ID), /Not a commit-pinned/);
  assert.throws(() => parseGitArtifactRef("git:", TASK_ID), /git:<commit>/);
  assert.throws(() => parseGitArtifactRef(`git:${COMMIT}:`, TASK_ID), /git:<commit>/);
  assert.throws(() => parseGitArtifactRef(`git:${COMMIT}`, TASK_ID), /git:<commit>/);
});

test("git artifact ref: resolve returns frozen bytes, self-certifying across later saves", async () => {
  const home = makeHome();
  try {
    const repo = openTaskArtifactRepository(home, TASK_ID);
    await repo.ensure();
    const v1 = await repo.save({ files: [{ relativePath: "doc.md", bytes: Buffer.from("v1\n") }], message: "v1" });
    await repo.save({ files: [{ relativePath: "doc.md", bytes: Buffer.from("v2\n") }], message: "v2" });

    const pinned = validateGitArtifactRef({ taskId: TASK_ID, commit: v1.commit, relativePath: "doc.md" });
    const resolved = await resolveGitArtifact(home, pinned);
    assert.equal(resolved.bytes.toString("utf8"), "v1\n");
    assert.equal(resolved.commit, v1.commit);
    assert.match(resolved.digest, /^[a-f0-9]{64}$/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("git artifact ref: resolve detects a recorded-digest drift", async () => {
  const home = makeHome();
  try {
    const repo = openTaskArtifactRepository(home, TASK_ID);
    await repo.ensure();
    const saved = await repo.save({ files: [{ relativePath: "doc.md", bytes: Buffer.from("real\n") }], message: "real" });
    // A reference that pins the right commit/path but a WRONG digest must fail.
    const wrong = validateGitArtifactRef({ taskId: TASK_ID, commit: saved.commit, relativePath: "doc.md", digest: DIGEST });
    await assert.rejects(resolveGitArtifact(home, wrong), /drifted/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("git artifact ref: pinCurrentArtifacts captures HEAD with real digests", async () => {
  const home = makeHome();
  try {
    const repo = openTaskArtifactRepository(home, TASK_ID);
    await repo.ensure();
    await repo.save({
      files: [
        { relativePath: "design/plan.md", bytes: Buffer.from("plan\n") },
        { relativePath: "report.md", bytes: Buffer.from("report\n") }
      ],
      message: "two files"
    });
    const refs = await pinCurrentArtifacts(home, TASK_ID, ["design/plan.md", "report.md"]);
    assert.equal(refs.length, 2);
    for (const ref of refs) {
      assert.match(ref.commit, /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
      assert.match(ref.digest ?? "", /^[a-f0-9]{64}$/);
      // Each pinned ref resolves back to real bytes.
      const resolved = await resolveGitArtifact(home, ref);
      assert.ok(resolved.bytes.length > 0);
    }
    // Pinning a path that is not tracked fails clearly.
    await assert.rejects(pinCurrentArtifacts(home, TASK_ID, ["missing.md"]), /unavailable/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("git artifact ref: ordinary read/list work at HEAD (unfrozen)", async () => {
  const home = makeHome();
  try {
    const repo = openTaskArtifactRepository(home, TASK_ID);
    await repo.ensure();
    await repo.save({ files: [{ relativePath: "a.md", bytes: Buffer.from("A\n") }], message: "a" });
    await repo.save({ files: [{ relativePath: "a.md", bytes: Buffer.from("A2\n") }], message: "a2" });
    const current = await readCurrentArtifact(home, TASK_ID, "a.md");
    assert.equal(current.bytes.toString("utf8"), "A2\n");
    const list = await listCurrentArtifacts(home, TASK_ID);
    assert.deepEqual(list.map((entry) => entry.relativePath), ["a.md"]);
    // A Task with no repo lists as empty (not an error).
    assert.deepEqual(await listCurrentArtifacts(home, "task-none"), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
