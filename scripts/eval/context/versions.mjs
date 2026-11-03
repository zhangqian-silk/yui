// Three independent identities. Changing a report/rubric cannot rewrite a run.
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hash } from "./common.mjs";
export const RUN_VERSION = "collaboration-run/1";
const analysisOnly = new Set(["analyze.mjs", "dimensions.mjs", "saved-evidence.mjs", "quantify.mjs", "history.mjs", "semantic-review.mjs", "readable-review.mjs", "review-reader.mjs"]);
export function executionModules(here = fileURLToPath(new URL(".", import.meta.url))) {
  const modules = Object.fromEntries(readdirSync(here).filter(n => n.endsWith(".mjs")
    && !analysisOnly.has(n) && !n.endsWith(".check.mjs") && n !== "check.mjs")
    .sort().map(n => [`context/${n}`, hash(readFileSync(join(here, n)))]));
  for (const path of ["turn-reader.mjs", "replay-observer.mjs", "role-boundary.mjs", "evidence.mjs",
    "shared-collector.mjs", "reuse-fixture/handling.mjs"])
    modules[`context/support/${path}`] = hash(readFileSync(resolve(here, "support", path)));
  for (const path of ["core/io.mjs", "adapters/codex/usage.mjs"])
    modules[path] = hash(readFileSync(resolve(here, "..", path)));
  return modules;
}
