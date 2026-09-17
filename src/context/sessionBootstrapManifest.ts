import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { GlobalRole, TaskRole } from "../role/role.js";
import { writeTextFileAtomically } from "../storage/durableFile.js";
import type { RoleSessionOwner, RoleSkillContext } from "./roleSessionContext.js";
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
  controlPlane: Readonly<{
    sessionCliPath: string;
  }>;
  skills: readonly Readonly<{ id: string; path: string; digest: string }>[];
  roleProfileRef: Readonly<{ digest: string; path: string }>;
  contextProtocol: Readonly<{
    loadCommand: string;
    expandCommand?: string;
    currentCommand?: string;
  }>;
  digest: string;
}>;

export type MaterializedSessionBootstrap = Readonly<{
  manifest: SessionBootstrapManifest;
  manifestPath: string;
  sessionCliPath: string;
  roleProfilePath: string;
}>;

export type SessionCliRefreshResult = Readonly<{
  refreshed: number;
  current: number;
  skipped: number;
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
    `Read the Yui Session Manifest at ${manifest}.`,
    "Follow its referenced Role Skills and role profile. It gives the exact Context load command.",
    ...(environment.YUI_SESSION_CLI === undefined ? [] : [
      `Use this absolute CLI entry for Yui commands: ${environment.YUI_SESSION_CLI}`
    ]),
    "",
    text
  ].join("\n");
}

/** Where a managed Session's commands run: this installation, nothing more. */
export type SessionEntryPoint = Readonly<{
  executable: string;
  cliEntry: string;
}>;

/**
 * A managed Session wrapper answers exactly one question: which installation
 * runs this command. It therefore carries only the resolved entry point, never
 * a package or build identity. Current Sessions may survive a compatible
 * installation relocation; this is not a cross-version runtime adapter.
 */
function renderSessionCli(entryPoint: SessionEntryPoint): string {
  return [
    "#!/bin/sh",
    `exec ${quoteShellWord(entryPoint.executable)} `
      + `${quoteShellWord(entryPoint.cliEntry)} \"$@\"`,
    ""
  ].join("\n");
}

/** Read back one immutable Session Manifest and verify its content digest. */
export function readSessionBootstrapManifest(path: string): SessionBootstrapManifest {
  const source = resolve(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(source, "utf8"));
  } catch (error) {
    throw new Error(`Session Manifest is unreadable: ${source}.`, { cause: error });
  }
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
    || record.controlPlane === null
    || typeof record.controlPlane !== "object"
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
  const control = record.controlPlane as Record<string, unknown>;
  requireText(control.sessionCliPath, "Session Manifest CLI path");
  for (const skill of record.skills) {
    if (skill === null || typeof skill !== "object") {
      throw new Error("Session Manifest Skill entry is invalid.");
    }
    const entry = skill as Record<string, unknown>;
    requireText(entry.id, "Session Manifest Skill id");
    requireText(entry.path, "Session Manifest Skill path");
    requireDigest(entry.digest, "Session Manifest Skill digest");
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
  // Provider command runners may rebuild PATH independently of the managed
  // process environment, so a bare `yui` could resolve to another install or
  // Home. The wrapper pins the resolved entry point instead. Package identity
  // stays out of it: current Session authority and the CLI/Controller protocol
  // boundary authorize the command.
  const sessionCliContent = renderSessionCli(input.entryPoint);
  const sessionCliDigest = digest(sessionCliContent);
  const sessionCliPath = resolve(join(home, "runtime", "session-cli", `yui-${sessionCliDigest}.sh`));
  writeImmutableText(sessionCliPath, sessionCliContent);
  chmodSync(sessionCliPath, 0o700);

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
    controlPlane: {
      sessionCliPath
    },
    skills: input.skills.map((skill) => Object.freeze({
      id: skill.id,
      path: skill.path,
      digest: digest(skill.content)
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
          )
        }
      : {
          loadCommand: "\"$YUI_SESSION_CLI\" task run context \"$YUI_TASK_ID/<run-id>\" --json",
          expandCommand: "\"$YUI_SESSION_CLI\" task run context expand \"$YUI_TASK_ID/<run-id>\" <ref-id> --store <store> --mode full --json",
          ...(input.role.name === "leader" ? {
            currentCommand: "\"$YUI_SESSION_CLI\" task context \"$YUI_TASK_ID\" --json"
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
    sessionCliPath,
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

/**
 * Retargets current managed wrappers to the resolved installation entry point.
 * Only a valid Session Manifest may nominate a wrapper, and only the exact
 * two-argument shell form generated here is changed.
 */
export function refreshManagedSessionCliWrappers(
  homeInput: string,
  entryPoint: SessionEntryPoint
): SessionCliRefreshResult {
  const home = resolve(homeInput);
  const currentSessionCli = renderSessionCli(entryPoint);
  const manifestDirectory = resolve(join(home, "runtime", "session-manifests"));
  const sessionCliDirectory = resolve(join(home, "runtime", "session-cli"));
  if (!existsSync(manifestDirectory)) {
    return Object.freeze({ refreshed: 0, current: 0, skipped: 0 });
  }

  const wrapperPaths = new Set<string>();
  let skipped = 0;
  for (const name of readdirSync(manifestDirectory).filter((entry) => entry.endsWith(".json"))) {
    const manifestPath = resolve(join(manifestDirectory, name));
    try {
      const manifest = readSessionBootstrapManifest(manifestPath);
      if (manifestPath !== resolve(join(manifestDirectory, `${manifest.digest}.json`))) {
        skipped += 1;
        continue;
      }
      const wrapperPath = resolve(manifest.controlPlane.sessionCliPath);
      if (dirname(wrapperPath) !== sessionCliDirectory) {
        skipped += 1;
        continue;
      }
      wrapperPaths.add(wrapperPath);
    } catch {
      // An invalid Manifest cannot nominate a wrapper for mutation.
      skipped += 1;
    }
  }

  let refreshed = 0;
  let current = 0;
  for (const wrapperPath of wrapperPaths) {
    if (!existsSync(wrapperPath)) {
      skipped += 1;
      continue;
    }
    const content = readFileSync(wrapperPath, "utf8");
    if (content === currentSessionCli) {
      current += 1;
      continue;
    }
    if (!isManagedSessionCli(content)) {
      skipped += 1;
      continue;
    }
    writeTextFileAtomically(wrapperPath, currentSessionCli);
    chmodSync(wrapperPath, 0o700);
    refreshed += 1;
  }
  return Object.freeze({ refreshed, current, skipped });
}

/** Match exactly the two shell-quoted words emitted by renderSessionCli. */
function isManagedSessionCli(content: string): boolean {
  return /^#!\/bin\/sh\nexec '(?:[^'\n]|'"'"')*' '(?:[^'\n]|'"'"')*' "\$@"\n$/u.test(content);
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
