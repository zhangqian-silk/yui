import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeGitWorkspace } from "../../dist/repository/gitWorkspace.js";
import { executeGitCommand, GitCommandError } from "../../dist/repository/gitCommand.js";
import { managedGit, managedGitSucceeds, ManagedGitError } from "../../dist/artifacts/managedGit.js";
import { runProjectCommand } from "../../dist/commands/projectCommands.js";
import { openTaskArtifactRepository } from "../../dist/artifacts/taskArtifactRepository.js";

test("clone errors retain the exit reason alongside progress and exact cleanup", async t => {
  const root = mkdtempSync(join(tmpdir(), "yui-git-command-"));
  const originalPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, "git"), `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'git version 2.30.2\\n'
  exit 0
fi
for arg; do
  if [ "$arg" = "signal-fixture" ]; then kill -TERM "$$"; fi
done
printf 'Cloning into fixture...\\n' >&2
exit 128
`, { mode: 0o700 });
  process.env.PATH = `${root}:${originalPath}`;
  const destination = join(root, "clone");
  let config = { gitLocalTimeoutSeconds: 2, gitRemoteInactivityTimeoutSeconds: 3, gitRemoteTimeoutSeconds: 7 };
  const workspace = new NodeGitWorkspace(() => config);
  await assert.rejects(workspace.clone({
    remoteUrl: "/disposable-fixture", destination
  }), error => {
    assert.ok(error instanceof GitCommandError);
    assert.deepEqual(error.budget, { inactivityMs: 3000, totalMs: 7000 });
    assert.equal(error.exitCode, 128);
    assert.equal(error.signal, null);
    assert.match(error.message, /exit code 128/);
    assert.match(error.message, /Cloning into fixture/);
    assert.match(error.message, /Exact temporary clone directory removed or already absent/);
    return true;
  });
  assert.equal(existsSync(destination), false);
  config = { gitLocalTimeoutSeconds: 5, gitRemoteInactivityTimeoutSeconds: 4, gitRemoteTimeoutSeconds: 8 };
  await assert.rejects(runProjectCommand(["clone", "fixture", "/disposable-fixture"], {
    getConfig: () => config,
    rootDirectory: () => root,
    nextProjectId: () => "project-1",
    listProjects: () => []
  }), error => {
    assert.deepEqual(error.budget, { inactivityMs: 4000, totalMs: 8000 },
      "the Project command binds its durable configuration to the default Git implementation");
    return true;
  });
  assert.equal(existsSync(join(root, "projects", "project-1")), false);
  await assert.rejects(workspace.resolveRemoteHead({ remoteUrl: "/fixture", branch: "HEAD" }), error => {
    assert.deepEqual(error.cause.budget, { inactivityMs: 4000, totalMs: 8000 },
      "an existing workspace reads current configuration for the next remote command");
    return true;
  });
  await assert.rejects(workspace.resolveTree(root, "HEAD"), error => {
    assert.deepEqual(error.budget, { totalMs: 5_000 },
      "local commands read their own current budget, independent of remote configuration");
    return true;
  });
  await assert.rejects(workspace.inspect(root), error => {
    assert.deepEqual(error.budget, { totalMs: 5_000 }, "worktree path helpers share the local budget");
    return true;
  });
  await assert.rejects(workspace.treesAgreeOnPaths({
    repositoryPath: root, leftCommit: "signal-fixture", rightCommit: "HEAD", paths: ["fixture"]
  }), error => {
    assert.equal(error.signal, "SIGTERM", "a failed predicate is not a normal false result after signal termination");
    return true;
  });
  await assert.rejects(managedGit(root, ["status"], { getConfig: () => config }), error => {
    assert.ok(error instanceof ManagedGitError);
    assert.deepEqual(error.cause.budget, { totalMs: 5_000 });
    assert.match(error.message, /exit code 128/);
    assert.equal(error.stderr, "Cloning into fixture...");
    return true;
  });
  const artifacts = openTaskArtifactRepository(root, "task-1", () => config);
  await assert.rejects(artifacts.ensure(), error => {
    assert.deepEqual(error.cause.budget, { totalMs: 5_000 }, "artifact repository forwards its owning configuration");
    return true;
  });
  await assert.rejects(managedGitSucceeds(root, ["status", "signal-fixture"]), error => {
    assert.equal(error.cause.signal, "SIGTERM", "managed Git predicates preserve termination facts too");
    return true;
  });
});

