// Deterministic fake business implementation, separate from the evaluator's
// literal answers. It consumes only actual original bodies and request fields.
export function allocationPlan(documents, request) {
  const sites = new Map();
  let warehouse;
  for (const doc of documents) {
    if (doc.authority !== "coordinator") continue;
    if (doc.stock && (!warehouse || doc.revision > warehouse.revision))
      warehouse = { ...doc.stock, revision: doc.revision };
    for (const site of doc.sites ?? []) {
      if (!sites.has(site.site) || doc.revision > sites.get(site.site).revision)
        sites.set(site.site, { ...site, revision: doc.revision });
    }
  }
  if (!warehouse) throw Error("Missing coordinator stock original; no guessed answer");
  let remainingKits = warehouse.kits - warehouse.reserve;
  const allocations = [], deferred = [];
  for (const name of request.priority) {
    const site = sites.get(name);
    if (!site) throw Error(`Missing site original: ${name}`);
    const needed = site.attendees * request.kitsPerAttendee;
    const reason = request.excludedSites.includes(name) ? "excluded"
      : !site.ready ? "venue" : needed > remainingKits ? "stock" : undefined;
    if (reason) deferred.push({ site: name, reason });
    else { allocations.push({ site: name, kits: needed }); remainingKits -= needed; }
  }
  return { allocations, deferred, remainingKits, carrierEta: "unknown", mode: "plan-only" };
}
