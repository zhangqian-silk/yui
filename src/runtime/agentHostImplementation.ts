import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { detectRunningRelease } from "../release/runtimeRelease.js";
import type { ImplementationRef } from "../kernel/instanceHost.js";

// Capture once when this process loads its Host bridge. Never label a live
// process with the installation currently on disk at status-query time.
const release = detectRunningRelease(fileURLToPath(import.meta.url));
const modules = [
  "agentHost.js", "agentHostProtocol.js", "agentHostImplementation.js",
  "codexInteractiveHost.js", "../controller/structuredProviderObservation.js",
  "../controller/runtimeEventInbox.js"
];
export const AGENT_HOST_IMPLEMENTATION: ImplementationRef = Object.freeze({
  id: "yui.agent-host",
  generation: release?.manifest.packageDigest ?? `checkout-${createHash("sha256")
    .update(modules.map(module => `${module}\0${readFileSync(new URL(module, import.meta.url), "utf8")}`).join("\0"))
    .digest("hex")}`
});
