import { parseRepeatable } from "../cli/parseRepeatable.js";
import { usageError } from "../errors/cliError.js";
import { GitIntegrationService, type IntegrationJobPort, type IntegrationResult } from "../integration/gitIntegrationService.js";
import { createIntegrationAttempt } from "../integration/integrationAttempt.js";
import { NodeGitWorkspace, type GitWorkspacePort } from "../repository/gitWorkspace.js";
import { FileTaskWorkspacePreparer } from "../repository/taskWorkspacePreparer.js";
import type { TaskStore } from "../storage/taskStore.js";
import { workspaceProjectEntry } from "../worktree/managedWorkspace.js";
import { taskLocalActor } from "../task/taskAuthority.js";

export type TaskUpstreamCommandOptions = Readonly<{
  git?: GitWorkspacePort;
  now?: () => Date;
  environment?: NodeJS.ProcessEnv;
  jobPort?: IntegrationJobPort;
}>;

export type TaskUpstreamCommandResult = Readonly<{
  output: string;
  data?: unknown;
}>;

export async function runTaskUpstreamCommand(
  args: readonly string[],
  store: TaskStore,
  home: string,
  options: TaskUpstreamCommandOptions = {}
): Promise<TaskUpstreamCommandResult> {
  const [command, ...rest] = args;
  if (command === "integrate") return integrateUpstream(rest, store, home, options);
  throw usageError(
    command === undefined
      ? "Task upstream command is required."
      : `Unknown command: task upstream ${command}`
  );
}

