// Command for browser-workflows/with_server.py. Settle fixture cleanup before
// that helper's five-second process-group shutdown, even if browser-use fails.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const reportPath = join(process.env.YUI_SMOKE_EVIDENCE, "report.json");
const fixture = JSON.parse(readFileSync(reportPath, "utf8"));
try {
  const browser = spawn(process.env.BROWSER_USE ?? "browser-use", [], {
    stdio: ["pipe", "inherit", "inherit"], env: process.env
  });
  const completed = new Promise((resolve, reject) => {
    browser.once("error", reject);
    browser.once("exit", code => resolve(code));
  });
  browser.stdin.on("error", () => {}); // Spawn failure is reported above.
  browser.stdin.end(readFileSync(new URL("./smoke-web-recovery.py", import.meta.url)));
  if (await completed !== 0) process.exitCode = 1;
} finally {
  try { process.kill(fixture.fixturePid, "SIGTERM"); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
  let settled;
  for (let attempt = 0; attempt < 225; attempt++) {
    try {
      settled = JSON.parse(readFileSync(reportPath, "utf8"));
      if (settled.finishedAt) break;
    } catch {} // Report file may be replacing its previous snapshot.
    await delay(200);
  }
  if (!settled?.finishedAt || settled.status !== "passed") process.exitCode = 1;
}
