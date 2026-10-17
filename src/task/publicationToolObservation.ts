import { usageError } from "../errors/cliError.js";
import type { PublicationProvider, PublicationReference } from "./publicationReference.js";
import type { PublicationVerificationObservation } from "./publicationVerification.js";

/**
 * An authorized caller's tool observation, not executable code or a tool
 * certification. Core validates the binding; the caller owns interpretation of
 * the sanitized tool output. The original is retained in Publication.evidence,
 * whose existing opaque text contract needs no storage-format transition.
 */
export type PublicationToolObservation = PublicationVerificationObservation & Readonly<{
  taskId: string;
  publicationId: string;
  projectId: string;
  localCommit: string;
  externalUrl: string;
  targetBranch: string;
  observedAt: string;
  tool: string;
  command: string;
  output: string;
}>;

const REQUIRED = [
  "taskId", "publicationId", "projectId", "localCommit", "provider", "repository",
  "externalKind", "externalId", "externalUrl", "targetBranch", "state",
  "headCommit", "observedAt", "tool", "command", "output"
] as const;
const OPTIONAL = ["remoteCommit", "mergedAt"] as const;
const SHA = /^[0-9a-f]{40}$/u;
const MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export function parsePublicationToolObservation(text: string): PublicationToolObservation {
  if (Buffer.byteLength(text, "utf8") > 64 * 1024) {
    throw usageError("Tool observation must not exceed 64 KiB; supply a sanitized relevant output excerpt.");
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch {
    throw usageError("--observation requires a JSON object.");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw usageError("--observation requires a JSON object.");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set<string>([...REQUIRED, ...OPTIONAL]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw usageError(`Unknown tool observation field: ${key}.`);
  }
  for (const key of [...REQUIRED, ...OPTIONAL]) {
    if (OPTIONAL.includes(key as typeof OPTIONAL[number]) && record[key] === undefined) continue;
    if (typeof record[key] !== "string" || (record[key] as string).trim().length === 0) {
      throw usageError(`Tool observation requires nonempty ${key}.`);
    }
  }
  for (const key of ["localCommit", "headCommit", "remoteCommit"]) {
    if (record[key] !== undefined && !SHA.test(record[key] as string)) {
      throw usageError(`Tool observation ${key} requires an exact lowercase Git SHA.`);
    }
  }
  if (!((record.provider === "github" && record.externalKind === "pull-request")
    || (record.provider === "gitlab" && record.externalKind === "merge-request"))) {
    throw usageError("Tool observation requires a matching GitHub PR or GitLab MR kind.");
  }
  if (!["open", "merged", "closed"].includes(record.state as string)
    || (record.state === "merged" && record.remoteCommit === undefined)) {
    throw usageError("Tool observation requires a known state and an integrated commit for a merge.");
  }
  for (const key of ["observedAt", "mergedAt"]) {
    if (record[key] !== undefined
      && (!/^\d{4}-\d\d-\d\dT/u.test(record[key] as string)
        || !Number.isFinite(Date.parse(record[key] as string)))) {
      throw usageError(`Tool observation ${key} requires an ISO timestamp.`);
    }
  }
  // Canonical key ordering makes retries independent of JSON whitespace/order.
  const evidence = JSON.stringify(Object.fromEntries(
    Object.keys(record).sort().map(key => [key, record[key]])
  ));
  return { ...record, evidence } as PublicationToolObservation;
}

export function assertPublicationToolObservation(
  publication: PublicationReference,
  observation: PublicationToolObservation,
  now: Date,
  observationNotBefore: number | undefined
): void {
  for (const field of ["taskId", "projectId", "provider", "repository",
    "externalKind", "externalId", "localCommit", "targetBranch"] as const) {
    if (observation[field] !== publication[field]) {
      throw usageError(`Tool observation ${field} does not match the Publication candidate.`);
    }
  }
  if (observation.publicationId !== publication.id) {
    throw usageError("Tool observation publicationId does not match the selected Publication.");
  }
  if (publication.externalUrl === undefined
    || canonicalPublicationUrl(observation.externalUrl, publication.provider)
      !== canonicalPublicationUrl(publication.externalUrl, publication.provider)) {
    throw usageError("Tool observation externalUrl must match the recorded Publication service and object.");
  }
  const url = new URL(canonicalPublicationUrl(observation.externalUrl, publication.provider));
  // GitLab UI routes are deployment-specific. Structured identity above and
  // the complete registered URL bind the object without inventing a web route.
  if (publication.provider === "github"
    && url.pathname !== `/${publication.repository.toLowerCase()}/pull/${publication.externalId}`) {
    throw usageError("Tool observation URL does not match the repository and PR/MR identity.");
  }
  const observed = Date.parse(observation.observedAt);
  if ((observationNotBefore !== undefined && observed < observationNotBefore)
    || observed > now.getTime() || now.getTime() - observed > MAX_AGE_MS) {
    throw usageError("Tool observation is stale or future-dated; observe the current Publication within 24 hours of recording.");
  }
  if (observation.mergedAt !== undefined && Date.parse(observation.mergedAt) > observed) {
    throw usageError("Tool observation merge time cannot follow its observation time.");
  }
}

/** Derive the latest material change from immutable history, not title edits or
 * initial bookkeeping. A tool read may legitimately precede its first upsert.
 * Changed-then-restored candidates still have a change boundary. */
export function publicationObservationNotBefore(
  publication: PublicationReference,
  previous: (id: string) => PublicationReference | null
): number | undefined {
  const fields = [
    "projectId", "provider", "repository", "externalKind", "externalId",
    "externalUrl", "localCommit", "targetBranch", "state", "headCommit", "remoteCommit", "mergedAt"
  ] as const;
  let current = publication;
  while (current.supersedes !== undefined) {
    const prior = previous(current.supersedes);
    if (prior === null) throw usageError("Publication history is incomplete; cannot validate observation freshness.");
    if (fields.some(field => current[field] !== prior[field])) {
      return Date.parse(current.createdAt);
    }
    current = prior;
  }
  return undefined;
}

export function canonicalPublicationUrl(value: string, provider?: PublicationProvider): string {
  let url: URL;
  try { url = new URL(value); } catch { throw usageError("Publication URL must be an absolute HTTP(S) URL."); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password
    || url.search || url.hash) {
    throw usageError("Publication URL must be HTTP(S), without credentials, query or fragment.");
  }
  const path = url.pathname.replace(/\/$/u, "");
  return `${url.origin}${provider === "github" ? path.toLowerCase() : path}`;
}
