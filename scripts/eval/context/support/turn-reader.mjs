// One instance per synthetic native Turn. Discovery supplies current exact refs;
// only complete values with the same Task/store/id/digest may be reused.
import { setTimeout as delay } from "node:timers/promises";

export class TurnOriginalReader {
  constructor(client, task) { this.client = client; this.task = task; this.complete = new Map(); }

  references(store) {
    const items = [];
    let cursor, source, digest;
    do {
      const page = this.client.call(["task", "context", "list", this.task, "--store", store,
        ...(cursor ? ["--cursor", cursor] : [])]);
      if (!Array.isArray(page.items)) throw Error("Invalid original discovery");
      if (cursor && (source !== page.source || digest !== page.digest)) throw Error("Original discovery identity changed");
      source = page.source; digest = page.digest;
      for (const item of page.items) {
        if (item.ref?.store !== store) throw Error("Original discovery store mismatch");
        items.push(item);
      }
      cursor = page.nextCursor;
      if (!page.complete && !cursor) throw Error("Incomplete original discovery without continuation");
    } while (cursor);
    return items;
  }

  original(ref) {
    if (ref.taskId !== undefined && ref.taskId !== this.task) throw Error("Cross-Task original denied");
    if (!ref.store || !ref.refId || !ref.digest) throw Error("Incomplete exact original identity");
    const key = JSON.stringify([this.task, ref.store, ref.refId, ref.digest]);
    if (this.complete.has(key)) return this.complete.get(key);
    const original = this.client.detail(["task", "context", "inspect", this.task,
      "--store", ref.store, "--ref", ref.refId, "--digest", ref.digest]);
    if (original.contentPage || original.ref?.store !== ref.store || original.ref.refId !== ref.refId
      || original.ref.digest !== ref.digest || original.value?.taskId !== this.task || original.value.id !== ref.refId)
      throw Error("Complete original identity/digest mismatch");
    this.complete.set(key, original);
    return original;
  }

  message(id, inventory) {
    const ref = inventory.find(item => item.ref.refId === id)?.ref;
    if (!ref) throw Error("Missing exact wake or Task-local original");
    return this.original(ref);
  }

  effects(effectKey) {
    // Complete, unambiguous discovery titles can exclude unrelated records.
    // Truncated/unknown summaries remain candidates and require a full original.
    const candidates = this.references("task-decision").filter(item => {
      const summary = item.summary ?? "";
      const title = /(?:…|\.\.\.)$/.test(summary) ? undefined
        : /^title: (.*); status: [^;\n]+$/.exec(summary)?.[1];
      return title === undefined || title === effectKey;
    });
    return candidates.map(item => this.original(item.ref)).filter(original => original.value.title === effectKey);
  }
}

export function readRunOriginals(reader, context, task, run) {
  if (context?.identity?.taskId !== task || context.identity.runId !== run)
    throw Error("Initialization Run context identity mismatch");
  // The bounded fixture initialization has a complete, small frozen inventory.
  // Do not guess a missing original from the mutable message list.
  if (context.pointerPage?.complete !== true) throw Error("Initialization original inventory incomplete");
  return context.pointers.filter(pointer => pointer.store === "task-message")
    .map(pointer => reader.original(pointer));
}

export async function waitForGlobalAcceptance(client, id, original, milliseconds = 5000) {
  const initial = original, deadline = Date.now() + milliseconds;
  for (;;) {
    if (original.id !== id || original.roleName !== initial.roleName
      || original.kind !== initial.kind || original.body !== initial.body)
      throw Error("Exact Global input identity changed");
    if (original.delivery?.via === "provider") return original;
    if (Date.now() >= deadline) throw Error("Exact Global input acceptance not observed");
    await delay(25);
    original = client.detail(["inbox", "show", id]);
  }
}
