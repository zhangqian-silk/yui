import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNativeModelConfiguration } from "../../dist/models/nativeModelConfiguration.js";
import { createModelManagement } from "../../dist/models/modelManagement.js";

test("native model view reads local configuration/cache without exposing credentials or inventing registration", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-native-view-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, ".codex"));
  writeFileSync(join(home, ".codex/config.toml"), `
model = "local-model"
model_provider = "bridge"
model_reasoning_effort = "high"
[model_providers.bridge]
name = "Existing bridge"
base_url = "http://user:secret@localhost:8318/v1?key=secret#secret"
wire_api = "responses"
http_headers = { Authorization = "Bearer secret" }
`);
  writeFileSync(join(home, ".codex/models_cache.json"), JSON.stringify({
    fetched_at: "2026-10-26T00:00:00Z",
    models: [{ slug: "local-model", display_name: "Local model",
      supported_reasoning_levels: [{ effort: "high", description: "secret" }] }]
  }));
  const view = readNativeModelConfiguration({ id: "codex", adapterId: "codex", environment: [] }, { HOME: home });
  assert.equal(view.status, "read");
  assert.equal(view.model, "local-model");
  assert.equal(view.providers[0].baseUrl, "http://localhost:8318/v1");
  assert.equal(view.providers[0].credentialPresent, true);
  assert.equal(view.providers[0].selected, true);
  assert.equal(view.models[0].efforts[0].value, "high");
  assert.equal(JSON.stringify(view).includes("secret"), false);
  assert.equal(view.catalogFetchedAt, "2026-10-26T00:00:00Z");
  const missing = readNativeModelConfiguration({ id: "claude", adapterId: "claude", environment: [] }, { HOME: home });
  assert.equal(missing.status, "absent");
  assert.deepEqual(missing.models, []);
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({
    model: "sonnet", effortLevel: "high", env: {
      ANTHROPIC_BASE_URL: "https://example.test/api?token=secret",
      ANTHROPIC_AUTH_TOKEN: "secret"
    }
  }));
  const claude = readNativeModelConfiguration({ id: "claude", adapterId: "claude", environment: [] }, { HOME: home });
  assert.equal(claude.model, "sonnet");
  assert.equal(claude.providers[0].baseUrl, "https://example.test/api");
  assert.equal(JSON.stringify(claude).includes("secret"), false);
});

test("CPA provider projection shows configured connections but never credential payloads", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-cpa-view-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const configFile = join(home, "cpa.json");
  writeFileSync(configFile, JSON.stringify({ "api-keys": {
    codex: [{ name: "existing", prefix: "relay", "base-url": "https://example.test/v1",
      keys: [{ "api-key": "never-return-this-key" }] }]
  } }), { mode: 0o600 });
  const service = createModelManagement({ getConfig: () => ({ modelManagement: {
    modules: [{ id: "cpa", kind: "cliproxyapi", version: "8", managementUrl: "",
      configFile, managementKeyFile: "", maintenance: "external", quotaAdapter: "none" }],
    endpoints: [], bindings: [], receipts: []
  } }) });
  const view = service.read("cpa");
  assert.equal(view.providers[0].owner, "cliproxyapi");
  assert.equal(view.providers[0].name, "existing");
  assert.equal(view.providers[0].credentialPresent, true);
  assert.equal(view.providers[0].editable, false);
  assert.equal(JSON.stringify(view).includes("never-return-this-key"), false);
});
