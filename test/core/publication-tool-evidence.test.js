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
  const upsert = (patch, at = now) => store.transaction(tx => upsertTaskPublication(tx, task,
    { ...identity, ...patch }, "user", at).reference);
  const publication = upsert({ localCommit: head, externalUrl: "https://forge.example/team/app/-/merge_requests/42",
    targetBranch: "main" });
  const evidence = { ...identity, taskId: task.id, publicationId: publication.id,
    localCommit: head, externalUrl: publication.externalUrl, targetBranch: "main",
    state: "merged", headCommit: head, remoteCommit: remote,
    observedAt: now.toISOString(), tool: "internal-cli", command: "internal-cli mr inspect team/app!42",
    output: JSON.stringify({ iid: 42, state: "merged", sha: head, merge_commit_sha: remote }) };
  const verify = (input = evidence, id = publication.id, at = now) => runTaskPublicationVerifyCommand(
    [`${task.id}/${id}`, "--observation", JSON.stringify(input)], store,
    { environment: {}, now: () => at, verifiers: {} });
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

  const githubRepos = [];
  const github = createGitHubCliPublicationVerifier({ runCommand: async (command, args) => {
    assert.equal(command, "gh");
    githubRepos.push(args[args.indexOf("--repo") + 1]);
    return { code: 0, stderr: "", stdout: JSON.stringify({ number: 42, state: "MERGED",
      headRefOid: head, mergeCommit: { oid: remote }, baseRefName: "main",
      url: "https://github.enterprise/Team/App/pull/42" }) };
  } });
  const input = { provider: "github", repository: "team/app", externalKind: "pull-request",
    externalId: "42", externalUrl: "https://github.enterprise/team/app/pull/42",
    expectedLocalCommit: head };
  const observation = await github.inspect(input);
  assert.equal(observation.headCommit, head);
  assert.equal(observation.targetBranch, "main");
  await assert.rejects(github.inspect({ ...input, repository: "wrong/repo" }), /URL does not match/);
  assert.deepEqual(githubRepos, ["github.enterprise/team/app", "github.enterprise/wrong/repo"]);
});

test("tool evidence retains the exact GitLab service prefix and tolerates GitHub repository URL casing", async t => {
  const f = fixture(t);
  const prefixed = f.upsert({ externalUrl: "https://forge.example/gitlab/team/app/-/merge_requests/42" });
  const prefixedObservation = { ...f.evidence, publicationId: prefixed.id, externalUrl: prefixed.externalUrl };
  const verified = await f.verify(prefixedObservation, prefixed.id);
  assert.equal(verified.data.publication.verification, "verified");
  await assert.rejects(f.verify({ ...prefixedObservation,
    publicationId: verified.data.publication.id,
    externalUrl: "https://forge.example/other/team/app/-/merge_requests/42"
  }, verified.data.publication.id), /externalUrl/);

  const github = f.upsert({ provider: "github", externalKind: "pull-request",
    externalUrl: "https://github.example/team/app/pull/42", localCommit: head, targetBranch: "main" });
  const githubObservation = { ...f.evidence, publicationId: github.id, provider: "github",
    externalKind: "pull-request", externalUrl: "https://github.example/Team/App/pull/42" };
  assert.equal((await f.verify(githubObservation, github.id)).data.publication.verification, "verified");
});

