// Only the external Provider is fake. Native Session IDs are fresh per proxy;
// the managed Host, Context API and command authorization remain real.
import { randomUUID } from "node:crypto";
const args = process.argv.slice(2);
if (args.includes("app-server") && args.includes("proxy")) {
  process.env.YUI_FAKE_THREAD_ID = randomUUID();
  process.env.YUI_FAKE_TURN_HANDLER = new URL("./native-turn.mjs", import.meta.url).href;
  await import("../../test/fixtures/fake-codex-app-server-proxy.mjs");
} else {
  await import("../../test/fixtures/fake-codex-cli.mjs");
}
