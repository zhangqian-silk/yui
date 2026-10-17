import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createProject } from "../../dist/repository/project.js";
import { createTask, activateTask, completeTask } from "../../dist/task/task.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";
import { runPublicationCommand, upsertTaskPublication } from "../../dist/commands/taskPublicationCommands.js";
import { runTaskPublicationVerifyCommand } from "../../dist/commands/taskPublicationVerifyCommand.js";
import { createTaskRemoteDeliveryProof } from "../../dist/task/remoteDeliveryService.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { createGitLabCliPublicationVerifier } from "../../dist/external/gitlabPublicationVerifier.js";
import { createGitHubCliPublicationVerifier } from "../../dist/external/githubPublicationVerifier.js";

const now = new Date("2026-10-17T04:00:00Z");
const head = "a".repeat(40), remote = "b".repeat(40), base = "c".repeat(40);
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "yui-tool-evidence-"));
  let store;
  t.after(() => { store?.close(); rmSync(home, { recursive: true, force: true }); });
  store = new SqliteTaskStore(home);
  store.saveProject(createProject("project-1", "app", home,
    { stable: "main", development: "main" }, now));
  const task = completeTask(activateTask(createTask("task-1", "Delivery", now, {
    projectBindings: [{ projectId: "project-1", directory: "app", baseRef: "main",
      baseCommit: base, currentCommit: head }]
  }), now), now, { by: "user", summary: "Accepted" });
  store.saveTask(task);
  store.saveEvent(task.id, createTaskEvent(store.nextEventId(task.id), task.id,
    "task.completed", { projectHeads: `project-1@${head}`, projectBases: `project-1@${base}` }, now));
  const identity = { projectId: "project-1", provider: "gitlab", repository: "team/app",
    externalKind: "merge-request", externalId: "42" };
  const upsert = patch => store.transaction(tx => upsertTaskPublication(tx, task,
    { ...identity, ...patch }, "user", now).reference);
  const publication = upsert({ localCommit: head, externalUrl: "https://forge.example/team/app/-/merge_requests/42",
    targetBranch: "main" });
  const evidence = { ...identity, taskId: task.id, publicationId: publication.id,
    localCommit: head, externalUrl: publication.externalUrl, targetBranch: "main",
    state: "merged", headCommit: head, remoteCommit: remote,
    observedAt: now.toISOString(), tool: "internal-cli", command: "internal-cli mr inspect team/app!42",
    output: JSON.stringify({ iid: 42, state: "merged", sha: head, merge_commit_sha: remote }) };
  const verify = (input = evidence, id = publication.id) => runTaskPublicationVerifyCommand(
    [`${task.id}/${id}`, "--observation", JSON.stringify(input)], store,
    { environment: {}, now: () => now, verifiers: {} });
  const proof = () => createTaskRemoteDeliveryProof(store, task);
  return { store, task, publication, evidence, verify, proof, upsert };
}

test("tool evidence without gh/glab drives exact delivery and ordinary integrated archive", async t => {
  const f = fixture(t);
  assert.equal(f.proof().delivery.integratedCoverageSatisfied, false);
  const verified = (await f.verify()).data.publication;
  assert.equal(verified.verification, "verified");
  assert.deepEqual(JSON.parse(verified.evidence), f.evidence);
  assert.equal(f.proof().delivery.integratedCoverageSatisfied, true);
  const count = f.store.listPublicationReferences(f.task.id).length;
  assert.equal((await f.verify()).data.publication.id, verified.id, "exact retry is idempotent");
  assert.equal(f.store.listPublicationReferences(f.task.id).length, count);
  assert.deepEqual(f.store.getPublicationReference(f.task.id, f.publication.id), f.publication);
  const archived = runTaskCommand(["archive", f.task.id, "--integrated"], f.store,
    { environment: {}, now: () => now, archiveRemoteDeliveryProof: f.proof() });
  assert.equal(archived.data.archived, true);
  await assert.rejects(f.verify(), /Archived/);
});