test("Git progress refreshes only inactivity; silence, total limit and signals stay distinguishable", async t => {
  const root = mkdtempSync(join(tmpdir(), "yui-git-timeout-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lateHelper = join(root, "late-helper");
  const run = (source, budget) => executeGitCommand(process.execPath, ["-e", source], { budget });
  await Promise.all([
    (async () => {
      const result = await run(`
        let n = 0;
        const timer = setInterval(() => {
          (n++ < 6 ? process.stdout : process.stderr).write("progress\\r");
          if (n === 12) clearInterval(timer);
        }, 80);
      `, { inactivityMs: 400, totalMs: 3000 });
      assert.match(result.stdout.toString(), /progress/);
      assert.match(result.stderr.toString(), /progress/);
    })(),
    assert.rejects(run(`
      process.stderr.write("Cloning into fixture...\\n");
      setInterval(() => {}, 10000);
    `, { inactivityMs: 400, totalMs: 3000 }), error => {
      assert.equal(error.timeoutKind, "inactivity");
      assert.equal(error.signal, "SIGKILL");
      assert.match(error.message, /no-progress timeout.*400 ms/);
      assert.match(error.message, /Cloning into fixture/);
      return true;
    }),
    assert.rejects(run(`
      setInterval(() => process.stderr.write("receiving\\r"), 30);
    `, { inactivityMs: 2000, totalMs: 500 }), error => {
      assert.equal(error.timeoutKind, "total");
      assert.equal(error.signal, "SIGKILL");
      assert.match(error.message, /total timeout.*500 ms/);
      return true;
    }),
    assert.rejects(run(`process.kill(process.pid, "SIGTERM");`, { totalMs: 3000 }), error => {
      assert.equal(error.timeoutKind, undefined);
      assert.equal(error.exitCode, null);
      assert.equal(error.signal, "SIGTERM");
      assert.match(error.message, /signal SIGTERM/);
      return true;
    }),
    assert.rejects(executeGitCommand(join(root, "missing-git"), []), error => {
      assert.equal(error.code, "ENOENT");
      assert.equal(error.exitCode, null, "a spawn error has no fabricated process exit code");
      assert.equal(error.signal, null);
      assert.match(error.message, /ENOENT/);
      return true;
    }),
    (async () => {
      await assert.rejects(run(`
        require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(
          `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(lateHelper)}, "survived"), 1200);`
        )}], { stdio: "inherit" });
        process.stderr.write("transport started\\n");
        setInterval(() => {}, 10000);
      `, { inactivityMs: 400, totalMs: 3000 }), error => {
        assert.equal(error.timeoutKind, "inactivity");
        return true;
      });
      assert.equal(existsSync(lateHelper), false,
        "the transport helper must close with its process group, before cleanup can run");
    })(),
    (async () => {
      const result = await executeGitCommand(process.execPath, ["-e", `
        process.stderr.write("x".repeat(100000) + "last progress");
      `], { budget: { totalMs: 3000 }, stderrTail: true, maxBuffer: 1000 });
      assert.equal(result.stderr.length, 1000);
      assert.equal(result.stderrTruncated, true);
      assert.ok(result.stderr.toString().endsWith("last progress"));
      await assert.rejects(executeGitCommand(process.execPath,
        ["-e", `process.stdout.write("x".repeat(2000));`], {
          budget: { totalMs: 3000 }, maxBuffer: 1000
        }), error => {
        assert.equal(error.code, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
        assert.match(error.message, /stdout maxBuffer/);
        return true;
      });
    })()
  ]);
});
