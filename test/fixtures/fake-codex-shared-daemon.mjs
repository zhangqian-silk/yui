import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.CODEX_HOME;
if (home === undefined) throw new Error("The fake Codex account Home is missing.");
const marker = join(home, "daemon-started");
const args = process.argv.slice(2);
if (args.join(" ") === "app-server daemon start") {
  appendFileSync(join(home, "commands"), "start\n");
  writeFileSync(marker, "ready\n");
} else if (args.at(-2) === "app-server" && args.at(-1) === "proxy") {
  appendFileSync(join(home, "commands"), "proxy\n");
  if (!existsSync(marker)) process.exit(1);
  await import("./fake-codex-app-server-proxy.mjs");
} else {
  throw new Error(`Unexpected fake Codex command: ${args.join(" ")}`);
}
