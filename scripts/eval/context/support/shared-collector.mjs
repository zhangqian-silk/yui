// Independent process: read-only full-table snapshots and owned-root file watch,
// armed before setup/Global input and stopped only after business/native cleanup.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { ReplayObserver } from "./replay-observer.mjs";
import { digest } from "./evidence.mjs";
const [product, root, output] = process.argv.slice(2);
const observer = await ReplayObserver.create(product, { root, home: join(root, "state") });
const samples = [], failures = [];
let previous, busy = false;
const sample = () => {
  if (!existsSync(join(root, "state/yui.db"))) return;
  try {
    const snapshot = observer.capture(), value = digest(JSON.stringify({ state: snapshot.state, files: snapshot.files }));
    if (value !== previous) { samples.push(snapshot); previous = value; }
    if (samples.length > 1000) throw Error("collector sample limit");
  } catch (error) { failures.push({ at: new Date().toISOString(), error: String(error) }); }
};
const interval = setInterval(sample, 100);
process.on("message", message => {
  if (message !== "finish" || busy) return;
  busy = true; clearInterval(interval); sample();
  const report = { samples, fileJournal: observer.fileEvents, errors: [...failures, ...observer.errors],
    coverage: { allSQLiteTablesAtSamples: true, ownedRootOnly: true, continuousProcessThroughCleanup: true,
      losslessSqlJournal: false, losslessFilesystemJournal: false },
    limitations: ["100ms snapshots cannot prove unjournaled write/revert absence.",
      "fs.watch is not lossless; concurrent file/SQLite snapshot bytes are not one atomic snapshot.",
      "Before schema initialization samples may fail; all failures retained, never treated as zero effects."] };
  observer.close();
  writeFileSync(output, gzipSync(JSON.stringify(report)), { flag: "wx" });
  process.disconnect();
});
process.send("ready");
