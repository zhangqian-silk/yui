// Wait for process assertions, then exercise the rendered normal paths and
// wait for owned cleanup before with_server.py stops its process group.
import {spawn} from "node:child_process";
import fs from "node:fs";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
const reportPath = join(process.env.YUI_SMOKE_EVIDENCE, "report.json");
let fixture;
try {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try {fixture = JSON.parse(fs.readFileSync(reportPath, "utf8"));} catch {}
    if (fixture?.finishedAt || fixture?.url) break;
    await delay(200);
  }
  if (!fixture?.url || fixture.finishedAt) throw Error("Fixture did not become ready; inspect its report");
  const browser = spawn(process.env.BROWSER_USE ?? "browser-use", [], {stdio: ["pipe", "inherit", "inherit"]});
  const completed = new Promise((resolve, reject) => {
    browser.once("error", reject);
    browser.once("exit", code => resolve(code ?? 1));
  });
  browser.stdin.on("error", () => {});
  browser.stdin.end(fs.readFileSync(new URL("./smoke-web-browser.py", import.meta.url)));
  if (await completed !== 0) process.exitCode = 1;
} finally {
  if (fixture?.fixturePid) {
    try {process.kill(fixture.fixturePid, "SIGTERM");} catch (e) {if (e.code !== "ESRCH") throw e;}
    const deadline = Date.now() + 45000;
    let settled;
    while (Date.now() < deadline) {
      try {settled = JSON.parse(fs.readFileSync(reportPath, "utf8"));} catch {}
      if (settled?.finishedAt) break;
      await delay(200);
    }
    if (!settled?.finishedAt || settled.status !== "passed") process.exitCode = 1;
  }
}
