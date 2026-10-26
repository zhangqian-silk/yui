import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import type { ConfiguredAgent } from "../agent/agent.js";

export type NativeProvider = {
  id: string; agentId: string; name: string; baseUrl: string; protocol: string;
  credentialPresent: boolean; selected: boolean; sourceFile: string;
};
export type NativeModelConfiguration = {
  status: "read" | "absent" | "unavailable" | "unsupported";
  sourceFile: string; model: string | null; effort: string | null; provider: string | null;
  providers: NativeProvider[];
  models: { value: string; label: string; efforts: { value: string; label: string }[] }[];
  catalogSource: string | null; catalogFetchedAt: string | null;
};

/** Local user-level facts only. Never executes an Agent, contacts an endpoint,
 * reads an auth file or returns arbitrary config/env/header values.
 * Project/session overrides remain outside this observation's scope. */
export function readNativeModelConfiguration(
  agent: Pick<ConfiguredAgent, "id" | "adapterId" | "environment">,
  environment: NodeJS.ProcessEnv = process.env
): NativeModelConfiguration {
  const env = { ...environment };
  for (const binding of agent.environment ?? []) {
    env[binding.target] = environment[binding.sourceName];
  }
  const home = env.HOME ?? homedir();
  const root = agent.adapterId === "codex" ? env.CODEX_HOME ?? join(home, ".codex")
    : env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  const sourceFile = agent.adapterId === "codex" ? join(root, "config.toml") : join(root, "settings.json");
  const result: NativeModelConfiguration = { status: "unsupported", sourceFile,
    model: null, effort: null, provider: null, providers: [], models: [],
    catalogSource: null, catalogFetchedAt: null };
  if (!["codex", "claude"].includes(agent.adapterId)) return { ...result, sourceFile: "" };
  try {
    const raw = readBounded(sourceFile);
    const config = object(agent.adapterId === "codex" ? parse(raw) : JSON.parse(raw));
    result.status = "read";
    result.model = text(config.model);
    if (agent.adapterId === "codex") {
      result.effort = text(config.model_reasoning_effort);
      result.provider = text(config.model_provider);
      result.providers = Object.entries(object(config.model_providers)).slice(0, 100).map(([id, value]) => {
        const p = object(value);
        return { id, agentId: agent.id, name: text(p.name) ?? id,
          baseUrl: safeNativeUrl(p.base_url), protocol: text(p.wire_api) ?? "unknown",
          credentialPresent: Object.keys(object(p.http_headers)).some(key => /^(authorization|x-api-key|api-key)$/i.test(key))
            || !!(text(p.env_key) && env[String(p.env_key)]),
          selected: id === result.provider, sourceFile };
      });
      // This is explicitly a native cache observation, not current availability
      // or a promise that all providers' model catalogs have been discovered.
      const path = join(root, "models_cache.json");
      try {
        const cache = object(JSON.parse(readBounded(path)));
        if (Array.isArray(cache.models)) {
          result.catalogSource = path;
          result.catalogFetchedAt = text(cache.fetched_at);
          result.models = cache.models.slice(0, 2000).flatMap(value => {
            const m = object(value), id = text(m.slug);
            if (!id) return [];
            return [{ value: id, label: text(m.display_name) ?? id,
              efforts: Array.isArray(m.supported_reasoning_levels)
                ? m.supported_reasoning_levels.slice(0, 20).flatMap(value => {
                  const effort = text(object(value).effort);
                  return effort ? [{ value: effort, label: effort }] : [];
                }) : [] }];
          });
        }
      } catch { /* Missing/invalid optional cache does not erase configured facts. */ }
    } else {
      result.effort = text(config.effortLevel) ?? text(config.effort);
      const nativeEnv = object(config.env);
      const baseUrl = safeNativeUrl(env.ANTHROPIC_BASE_URL ?? nativeEnv.ANTHROPIC_BASE_URL);
      if (baseUrl) {
        result.provider = "native";
        result.providers = [{ id: "native", agentId: agent.id, name: "Claude native",
          baseUrl, protocol: "anthropic-messages",
          credentialPresent: !!(env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY
            ?? nativeEnv.ANTHROPIC_AUTH_TOKEN ?? nativeEnv.ANTHROPIC_API_KEY),
          selected: true, sourceFile }];
      }
    }
  } catch (error) {
    result.status = (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unavailable";
  }
  return result;
}

function readBounded(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("unsupported-file");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 2048 && !/[\0\r\n]/.test(value) ? value : null;
}
export function safeNativeUrl(value: unknown): string {
  try {
    const url = new URL(typeof value === "string" ? value : "");
    if (!["http:", "https:"].includes(url.protocol)) return "";
    // No URL credentials, query tokens or fragments cross the Web boundary.
    return `${url.origin}${url.pathname}`;
  } catch { return ""; }
}
