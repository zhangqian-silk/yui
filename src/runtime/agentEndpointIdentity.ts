import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ImplementationRef } from "../kernel/instanceHost.js";
import { detectRunningRelease } from "../release/runtimeRelease.js";
import { isAgentAdapterId } from "../agent/adapterCatalog.js";
import { nativeExecutable } from "./nativeExecutable.js";

/**
 * The generation of the Endpoint code this process is actually executing.
 *
 * Resolved once, at module load, from the immutable release the running module
 * belongs to — the same idiom the Controller, the handover candidate and the CLI
 * Home fence already use. A release directory is content-addressed
 * (`<version>-<packageDigest>`) and byte-verified on install, so its digest
 * covers every shipped file rather than a hand-picked few, and cannot drift
 * under a live process: publishing a new release writes a new directory instead
 * of mutating this one.
 *
 * Resolving at load rather than on first use is the point. A digest computed
 * lazily would read whatever is on disk when the first Session happens to pin,
 * and could label already-loaded code A with the identity of a newer B.
 *
 * A development checkout has no immutable release, and mutable files have no
 * honest generation: editing a module in place would keep claiming the previous
 * bytes. So a checkout gets a digest of its loaded Endpoint modules, explicitly
 * marked `checkout-`, which never compares equal to a release generation. It is
 * a development identity and is not claimed to be reproducible from a release.
 */
const ENDPOINT_CHECKOUT_MODULES = Object.freeze([
  "agentEndpoint.js",
  "agentEndpointIdentity.js",
  "structuredProviderHost.js",
  "nativeExecutable.js",
  "codexAppServerRuntime.js",
  "acpSession.js",
  "acpProtocol.js",
  "acpSessionConfiguration.js",
  "agentRunConfiguration.js",
  "jsonLineChannel.js"
]);

function resolveEndpointGeneration(): string {
  const running = detectRunningRelease(fileURLToPath(import.meta.url));
  // The release digest already covers these modules' bytes, so an installed
  // release needs no separate file list to be exact.
  if (running !== null) return running.manifest.packageDigest.slice(0, 32);
  const hash = createHash("sha256");
  for (const module of ENDPOINT_CHECKOUT_MODULES) {
    // An unreadable module is a broken installation, not a reason to fall back
    // to an identity that would silently match a different build.
    hash.update(module).update("\0").update(readFileSync(new URL(module, import.meta.url))).update("\0");
  }
  hash.update("claude-process-owner").update("\0")
    .update(readFileSync(nativeExecutable("claude-process-owner"))).update("\0");
  return `checkout-${hash.digest("hex").slice(0, 23)}`;
}

const ENDPOINT_GENERATION = resolveEndpointGeneration();

/**
 * Built-in Endpoint identity under the existing ImplementationRef contract.
 * Uses the adopted release/checkout identity; matching it does not by itself
 * prove that the Provider can recover its native Session.
 */
export function builtinAgentEndpointImplementation(adapterId: string): ImplementationRef {
  // Every catalogued adapter has a managed Endpoint. Re-listing the adapter
  // names here would let the two lists drift, so the catalog is the only source.
  if (!isAgentAdapterId(adapterId)) {
    throw new Error(`No managed Endpoint implementation for adapter: ${adapterId}.`);
  }
  return Object.freeze({
    id: `yui.agent-endpoint.${adapterId}`,
    generation: ENDPOINT_GENERATION
  });
}

export function validateAgentEndpointImplementation(ref: ImplementationRef): ImplementationRef {
  if (ref === null || typeof ref !== "object"
    || typeof ref.id !== "string" || !ref.id.trim() || ref.id.includes("\0")
    || typeof ref.generation !== "string" || !ref.generation.trim() || ref.generation.includes("\0")) {
    throw new Error("Session Endpoint implementation identity is invalid.");
  }
  return ref;
}

/** Missing old code is an explicit inability to resume, never a Provider fallback. */
export function requireBuiltinAgentEndpointImplementation(
  adapterId: string,
  ref: ImplementationRef
): ImplementationRef {
  validateAgentEndpointImplementation(ref);
  const current = builtinAgentEndpointImplementation(adapterId);
  if (ref.id !== current.id || ref.generation !== current.generation) {
    throw new Error(`Session Endpoint ${ref.id}@${ref.generation} is unavailable; explicitly select a new Session.`);
  }
  return ref;
}
