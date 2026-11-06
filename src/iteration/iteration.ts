import { createHash } from "node:crypto";
import type { TaskArtifactRepository } from "../artifacts/taskArtifactRepository.js";
import { managedGit } from "../artifacts/managedGit.js";
import { requireKnownFields } from "../domain/validation.js";

export type KnowledgeKind = "direction" | "plan" | "experiment" | "execution" | "analysis";
export type KnowledgeRef = Readonly<{ taskId: string; kind: KnowledgeKind; id: string; commit: string }>;
type Base<K extends KnowledgeKind> = { schemaVersion: 1; kind: K; id: string };
export type Direction = Base<"direction"> & {
  title: string; problem: string; goal: string; metrics: string[]; constraints: string[];
  priority: "low" | "medium" | "high"; status: "active" | "paused" | "closed" | "abandoned";
  next: string; unresolved: string[]; currentExperiment?: KnowledgeRef; currentConclusion?: KnowledgeRef;
};
export type ExperimentPlan = Base<"plan"> & {
  title: string; method: string; parameters: Record<string, unknown>; document: string;
  source?: KnowledgeRef;
};
export type CodeCondition = { repository: string; commit: string | "unknown"; tree: "clean" | "dirty" | "unknown"; diff?: string };
export type Experiment = Base<"experiment"> & {
  title: string; directions: string[]; hypothesis: string; plan: KnowledgeRef;
  parameters: Record<string, unknown>; baseline: CodeCondition; candidate: CodeCondition;
  conditions: Record<string, unknown>; revises?: KnowledgeRef;
  workItemIds?: string[];
};
export type Execution = Base<"execution"> & {
  experiment: KnowledgeRef; sample: string; conditions: Record<string, unknown>;
  observations: Record<string, unknown>; evidence: string[];
  outcome: "observed" | "failed" | "unknown"; limitations: string[];
  runId?: string; jobRunId?: string; retryOf?: KnowledgeRef;
};
export type Analysis = Base<"analysis"> & {
  title: string; inputs: KnowledgeRef[]; method: KnowledgeRef; conclusion: string;
  limitations: string[]; evidence: string[]; document: string; decisionId?: string;
  relations: { relation: "supports" | "refutes" | "supersedes"; report: KnowledgeRef }[];
};
export type KnowledgeRecord = Direction | ExperimentPlan | Experiment | Execution | Analysis;
type Index = { schemaVersion: 1; directions: string[] };
const kinds: readonly KnowledgeKind[] = ["direction", "plan", "experiment", "execution", "analysis"];
const fields: Record<KnowledgeKind, string[]> = {
  direction: ["title", "problem", "goal", "metrics", "constraints", "priority", "status", "next", "unresolved", "currentExperiment", "currentConclusion"],
  plan: ["title", "method", "parameters", "document", "source"],
  experiment: ["title", "directions", "hypothesis", "plan", "parameters", "baseline", "candidate", "conditions", "revises", "workItemIds"],
  execution: ["experiment", "sample", "conditions", "observations", "evidence", "outcome", "limitations", "runId", "jobRunId", "retryOf"],
  analysis: ["title", "inputs", "method", "conclusion", "limitations", "evidence", "document", "decisionId", "relations"]
};
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const hash = (value: unknown) => createHash("sha256").update(json(value)).digest("hex");
const pathFor = (kind: KnowledgeKind, id: string) => `iteration/${kind}/${identity(id)}.json`;
function identity(value: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/u.test(value)) throw new Error("Invalid iteration identity.");
  return value;
}
function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an iteration object.");
}
function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || Buffer.byteLength(value) > 32_768) {
    throw new Error("Iteration text must be nonempty UTF-8 without NUL, at most 32 KiB.");
  }
}
function texts(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Expected at most 100 iteration values.");
  value.forEach(text);
}
function choice(value: unknown, choices: string[]) {
  if (!choices.includes(value as string)) throw new Error(`Expected ${choices.join(", ")}.`);
}
function ref(value: KnowledgeRef, kind?: KnowledgeKind) {
  object(value);
  requireKnownFields(value, ["taskId", "kind", "id", "commit"], "Iteration reference");
  identity(value.taskId); identity(value.id);
  choice(value.kind, [...kinds]);
  if (kind !== undefined && value.kind !== kind) throw new Error(`Expected ${kind} reference.`);
  if (typeof value.commit !== "string" || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value.commit)) {
    throw new Error("Iteration references require a full immutable commit.");
  }
}
function code(value: CodeCondition) {
  object(value);
  requireKnownFields(value, ["repository", "commit", "tree", "diff"], "Code condition");
  text(value.repository);
  if (value.commit !== "unknown" && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value.commit)) throw new Error("Code condition requires a full commit or unknown.");
  choice(value.tree, ["clean", "dirty", "unknown"]);
  if (value.diff !== undefined) text(value.diff);
  if (value.tree === "dirty" && value.diff === undefined) throw new Error("Dirty code requires a diff evidence reference.");
}
export function validateKnowledge(record: KnowledgeRecord): KnowledgeRecord {
  object(record);
  choice(record.kind, [...kinds]);
  requireKnownFields(record, ["schemaVersion", "kind", "id", ...fields[record.kind]], "Iteration record");
  if (record.schemaVersion !== 1) throw new Error("Unsupported iteration schema.");
  identity(record.id);
  if (Buffer.byteLength(json(record)) > 65_536) throw new Error("Iteration record exceeds 64 KiB; reference larger evidence.");
  switch (record.kind) {
    case "direction":
      if (Buffer.byteLength(json(record)) > 32_768) throw new Error("Direction exceeds 32 KiB; reference detailed evidence.");
      [record.title, record.problem, record.goal, record.next].forEach(text);
      [record.metrics, record.constraints, record.unresolved].forEach(texts);
      choice(record.priority, ["low", "medium", "high"]);
      choice(record.status, ["active", "paused", "closed", "abandoned"]);
      if (record.currentExperiment !== undefined) ref(record.currentExperiment, "experiment");
      if (record.currentConclusion !== undefined) ref(record.currentConclusion, "analysis");
      break;
    case "plan":
      [record.title, record.method, record.document].forEach(text);
      object(record.parameters);
      if (record.source !== undefined) ref(record.source, "plan");
      break;
    case "experiment":
      [record.title, record.hypothesis].forEach(text);
      texts(record.directions);
      if (!record.directions.length || new Set(record.directions).size !== record.directions.length) throw new Error("Experiment directions must be nonempty and unique.");
      record.directions.forEach(identity);
      ref(record.plan, "plan"); code(record.baseline); code(record.candidate);
      object(record.parameters); object(record.conditions);
      if (record.workItemIds !== undefined) { texts(record.workItemIds); record.workItemIds.forEach(identity); }
      if (record.revises !== undefined) ref(record.revises, "experiment");
      break;
    case "execution":
      ref(record.experiment, "experiment"); text(record.sample);
      object(record.conditions); object(record.observations);
      texts(record.evidence); texts(record.limitations);
      choice(record.outcome, ["observed", "failed", "unknown"]);
      if (record.retryOf !== undefined) ref(record.retryOf, "execution");
      if (record.runId !== undefined) identity(record.runId);
      if (record.jobRunId !== undefined) identity(record.jobRunId);
      break;
    case "analysis":
      [record.title, record.conclusion, record.document].forEach(text);
      texts(record.limitations); texts(record.evidence);
      ref(record.method, "plan");
      if (!Array.isArray(record.inputs) || !record.inputs.length || record.inputs.length > 100) throw new Error("Analysis requires 1–100 fixed inputs.");
      record.inputs.forEach(input => ref(input, "execution"));
      if (!Array.isArray(record.relations) || record.relations.length > 100) throw new Error("Invalid analysis relations.");
      for (const relation of record.relations) {
        requireKnownFields(relation, ["relation", "report"], "Analysis relation");
        choice(relation.relation, ["supports", "refutes", "supersedes"]); ref(relation.report, "analysis");
      }
      if (record.decisionId !== undefined) identity(record.decisionId);
      break;
  }
  return record;
}

