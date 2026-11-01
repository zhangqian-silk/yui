import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createReleaseActivatePorts, runReleaseInstall } from "../../dist/commands/releaseCommands.js";
import { assertCliHomeReleaseFence } from "../../dist/release/cliHomeReleaseFence.js";
import { writeActiveReleasePointer } from "../../dist/release/runtimeRelease.js";
import { buildReleaseManifest } from "../../scripts/lib/runtime-package.mjs";

test("verified activation preflight reads an inactive target without widening ordinary CLI access", t => {
  const root = mkdtempSync(join(tmpdir(), "yui-release-preflight-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  new SqliteTaskStore(home).close();
  const fenceModule = pathToFileURL(resolve("dist/release/cliHomeReleaseFence.js")).href;
  const upgradeModule = pathToFileURL(resolve("dist/storage/upgrade/upgradeOrchestrator.js")).href;
  const make = name => {
    const source = join(root, name);
    mkdirSync(join(source, "dist/storage/upgrade"), { recursive: true });
    writeFileSync(join(source, "package.json"), JSON.stringify({ type: "module", private: false }));
    // Small executable package fixture. Real CLI/Controller/Host wiring is
    // exercised by the existing assembled-package lifecycle smoke.
    writeFileSync(join(source, "dist/cli.js"), `
      import { fileURLToPath } from "node:url";
      import { dirname } from "node:path";
      import { assertCliHomeReleaseFence } from ${JSON.stringify(fenceModule)};
      const entryPath = fileURLToPath(import.meta.url);
      const args = process.argv.slice(2).filter(x => x !== "--json");
      if (args[0] === "version") console.log("2.18.0");
      else if (args[0] === "help") console.log("Yui fixture");
      else {
        assertCliHomeReleaseFence({ home: process.env.YUI_HOME,
          packageRoot: dirname(dirname(entryPath)), entryPath, args });
        const { runStorageUpgrade } = await import(${JSON.stringify(upgradeModule)});
        console.log(JSON.stringify({ ok: true, data: await runStorageUpgrade({
          home: process.env.YUI_HOME, mode: "update-preflight" }) }));
      }
      // ${name}
    `);
    writeFileSync(join(source, "dist/storage/upgrade/upgradeOrchestrator.js"),
      `export { runStorageUpgrade } from ${JSON.stringify(upgradeModule)};\n`);
    const manifest = buildReleaseManifest(source, { version: "2.18.0" });
    writeFileSync(join(source, "release-manifest.json"), JSON.stringify(manifest));
    const installed = runReleaseInstall(home, source);
    assert.equal(installed.outcome, "installed", installed.message);
    return { ...installed, manifest, source };
  };
  const old = make("old"), target = make("target");
  writeActiveReleasePointer(home, {
    schemaVersion: 1, releaseId: old.releaseId, version: old.manifest.version,
    buildId: old.buildId, packageDigest: old.packageDigest, activatedAt: new Date().toISOString()
  });
  const pointer = readFileSync(join(home, "runtime/active-release.json"));
  const database = readFileSync(join(home, "yui.db"));
  const invocation = {
    home, packageRoot: target.releaseDir, entryPath: join(target.releaseDir, "dist/cli.js")
  };
  for (const args of [["upgrade", "--update-preflight"], ["upgrade"], ["task", "list"]]) {
    assert.throws(() => assertCliHomeReleaseFence({ ...invocation, args }), /Refusing installed-release/);
  }
  const ports = createReleaseActivatePorts();
  assert.throws(() => ports.runPreflight(target.source, home), /verified installed target/);
  const smokePath = join(target.releaseDir, "smoke-receipt.json");
  const smoke = readFileSync(smokePath);
  writeFileSync(smokePath, "{}");
  assert.throws(() => ports.runPreflight(target.releaseDir, home), /matching smoke receipt/);
  writeFileSync(smokePath, smoke);
  assert.doesNotThrow(() => ports.runPreflight(target.releaseDir, home));
  assert.deepEqual(readFileSync(join(home, "runtime/active-release.json")), pointer);
  assert.deepEqual(readFileSync(join(home, "yui.db")), database, "preflight is read-only");
  writeFileSync(join(target.releaseDir, "dist/storage/upgrade/upgradeOrchestrator.js"), "throw new Error('tampered');");
  assert.throws(() => ports.runPreflight(target.releaseDir, home), /drift|digest|integrity/i);
  assert.deepEqual(readFileSync(join(home, "runtime/active-release.json")), pointer);
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  writeFileSync(join(checkout, "package.json"), JSON.stringify({ private: true }));
  assert.throws(() => assertCliHomeReleaseFence({
    home, packageRoot: checkout, entryPath: join(checkout, "dist/cli.js"),
    args: ["upgrade", "--update-preflight"]
  }), /Refusing checkout-local/);
});
