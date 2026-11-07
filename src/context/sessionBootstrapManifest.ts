import { createHash } from "node:crypto";
import { chmodSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { GlobalRole, TaskRole } from "../role/role.js";
import { readCurrentTaskLeader } from "../storage/currentTaskLeader.js";
import { roleSkillIds } from "./roleSessionContext.js";
import { writeTextFileAtomically } from "../storage/durableFile.js";
import type { RoleSessionOwner, RoleSkillContext } from "./roleSessionContext.js";
import { validateSkillPackageRef, type SkillPackageRef } from "./skillPackage.js";
import { checkCurrentSkills, checkCurrentSkillsAsync, SKILL_CHECK_COMMAND, SKILL_REUSE_RULE } from "./currentSkills.js";
import {
  SESSION_BOOTSTRAP_MANIFEST_SCHEMA_VERSION,
  SESSION_CONTEXT_PROTOCOL,
  sessionManifestCompatibilityDigest,
  type SessionRoleKind
} from "./sessionProtocolIdentity.js";
export {
  SESSION_BOOTSTRAP_MANIFEST_SCHEMA_VERSION,
  SESSION_CONTEXT_PROTOCOL,
  sessionManifestCompatibilityDigest,
  type SessionRoleKind
} from "./sessionProtocolIdentity.js";
export type SessionBootstrapManifest = Readonly<{
  schemaVersion: typeof SESSION_BOOTSTRAP_MANIFEST_SCHEMA_VERSION;
  protocol: typeof SESSION_CONTEXT_PROTOCOL;
  owner: RoleSessionOwner;
  effectiveRevision: number;
  roleKind: SessionRoleKind;
  /** Stable compatibility identity; distinct from this materialization's byte digest. */
  compatibilityDigest: string;
  skills: readonly Readonly<{ id: string; path: string; digest: string; package?: SkillPackageRef;
    version?: string; versionPath?: string }>[];
  roleProfileRef: Readonly<{ digest: string; path: string }>;
  contextProtocol: Readonly<{
    skillCheckCommand?: string;
    loadCommand: string;
    expandCommand?: string;
    currentCommand?: string;
  }>;
  digest: string;
}>;

export type MaterializedSessionBootstrap = Readonly<{
  manifest: SessionBootstrapManifest;
  manifestPath: string;
  roleProfilePath: string;
}>;

/** Portable read pointers accompany every managed input, including the first
 * notification on a fresh Session. No Task content or credentials are copied. */
export function withSessionContextPointer(
  text: string,
  environment: Readonly<Record<string, string | undefined>>
): string {
  const manifest = environment.YUI_SESSION_MANIFEST;
  if (manifest === undefined) return text;
  return [
    sessionContextInstructions(manifest),
    "",
    text
  ].join("\n");
}

/** Host metadata checks do not prove instructions survived context compaction.
 * Unmediated/native clients retain the explicit diagnostic fallback. */
export function sessionContextInstructions(manifestPath: string, digest?: string): string {
  return `Yui Session Manifest: ${manifestPath}${digest === undefined ? "" : ` (digest ${digest})`}. `
    + "The managed Host checks Skills internally and injects guidance only when loading is needed; absence of a notice does not require another check. "
    + `For unmediated clients or uncertain current input routing, run its contextProtocol.skillCheckCommand (fallback: ${SKILL_CHECK_COMMAND}); conversation reuse alone does not establish Host mediation. `
    + "On first entry or lost instructions, read the current applicable Skill entry points, then only references needed for the current action. "
    + "On change reload affected instructions. Compaction does not require restoring every previously used procedure. "
    + "Preserve the Manifest Role profile; metadata never proves loading or memory. Keep routine role, version and empty-inbox checks internal.";
}

/** The caller must already pass the ordinary managed Session/CLI/Home checks.
 * Old manifests remain immutable audit records, while this read resolves their
 * Skill IDs against the currently executing installation and Home. */
export function checkSessionSkills(home: string, manifestPath: string) {
  const manifest = readSessionBootstrapManifest(manifestPath);
  const current = currentInheritedProfile(home, manifest);
  return {
    skills: checkCurrentSkills(home, current.ids),
    roleProfileRef: current.profile,
    rule: SKILL_REUSE_RULE,
    historicalPackagesAreAuditOnly: true
  };
}

export async function checkSessionSkillsAsync(home: string, manifestPath: string, signal: AbortSignal) {
  const manifest = validateSessionBootstrapManifest(JSON.parse(
    await readFile(resolve(manifestPath), { encoding: "utf8", signal })));
  const current = currentInheritedProfile(home, manifest);
  return {
    skills: await checkCurrentSkillsAsync(home, current.ids, signal),
    roleProfileRef: current.profile,
    rule: SKILL_REUSE_RULE,
    historicalPackagesAreAuditOnly: true
  };
}

/** Parent configuration changes refresh the next input's exact profile/Skill
 * pointers. The launch snapshot and old manifests remain historical evidence. */
function currentInheritedProfile(home: string, manifest: SessionBootstrapManifest) {
  if (manifest.owner.scope !== "task" || !manifest.skills.some(skill => skill.id === "yui-experiment-leader")) {
    return { ids: manifest.skills.map(skill => skill.id), profile: manifest.roleProfileRef };
  }
  const role = readCurrentTaskLeader(home, manifest.owner.taskId);
  if (role?.template !== "experiment-leader") throw new Error("ExperimentLeader template binding is unavailable.");
  const content = JSON.stringify({
    roleName: role.name, roleKind: "leader", defaultAccess: role.defaultAccess,
    description: role.description, responsibilities: role.responsibilities ?? [],
    constraints: role.constraints ?? [], expectedOutput: role.expectedOutput, systemPrompt: role.systemPrompt
  }, null, 2) + "\n";
  const profileDigest = digest(content);
  const path = resolve(home, "runtime", "role-profiles", `${profileDigest}.json`);
  writeImmutableText(path, content);
  return { ids: roleSkillIds(role, "leader"), profile: { digest: profileDigest, path } };
}

/** Explicit entry for self-contained Global Context reads across clients. */
export type SessionEntryPoint = Readonly<{
  executable: string;
  cliEntry: string;
}>;

/** Read back one immutable Session Manifest and verify its content digest. */
export function readSessionBootstrapManifest(path: string): SessionBootstrapManifest {
  const source = resolve(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(source, "utf8"));
  } catch (error) {
    throw new Error(`Session Manifest is unreadable: ${source}.`, { cause: error });
  }
  return validateSessionBootstrapManifest(parsed);
}

