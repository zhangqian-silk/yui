import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ArtifactHeadConflictError,
  ArtifactManagedConfigViolationError,
  ArtifactRemoteViolationError,
  openTaskArtifactRepository
} from "../../dist/artifacts/taskArtifactRepository.js";
import {
  safeRelativeArtifactPath,
  resolveContainedArtifactPath,
  taskArtifactRepoPath
} from "../../dist/artifacts/artifactPaths.js";
import {
  ManagedGitError,
  externalProgramConfigViolations,
  managedGit
} from "../../dist/artifacts/managedGit.js";

function makeHome() {
  return mkdtempSync(join(tmpdir(), "yui-artifacts-home-"));
}

const TASK_ID = "task-777";

test("artifact repo: ensure creates a local repo with an empty root commit and no remote", async () => {
  const home = makeHome();
  try {
    const repo = openTaskArtifactRepository(home, TASK_ID);
    assert.equal(repo.exists(), false);
    await repo.ensure();
    assert.equal(repo.exists(), true);
    assert.equal(repo.repoPath, taskArtifactRepoPath(home, TASK_ID));

    // HEAD exists immediately (empty root commit).
    const head = await repo.head();
    assert.match(head ?? "", /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);

    // No remote is configured.
    const remotes = await managedGit(repo.repoPath, ["remote"]);
    assert.equal(remotes.trim(), "");

    // ensure() is idempotent.
    await repo.ensure();
    assert.equal(await repo.head(), head);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("artifact repo: scoped save commits exactly the saved paths and leaves other WIP untouched", async () => {
  const home = makeHome();
  try {
    const repo = openTaskArtifactRepository(home, TASK_ID);
    await repo.ensure();

    // Drop an unrelated WIP file directly in the working tree.
    writeFileSync(join(repo.repoPath, "scratch.txt"), "work in progress\n");

    const result = await repo.save({
      files: [{ relativePath: "design/plan.md", bytes: Buffer.from("plan v1\n") }],
      message: "save design/plan.md"
    });
    assert.deepEqual(result.savedPaths, ["design/plan.md"]);
    assert.match(result.commit, /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);

    // Only design/plan.md is tracked; scratch.txt remains WIP.
    const tracked = await repo.list();
    assert.deepEqual(tracked.map((entry) => entry.relativePath), ["design/plan.md"]);
    const wip = await repo.workingChanges();
    assert.ok(wip.includes("scratch.txt"), `expected scratch.txt in WIP, got ${JSON.stringify(wip)}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("artifact repo: one meaningful update is one commit; re-saving identical bytes is a no-op", async () => {
  const home = makeHome();
  try {
    const repo = openTaskArtifactRepository(home, TASK_ID);
    await repo.ensure();
    const first = await repo.save({
      files: [{ relativePath: "report.md", bytes: Buffer.from("hello\n") }],
      message: "first"
    });
    const second = await repo.save({
      files: [{ relativePath: "report.md", bytes: Buffer.from("hello\n") }],
      message: "identical"
    });
    // No new commit for identical content.
    assert.equal(second.commit, first.commit);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("artifact repo: expected-HEAD conflict stops the save and writes nothing", async () => {
  const home = makeHome();
  try {
    const repo = openTaskArtifactRepository(home, TASK_ID);
    await repo.ensure();
    const base = await repo.head();

    // A concurrent save advances HEAD.
    await repo.save({
      files: [{ relativePath: "a.md", bytes: Buffer.from("a\n") }],
      message: "advance"
    });

    await assert.rejects(
      repo.save({
        files: [{ relativePath: "b.md", bytes: Buffer.from("b\n") }],
        message: "stale",
        expectedHead: base ?? ""
      }),
      (error) => error instanceof ArtifactHeadConflictError
    );

    // b.md must not have been committed.
    const tracked = (await repo.list()).map((entry) => entry.relativePath);
    assert.ok(!tracked.includes("b.md"), `b.md should not be committed, got ${JSON.stringify(tracked)}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("artifact repo: a configured remote is reported as a violation and stops writes", async () => {
  const home = makeHome();
  try {
    const repo = openTaskArtifactRepository(home, TASK_ID);
    await repo.ensure();
    // Someone configures sync out-of-band.
    execFileSync("git", ["-C", repo.repoPath, "remote", "add", "origin", "https://example.invalid/x.git"]);

    await assert.rejects(
      repo.save({ files: [{ relativePath: "x.md", bytes: Buffer.from("x\n") }], message: "blocked" }),
      (error) => error instanceof ArtifactRemoteViolationError && error.remotes.includes("origin")
    );

    // The remote is NOT silently removed.
    const remotes = execFileSync("git", ["-C", repo.repoPath, "remote"], { encoding: "utf8" });
    assert.ok(remotes.includes("origin"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("artifact repo: read pins to a commit so it returns frozen bytes despite later saves", async () => {
  const home = makeHome();
  try {
    const repo = openTaskArtifactRepository(home, TASK_ID);
    await repo.ensure();
    const v1 = await repo.save({
      files: [{ relativePath: "doc.md", bytes: Buffer.from("v1\n") }],
      message: "v1"
    });
    await repo.save({
      files: [{ relativePath: "doc.md", bytes: Buffer.from("v2\n") }],
      message: "v2"
    });

    const frozen = await repo.read("doc.md", v1.commit);
    assert.equal(frozen.bytes.toString("utf8"), "v1\n");
    assert.equal(frozen.commit, v1.commit);

    const current = await repo.read("doc.md");
    assert.equal(current.bytes.toString("utf8"), "v2\n");

    // Digest is stable and matches sha256 of the bytes.
    assert.match(frozen.digest, /^[a-f0-9]{64}$/);
    assert.notEqual(frozen.digest, current.digest);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("artifact repo: reading a missing artifact at a commit fails clearly", async () => {
  const home = makeHome();
  try {
    const repo = openTaskArtifactRepository(home, TASK_ID);
    await repo.ensure();
    const head = await repo.head();
    await assert.rejects(repo.read("does/not/exist.md", head ?? ""), /unavailable/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("artifact paths: traversal, absolute, backslash, and reserved segments are rejected", () => {
  for (const bad of [
    "../escape.md",
    "design/../../escape.md",
    "/etc/passwd",
    "design\\plan.md",
    "design/./plan.md",
    "a/../../b",
    ".git/config",
    "",
    "design/",
    "design//plan.md"
  ]) {
    assert.throws(() => safeRelativeArtifactPath(bad), undefined, `expected rejection for ${JSON.stringify(bad)}`);
  }
  // Valid nested path passes and is normalized to POSIX.
  assert.equal(safeRelativeArtifactPath("design/sub/plan.md"), "design/sub/plan.md");
});

test("artifact paths: a symlink escape is rejected before read/write", async () => {
  const home = makeHome();
  try {
    const repo = openTaskArtifactRepository(home, TASK_ID);
    await repo.ensure();
    // Plant a symlink INSIDE the repo pointing outside it.
    const outside = mkdtempSync(join(tmpdir(), "yui-artifacts-outside-"));
    try {
      mkdirSync(join(repo.repoPath, "design"), { recursive: true });
      symlinkSync(outside, join(repo.repoPath, "design", "link"));
      await assert.rejects(
        resolveContainedArtifactPath(repo.repoPath, "design/link/evil.md"),
        /symbolic link/
      );
      // The save path must refuse it too, and write nothing outside.
      await assert.rejects(
        repo.save({ files: [{ relativePath: "design/link/evil.md", bytes: Buffer.from("x") }], message: "evil" }),
        /symbolic link/
      );
      assert.equal(existsSync(join(outside, "evil.md")), false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("artifact repo: a commit failure after write preserves the written file (no reset/clean)", async () => {
  const home = makeHome();
  try {
    const repo = openTaskArtifactRepository(home, TASK_ID);
    await repo.ensure();
    // Force the Git add/commit step to fail AFTER files are written by locking
    // the index. `git add` cannot take the lock and errors out; the working-tree
    // file the save wrote must remain on disk, exactly as authored.
    const indexLock = join(repo.repoPath, ".git", "index.lock");
    writeFileSync(indexLock, "");
    try {
      await assert.rejects(
        repo.save({ files: [{ relativePath: "keep.md", bytes: Buffer.from("keep\n") }], message: "will fail" }),
        (error) => error instanceof ManagedGitError
      );
      // The file is preserved on disk (not reset/cleaned) so the author can retry.
      const preserved = await readFile(join(repo.repoPath, "keep.md"), "utf8");
      assert.equal(preserved, "keep\n");
    } finally {
      rmSync(indexLock, { force: true });
    }
    // It was never committed.
    const tracked = (await repo.list()).map((entry) => entry.relativePath);
    assert.ok(!tracked.includes("keep.md"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("managed git: forbidden passthrough arguments are rejected", async () => {
  const home = makeHome();
  try {
    const repo = openTaskArtifactRepository(home, TASK_ID);
    await repo.ensure();
    for (const forbidden of [["-c", "protocol.allow=always"], ["--upload-pack", "x"], ["--exec", "sh"]]) {
      await assert.rejects(
        managedGit(repo.repoPath, [...forbidden, "status"]),
        /not permitted/
      );
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("managed git: transport is blocked even when a remote exists", async () => {
  const home = makeHome();
  try {
    const repo = openTaskArtifactRepository(home, TASK_ID);
    await repo.ensure();
    execFileSync("git", ["-C", repo.repoPath, "remote", "add", "origin", "https://example.invalid/x.git"]);
    // A managed fetch must fail closed: protocol.allow=never blocks https.
    await assert.rejects(
      managedGit(repo.repoPath, ["fetch", "origin"]),
      (error) => error instanceof ManagedGitError
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("artifact paths: glob metacharacters in a relativePath are rejected", () => {
  // A pathspec is only safe as a literal identity; a glob char could otherwise
  // be interpreted by Git as a pattern that matches OTHER paths.
  for (const bad of ["a*.md", "a?.md", "a[bc].md", "notes:1.md", "sub/*.md"]) {
    assert.throws(
      () => safeRelativeArtifactPath(bad),
      /glob|wildcard|metacharacter/i,
      `expected rejection for ${JSON.stringify(bad)}`
    );
  }
});

test("artifact repo: a wildcard-named file commits only itself, never undeclared dirty siblings", async () => {
  const home = makeHome();
  try {
    const repo = openTaskArtifactRepository(home, TASK_ID);
    await repo.ensure();

    // Track two real markdown files in an initial save.
    await repo.save({
      files: [
        { relativePath: "a.md", bytes: Buffer.from("a\n") },
        { relativePath: "b.md", bytes: Buffer.from("b\n") }
      ],
      message: "seed"
    });

    // Create a file whose NAME literally contains a glob metacharacter, and make
    // undeclared modifications to the two tracked md files. The pathspec `*.md`
    // WOULD, under glob semantics, match a.md and b.md and sweep those dirty
    // edits into the commit. Under the managed runner's literal pathspec, `*.md`
    // names exactly the one file called `*.md`.
    const wildcard = "*.md";
    writeFileSync(join(repo.repoPath, wildcard), "only me\n");
    writeFileSync(join(repo.repoPath, "a.md"), "a DIRTY\n");
    writeFileSync(join(repo.repoPath, "b.md"), "b DIRTY\n");

    await managedGit(repo.repoPath, ["add", "--", wildcard]);
    await managedGit(repo.repoPath, ["commit", "--only", "-m", "add literal *.md", "--", wildcard]);

    // The undeclared dirty md files must remain UNcommitted WIP — not swept in.
    const wip = await repo.workingChanges();
    assert.ok(wip.includes("a.md"), `a.md must stay WIP, got ${JSON.stringify(wip)}`);
    assert.ok(wip.includes("b.md"), `b.md must stay WIP, got ${JSON.stringify(wip)}`);

    // The committed HEAD content of a.md is still the seeded bytes (not "a DIRTY").
    const head = await repo.head();
    const a = await repo.read("a.md", head ?? "");
    assert.equal(a.bytes.toString("utf8"), "a\n");
    // The literally-named `*.md` IS tracked (the safe-path guard rejects it as an
    // identity, so read it via a direct object lookup, which is literal too).
    const tracked = (await repo.list(head ?? "")).map((entry) => entry.relativePath);
    assert.ok(tracked.includes("*.md"), `*.md must be tracked, got ${JSON.stringify(tracked)}`);
    const committed = await managedGit(repo.repoPath, ["cat-file", "blob", `${head}:*.md`]);
    assert.equal(committed, "only me\n");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("artifact repo: reading a directory object fails as not-a-file (no tree listing as bytes)", async () => {
  const home = makeHome();
  try {
    const repo = openTaskArtifactRepository(home, TASK_ID);
    await repo.ensure();
    await repo.save({
      files: [{ relativePath: "design/plan.md", bytes: Buffer.from("plan\n") }],
      message: "seed"
    });
    // `design` resolves to a TREE object at HEAD; a read must reject it rather
    // than return the tree listing as if it were file bytes.
    await assert.rejects(repo.read("design"), /not a file|unavailable/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("managed git: repo-local external-program config is detected and stops managed writes", async () => {
  const home = makeHome();
  try {
    const repo = openTaskArtifactRepository(home, TASK_ID);
    await repo.ensure();

    // Configure a repo-local content filter plus a matching .gitattributes, the
    // classic vector: `git add` would otherwise run the filter's clean command.
    // Use a HARMLESS SENTINEL that writes a marker file, so we can prove whether
    // it ran. Managed writes must refuse to proceed BEFORE the filter can fire.
    const marker = join(home, "filter-ran.marker");
    execFileSync("git", [
      "-C", repo.repoPath, "config", "--local", "filter.evil.clean",
      // A portable no-network command that leaves proof if ever executed.
      `sh -c 'echo ran > ${marker}'`
    ]);
    writeFileSync(join(repo.repoPath, ".gitattributes"), "*.md filter=evil\n");

    await assert.rejects(
      repo.save({ files: [{ relativePath: "doc.md", bytes: Buffer.from("hello\n") }], message: "blocked" }),
      (error) =>
        error instanceof ArtifactManagedConfigViolationError &&
        error.keys.includes("filter.evil.clean")
    );

    // The filter command was never executed (fail-closed BEFORE `git add`).
    assert.equal(existsSync(marker), false);
    // The config is NOT silently removed — reported and left for manual cleanup.
    const still = execFileSync(
      "git", ["-C", repo.repoPath, "config", "--local", "--get", "filter.evil.clean"],
      { encoding: "utf8" }
    );
    assert.ok(still.includes(marker));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("managed git: externalProgramConfigViolations flags program keys and ignores benign ones", () => {
  // PURE classifier proof with a deterministic `--list -z` sample (key\nvalue\0).
  const sample = [
    "filter.lfs.clean\ngit-lfs clean",     // external program: flagged
    "diff.external\n/usr/bin/x",           // external program: flagged
    "core.pager\nless",                    // external program surface: flagged
    "alias.st\nstatus",                    // alias can run a shell: flagged
    "core.autocrlf\nfalse",                // benign: ignored
    "user.name\nYui",                      // benign: ignored
    "branch.main.remote\norigin"           // benign here (remote is a separate check): ignored
  ].join("\0") + "\0";
  const flagged = externalProgramConfigViolations(sample);
  assert.deepEqual(
    flagged,
    ["alias.st", "core.pager", "diff.external", "filter.lfs.clean"]
  );
  // Empty config is within the boundary.
  assert.deepEqual(externalProgramConfigViolations(""), []);
});

test("managed git: a filter hidden behind include.path is refused before it can run", async () => {
  const home = makeHome();
  try {
    const repo = openTaskArtifactRepository(home, TASK_ID);
    await repo.ensure();

    // The vector message-18 flagged: a `filter.*.clean` lives in an INCLUDED
    // file, not directly in .git/config. `git config --local --list -z` lists
    // only `include.path` (it does NOT expand the include), so a scan that keys
    // solely off `filter.*` would miss it — yet a real `git add`/`status` follows
    // the include and would run the hidden clean command. A managed repo never
    // needs an include, so the include entry point itself must be refused.
    const marker = join(home, "include-filter-ran.marker");
    const includedConfig = join(home, "hidden.cfg");
    writeFileSync(
      includedConfig,
      `[filter "sneaky"]\n\tclean = sh -c 'echo ran > ${marker}'\n`
    );
    execFileSync("git", [
      "-C", repo.repoPath, "config", "--local", "include.path", includedConfig
    ]);
    writeFileSync(join(repo.repoPath, ".gitattributes"), "*.md filter=sneaky\n");

    // Prove the include really is live for an ordinary read (defensive: confirms
    // the vector exists so the test cannot silently pass on a no-op include).
    const expanded = execFileSync(
      "git", ["-C", repo.repoPath, "config", "--list"], { encoding: "utf8" }
    );
    assert.ok(expanded.includes("filter.sneaky.clean"), "include should expand for ordinary git reads");

    await assert.rejects(
      repo.save({ files: [{ relativePath: "doc.md", bytes: Buffer.from("hello\n") }], message: "blocked" }),
      (error) =>
        error instanceof ArtifactManagedConfigViolationError &&
        error.keys.includes("include.path")
    );

    // The hidden clean command never executed (fail-closed before `git add`).
    assert.equal(existsSync(marker), false);
    // Neither the include pointer nor the included file is deleted (reported, not repaired).
    const stillIncluded = execFileSync(
      "git", ["-C", repo.repoPath, "config", "--local", "--get", "include.path"],
      { encoding: "utf8" }
    );
    assert.ok(stillIncluded.includes(includedConfig));
    assert.equal(existsSync(includedConfig), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("managed git: externalProgramConfigViolations rejects config-inclusion entry points", () => {
  // `git config --local --list -z` lists include/worktree entry points without
  // expanding them, so a filter can hide in an included file. The classifier
  // rejects the entry points themselves rather than parsing included files.
  const sample = [
    "include.path\t/etc/evil.cfg".replace("\t", "\n"),
    "includeif.gitdir:/x/.path\n/etc/evil.cfg",
    "extensions.worktreeconfig\ntrue",
    "core.autocrlf\nfalse",                // benign: ignored
    "user.name\nYui"                       // benign: ignored
  ].join("\0") + "\0";
  const flagged = externalProgramConfigViolations(sample);
  assert.deepEqual(
    flagged,
    ["extensions.worktreeconfig", "include.path", "includeif.gitdir:/x/.path"]
  );
});
