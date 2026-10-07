// Participant code: business input and files only, no catalog/preparation/oracle.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { createHash } from "node:crypto";

export async function producePredecessor(root, operation) {
  const hash = text => createHash("sha256").update(text).digest("hex");
  const input = JSON.parse(await readFile(join(root, "source/predecessor.json"), "utf8"));
  if (JSON.stringify(input) !== JSON.stringify(operation)) throw new Error("Predecessor input provenance mismatch");
  const artifacts = [];
  async function save(path, content) {
    const target = resolve(root, path);
    if (relative(root, target).startsWith("..") || target === resolve(root)) throw new Error("Predecessor output outside scope");
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, content);
    artifacts.push({ path, content, digest: hash(content) });
  }
  let businessCheckpoint;
  switch (input.kind) {
    case "cursor-sdk": {
      const sdk = await readFile(join(root, input.sdk), "utf8");
      if (!sdk.includes("export const sdkName")) throw new Error("Missing existing SDK scaffold");
      const plan = `Use ${input.contract.requestField} from the prior response nextCursor unchanged; `
        + `consume ${input.contract.responseFields.join(", ")} under ${input.contract.version}. `
        + "Page numbers are not cursor values. Preserve the existing SDK scaffold; validate service/SDK composition.\n";
      await save(input.output, plan);
      businessCheckpoint = { completed: ["SDK scaffolding", "mapping plan"],
        remaining: ["cursor loop", "A/B composition"], sdkDigest: hash(sdk) };
      break;
    }
    case "design-document":
      await save(input.output, `# ${input.title}\n\nChoice: ${input.choice}.\n\n`
        + `Queued -> running -> completed. The queue is durable.\n\nMaximum: ${input.maxBytes} bytes.\n\n`
        + `Cancellation: ${input.cancellation}.\n\nRecovery section unfinished; draft not accepted.\n`);
      businessCheckpoint = { remaining: ["failure recovery", "state definitions", "acceptance checks"],
        choice: input.choice, maxBytes: input.maxBytes, cancellation: input.cancellation };
      break;
    case "incident-analysis":
      await save(input.output, `# Preliminary incident analysis\n\n${input.oldSummary}\n\n`
        + `Source: ${input.sourceVersion}. This prior conclusion is pending acceptance.\n`);
      businessCheckpoint = { previousConclusionStatus: "pending-acceptance",
        previousConclusion: input.oldSummary, sourceVersion: input.sourceVersion };
      break;
    case "order-aggregate": {
      const orders = new Map();
      for (const row of input.rows) {
        const prior = orders.get(row.order);
        if (!prior || prior.revision < row.revision) {
          orders.set(row.order, { order: row.order, revision: row.revision, cents: row.cents, at: row.at });
        }
      }
      const currentOrders = [...orders.values()], days = {};
      for (const row of currentOrders) {
        const day = new Date(Date.parse(row.at) + input.rule.timezoneOffsetMinutes * 60_000).toISOString().slice(0, 10);
        days[day] = (days[day] ?? 0) + row.cents;
      }
      businessCheckpoint = { waterMark: "w1", processed: input.rows.map(row => row.row),
        previousSnapshot: input.snapshot, currentOrders };
      await save(input.output, JSON.stringify({ days, ...businessCheckpoint }, null, 2) + "\n");
      break;
    }
    default: throw new Error("Unsupported native predecessor operation");
  }
  return { businessCheckpoint, artifacts };
}
