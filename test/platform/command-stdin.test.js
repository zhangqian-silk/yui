import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { installDevLauncher } from "../../scripts/manage-dev-launcher.mjs";

const barrier = pathToFileURL(resolve("test/fixtures/stdin-read-barrier.mjs")).href;

async function runWithInput(command, args, env, chunks = []) {
  const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe", "ipc"] });
  let stdout = "", stderr = "", timer;
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdin.on("error", () => {}); // A failing reader may close before the producer.
  child.once("message", message => {
    assert.equal(message, "stdin-read");
    child.stdin.write(chunks[0]);
    // The reader must wait both for the first data and for the remaining data/EOF.
    timer = setTimeout(() => child.stdin.end(chunks.slice(1).join("")), 20);
  });
  const deadline = setTimeout(() => child.kill(), 10000);
  try {
    return await new Promise((resolveResult, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolveResult({ code, signal, stdout, stderr }));
    });
  } finally {
    clearTimeout(deadline);
    clearTimeout(timer);
  }
}

test("command stdin survives terminal setup and delayed segmented pipes", async t => {
  const root = mkdtempSync(join(tmpdir(), "yui-command-stdin-"));
  let store;
  t.after(() => { store?.close(); rmSync(root, { recursive: true, force: true }); });
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root,
    YUI_HOME: join(root, "home"), YUI_STORE_WORKER: "false", NODE_OPTIONS: `--import=${barrier}` };
  const body = `  Quotes: 'single' "double"; 中文\n${"x".repeat(70000)}\nlast line  `;
  const file = join(root, "body.txt");
  writeFileSync(file, body);
  const source = `
    import assert from "node:assert/strict";
    import { TmuxManager } from ${JSON.stringify(pathToFileURL(resolve("dist/tmux/tmuxManager.js")).href)};
    import { readCommandText } from ${JSON.stringify(pathToFileURL(resolve("dist/commands/textInput.js")).href)};
    new TmuxManager("unused", { run() { throw Error("must not launch tmux"); } }, { yuiHome: ${JSON.stringify(root)} });
    const fromPipe = readCommandText(undefined, "-", "--body", "usage");
    const fromFile = readCommandText(undefined, ${JSON.stringify(file)}, "--body", "usage");
    assert.equal(readCommandText("  inline  ", undefined, "--body", "usage"), "inline");
    for (const [inline, file] of [[undefined, undefined], ["inline", "-"], ["  ", undefined], ["a\\0b", undefined]]) {
      assert.throws(() => readCommandText(inline, file, "--body", "usage"));
    }
    console.log(JSON.stringify({ fromPipe, fromFile }));
  `;
  const component = await runWithInput(process.execPath, ["--input-type=module", "-e", source],
    env, [body.slice(0, 9), body.slice(9)]);
  assert.equal(component.code, 0, component.stderr);
  assert.deepEqual(JSON.parse(component.stdout), { fromPipe: body.trim(), fromFile: body.trim() });

  // The actual CLI's pre-parser terminal checks must not touch stdin either.
  // NUL in the final chunk must be rejected before any durable submission.
  store = new SqliteTaskStore(env.YUI_HOME);
  const { launcherPath } = installDevLauncher({ projectRoot: process.cwd(), outputDir: join(root, "dev") });
  for (const json of [false, true]) {
    const result = await runWithInput(launcherPath,
      ["operator", "submit", "--body-file", "-", ...(json ? ["--json"] : [])],
      env, ["first chunk", "\0invalid final chunk"]);
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr + result.stdout, /body is required/);
    assert.doesNotMatch(result.stderr + result.stdout, /EAGAIN/);
    assert.deepEqual(store.listTasks(), []);
  }
});
