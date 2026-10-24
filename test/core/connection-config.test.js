import assert from "node:assert/strict";
import { test, mock } from "node:test";
import fs, { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, chmodSync, symlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import { parse } from "smol-toml";
import { planConnectionConfig, applyConnectionConfig, restoreConnectionConfig } from "../../dist/models/connectionConfig.js";

test("standalone connections preserve native config, preview, repeat and conflict-safe restore", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-connection-"));
  try {
    const codexHome = join(root, "codex");
    mkdirSync(codexHome, { mode: 0o700 });
    const config = join(codexHome, "config.toml");
    const original = '# user note\nmodel = "kept"\nmodel_provider = "openai" # official\n[mcp_servers.demo]\ncommand = "keep"\n[model_providers.other]\nname = "Other"\n';
    writeFileSync(config, original, { mode: 0o600 });
    const input = { codex: { codexHome, provider: { id: "cpa", name: "CPA", baseUrl: "http://localhost:9001/v1", auth: { type: "env", envKey: "CPA_KEY" } } } };
    const plan = planConnectionConfig(input);
    assert.equal(plan.status, "preview");
    assert.equal(readFileSync(config, "utf8"), original);
    assert.deepEqual(readdirSync(codexHome), ["config.toml"]);
    const result = applyConnectionConfig(plan, { exclusive: true });
    assert.equal(result.status, "saved");
    const added = readFileSync(config, "utf8");
    assert.ok(added.startsWith(original));
    assert.equal(parse(added).model_provider, "openai");
    assert.equal(parse(added).model_providers.cpa.env_key, "CPA_KEY");
    assert.equal(applyConnectionConfig(planConnectionConfig(input), { exclusive: true }).status, "unchanged");
    const selected = applyConnectionConfig(planConnectionConfig({ codex: { codexHome, selectProvider: "cpa" } }), { exclusive: true });
    assert.equal(parse(readFileSync(config, "utf8")).model_provider, "cpa");
    assert.ok(readFileSync(config, "utf8").includes("# official"));
    assert.equal(restoreConnectionConfig(result, { exclusive: true }).status, "failed");
    assert.equal(restoreConnectionConfig(selected, { exclusive: true }).status, "saved");
    assert.equal(restoreConnectionConfig(result, { exclusive: true }).status, "saved");
    assert.equal(readFileSync(config, "utf8"), original);
    const stale = planConnectionConfig(input);
    writeFileSync(config, original + "# external edit\n");
    assert.equal(applyConnectionConfig(stale, { exclusive: true }).status, "failed");
    assert.ok(readFileSync(config, "utf8").endsWith("# external edit\n"));
    const fresh = planConnectionConfig(input);
    writeFileSync(`${config}.connection.lock`, "another writer\n", { mode: 0o600 });
    const locked = applyConnectionConfig(fresh, { exclusive: true });
    assert.equal(locked.status, "failed");
    assert.equal(locked.files[0].code, "CONFIG_LOCK_UNAVAILABLE");
    assert.equal(readFileSync(`${config}.connection.lock`, "utf8"), "another writer\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bridge -> CPA and direct providers share native files without rewriting routes", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-bridge-connection-"));
  try {
    const configPath = join(root, "bridge.json");
    const providerPath = join(root, "cpa.json");
    writeFileSync(configPath, JSON.stringify({ host: "127.0.0.1", port: 9000, providerFiles: ["official.json"], routes: { keep: true } }), { mode: 0o600 });
    const input = { bridge: { configPath, host: "localhost", port: 9002, provider: { path: providerPath, name: "cpa", via: "cpa", baseUrl: "http://localhost:9001/v1", auth: { type: "keyfile", file: "cpa-key" } } } };
    const saved = applyConnectionConfig(planConnectionConfig(input), { exclusive: true });
    assert.equal(saved.status, "saved");
    assert.deepEqual(JSON.parse(readFileSync(configPath)).providerFiles, ["official.json", "cpa.json"]);
    assert.deepEqual(JSON.parse(readFileSync(configPath)).routes, { keep: true });
    assert.equal(JSON.parse(readFileSync(providerPath)).auth.file, "cpa-key");
    assert.equal(applyConnectionConfig(planConnectionConfig(input), { exclusive: true }).status, "unchanged");
    assert.equal(restoreConnectionConfig(saved, { exclusive: true }).status, "saved");
    assert.equal(readdirSync(root).includes("cpa.json"), false);
    const direct = structuredClone(input);
    direct.bridge.provider.via = "direct";
    direct.bridge.provider.auth = { type: "none" };
    assert.equal(applyConnectionConfig(planConnectionConfig(direct), { exclusive: true }).status, "saved");
    assert.equal(JSON.parse(readFileSync(providerPath)).via, "direct");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("protected files, source syntax, credentials and user scope fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-protected-connection-"));
  try {
    const configPath = join(root, "config.toml");
    const original = `# keep
model = """line one
[not.a.table]
line three"""
[mcp_servers.demo]
args = [
  "[model_providers.cpa]",
]
[model_providers.cpa] # connection
name = 'CPA' # provider label
base_url = 'http://localhost:9001/v1'
wire_api = "responses"
env_key = 'OLD'
extra = { kept = true }
`;
    writeFileSync(configPath, original, { mode: 0o600 });
    const input = { codex: { configPath, provider: { id: "cpa", name: "New", baseUrl: "http://localhost:9002/v1", auth: { type: "official" } } } };
    const saved = applyConnectionConfig(planConnectionConfig(input), { exclusive: true });
    assert.equal(saved.status, "saved");
    const after = readFileSync(configPath, "utf8");
    assert.ok(after.includes("# provider label"));
    assert.equal(parse(after).model, parse(original).model);
    assert.deepEqual(parse(after).model_providers.cpa.extra, { kept: true });
    assert.equal(parse(after).model_providers.cpa.requires_openai_auth, true);
    assert.equal(parse(after).model_providers.cpa.env_key, undefined);
    assert.equal(statSync(saved.files[0].backupPath).mode & 0o777, 0o600);
    assert.throws(() => applyConnectionConfig(JSON.parse(JSON.stringify(planConnectionConfig(input))), { exclusive: true }), /PLAN_HANDLE_REQUIRED/);
    chmodSync(configPath, 0o400);
    assert.throws(() => planConnectionConfig(input), /UNSAFE/);
    chmodSync(configPath, 0o600);
    const link = join(root, "linked");
    mkdirSync(link, { mode: 0o700 });
    symlinkSync(configPath, join(link, "config.toml"));
    assert.throws(() => planConnectionConfig({ codex: { configPath: join(link, "config.toml"), selectProvider: "openai" } }), /UNSAFE/);
    writeFileSync(configPath, '[model_providers.cpa]\nexperimental_bearer_token = "top-secret"\n');
    assert.throws(() => planConnectionConfig(input), error => !String(error).includes("top-secret") && error.code === "CODEX_AUTH_REQUIRES_NATIVE_EDIT");
    writeFileSync(configPath, 'broken = "top-secret');
    assert.throws(() => planConnectionConfig(input), error => !String(error).includes("top-secret") && error.code === "INVALID_TOML_CONFIG");
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, ".codex"));
    assert.throws(() => planConnectionConfig({ codex: { configPath: join(root, ".codex", "config.toml"), selectProvider: "openai" } }, {}), /PROJECT_CONFIG_UNSUPPORTED/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("partial and uncertain file writes are reported and never retried", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-partial-connection-"));
  const originalRename = fs.renameSync;
  try {
    const configPath = join(root, "bridge.json"), providerPath = join(root, "cpa.json");
    const original = '{"providerFiles":["official.json"]}\n';
    writeFileSync(configPath, original, { mode: 0o600 });
    const plan = planConnectionConfig({ bridge: { configPath, provider: { path: providerPath, name: "cpa", via: "cpa", baseUrl: "http://localhost:9001/v1", auth: { type: "none" } } } });
    const rename = mock.method(fs, "renameSync", (from, to) => {
      originalRename(from, to);
      if (to === providerPath) writeFileSync(configPath, `${original} `);
    });
    syncBuiltinESMExports();
    const partial = applyConnectionConfig(plan, { exclusive: true });
    assert.equal(partial.status, "partial");
    assert.deepEqual(partial.files.map(file => file.status), ["saved", "failed"]);
    assert.equal(rename.mock.callCount(), 1);
    rename.mock.restore();
    syncBuiltinESMExports();
    const next = planConnectionConfig({ bridge: { configPath, port: 9123 } });
    const uncertainRename = mock.method(fs, "renameSync", (from, to) => {
      originalRename(from, to);
      throw new Error("simulated post-write I/O failure with secret");
    });
    syncBuiltinESMExports();
    const uncertain = applyConnectionConfig(next, { exclusive: true });
    assert.equal(uncertain.status, "unknown");
    assert.equal(uncertain.files[0].code, "FILESYSTEM_OPERATION_FAILED");
    assert.equal(uncertain.files[0].cleanupPaths, undefined);
    assert.equal(uncertainRename.mock.callCount(), 1);
    assert.ok(!JSON.stringify(uncertain).includes("secret"));
    assert.equal(JSON.parse(readFileSync(configPath)).port, 9123);
    assert.ok(!readdirSync(root).some(name => name.endsWith(".lock") || name.endsWith(".tmp")));
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("packaged standalone CLI uses CODEX_HOME with revision-bound preview and private receipts", () => {
  const root = mkdtempSync(join(tmpdir(), "yui-connection-cli-"));
  try {
    const inputPath = join(root, "request.json"), previewPath = join(root, "preview.json"), receiptPath = join(root, "receipt.json");
    const configPath = join(root, "config.toml");
    writeFileSync(inputPath, JSON.stringify({ codex: { provider: { id: "cpa", name: "CPA", baseUrl: "http://localhost:9001/v1", auth: { type: "none" } } } }));
    const cli = (args) => spawnSync(process.execPath, [new URL("../../dist/models/configureConnection.js", import.meta.url).pathname, ...args],
      { encoding: "utf8", env: { PATH: process.env.PATH, CODEX_HOME: root } });
    const preview = cli(["preview", "--input", inputPath]);
    assert.equal(preview.status, 0, preview.stderr);
    writeFileSync(previewPath, preview.stdout, { mode: 0o600 });
    assert.ok(!readdirSync(root).includes("config.toml"));
    const apply = cli(["apply", "--input", inputPath, "--if-plan", previewPath, "--exclusive", "--receipt", receiptPath]);
    assert.equal(apply.status, 0, apply.stdout);
    assert.equal(JSON.parse(apply.stdout).status, "saved");
    assert.equal(statSync(receiptPath).mode & 0o777, 0o600);
    assert.equal(parse(readFileSync(configPath, "utf8")).model_provider, undefined);
    const repeat = cli(["apply", "--input", inputPath, "--if-plan", previewPath, "--exclusive", "--receipt", join(root, "repeat.json")]);
    assert.equal(repeat.status, 2);
    assert.equal(JSON.parse(repeat.stdout).code, "PREVIEW_REVISION_CONFLICT");
    const restore = cli(["restore", "--from", receiptPath, "--exclusive", "--receipt", join(root, "restored.json")]);
    assert.equal(restore.status, 0, restore.stdout);
    assert.ok(!readdirSync(root).includes("config.toml"));
    assert.ok(!readdirSync(root).some(name => name.endsWith(".lock") || name.endsWith(".tmp")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
