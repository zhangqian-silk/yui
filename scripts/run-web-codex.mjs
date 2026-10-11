// Driver waits for owned teardown before the server helper's process-group kill.
import {spawn} from "node:child_process";
import fs from "node:fs";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
const path = join(process.env.YUI_SMOKE_EVIDENCE, "report.json");
let fixture;
try {
  const end = Date.now() + 180000;
  while (Date.now() < end) {
    fixture = JSON.parse(fs.readFileSync(path, "utf8"));
    if (fixture.error) throw Error(fixture.error);
    if (fixture.ready) break;
    await delay(250);
  }
  if (!fixture.ready) throw Error("Fixture readiness timeout; no automatic retry");
  const child = spawn(process.env.BROWSER_USE ?? "browser-use", [], {stdio: ["pipe", "inherit", "inherit"]});
  child.stdin.end(fs.readFileSync("scripts/smoke-web-codex.py"));
  process.exitCode = await new Promise(resolve => child.on("exit", code => resolve(code ?? 1)));
} finally {
  if (fixture?.fixturePid) {
    try {process.kill(fixture.fixturePid, "SIGTERM");} catch {}
    const end = Date.now() + 45000;
    while (Date.now() < end) {
      if (JSON.parse(fs.readFileSync(path, "utf8")).finishedAt) break;
      await delay(200);
    }
  }
}