/** Artifacts are the only knowledge authority. Current navigation and a request
 * receipt commit together with the detail; no DB mirror or background repair.
 * Immutable records use a new identity for a revision, retry or reanalysis. */
export function openIteration(repo: TaskArtifactRepository) {
  const readJson = async (path: string, commit: string) => JSON.parse((await repo.read(path, commit)).bytes.toString("utf8"));
  const read = async (reference: KnowledgeRef): Promise<KnowledgeRecord> => {
    ref(reference);
    if (reference.taskId !== repo.taskId) throw new Error("Iteration reference belongs to another Task; import a reusable plan explicitly.");
    const record = validateKnowledge(await readJson(pathFor(reference.kind, reference.id), reference.commit));
    if (record.kind !== reference.kind || record.id !== reference.id) throw new Error("Iteration reference identity mismatch.");
    return record;
  };
  const indexAt = async (head: string): Promise<Index> => {
    if (!await repo.has("iteration/index.json", head)) return { schemaVersion: 1, directions: [] };
    const index: Index = await readJson("iteration/index.json", head);
    requireKnownFields(index, ["schemaVersion", "directions"], "Iteration index");
    if (index.schemaVersion !== 1) throw new Error("Unsupported iteration index.");
    if (!Array.isArray(index.directions) || index.directions.length > 10_000) throw new Error("Iteration index supports at most 10,000 directions.");
    index.directions.forEach(identity);
    if (new Set(index.directions).size !== index.directions.length) throw new Error("Duplicate direction.");
    return index;
  };
  const overview = async (cursor?: string) => {
    if (cursor !== undefined && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?:\d{1,5}$/u.test(cursor)) throw new Error("Invalid iteration cursor.");
    const head = cursor?.split(":")[0] ?? await repo.head();
    const offset = cursor === undefined ? 0 : Number(cursor.split(":")[1]);
    if (head === null) return { taskId: repo.taskId, commit: null, directions: [], total: 0, nextCursor: null };
    const index = await indexAt(head);
    if (offset > index.directions.length) throw new Error("Iteration cursor is outside the fixed index.");
    const directions: (Direction & { conclusion?: { summary: string; omitted: boolean } })[] = [];
    for (const id of index.directions.slice(offset, offset + 8)) {
      const direction = await read({ taskId: repo.taskId, kind: "direction", id, commit: head }) as Direction;
      if (direction.currentExperiment) await read(direction.currentExperiment);
      const report = direction.currentConclusion ? await read(direction.currentConclusion) as Analysis : undefined;
      const presented = { ...direction, ...(report ? {
        conclusion: { summary: report.conclusion.slice(0, 1200), omitted: report.conclusion.length > 1200 }
      } : {}) };
      if (Buffer.byteLength(json([...directions, presented])) > 60_000) break;
      directions.push(presented);
    }
    // Do not recursively expand experiments or history. Every current selection
    // is an exact reference; open inputs/authority remain in ordinary Task context.
    const next = offset + directions.length;
    const result = { taskId: repo.taskId, commit: head, directions, total: index.directions.length,
      nextCursor: next < index.directions.length ? `${head}:${next}` : null };
    return result;
  };
  const save = async (input: { requestId: string; expectedHead: string; record: KnowledgeRecord }) => {
    identity(input.requestId);
    const record = validateKnowledge(input.record);
    ref({ taskId: repo.taskId, kind: record.kind, id: record.id, commit: input.expectedHead });
    const digest = hash(input);
    const receiptPath = `iteration/requests/${input.requestId}.json`;
    const head = await repo.head();
    if (head === null) throw new Error("Initialize the artifact repository before saving iteration knowledge.");
    if (await repo.has(receiptPath, head)) {
      const receipt = await readJson(receiptPath, head);
      if (receipt.schemaVersion !== 1 || receipt.digest !== digest || receipt.kind !== record.kind || receipt.id !== record.id) {
        throw new Error("Iteration request reused with different input or invalid receipt.");
      }
      const commit = (await managedGit(repo.repoPath, ["log", "-1", "--format=%H", head, "--", receiptPath])).trim();
      return { commit, ref: { taskId: repo.taskId, kind: record.kind, id: record.id, commit } };
    }
    if (head !== input.expectedHead) throw new Error("Iteration HEAD conflict: repository advanced; reread before a new request.");
    if ((await repo.workingChanges()).some(path => path.startsWith("iteration/"))) {
      throw new Error("Uncommitted iteration changes require inspection; no automatic replay or overwrite.");
    }
    const path = pathFor(record.kind, record.id);
    if (record.kind !== "direction" && await repo.has(path, head)) throw new Error("Iteration record is immutable; create a new identity.");
    const index = await indexAt(head);
    const references: KnowledgeRef[] = [];
    switch (record.kind) {
      case "direction":
        if (record.currentExperiment) {
          const experiment = await read(record.currentExperiment) as Experiment;
          if (!experiment.directions.includes(record.id)) throw new Error("Current experiment does not belong to this direction.");
          references.push(record.currentExperiment);
        }
        if (record.currentConclusion) {
          const analysis = await read(record.currentConclusion) as Analysis;
          let related = false;
          for (const input of analysis.inputs) {
            const execution = await read(input) as Execution;
            const experiment = await read(execution.experiment) as Experiment;
            if (experiment.directions.includes(record.id)) { related = true; break; }
          }
          if (!related) throw new Error("Current conclusion has no input for this direction.");
          references.push(record.currentConclusion);
        }
        if (!index.directions.includes(record.id)) index.directions.push(record.id);
        if (index.directions.length > 10_000) throw new Error("Iteration index supports at most 10,000 directions.");
        index.directions.sort();
        break;
      case "plan": break;
      case "experiment":
        if (record.directions.some(id => !index.directions.includes(id))) throw new Error("Experiment references an unavailable direction.");
        {
          const plan = await read(record.plan) as ExperimentPlan;
          if (Object.keys(plan.parameters).some(key => !Object.hasOwn(record.parameters, key))) {
            throw new Error("Experiment parameters must explicitly expand every plan parameter.");
          }
        }
        references.push(record.plan, ...(record.revises ? [record.revises] : []));
        break;
      case "execution":
        references.push(record.experiment, ...(record.retryOf ? [record.retryOf] : []));
        if (record.retryOf) {
          const prior = await read(record.retryOf) as Execution;
          if (json(prior.experiment) !== json(record.experiment)) throw new Error("A retry must retain the exact experiment revision.");
        }
        break;
      case "analysis":
        references.push(record.method, ...record.inputs, ...record.relations.map(relation => relation.report));
        break;
    }
    await Promise.all(references.map(read));
    const files = [
      { relativePath: path, bytes: Buffer.from(json(record)) },
      { relativePath: receiptPath, bytes: Buffer.from(json({ schemaVersion: 1, digest, kind: record.kind, id: record.id })) }
    ];
    if (record.kind === "direction") files.push({ relativePath: "iteration/index.json", bytes: Buffer.from(json(index)) });
    const saved = await repo.save({ files, expectedHead: head, message: `iteration ${record.kind} ${record.id}` });
    return { commit: saved.commit, ref: { taskId: repo.taskId, kind: record.kind, id: record.id, commit: saved.commit } };
  };
  return { read, save, overview };
}