function validateSessionBootstrapManifest(parsed: unknown): SessionBootstrapManifest {
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("Session Manifest is invalid.");
  }
  const record = parsed as Record<string, unknown>;
  const claimedDigest = requireDigest(record.digest, "Session Manifest digest");
  const { digest: _digest, ...body } = record;
  if (digest(body) !== claimedDigest) {
    throw new Error("Session Manifest digest does not match its immutable content.");
  }
  if (record.schemaVersion !== SESSION_BOOTSTRAP_MANIFEST_SCHEMA_VERSION
    || record.protocol !== SESSION_CONTEXT_PROTOCOL
    || record.owner === null
    || typeof record.owner !== "object"
    || ((record.owner as { scope?: unknown }).scope !== "global"
      && (record.owner as { scope?: unknown }).scope !== "task")
    || typeof record.effectiveRevision !== "number"
    || !Number.isSafeInteger(record.effectiveRevision)
    || record.effectiveRevision < 1
    || (record.roleKind !== "operator"
      && record.roleKind !== "global"
      && record.roleKind !== "leader"
      && record.roleKind !== "worker"
      && record.roleKind !== "reviewer")
    || !Array.isArray(record.skills)
    || record.roleProfileRef === null
    || typeof record.roleProfileRef !== "object"
    || record.contextProtocol === null
    || typeof record.contextProtocol !== "object") {
    throw new Error("Session Manifest shape is invalid.");
  }
  const owner = record.owner as Record<string, unknown>;
  if (owner.scope === "task" && typeof owner.taskId !== "string") {
    throw new Error("Task Session Manifest owner is invalid.");
  }
  for (const skill of record.skills) {
    if (skill === null || typeof skill !== "object") {
      throw new Error("Session Manifest Skill entry is invalid.");
    }
    const entry = skill as Record<string, unknown>;
    requireText(entry.id, "Session Manifest Skill id");
    requireText(entry.path, "Session Manifest Skill path");
    requireDigest(entry.digest, "Session Manifest Skill digest");
    if (entry.version !== undefined) {
      requireText(entry.version, "Session Manifest Skill version");
      requireText(entry.versionPath, "Session Manifest Skill version path");
    }
    if (entry.package !== undefined) {
      const ref = entry.package as SkillPackageRef;
      validateSkillPackageRef(ref);
      if (entry.id !== ref.id || entry.path !== ref.path || entry.digest !== ref.digest) {
        throw new Error("Session Manifest Skill package identity mismatch.");
      }
    }
  }
  const profile = record.roleProfileRef as Record<string, unknown>;
  requireDigest(profile.digest, "Session Manifest Role Profile digest");
  requireText(profile.path, "Session Manifest Role Profile path");
  const protocol = record.contextProtocol as Record<string, unknown>;
  requireText(protocol.loadCommand, "Session Manifest Context load command");
  if (protocol.expandCommand !== undefined) {
    requireText(protocol.expandCommand, "Session Manifest Context expand command");
  }
  return Object.freeze(parsed as SessionBootstrapManifest);
}

