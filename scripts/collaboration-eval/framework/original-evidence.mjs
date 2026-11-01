// Non-executing adapter. Replays only captured CLI bytes through the frozen
// reader's pure validator; no historical shell or CLI is ever invoked here.
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readOriginalPage } from "./original-reader.mjs";
import { hash } from "./common.mjs";

export function originalPageEvidence(item, binding, threadId, start, end, argv, options) {
  if (!binding.originalTool || !argv || argv.length !== 3 || argv[0] !== binding.node
    || argv[1] !== binding.originalTool.entry || !isAbsolute(item.cwd ?? "")
    || item.status !== "completed" || item.exitCode !== 0 || !Number.isFinite(Date.parse(start))
    || !Number.isFinite(Date.parse(end)) || Date.parse(start) > Date.parse(end)) return null;
  let request;
  try { request = JSON.parse(argv[2]); } catch { return null; }
  if (binding.originalTool.cli !== binding.cli || binding.originalTool.home !== binding.home) return null;
  const matches = (options.originalAudits ?? []).filter(r => r.code === 0
    && isDeepStrictEqual(r.request, request) && r.cwd === item.cwd && r.stdout === item.aggregatedOutput
    && Date.parse(r.startedAt) >= Date.parse(start) && Date.parse(r.finishedAt) <= Date.parse(end)
    && isDeepStrictEqual(r.files, binding.originalTool.files));
  if (matches.length !== 1) return null;
  const audit = matches[0];
  const env = audit.environment;
  if (audit.calls?.length !== 1 || env?.YUI_AGENT_ID !== "codex" || env.YUI_HOME !== binding.home
    || env.YUI_ROLE !== binding.roleName || env.YUI_TASK_ID !== binding.taskId
    || env.YUI_SESSION_SCOPE !== (binding.taskId ? "task" : "global")
    || (env.CODEX_THREAD_ID ?? env.YUI_NATIVE_SESSION_ID) !== threadId) return null;
  let index = 0, result;
  try {
    result = readOriginalPage(request, { binding: binding.originalTool, environment: env, transport: call => {
      const row = audit.calls[index++];
      if (!row || row.cli !== call.cli || !isDeepStrictEqual(row.args, call.args)
        || row.error || row.signal) throw Error("Missing/mismatched actual CLI call");
      return { code: row.code, stdout: Buffer.from(row.stdout), stderr: Buffer.from(row.stderr) };
    } });
  } catch { return null; }
  if (index !== 1 || result.stdout !== item.aggregatedOutput) return null;
  return { args: result.args, source: result.source,
    outputSha256: hash(item.aggregatedOutput), outputBytes: Buffer.byteLength(item.aggregatedOutput),
    addedWrapperBytes: 0, cliCalls: 1,
    wireBytes: audit.calls.reduce((n, c) => n + Buffer.byteLength(c.stdout) + Buffer.byteLength(c.stderr), 0),
    evidence: "fixed static executable/argv/native owner/cwd/start/end and exact one-page CLI stdout; existing full-document observer must verify union/hash" };
}
