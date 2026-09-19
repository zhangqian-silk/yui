import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installDevLauncher } from "../../scripts/manage-dev-launcher.mjs";
import { sanitizedTestEnv } from "../helpers/sanitizedEnv.mjs";

test("local launcher is isolated, idempotent and never overwrites an unrelated entrypoint", t => {
  const root = mkdtempSync(join(tmpdir(), "yui-local-launcher-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projectRoot = join(root, "checkout with spaces");
  mkdirSync(join(projectRoot, "dist"), { recursive: true });
  writeFileSync(join(projectRoot, "dist", "cli.js"),
    "console.log(JSON.stringify({home:process.env.YUI_HOME,args:process.argv.slice(2)}));\n");
  const globalBin = join(root, "global-bin");
  mkdirSync(globalBin);
  const original = "#!/bin/sh\nexit 99\n";
  writeFileSync(join(globalBin, "yui"), original, { mode: 0o755 });
  const result = installDevLauncher({ projectRoot });
  const launcher = readFileSync(result.launcherPath, "utf8");
  assert.deepEqual(installDevLauncher({ projectRoot }), result);
  assert.equal(readFileSync(result.launcherPath, "utf8"), launcher);
  assert.deepEqual(readdirSync(join(projectRoot, "output", "dev")), ["bin"]);
  assert.equal(existsSync(result.yuiHome), false);
  const env = sanitizedTestEnv();
  delete env.YUI_HOME;
  env.PATH = `${dirname(process.execPath)}:${globalBin}:${env.PATH}`;
  for (const home of [undefined, join(root, "explicit-home")]) {
    const run = spawnSync(result.launcherPath, ["--probe", "argument with spaces"], {
      cwd: root, env: home === undefined ? env : { ...env, YUI_HOME: home }, encoding: "utf8"
    });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), {
      home: home ?? result.yuiHome, args: ["--probe", "argument with spaces"]
    });
  }
  assert.equal(readFileSync(join(globalBin, "yui"), "utf8"), original);
  writeFileSync(result.launcherPath, original);
  assert.throws(() => installDevLauncher({ projectRoot }), /not managed/);
  assert.equal(readFileSync(result.launcherPath, "utf8"), original);
  rmSync(result.launcherPath);
  symlinkSync(join(globalBin, "yui"), result.launcherPath);
  assert.throws(() => installDevLauncher({ projectRoot }), /not managed/);
  assert.equal(readFileSync(join(globalBin, "yui"), "utf8"), original);
});

test("removed global-link commands fail before touching the checkout or global state", t => {
  const root = mkdtempSync(join(tmpdir(), "yui-no-global-link-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = fileURLToPath(new URL("../../scripts/manage-dev-launcher.mjs", import.meta.url));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const npm = join(bin, "npm");
  writeFileSync(npm, "#!/bin/sh\nexit 97\n", { mode: 0o755 });
  const env = { ...sanitizedTestEnv(), XDG_STATE_HOME: join(root, "state"),
    PATH: `${bin}:${process.env.PATH}` };
  for (const command of ["link", "unlink"]) {
    const run = spawnSync(process.execPath, [script, command], { cwd: root, env, encoding: "utf8" });
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /Usage:.*install-local\|reset-home/);
    assert.deepEqual(readdirSync(root), ["bin"]);
    assert.deepEqual(readdirSync(bin), ["npm"]);
  }
});
