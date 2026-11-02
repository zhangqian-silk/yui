export const OPERATOR_HANDOFF_SCRIPT = String.raw`
import { h } from "/assets/js/lib/dom.js";

// One guide for every "I want to…" entry. The user writes the goal in their
// own words; the page adds only the facts of the entry it was opened from
// (exact IDs and adapter, never URLs, file paths or credentials) and the
// method/boundaries that apply to that scenario. Copying executes nothing.

const SAFE_ID = /^[A-Za-z0-9._\/-]{1,128}$/;
function id(value) { return typeof value === "string" && SAFE_ID.test(value) ? value : ""; }
function ids(values) { return (Array.isArray(values) ? values : []).map(id).filter(Boolean); }

// A pasted key must not leave the page inside a prompt.
const SECRET = /(?:\bsk-[A-Za-z0-9_-]{12,}|\bghp_[A-Za-z0-9]{12,}|\bxox[abpr]-[A-Za-z0-9-]{10,}|\bAKIA[A-Z0-9]{12,}|\bBearer\s+[A-Za-z0-9._~+\/-]{12,}|\b[A-Za-z0-9_-]{48,}\b)/;
export function looksLikeSecret(text) { return SECRET.test(String(text || "")); }

const COPY = {
  zh: {
    want: "我想：", from: "背景（来自 Yui 页面「{page}」）：", method: "请这样处理：",
    adapter: { codex: "Codex CLI", claude: "Claude Code", other: "其他执行适配器" },
    common: [
      "密钥只使用私有文件路径引用，不要出现在对话、命令参数或输出中。",
      "先说明具体改动和影响范围，得到我确认后再执行，完成后回读结果告诉我。",
      "未经我单独授权，不要调用真实模型、查询账户额度或重启共享服务。"
    ],
    scenarios: {
      "role": s => ({ page: "执行配置", context: [
        "对象：Yui 全局角色「" + s.name + "」" + (s.agentId ? "，当前使用 Agent「" + s.agentId + "」（" + s.adapterLabel + "）" : "") + "。",
        s.route ? "该 Agent 在 Yui 绑定了模型服务端点「" + s.route + "」，新会话的模型由端点绑定决定。" : "" ],
        steps: [
          "先用 yui config describe role 和 yui config role --help 确认当前安装版本支持的操作，再读取该角色现状。",
          "模型和思考强度只在该 Agent 实际支持的范围内选择；说明最终新会话会用哪个模型。",
          "改动只影响后续启动：不要重启正在运行的会话，也不要重绑已有任务的角色。",
          "如需从 Profile 复制配置，先预览差异再应用；复制是一次性的，之后不保持关联。" ] }),
      "role-new": s => ({ page: "执行配置", context: [
        "现有角色：" + (s.roles.length ? s.roles.join("、") : "无") + "；已接入 Agent：" + (s.agents.length ? s.agents.join("、") : "无") + "；Profile 模板：" + (s.profiles.length ? s.profiles.join("、") : "无") + "。" ],
        steps: [
          "先判断应修改已有角色、从 Profile 复制，还是新建角色；只问我缺少的选择。",
          "新角色需要明确 Agent、工作区，以及模型与思考强度是显式设置还是沿用 Agent 原生默认。",
          "用 yui config describe role / profile 确认命令语义；改动只影响后续启动，不改动正在运行的会话或已有任务。" ] }),
      "profile": s => ({ page: "执行配置", context: [
        "对象：Profile 模板「" + s.id + "」，" + (s.inherit ? "运行配置继承全局 worker 角色。" : "显式使用 Agent「" + (s.agentId || "未知") + "」。") ],
        steps: [
          "先用 yui config describe profile 确认语义：修改 Profile 只影响以后复制它的角色或任务，不会改写已经复制过的角色。",
          "如果要让某个角色采用它，请单独说明目标角色，预览差异后再应用。" ] }),
      "agent": s => ({ page: "Agent", context: [
        "对象：已接入的 Agent「" + s.id + "」（" + s.adapterLabel + "）" + (s.roles.length ? "，被角色 " + s.roles.join("、") + " 使用" : "，当前没有角色使用") + "。",
        s.route ? "它在 Yui 绑定了模型服务端点「" + s.route + "」（仅影响 Yui 新会话）。" : "它在 Yui 没有端点绑定，沿用自身原生模型配置。" ],
        steps: [
          "先用 yui config describe agent 和 yui config agent --help 确认可修改项；启动命令、参数和环境变量引用只影响之后启动的进程。",
          "模型、认证和思考强度默认沿用该 Agent 的原生配置；除非我明确要求，不要为此登记 Provider 或接入 metabridge。",
          "环境变量只能写进程变量引用，不要写入密钥值；不要修改我个人的原生配置文件，除非我明确同意。" ] }),
      "agent-new": s => ({ page: "Agent", context: [
        "已接入：" + (s.configured.length ? s.configured.join("、") : "无") + "；此版本支持但尚未接入：" + (s.unconfigured.length ? s.unconfigured.join("、") : "无") + "。" ],
        steps: [
          "先确认我要接入的工具，以及本机是否已安装、已登录；它的原生模型与认证配置可以直接沿用，不需要先登记 Provider。",
          "用 yui config describe agent 确认命令语义，接入后回读，并说明哪些角色可以改用它；不要自动切换已有角色的 Agent。" ] }),
      "service": s => ({ page: "模型服务", context: [
        "对象：" + (s.adapter === "codex" ? "Codex" : "Claude") + " 类 Agent（" + (s.agents.length ? s.agents.join("、") : "尚未接入") + "）的模型服务，接入协议为 " + (s.adapter === "codex" ? "Responses" : "Anthropic Messages") + "。",
        s.endpoints.length ? "Yui 已登记的同协议端点：" + s.endpoints.join("、") + "。" : "Yui 尚未登记这一协议的端点。" ],
        steps: [
          "先运行 yui models guide binding --json，阅读当前安装版本的指南。",
          "先问我生效范围：只影响 Yui 新会话（Yui 端点绑定，不改个人配置），还是修改个人原生配置。",
          "按 Agent 的接入方式判断走哪条路由，不按模型名称或品牌推断；" + (s.adapter === "codex" ? "Codex 也可以通过兼容服务使用其他厂商的模型。" : "Claude 的 Yui 端点绑定需要显式的客户端凭据文件，不能转发已保存的订阅登录。"),
          "metabridge 和 CPA 都是可选的；原生配置已能满足时保留它，不要重复登记。" ] }),
      "component": s => ({ page: "模型服务", context: [
        s.componentKind === "metabridge"
          ? "对象：可选组件 metabridge" + (s.id ? "「" + s.id + "」" : "（尚未在 Yui 登记）") + "。它自己的配置文件是 Provider 与路由的唯一来源；Yui 只登记引用。"
          : "对象：可选组件 CPA" + (s.id ? "「" + s.id + "」" : "（尚未在 Yui 登记）") + "。账号池、登录与部署由 CPA 自己管理；Yui 只读取登记的配置引用与额度观测。" ],
        steps: s.componentKind === "metabridge" ? [
          "先运行 yui models guide metabridge --json；涉及安装、升级或启停时再读 yui models guide maintenance --json。",
          "修改 Provider 或路由时改 metabridge 自己的配置，不要在 Yui 另存一份；不要按端口或进程名接管服务。" ] : [
          "先运行 yui models guide maintenance --json，确认 CPA 的实际所有者与版本。",
          "不要在 Yui 维护 CPA 的账号或登录；刷新额度会请求真实服务，需我单独授权。" ] })
    }
  },
  en: {
    want: "I want to: ", from: "Context (from the Yui page \"{page}\"):", method: "How to handle it:",
    adapter: { codex: "Codex CLI", claude: "Claude Code", other: "another execution adapter" },
    common: [
      "Use private credential-file references only; never put secrets in chat, arguments or output.",
      "Explain the exact change and its scope, wait for my confirmation, then apply and read back the result.",
      "Do not run real model requests, query account quota or restart shared services without my separate authorization."
    ],
    scenarios: {
      "role": s => ({ page: "Execution configs", context: [
        "Target: Yui global Role \"" + s.name + "\"" + (s.agentId ? ", currently using Agent \"" + s.agentId + "\" (" + s.adapterLabel + ")" : "") + ".",
        s.route ? "That Agent has a Yui endpoint binding \"" + s.route + "\"; new Sessions take their model from that binding." : "" ],
        steps: [
          "Check yui config describe role and yui config role --help for this installation, then read the Role's current state.",
          "Choose model and effort only from what that Agent supports; tell me which model new Sessions will actually use.",
          "Changes affect later launches only: do not restart running Sessions or rebind existing Task Roles.",
          "To copy from a Profile, preview the difference first; the copy is one-time and creates no lasting link." ] }),
      "role-new": s => ({ page: "Execution configs", context: [
        "Roles: " + (s.roles.join(", ") || "none") + "; configured Agents: " + (s.agents.join(", ") || "none") + "; Profiles: " + (s.profiles.join(", ") || "none") + "." ],
        steps: [
          "Decide whether to change an existing Role, copy from a Profile or create a Role; ask only for missing choices.",
          "A new Role needs an Agent, a workspace, and either explicit model/effort or the Agent's native defaults.",
          "Confirm semantics with yui config describe role / profile; changes affect later launches only." ] }),
      "profile": s => ({ page: "Execution configs", context: [
        "Target: Profile template \"" + s.id + "\", " + (s.inherit ? "inheriting the global worker Role's runtime." : "explicitly using Agent \"" + (s.agentId || "unknown") + "\".") ],
        steps: [
          "Confirm with yui config describe profile: editing a Profile affects future copies only, never Roles that already copied it.",
          "If a Role should adopt it, name that Role, preview the difference and only then apply." ] }),
      "agent": s => ({ page: "Agents", context: [
        "Target: configured Agent \"" + s.id + "\" (" + s.adapterLabel + ")" + (s.roles.length ? ", used by Roles " + s.roles.join(", ") : ", used by no Role") + ".",
        s.route ? "It has a Yui endpoint binding \"" + s.route + "\" (new Yui Sessions only)." : "It has no Yui endpoint binding and uses its native model configuration." ],
        steps: [
          "Check yui config describe agent and yui config agent --help; command, arguments and environment references affect later processes only.",
          "Keep the Agent's native model, authentication and effort; do not register a Provider or add metabridge for this unless I ask.",
          "Environment entries are process-variable references, never secret values; do not edit my personal native config without my consent." ] }),
      "agent-new": s => ({ page: "Agents", context: [
        "Configured: " + (s.configured.join(", ") || "none") + "; supported but not configured: " + (s.unconfigured.join(", ") || "none") + "." ],
        steps: [
          "Confirm which tool I want and whether it is installed and signed in here; its native model and authentication work without registering a Provider.",
          "Use yui config describe agent, read back afterwards and tell me which Roles could use it; do not switch existing Roles automatically." ] }),
      "service": s => ({ page: "Model services", context: [
        "Target: model services for " + (s.adapter === "codex" ? "Codex" : "Claude") + " Agents (" + (s.agents.join(", ") || "none configured") + "), protocol " + (s.adapter === "codex" ? "Responses" : "Anthropic Messages") + ".",
        s.endpoints.length ? "Yui endpoints with this protocol: " + s.endpoints.join(", ") + "." : "Yui has no endpoint for this protocol yet." ],
        steps: [
          "Run yui models guide binding --json and read this installation's guide first.",
          "Ask me for the scope: new Yui Sessions only (a Yui endpoint binding) or my personal native configuration.",
          "Route by the Agent's connection, not the model name or vendor; " + (s.adapter === "codex" ? "Codex can use other vendors' models through a compatible service." : "a Claude Yui endpoint needs an explicit client credential file and never forwards a saved subscription login."),
          "metabridge and CPA are optional; keep working native configuration instead of registering a duplicate." ] }),
      "component": s => ({ page: "Model services", context: [
        s.componentKind === "metabridge"
          ? "Target: optional component metabridge" + (s.id ? " \"" + s.id + "\"" : " (not registered in Yui yet)") + ". Its own configuration file is the only source of Providers and routes; Yui stores references."
          : "Target: optional component CPA" + (s.id ? " \"" + s.id + "\"" : " (not registered in Yui yet)") + ". CPA owns its account pool, login and deployment; Yui reads registered references and quota observations." ],
        steps: s.componentKind === "metabridge" ? [
          "Run yui models guide metabridge --json; for install, upgrade or start/stop read yui models guide maintenance --json.",
          "Change Providers and routes in metabridge's own configuration, never a second copy in Yui; never adopt a service by its port or process name." ] : [
          "Run yui models guide maintenance --json and confirm CPA's actual owner and version.",
          "Do not manage CPA accounts or logins in Yui; refreshing quota calls the real service and needs my separate authorization." ] })
    }
  }
};

function normalize(scenario, lang) {
  const s = scenario || {};
  const adapter = ["codex", "claude"].includes(s.adapter) ? s.adapter : "other";
  return { kind: s.kind, name: id(s.name), id: id(s.id), agentId: id(s.agentId), route: id(s.route),
    adapter, adapterLabel: COPY[lang].adapter[adapter], inherit: !!s.inherit,
    componentKind: s.componentKind === "metabridge" ? "metabridge" : "cliproxyapi", roles: ids(s.roles), agents: ids(s.agents), profiles: ids(s.profiles),
    endpoints: ids(s.endpoints), configured: ids(s.configured),
    unconfigured: (Array.isArray(s.unconfigured) ? s.unconfigured : []).map(String).map(v => v.slice(0, 64).replace(/[\r\n]/g, " ")) };
}

// Builds the exact copied text. Exported for deterministic tests.
export function buildOperatorPrompt(scenario, intent, locale) {
  const lang = String(locale || "").startsWith("zh") ? "zh" : "en";
  const copy = COPY[lang];
  const s = normalize(scenario, lang);
  const make = copy.scenarios[s.kind] || copy.scenarios["role-new"];
  const spec = make(s);
  const goal = String(intent || "").trim();
  return [copy.want + goal, "", copy.from.replace("{page}", spec.page),
    ...spec.context.filter(Boolean).map(line => "- " + line), "", copy.method,
    ...spec.steps.concat(copy.common).map(line => "- " + line)].join("\n");
}

export function openOperatorHandoff(options) {
  const { t, onReadback } = options;
  const scenario = options.scenario || { kind: "role-new" };
  const locale = () => options.locale ? options.locale() : "en";
  const previous = document.activeElement;
  const variant = scenario.kind === "component" ? "." + (scenario.componentKind === "metabridge" ? "metabridge" : "cliproxyapi")
    : scenario.kind === "service" ? "." + (scenario.adapter === "claude" ? "claude" : "codex") : "";
  const titleKey = "guide.title." + scenario.kind + variant;
  const intent = h("textarea.guide-intent", { rows: 3, spellcheck: false, id: "operator-guide-intent",
    placeholder: t("guide.placeholder." + scenario.kind + variant) });
  const preview = h("pre.guide-preview", { tabindex: "0", "aria-label": t("guide.preview"), dataset: { operatorPrompt: scenario.kind } });
  const result = h("p.guide-result", { role: "status", "aria-live": "polite" });
  const copy = h("button.btn.btn-primary", { type: "button" }, t("guide.copy"));
  function current() { return buildOperatorPrompt(scenario, intent.value, locale()); }
  function update() {
    const empty = !intent.value.trim();
    const secret = looksLikeSecret(intent.value);
    // Never echo a pasted credential back, even locally in the preview.
    preview.textContent = secret ? buildOperatorPrompt(scenario, t("guide.redacted"), locale()) : current();
    copy.disabled = empty || secret;
    result.textContent = secret ? t("guide.secret") : empty ? t("guide.needIntent") : "";
    result.dataset.state = secret ? "bad" : "";
  }
  intent.addEventListener("input", update);
  copy.addEventListener("click", async () => {
    if (copy.disabled) return;
    const text = current();
    try {
      if (options.copyText) await options.copyText(text);
      else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else throw new Error("Clipboard unavailable");
      result.textContent = t("guide.copied"); result.dataset.state = "ok";
    } catch {
      const range = document.createRange(); range.selectNodeContents(preview);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      preview.focus(); result.textContent = t("guide.copyManually");
    }
  });
  const close = h("button.icon-btn.guide-close", { type: "button", "aria-label": t("guide.close"), title: t("guide.close"), onclick: () => dialog.close() }, "×");
  const read = onReadback ? h("button.btn", { type: "button", onclick: async () => {
    read.disabled = true;
    try { await onReadback(); result.textContent = t("guide.readbackDone"); result.dataset.state = "ok"; }
    catch (error) { result.textContent = error.message; result.dataset.state = "bad"; }
    finally { read.disabled = false; }
  } }, t("guide.readback")) : null;
  const dialog = h("dialog.guide-dialog", { "aria-labelledby": "operator-guide-title" },
    h("header.guide-head", null, h("div", null, h("h2", { id: "operator-guide-title" }, t(titleKey)),
      h("p", null, t("guide.lead"))), close),
    h("label.guide-label", { for: "operator-guide-intent" }, t("guide.intent")), intent,
    h("div.guide-preview-head", null, h("span", null, t("guide.preview")), h("small", null, t("guide.noEffect"))), preview,
    h("div.guide-actions", null, result, h("span.spacer"), read, copy));
  dialog.addEventListener("close", () => { dialog.remove(); previous?.focus?.(); });
  dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
  document.body.append(dialog);
  update();
  dialog.showModal();
  intent.focus();
  return dialog;
}
`;
