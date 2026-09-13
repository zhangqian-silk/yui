export const TASK_SUMMARY_SCRIPT = `
import { node, clear } from "/assets/js/dom.js";
import { richText, inputCard, observabilityMetricCard } from "/assets/js/components.js";
import { formatDateTime } from "/assets/js/format.js";

const sessionLabels = {
  active: ["Recent activity", "近期有活动"], waiting: ["Waiting", "正在等待"],
  quiet: ["Quiet · not a proven deadlock", "安静 · 尚不能判定卡死"],
  diagnostic: ["Needs diagnosis", "需要诊断"], unknown: ["Observation unknown", "观测未知"],
  stopped: ["Stopped / failed", "已停止／失败"], idle: ["Turn ended", "该轮已结束"],
  background: ["Background unsettled", "后台未结清"]
};
const sayFor = locale => (en, cn) => locale.startsWith("zh") ? cn : en;
function block(title, key) {
  const section = node("section", "record-card summary-block");
  section.dataset.summary = key;
  section.append(node("h3", "", title));
  return section;
}
function disclosure(title, key) {
  const details = node("details", "record-card");
  details.dataset.viewKey = key;
  details.append(node("summary", "", title));
  return details;
}

export function renderSessionSummary(container, observation, locale) {
  clear(container);
  const say = sayFor(locale);
  container.append(node("h3", "", say("Session activity", "会话活动")));
  if (!observation) {
    container.append(node("p", "muted", say(
      "Observation unavailable or not yet read; this does not mean zero running Sessions.",
      "观测尚未读取或不可用；不代表运行会话为零。")));
    return;
  }
  const metrics = node("div", "session-counts");
  for (const [key, count] of Object.entries(observation.counts)) {
    if (!count) continue;
    const label = sessionLabels[key];
    metrics.append(node("span", "session-count", count + " · " + say(...label)));
  }
  if (!observation.sessions.length) metrics.append(node("p", "muted", say(
    "No selected native Session is recorded. Historical resources were not inspected.",
    "未记录当前选用的原生会话；未盘点历史资源。")));
  container.append(metrics, node("p", "muted", say(
    "Scope: this Task's selected native Sessions. Activity is not delivery progress; no live process probe.",
    "范围：本 Task 当前选用的原生会话。活动不等于交付进展；未探测实时进程。")));
  container.append(node("small", "muted", say("Independent observation read: ", "独立观察读取于：")
    + formatDateTime(observation.readAt, locale)));
  const details = disclosure(say("Session facts and timestamps", "会话依据与时间"), "sessions");
  for (const session of observation.sessions) {
    const row = node("article", "session-row");
    row.append(node("strong", "", session.roleName + " · " + say(...sessionLabels[session.group])));
    row.append(node("p", "record-copy", session.reason));
    if (session.waitingReason) row.append(node("p", "", say("Waiting for: ", "等待：") + session.waitingReason));
    row.append(node("p", "muted", say("Last activity: ", "最近活动：")
      + (session.lastActivityAt ? formatDateTime(session.lastActivityAt, locale) : say("unobserved", "未观测"))));
    row.append(node("p", "muted", say("Native input updated: ", "原生输入记录更新：") + formatDateTime(session.sourceUpdatedAt, locale)));
    if (session.operations.length) row.append(node("p", "muted", say(
      "Operations without a terminal (not proof of recent activity): ",
      "尚无终态的操作（不证明近期仍有活动）：") + session.operations.join(", ")));
    if (session.background.length) row.append(node("p", "", say("Background: ", "后台：")
      + session.background.map(item => item.id + " · " + item.execution).join(", ")));
    row.append(node("small", "mono", [session.nativeSessionId, session.nativeTurnId, session.attemptId].filter(Boolean).join(" / ")));
    details.append(row);
  }
  container.append(details);
}

export function renderTaskSummary(container, data, t, locale, actions, recordCard) {
  const say = sayFor(locale);
  const entries = store => data.core.records.filter(entry => entry.ref.store === store);
  const available = store => entries(store).filter(entry => !entry.omitted).map(entry => entry.value);
  const scope = node("p", "muted", say("Scope: ", "范围：") + data.task.id + " · "
    + say("Reading does not accept results or acknowledge Messages.", "读取不验收成果，也不确认消息。"));
  container.append(scope);
  const grid = node("div", "task-summary-grid");
  container.append(grid);
  const attention = block(say("Needs your input", "需要你处理"), "attention");
  attention.id = "detail-attention";
  const inputCount = data.core.attention.openInputs.count;
  attention.append(node("p", "", inputCount ? inputCount + say(" open questions", " 项待答问题")
    : say("No open InputRequest requires your answer.", "当前没有待你回答的 InputRequest。")));
  const inputs = entries("input-request").filter(entry => !entry.omitted && entry.value.status === "open");
  inputs.forEach(entry => attention.append(inputCard(entry.value, { single: true }, t, locale, actions)));
  const missing = data.core.attention.openInputs.refs.filter(ref => !inputs.some(entry => entry.ref.refId === ref.refId));
  missing.forEach(ref => attention.append(recordCard({ ref, omitted: true })));
  if (inputCount > inputs.length + missing.length) attention.append(node("p", "muted", say(
    "Some open questions are outside this bounded read. Read all original questions with: ",
    "部分待答问题未包含在本次有界读取中，请读取全部原问题：") + "yui task input list " + data.task.id));
  const technical = node("div", "");
  technical.dataset.technicalSummary = "";
  attention.append(technical);
  grid.append(attention);
  const sessions = block("", "sessions");
  sessions.dataset.sessionSummary = "";
  grid.append(sessions);
  const progress = block(say("Task progress", "任务进展"), "progress");
  const briefEntry = entries("task-brief")[0];
  const brief = available("task-brief")[0];
  if (data.task.completionSummary) progress.append(richText(say("Recorded completion", "已记录完成"), data.task.completionSummary, t));
  if (brief) {
    progress.append(richText(say("Current focus", "当前工作"), brief.currentFocus, t));
    progress.append(richText(say("Leader's progress report", "Leader 进展摘要"), brief.leaderSummary, t));
    progress.append(node("small", "muted", say("Brief updated: ", "Brief 更新：") + formatDateTime(brief.updatedAt, locale)));
  } else if (briefEntry) progress.append(recordCard(briefEntry));
  else progress.append(node("p", "muted", say("No progress summary in this read; no percentage or ETA is inferred.",
    "本次读取未包含进展摘要；不推算完成百分比或预计时间。")));
  const next = node("p", "muted");
  next.dataset.nextSummary = "";
  progress.append(next);
  grid.append(progress);
  const conclusions = block(say("Key conclusions", "关键结论"), "conclusions");
  const decisions = entries("task-decision").filter(entry => !entry.omitted && entry.value.status === "active");
  decisions.slice(0, 3).forEach(entry => {
    const card = recordCard(entry);
    card.prepend(node("small", "muted", say("Recorded decision", "已记录决定")));
    conclusions.append(card);
  });
  if (!decisions.length) conclusions.append(node("p", "muted", say(
    "No current Decision is included. Reports and recommendations are not user approval.",
    "本次读取未包含当前 Decision；报告和建议不代表用户批准。")));
  if (decisions.length > 3 || data.core.omitted.records || entries("task-decision").some(entry => entry.omitted)) {
    conclusions.append(node("p", "muted", say("More conclusions or omitted sources are available in history / Context.",
      "更多结论或省略来源请查看历史／Context。")));
  }
  grid.append(conclusions);
  updateTaskObservations(container, data, t, locale);
}

export function updateTaskObservations(container, data, t, locale) {
  const say = sayFor(locale);
  const sessions = container.querySelector("[data-session-summary]");
  if (sessions && !sessions.contains(document.activeElement)) {
    const wasOpen = sessions.querySelector("details")?.open;
    renderSessionSummary(sessions, data.runtimeStatus === "available" ? data.runtime?.sessions : null, locale);
    if (wasOpen && sessions.querySelector("details")) sessions.querySelector("details").open = true;
  }
  const technical = container.querySelector("[data-technical-summary]");
  const execution = data.runtimeStatus === "available" ? data.runtime?.execution : null;
  if (technical) {
    clear(technical);
    if (!execution) technical.append(node("p", "muted", say(
      "Technical attention and native waits have not been observed; no open question does not prove health.",
      "技术关注和原生等待尚未观测；没有待答问题不代表系统完全健康。")));
    else {
      const facts = execution.attention.concat(execution.blockers.filter(item => item.kind !== "input"));
      if (facts.length) technical.append(node("h4", "", say("Technical attention · owner assigned, not necessarily started",
        "技术关注 · 有负责人不代表已开始处理")));
      facts.forEach(item => technical.append(node("p", "record-copy", item.owner + " · " + item.summary + " · " + item.id)));
      if (!facts.length) technical.append(node("p", "muted", say("No technical attention in the current Task projection.",
        "当前任务投影未列出技术关注。")));
    }
    const waits = data.runtimeStatus === "available" ? data.runtime?.sessions?.sessions.filter(session =>
      session.group === "waiting" && ["user", "permission"].includes(session.waitingReason)) ?? [] : [];
    waits.forEach(session => technical.append(node("p", "", session.roleName + say(
      " is waiting for user/permission input. Inspect its original Session; this is not a new approval request.",
      " 明确等待用户／权限输入。请查看原 Session；这里没有新建审批请求。"))));
  }
  const next = container.querySelector("[data-next-summary]");
  if (next) next.textContent = execution ? say("Next owner: ", "下一步负责人：") + execution.next.owner
    + " · " + t("exec.action." + execution.next.action) + " · " + execution.reason
    : say("Next owner/action observation unavailable.", "下一步负责人／动作观测不可用。");
}

export function renderEvidence(container, data, t, locale, actions) {
  const say = sayFor(locale);
  const state = data.viewState;
  const artifacts = disclosure(say("Saved files · read a fixed version", "已保存文件 · 读取固定版本"), "artifacts");
  const body = node("div", "section-body");
  artifacts.append(body);
  const selection = node("div", "section-body");
  let readSequence = 0;
  const read = async (path, commit) => {
    const sequence = ++readSequence;
    selection.dataset.reading = "true";
    selection.textContent = say("Reading selected revision…", "正在读取所选版本…");
    try {
      const result = await actions.readArtifact(data.task.id, path, commit);
      if (sequence !== readSequence) return;
      state.artifact = result;
      drawSelection();
    } catch (error) {
      if (sequence === readSequence) selection.textContent = say("Selected revision unavailable: ", "所选版本不可用：") + error.message;
    } finally { if (sequence === readSequence) selection.dataset.reading = "false"; }
  };
  function drawSelection() {
    clear(selection);
    const value = state.artifact;
    if (!value) return;
    const ref = "git:" + value.commit + ":" + value.relativePath;
    selection.append(node("strong", "", say("Fixed result · ", "固定成果 · ") + value.relativePath));
    selection.append(node("p", "mono", ref));
    selection.append(node("p", "muted", say(
      "This revision stays selected across refreshes. Reading or discussing it does not accept, publish or execute it.",
      "刷新后仍保留此版本。读取或讨论不会验收、发布或执行该成果。")));
    const copy = node("button", "record-open", say("Copy source for discussion", "复制来源用于讨论"));
    copy.type = "button";
    copy.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(data.task.id + " " + ref); copy.textContent = say("Copied", "已复制"); }
      catch { copy.textContent = say("Copy the source shown above", "请复制上方来源"); }
    });
    selection.append(copy);
    const content = node("pre", "surface-json artifact-text", value.content);
    content.tabIndex = 0;
    content.setAttribute("aria-label", say("Fixed artifact text", "固定成果正文"));
    selection.append(content);
  }
  const load = node("button", "record-open", say("Read current file list", "读取当前文件列表"));
  load.type = "button";
  const list = node("div", "section-body");
  load.addEventListener("click", async () => {
    load.disabled = true;
    list.dataset.reading = "true";
    try {
      const result = await actions.artifacts(data.task.id);
      state.artifactList = result;
      drawList();
    } catch (error) { list.textContent = say("File list unavailable: ", "文件列表不可用：") + error.message; }
    finally { load.disabled = false; list.dataset.reading = "false"; }
  });
  function drawList() {
    clear(list);
    const current = state.artifactList;
    if (!current) return;
    if (state.artifact && current.commit !== state.artifact.commit) list.append(node("p", "", say(
      "The file list is at a different revision. Your selected result below has not changed.",
      "文件列表来自不同版本，下方所选成果未被替换。")));
    if (!current.entries.length) list.append(node("p", "muted", say("No saved files at this read.", "本次读取没有已保存文件。")));
    current.entries.forEach(entry => {
      const button = node("button", "record-open artifact-choice", entry.relativePath + " · " + entry.size + " B");
      button.type = "button";
      button.addEventListener("click", () => read(entry.relativePath, current.commit));
      list.append(button);
    });
  }
  body.append(node("p", "muted", say("Files are loaded only on request; missing Context rows do not mean no files.",
    "文件仅在请求时读取；Context 没有文件行不代表没有成果。")), load, list);
  // Explicit frozen references stay attached to their original revision.
  const sources = [data.task.completionArtifactRefs ?? [],
    data.core.records.filter(entry => !entry.omitted && ["task-brief", "task-decision"].includes(entry.ref.store))
      .map(entry => JSON.stringify(entry.value))].flat().join(" ");
  const refs = [...sources.matchAll(/git:([0-9a-f]{40}):([^\\s"\\\\]+?)(?=[\\s"\\\\]|$)/g)];
  const seen = new Set();
  for (const match of refs) {
    if (seen.has(match[0])) continue;
    seen.add(match[0]);
    const button = node("button", "record-open artifact-choice", say("Referenced revision · ", "已引用版本 · ") + match[2]);
    button.type = "button";
    button.addEventListener("click", () => read(match[2], match[1]));
    body.append(button);
  }
  body.append(selection);
  drawList();
  drawSelection();
  container.append(artifacts);
  const delivery = disclosure(say("Delivery, review and retained resources", "交付、审阅与保留资源"), "delivery");
  const output = node("div", "section-body");
  delivery.append(output);
  delivery.addEventListener("toggle", async () => {
    if (!delivery.open) return;
    clear(output);
    const runtime = data.runtimeStatus === "available" ? data.runtime : null;
    output.append(node("p", "", say("Local completion, review, remote delivery and resource cleanup are separate facts.",
      "本地完成、审阅、远程交付和资源清理是不同事实。")));
    if (!runtime) {
      output.append(node("p", "muted", say("Evidence observation unavailable. Core requirements remain readable.",
        "证据观测不可用；核心要求仍可读取。")));
      return;
    }
    const remote = runtime.remoteDelivery;
    if (remote) {
      output.append(node("h4", "", say("Remote delivery", "远程交付") + " · " + remote.status));
      remote.projects.forEach(project => {
        const card = node("article", "record-card");
        card.append(node("strong", "", project.directory + " · " + project.coverage));
        card.append(node("p", "", project.reason));
        card.append(node("p", "mono", say("Expected local commit: ", "期望本地提交：") + (project.expectedLocalCommit || say("unknown", "未知"))));
        card.append(node("p", "", "PR/MR · " + (project.state || "none") + " · "
          + say("Evidence: ", "证据：") + (project.verification || "unverified")));
        if (project.adoption) card.append(node("p", "mono", say("Adoption: ", "采用记录：") + project.adoption.id));
        output.append(card);
      });
    }
    output.append(node("p", "muted", say(
      "Review reports are evidence, not acceptance. Read the original report and its fixed candidate in Reviews below. Missing checks are not passes.",
      "审阅报告是证据，不是验收。请在下方审阅中读取原报告与固定候选；缺失检查不算通过。")));
    const original = node("div", "section-body");
    output.append(original);
    original.textContent = say("Reading original checks and review bindings…", "读取原始检查与审阅绑定…");
    void actions.evidence(data.task.id).then(evidence => {
      clear(original);
      original.append(node("h4", "", say("Integration checks · exact recorded candidate", "集成检查 · 精确记录候选")));
      if (!evidence.integrations.length) original.append(node("p", "muted", say(
        "No Integration check records. Direct Leader verification may be recorded in the completion report.",
        "没有 Integration 检查记录；Leader 直接执行的验证可能记录于完成报告。")));
      for (const attempt of evidence.integrations) {
        const card = node("article", "record-card");
        card.append(node("strong", "", attempt.id + " · " + attempt.status),
          node("p", "mono", (attempt.candidateCommit || say("No check candidate", "无检查候选"))),
          node("p", "muted", say("Coverage of the physical current head has not been checked here.",
            "此处未核对对物理当前 head 的覆盖。")));
        if (!attempt.checks?.length) card.append(node("p", "muted", say("No check outcomes recorded.", "未记录检查结果。")));
        (attempt.checks || []).forEach(check => card.append(node("p", "", check.name + " · " + check.outcome),
          ...(check.details ? [node("p", "muted", check.details)] : [])));
        original.append(card);
      }
      original.append(node("h4", "", say("Review bindings · not semantic approval", "审阅绑定 · 不等于语义通过")));
      if (!evidence.reviews.length) original.append(node("p", "muted", say("No Review records.", "没有 Review 记录。")));
      for (const round of evidence.reviews) {
        const card = node("article", "record-card");
        card.append(node("strong", "", round.id + " · " + round.status));
        card.append(node("p", "mono", round.taskCandidate
          ? round.taskCandidate.projects.map(p => p.projectId + " · " + p.commit).join("\\n")
          : [round.workItemId, round.candidateId, round.reviewBaseCommit].filter(Boolean).join(" · ")));
        if (round.reviewerRunId) {
          const report = node("button", "record-open", say("Read original review report", "读取原始审阅报告"));
          report.type = "button";
          report.addEventListener("click", async () => {
            report.disabled = true;
            try {
              const source = await actions.inspect(data.task.id, { store: "run", refId: round.reviewerRunId });
              card.append(richText(round.reviewerRunId, source.value.result?.output
                || say("No report recorded.", "未记录报告。"), t));
            } catch (error) { card.append(node("p", "muted", error.message)); report.disabled = false; }
          });
          card.append(report);
        }
        original.append(card);
      }
      original.append(node("h4", "", say("Recorded workspace owners", "已记录工作区所有者")));
      evidence.workspaces.forEach(workspace => original.append(node("p", "mono", workspace.owner.type + " · " + workspace.root)));
    }).catch(error => { original.textContent = say("Original evidence unavailable: ", "原始证据不可用：") + error.message; });
    const metrics = observabilityMetricCard(runtime.observability, t);
    if (metrics) output.append(metrics);
    output.append(node("h4", "", say("Retained workspaces · recorded ownership only", "保留工作区 · 仅已记录所有权")));
    output.append(node("p", "muted", say(
      "No physical cleanup inspection was run. Use the existing read-only preflight when needed; it does not authorize archive or cleanup:",
      "未执行物理清理检查。需要时使用既有只读预检；预检不授权归档或清理：")));
    output.append(node("code", "", "yui task archive-preflight " + data.task.id + " --integrated"));
  });
  container.append(delivery);
}
`;