test("wrong, incomplete and expired tool evidence cannot establish delivery", async t => {
  const f = fixture(t);
  for (const patch of [
    { taskId: "task-2" }, { publicationId: "publication-2" }, { projectId: "project-2" },
    { repository: "other/app" }, { externalId: "43" },
    { externalUrl: "https://other.example/team/app/-/merge_requests/42" },
    { targetBranch: "other" }, { localCommit: base }, { state: "unknown" },
    { remoteCommit: undefined }, { output: "" }, { tool: "" },
    { observedAt: "2026-10-15T00:00:00Z" }, { observedAt: "2026-10-18T00:00:00Z" }
  ]) {
    await assert.rejects(f.verify({ ...f.evidence, ...patch }));
    assert.equal(f.store.listPublicationReferences(f.task.id).length, 1);
  }
  assert.throws(() => runPublicationCommand(["upsert", f.task.id, "--project", "project-1",
    "--provider", "gitlab", "--repository", "team/app", "--kind", "merge-request", "--id", "42",
    "--state", "merged", "--remote-commit", remote, "--local-commit", head,
    "--verified"], f.store, { environment: {} }), /observation|verify/);
});

test("contrary observations invalidate verification; old receipts cannot restore changed candidates", async t => {
  const f = fixture(t);
  const verified = (await f.verify()).data.publication;
  const contrary = { ...f.evidence, publicationId: verified.id, headCommit: base };
  const changed = (await f.verify(contrary, verified.id)).data.publication;
  assert.equal(changed.verification, "reported");
  assert.equal(f.proof().delivery.integratedCoverageSatisfied, false);
  await assert.rejects(f.verify(), /current|superseded/);
  const moved = f.upsert({ localCommit: base });
  await assert.rejects(f.verify({ ...f.evidence, publicationId: moved.id }, moved.id), /candidate|local/);
  assert.equal(f.proof().delivery.integratedCoverageSatisfied, false);
});

test("service and target edits invalidate tool verification without erasing the original", async t => {
  const f = fixture(t);
  const verified = (await f.verify()).data.publication;
  const title = f.upsert({ title: "New title" });
  assert.equal(title.verification, "verified");
  for (const patch of [{ targetBranch: "release" },
    { externalUrl: "https://another.example/team/app/-/merge_requests/42" }]) {
    const changed = f.upsert(patch);
    assert.equal(changed.verification, "reported");
    assert.equal(f.proof().delivery.integratedCoverageSatisfied, false);
    await assert.rejects(f.verify(), /current|superseded/);
  }
  assert.deepEqual(f.store.getPublicationReference(f.task.id, verified.id), verified);
});

test("optional forge adapters still verify precise objects and expose failures without a new receipt", async t => {
  const f = fixture(t);
  const runCommand = async (command, args) => {
    assert.equal(command, "glab");
    assert.deepEqual(args, ["api", "projects/team%2Fapp/merge_requests/42", "--hostname", "forge.example"]);
    return { code: 0, stdout: JSON.stringify({ iid: 42, state: "merged",
      sha: head, merge_commit_sha: remote, web_url: f.publication.externalUrl,
      target_branch: "main", references: { full: "team/app!42" } }), stderr: "" };
  };
  const verified = await runTaskPublicationVerifyCommand([f.task.id, f.publication.id], f.store, {
    environment: {}, now: () => now, verifiers: { gitlab: createGitLabCliPublicationVerifier({ runCommand }) }
  });
  assert.equal(verified.data.publication.verification, "verified");
  const count = f.store.listPublicationReferences(f.task.id).length;
  await assert.rejects(runTaskPublicationVerifyCommand([f.task.id, verified.data.publication.id], f.store, {
    environment: {}, verifiers: { gitlab: createGitLabCliPublicationVerifier({
      runCommand: async () => ({ code: 127, stdout: "", stderr: "" })
    }) }
  }), /verification failed/);
  assert.equal(f.store.listPublicationReferences(f.task.id).length, count);

  const github = createGitHubCliPublicationVerifier({ runCommand: async (command, args) => {
    assert.equal(command, "gh");
    assert.equal(args[args.indexOf("--repo") + 1], "github.enterprise/team/app");
    return { code: 0, stderr: "", stdout: JSON.stringify({ number: 42, state: "MERGED",
      headRefOid: head, mergeCommit: { oid: remote }, baseRefName: "main",
      url: "https://github.enterprise/team/app/pull/42" }) };
  } });
  const input = { provider: "github", repository: "team/app", externalKind: "pull-request",
    externalId: "42", externalUrl: "https://github.enterprise/team/app/pull/42",
    expectedLocalCommit: head };
  const observation = await github.inspect(input);
  assert.equal(observation.headCommit, head);
  assert.equal(observation.targetBranch, "main");
  await assert.rejects(github.inspect({ ...input, repository: "wrong/repo" }));
});
