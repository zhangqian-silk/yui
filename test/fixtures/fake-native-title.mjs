import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["app-server", "--listen", "stdio://"])) process.exit(81);
const state = process.env.YUI_FAKE_TITLE_STATE;
const events = process.env.YUI_FAKE_TITLE_EVENTS;
let reads = 0;
if (!state || !events) process.exit(82);
appendFileSync(events, JSON.stringify({ pid: process.pid }) + "\n");
process.on("SIGTERM", () => process.env.YUI_FAKE_TITLE_STALL === "1" ? undefined : process.exit(0));
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  const reply = result => process.stdout.write(JSON.stringify({ id: message.id, result }) + "\n");
  if (message.method === "initialize") {
    reply({ codexHome: process.env.YUI_FAKE_TITLE_ACCOUNT ?? process.env.CODEX_HOME });
  } else if (message.method === "thread/read") {
    const current = JSON.parse(readFileSync(state, "utf8"));
    reply({ thread: { id: message.params.threadId, name: current.name ?? null } });
    if (++reads === 1 && process.env.YUI_FAKE_TITLE_EDIT_BEFORE_WRITE === "1") {
      writeFileSync(state, JSON.stringify({ name: "Manual between reads" }));
    }
  } else if (message.method === "thread/name/set") {
    appendFileSync(events, JSON.stringify({ method: message.method, ...message.params }) + "\n");
    writeFileSync(state, JSON.stringify({ name: message.params.name }));
    if (process.env.YUI_FAKE_TITLE_STALL === "1") return;
    if (process.env.YUI_FAKE_TITLE_BAD_REPLY === "1") { reply(null); return; }
    // Unrelated/duplicate replies cannot turn a sent request into confirmation.
    process.stdout.write(JSON.stringify({ id: 9001, result: {} }) + "\n");
    reply({});
    reply({});
  } else if (message.method !== "initialized") {
    process.stdout.write(JSON.stringify({ id: message.id, error: { message: "No business methods on metadata process" } }) + "\n");
  }
});
