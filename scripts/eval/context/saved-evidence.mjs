// Context-run schema adapter, separate from topic-neutral evidence storage.
import { hash } from "../core/io.mjs";
import { safeMember } from "../core/evidence.mjs";
export const ANALYSIS_VERSION = "history-quant/5";
export function readSavedInvocation(store, prefix = "") {
  prefix = safeMember(prefix);
  const member = path => prefix ? `${prefix}/${safeMember(path)}` : safeMember(path);
  const sealBytes = store.bytes(member("seal.json")), seal = JSON.parse(sealBytes);
  const files = store.list(prefix).map(path => prefix ? path.slice(prefix.length + 1) : path);
  const mismatches = Object.entries(seal).filter(([path, expected]) =>
    !store.has(member(path)) || hash(store.bytes(member(path))) !== expected.sha256).map(([path]) => path);
  const additions = files.filter(path => path !== "seal.json" && !Object.hasOwn(seal, path));
  if (mismatches.length || additions.length) throw Error(`Evidence seal mismatch: ${JSON.stringify({ mismatches, additions })}`);
  const preflightBytes = store.bytes(member("preflight.json")), preflight = JSON.parse(preflightBytes);
  const plan = store.json(member("plan.json"));
  if (plan.preflightIdentity !== hash(preflightBytes)) throw Error("Wrong preflight identity");
  const ledger = store.json(member("ledger.json"));
  const identity = hash(JSON.stringify({ seal: hash(sealBytes), preflight: hash(preflightBytes), plan: hash(store.bytes(member("plan.json"))) }));
  return { store, prefix, files, member, plan, preflight, ledger, seal, identity,
    versions: { run: plan.harnessIdentity ?? "unknown", analysis: ANALYSIS_VERSION },
    bytes: path => store.bytes(member(path)), json: path => store.json(member(path)) };
}
