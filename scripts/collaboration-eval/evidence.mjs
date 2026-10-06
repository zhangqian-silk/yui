import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const digest = value => createHash("sha256").update(value).digest("hex");

// Evidence is append-once. Analysis never imports a runner or contacts a Home.
export function createEvidenceWriter(directory) {
  mkdirSync(directory, { recursive: false });
  writeFileSync(join(directory, "record.json"),
    `${JSON.stringify({ schemaVersion: 1, createdAt: new Date().toISOString() })}\n`, { flag: "wx" });
  return evidence => {
    const raw = `${JSON.stringify(evidence, null, 2)}\n`;
    writeFileSync(join(directory, "evidence.json"), raw, { flag: "wx" });
    writeFileSync(join(directory, "sha256"), `${digest(raw)}\n`, { flag: "wx" });
  };
}

export function saveEvidence(directory, evidence) {
  createEvidenceWriter(directory)(evidence);
}

export function readEvidence(directory) {
  const raw = readFileSync(join(directory, "evidence.json"), "utf8");
  if (digest(raw) !== readFileSync(join(directory, "sha256"), "utf8").trim()) {
    throw new Error("Evidence digest mismatch; refusing to analyze modified evidence.");
  }
  const evidence = JSON.parse(raw);
  if (evidence.schemaVersion !== 1 || evidence.mode !== "offline") {
    throw new Error("Unsupported evidence format.");
  }
  return evidence;
}

export function analyze(evidence) {
  const categories = ["code", "docs", "research", "data", "operations"];
  return {
    schemaVersion: 1,
    experiment: evidence.experiment,
    version: evidence.version,
    categories: Object.fromEntries(categories.map(category => {
      const cases = evidence.conditions.filter(item => item.category === category);
      return [category, {
        planned: cases.length,
        statuses: cases.reduce((counts, item) => {
          counts[item.status] = (counts[item.status] ?? 0) + 1;
          return counts;
        }, {})
      }];
    })),
    conditions: evidence.conditions,
    costs: {
      reads: evidence.trace.filter(item => item.phase === "query").length,
      readBytes: evidence.trace.filter(item => item.phase === "query")
        .reduce((sum, item) => sum + item.stdoutBytes + item.stderrBytes, 0),
      modelCalls: 0,
      modelTokens: "unverified",
      modelCost: "N/A",
      humanPreparation: "unknown"
    },
    cleanup: evidence.cleanup,
    limitations: [
      "Deterministic scripted outcomes are not Agent understanding or collaboration success rates.",
      "Not-run, environment-error and pending-human conditions remain in the planned denominator.",
      "No real models, accounts, production systems or user history are evaluated."
    ]
  };
}