async function integrateUpstream(
  args: readonly string[],
  store: TaskStore,
  home: string,
  options: TaskUpstreamCommandOptions
): Promise<TaskUpstreamCommandResult> {
  const usage = "Task upstream integrate usage: yui task upstream integrate <task> (--latest|--project <project>) [--check <command> ...] [--rerun-checks].";
  let latest = false;
  const normalized: string[] = [];
  for (const arg of args) {
    if (arg === "--latest") {
      if (latest) throw usageError("Option may only be specified once: --latest.", usage);
      latest = true;
      continue;
    }
    normalized.push(
      ...(arg.startsWith("--project=")
        ? ["--project", arg.slice("--project=".length)]
        : [arg])
    );
  }
  const parsed = parseRepeatable(
    normalized,
    new Set(["--check"]),
    new Set(["--project"]),
    usage,
    new Set(["--rerun-checks"])
  );
  if (parsed.positionals.length !== 1) throw usageError(usage);
  const taskId = parsed.positionals[0]!;
  const projectRef = parsed.one.get("--project");
  if (!latest && projectRef === undefined) {
    throw usageError("Specify --latest for every Task Project, or --project <project>.");
  }
  if (latest && projectRef !== undefined) {
    throw usageError("--latest and --project are mutually exclusive.");
  }
  let task = store.getTask(taskId);
  if (task === null) throw usageError(`Task not found: ${taskId}.`);
  if (task.status !== "active") {
    throw usageError(`Task must be active to integrate upstream: ${taskId}/${task.status}.`);
  }
  taskLocalActor(store, options.environment, task.id);
  const git = options.git ?? new NodeGitWorkspace();
  const now = options.now ?? (() => new Date());
  await new FileTaskWorkspacePreparer(home, store, git, now)
    .prepareTaskWorkspace(task.id);
  task = store.getTask(task.id);
  if (task === null || task.status !== "active") {
    throw usageError(`Task is no longer active: ${taskId}.`);
  }
  const workspace = store.getTaskWorkspace(task.id);
  if (workspace === null || workspace.owner.type !== "task") {
    throw usageError(`Task has no authoritative main clone: ${task.id}.`);
  }

  const service = new GitIntegrationService(store.rootDirectory(), store, git, now,
    options.environment, undefined, options.jobPort);
  const results: IntegrationResult[] = [];
  let failure: {
    projectId: string;
    phase: "prepare" | "resolve-remote" | "integrate";
    message: string;
    integrationId?: string;
    effect: "not-started" | "inspect-required";
  } | undefined;
  const selected = task.projectBindings.filter(binding =>
    projectRef === undefined || binding.projectId === projectRef);
  if (projectRef !== undefined && selected.length === 0) {
    throw usageError(`Task Project not found: ${task.id}/${projectRef}.`);
  }

  for (const binding of selected) {
    let phase: "prepare" | "resolve-remote" | "integrate" = "prepare";
    let integrationId: string | undefined;
    try {
      const project = store.getProject(binding.projectId);
      if (project === null) throw usageError(`Project not found: ${binding.projectId}.`);
      if (project.remoteUrl === undefined) {
        throw usageError(`Project has no remote URL: ${project.id}.`);
      }
      if (binding.baseCommit === undefined || binding.currentCommit === undefined) {
        throw usageError(`Task Project has no activated commit boundary: ${task.id}/${project.id}.`);
      }
      const entry = workspaceProjectEntry(workspace, project.id);
      if (entry === undefined) {
        throw usageError(`Task workspace has no entry for Project: ${project.id}.`);
      }
      const head = (await git.inspect(entry.path, entry.branch)).baseCommit;
      if (head !== binding.currentCommit) {
        throw usageError(
          `Task Project current commit diverged from its main clone: ${task.id}/${project.id}.`
        );
      }
      phase = "resolve-remote";
      const remote = await git.resolveRemoteHead({
        remoteUrl: project.remoteUrl,
        branch: binding.baseRef
      });
      const attempt = store.transaction((tx) => {
        const created = createIntegrationAttempt({
          id: tx.nextIntegrationAttemptId(task.id),
          taskId: task.id,
          projectId: project.id,
          targetRef: entry.branch,
          beforeCommit: binding.currentCommit!,
          source: {
            kind: "upstream",
            branch: remote.branch,
            remoteCommit: remote.commit,
            taskBaseCommit: binding.baseCommit!,
            strategy: "rebase"
          },
          checkCommands: parsed.many.get("--check") ?? [],
          rerunChecks: parsed.one.has("--rerun-checks")
        }, now());
        tx.saveIntegrationAttempt(task.id, created);
        return created;
      });
      integrationId = attempt.id;
      phase = "integrate";
      const result = await service.integrate(task.id, attempt.id);
      results.push(result);
      // Each Project has an independent candidate and Job. --latest admits all
      // requested Projects, then the Agent continues the returned exact attempts.
      if (result.status !== "committed" && result.status !== "checks-running") break;
    } catch (error) {
      // Earlier Projects may already have advanced HEAD or admitted a Job.
      // Preserve those receipts and the exact uncertain attempt; never turn a
      // partially executed batch into a usage error or replay it automatically.
      failure = {
        projectId: binding.projectId,
        phase,
        message: error instanceof Error ? error.message : String(error),
        ...(integrationId === undefined ? {} : { integrationId }),
        effect: integrationId === undefined ? "not-started" : "inspect-required"
      };
      break;
    }
  }

  const attempted = new Set([
    ...results.map(result => result.attempt.projectId),
    ...(failure === undefined ? [] : [failure.projectId])
  ]);
  const remainingProjectIds = selected.map(binding => binding.projectId)
    .filter(id => !attempted.has(id));
  const stage = failure !== undefined
    || results.some(result => result.status !== "committed" && result.status !== "checks-running")
    ? "integration-blocked"
    : results.some(result => result.status === "checks-running")
      ? "checks-running" : "integrated";
  const lines = results.flatMap(result => {
    const { attempt, status } = result;
    return [
      `  ${attempt.id} ${attempt.projectId}: ${status} (rebase)`,
      `    Expected HEAD: ${attempt.beforeCommit}; committed HEAD: ${attempt.afterCommit ?? "not committed"}`,
      `    Candidate: ${attempt.candidateCommit ?? "not prepared"}`,
      ...(status === "checks-running" ? [
        `    Job ${result.job.id}; continue with yui task integration continue ${task.id}/${attempt.id}`
      ] : [])
    ];
  });
  return {
    output: `Upstream Integration results for Task ${task.id} (${stage}):\n${lines.join("\n")}\n`
      + (failure === undefined ? "" : (
        `  ${failure.projectId} stopped during ${failure.phase}: ${failure.message}\n`
        + (failure.integrationId === undefined
          ? "  No Integration was started for this Project.\n"
          : `  Inspect yui task integration show ${task.id}/${failure.integrationId}; effects require inspection, not batch replay.\n`)
      ))
      + (remainingProjectIds.length === 0 ? "" : `  Not attempted: ${remainingProjectIds.join(", ")}\n`),
    data: { taskId: task.id, stage, strategy: "rebase", integrations: results,
      remainingProjectIds, ...(failure === undefined ? {} : { failure }) }
  };
}