test("GitLab delivery binds structured identity and safe candidate URLs, not UI routes", async t => {
  const f = fixture(t);
  for (const externalUrl of [
    "https://forge.example/team/app/-/merge_requests/42",
    "https://forge.example/team/app/merge_requests/42",
    "https://forge.example/gitlab/review/opaque-link/",
    "https://FORGE.example:443/gitlab/team/app/merge_requests/42"
  ]) {
    for (const adapter of [false, true]) {
      const publication = f.upsert({ externalUrl });
      const observedUrl = externalUrl.replace("FORGE", "forge").replace(":443", "").replace(/\/$/, "");
      const payload = { iid: 42, state: "merged", sha: head, merge_commit_sha: remote,
        web_url: observedUrl, target_branch: "main", references: { full: "team/app!42" } };
      const verify = patch => adapter
        ? runTaskPublicationVerifyCommand([f.task.id, publication.id], f.store, {
          environment: {}, now: () => now, verifiers: {
            gitlab: createGitLabCliPublicationVerifier({ runCommand: async () => ({
              code: 0, stderr: "", stdout: JSON.stringify({ ...payload, ...patch })
            }) })
          }
        })
        : f.verify({ ...f.evidence, publicationId: publication.id,
          externalUrl: observedUrl, ...patch }, publication.id);
      for (const badUrl of [
        "https://other.example/gitlab/review/opaque-link",
        "https://forge.example/another-object",
        "https://user:secret@forge.example/gitlab/review/opaque-link",
        "javascript:alert(1)", `${observedUrl}?token=secret`, `${observedUrl}#fragment`
      ]) await assert.rejects(verify(adapter ? { web_url: badUrl } : { externalUrl: badUrl }));
      if (adapter) {
        for (const patch of [
          { iid: 43 }, { references: { full: "other/app!42" } },
          { target_branch: "wrong" }, { merge_commit_sha: null }, { state: "unknown" }
        ]) await assert.rejects(verify(patch));
      }
      const verified = (await verify({})).data.publication;
      assert.equal(verified.verification, "verified");
      assert.equal(verified.externalUrl, observedUrl, "preserve the provider URL, not a synthesized route");
    }
  }
  for (const externalUrl of ["https://user:secret@forge.example/review/42", "file:///review/42"]) {
    const publication = f.upsert({ externalUrl });
    await assert.rejects(f.verify({ ...f.evidence, publicationId: publication.id, externalUrl }, publication.id));
    let called = false;
    const verifier = createGitLabCliPublicationVerifier({ runCommand: async () => { called = true; } });
    await assert.rejects(verifier.inspect({ provider: "gitlab", externalKind: "merge-request",
      repository: "team/app", externalId: "42", externalUrl, expectedLocalCommit: head }));
    assert.equal(called, false, "reject unsafe recorded URLs before invoking glab");
  }
});

test("evidence may precede bookkeeping, but cannot cross candidate or remote-fact changes", async t => {
  const f = fixture(t);
  const observedAt = new Date(now.getTime() - 1000).toISOString();
  const title = f.upsert({ title: "Bookkeeping after inspection" }, new Date(now.getTime() + 1000));
  const evidence = { ...f.evidence, publicationId: title.id, observedAt };
  const verified = (await f.verify(evidence, title.id, new Date(now.getTime() + 2000))).data.publication;
  assert.equal(verified.verification, "verified", "pre-upsert observation survives a title-only successor");
  const movedAt = new Date(now.getTime() + 3000);
  f.upsert({ localCommit: base }, movedAt);
  const restored = f.upsert({ localCommit: head }, movedAt);
  await assert.rejects(f.verify({ ...evidence, publicationId: restored.id }, restored.id, movedAt), /stale/);
  const fresh = { ...evidence, publicationId: restored.id, observedAt: movedAt.toISOString() };
  const refreshed = (await f.verify(fresh, restored.id, movedAt)).data.publication;
  const contraryAt = new Date(now.getTime() + 4000);
  const contrary = (await f.verify({ ...fresh, publicationId: refreshed.id,
    state: "closed", remoteCommit: undefined, observedAt: contraryAt.toISOString()
  }, refreshed.id, contraryAt)).data.publication;
  await assert.rejects(f.verify({ ...fresh, publicationId: contrary.id }, contrary.id, contraryAt), /stale/);
});

test("adapter observations persist a newly discovered target and reject missing targets", async t => {
  const f = fixture(t);
  const publication = f.upsert({ externalId: "43", localCommit: head });
  const verify = targetBranch => runTaskPublicationVerifyCommand([f.task.id, publication.id], f.store, {
    environment: {}, now: () => now, verifiers: { gitlab: { inspect: async () => ({
      provider: "gitlab", repository: publication.repository, externalKind: "merge-request", externalId: "43",
      state: "merged", headCommit: head, remoteCommit: remote, targetBranch,
      evidence: "controlled adapter response"
    }) } }
  });
  await assert.rejects(verify(undefined), /target branch/);
  const verified = (await verify("release")).data.publication;
  assert.equal(verified.targetBranch, "release");
  assert.equal(verified.verification, "verified");
});
