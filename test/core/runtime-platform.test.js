import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { sanitizedTestEnv } from "../helpers/sanitizedEnv.mjs";

test("Intel macOS is rejected before CLI dispatch or Home initialization", t => {
  const root = mkdtempSync(join(tmpdir(), "yui-unsupported-platform-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "unopened-home");
  const cli = resolve("dist/cli.js");
  for (const args of [
    ["--json", "version"],
    ["--json", "agent", "--help"],
    ["--json", "upgrade", "--update-preflight"]
  ]) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      Object.defineProperty(process, "platform", { value: "darwin" });
      Object.defineProperty(process, "arch", { value: "x64" });
      process.argv = ${JSON.stringify([process.execPath, cli, ...args])};
      await import(${JSON.stringify(pathToFileURL(cli).href)});
    `], { encoding: "utf8", timeout: 5000, env: sanitizedTestEnv({ YUI_HOME: home }) });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, "Entry paths and update preflight must refuse an unsupported runtime.");
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /"code":"unsupported_platform"/);
    const failure = JSON.parse(result.stderr);
    assert.equal(failure.ok, false);
    assert.equal(failure.code, "unsupported_platform");
    assert.match(failure.message, /darwin-x64/);
    assert.match(failure.message, /arm64 Node\.js/);
    assert.match(failure.message, /2\.23\.0/);
    assert.equal(existsSync(home), false);
  }
});