export function materializeSessionBootstrap(input: Readonly<{
  yuiHome: string;
  role: GlobalRole | TaskRole;
  owner: RoleSessionOwner;
  roleKind: SessionRoleKind;
  skills: readonly RoleSkillContext[];
  entryPoint: SessionEntryPoint;
}>): MaterializedSessionBootstrap {
  const home = resolve(input.yuiHome);
  const roleProfile = {
    roleName: input.role.name,
    roleKind: input.roleKind,
    defaultAccess: input.role.defaultAccess,
    description: input.role.description,
    responsibilities: input.role.responsibilities ?? [],
    constraints: input.role.constraints ?? [],
    expectedOutput: input.role.expectedOutput,
    systemPrompt: input.role.systemPrompt
  };
  const profileContent = `${JSON.stringify(roleProfile, null, 2)}\n`;
  const profileDigest = digest(profileContent);
  const roleProfilePath = resolve(join(
    home,
    "runtime",
    "role-profiles",
    `${profileDigest}.json`
  ));
  writeImmutableText(roleProfilePath, profileContent);

  const body = {
    schemaVersion: SESSION_BOOTSTRAP_MANIFEST_SCHEMA_VERSION,
    protocol: SESSION_CONTEXT_PROTOCOL,
    owner: input.owner,
    effectiveRevision: input.role.launchRevision,
    roleKind: input.roleKind,
    compatibilityDigest: sessionManifestCompatibilityDigest(
      input.role.name,
      input.roleKind,
      input.role
    ),
    skills: input.skills.map((skill) => Object.freeze({
      id: skill.id,
      path: skill.path,
      digest: skill.package?.digest ?? digest(skill.content),
      ...(skill.version === undefined ? {} : { version: skill.version, versionPath: skill.versionPath }),
      ...(skill.package === undefined ? {} : { package: skill.package })
    })),
    roleProfileRef: { digest: profileDigest, path: roleProfilePath },
    contextProtocol: input.owner.scope === "global"
      ? {
          // A Global Session may move between Yui's remote TUI and Desktop.
          // Carry its read entry in the Thread-visible Manifest instead of
          // depending on the client process that happened to create it.
          loadCommand: renderGlobalContextCommand(
            input.entryPoint,
            home,
            input.role.name
          ),
          // Same self-contained read remains usable from Desktop without the
          // launching shell's managed environment or PATH.
          skillCheckCommand: renderGlobalContextCommand(input.entryPoint, home, input.role.name)
        }
      : {
          loadCommand: `yui task run context ${quoteShellWord(`${input.owner.taskId}/<run-id>`)} --json`,
          expandCommand: `yui task run context expand ${quoteShellWord(`${input.owner.taskId}/<run-id>`)} <ref-id> --store <store> --mode full --json`,
          skillCheckCommand: SKILL_CHECK_COMMAND,
          ...(input.role.name === "leader" ? {
            currentCommand: `yui task context ${quoteShellWord(input.owner.taskId)} --json`
          } : {})
        }
  };
  const manifest = Object.freeze({ ...body, digest: digest(body) });
  const manifestPath = resolve(join(
    home,
    "runtime",
    "session-manifests",
    `${manifest.digest}.json`
  ));
  writeImmutableText(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return Object.freeze({
    manifest,
    manifestPath,
    roleProfilePath
  });
}

function renderGlobalContextCommand(
  entryPoint: SessionEntryPoint,
  home: string,
  roleName: string
): string {
  return [
    `YUI_HOME=${quoteShellWord(home)}`,
    quoteShellWord(entryPoint.executable),
    quoteShellWord(entryPoint.cliEntry),
    "session",
    "context",
    quoteShellWord(roleName),
    "--json"
  ].join(" ");
}

function quoteShellWord(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function writeImmutableText(path: string, content: string): void {
  writeTextFileAtomically(path, content);
  chmodSync(path, 0o600);
}

function digest(value: unknown): string {
  const bytes = typeof value === "string" ? value : JSON.stringify(value);
  return createHash("sha256").update(bytes).digest("hex");
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new Error(`${label} is invalid.`);
  }
  return value.trim();
}
