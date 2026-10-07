// Evaluator-only staging. No future material is placed in the native input.
import { readFile, writeFile, unlink, chmod } from "node:fs/promises";
import { join } from "node:path";
import { digest } from "./evidence.mjs";

export async function stagePredecessor(root, prepared) {
  const fact = key => prepared.facts.find(f => f.key === key).body;
  const r = fact("request"), d = fact("decision"), e = fact("evidence");
  let operation;
  switch (r.kind) {
    case "cursor-sdk":
      operation = { kind: r.kind, output: "B/mapping-plan.md", sdk: r.output,
        contract: { version: d.version, requestField: d.requestField, responseFields: d.responseFields } };
      break;
    case "design-document":
      operation = { kind: r.kind, output: r.output, title: r.title,
        choice: d.choice, maxBytes: d.maxBytes, cancellation: d.cancel };
      break;
    case "incident-analysis":
      operation = { kind: r.kind, output: r.output, oldSummary: e.oldSummary,
        sourceVersion: d.supersedes };
      break;
    case "order-aggregate": {
      const source = e.assets.find(a => a.label === e.snapshots[0]);
      operation = { kind: r.kind, output: r.output, snapshot: source.label,
        rule: d, rows: JSON.parse(await readFile(join(root, source.path), "utf8")) };
      break;
    }
    default: throw new Error(`No staged predecessor for ${r.kind}`);
  }
  const sources = [];
  for (const path of Object.keys(prepared.manifest.sourceHashes)) {
    const content = await readFile(join(root, path), "utf8");
    if (digest(content) !== prepared.manifest.sourceHashes[path]) throw new Error("Preparation source drift");
    sources.push({ path, content });
  }
  // The private source array stays in the evaluator process. Remove T1/T2
  // assets before launching the native predecessor, not merely from its prompt.
  for (const { path } of sources) await unlink(join(root, path));
  await writeFile(join(root, "source/predecessor.json"), JSON.stringify(operation, null, 2) + "\n", { mode: 0o444 });
  return { operation, sources };
}

export async function publishAfterPredecessor(root, prepared, staged, checkpoint) {
  if (!checkpoint.businessCheckpoint || !checkpoint.recordRef) throw new Error("Missing native predecessor original");
  await unlink(join(root, "source/predecessor.json"));
  for (const { path, content } of staged.sources) {
    await writeFile(join(root, path), content);
    await chmod(join(root, path), 0o444);
  }
  const index = prepared.facts.findIndex(f => f.key === "checkpoint");
  const old = prepared.facts[index];
  const unsigned = { key: old.key, revision: old.revision,
    source: `native:${checkpoint.recordRef.store}:${checkpoint.recordRef.refId}`,
    body: checkpoint.businessCheckpoint };
  const fact = { ...unsigned, digest: digest(JSON.stringify(unsigned)) };
  prepared.facts[index] = fact;
  prepared.manifest.factDigests.checkpoint = fact.digest;
  prepared.manifest.factSources.checkpoint = { source: fact.source, revision: fact.revision };
}
