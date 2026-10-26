export const OPERATOR_HANDOFF_SCRIPT = String.raw`
import { h } from "/assets/js/lib/dom.js";

const PROMPTS = {
  zh: {
    agent: "请帮我在 Yui 接入 Agent。先核对 Yui 支持的 Agent、已有实例及角色配置，确认需要接入的执行工具和实例。优先沿用该 Agent 已有的模型、认证和思考强度配置；不要为了接入 Agent 重复登记 Provider 或托管 metabridge。说明对新会话和角色的影响，获得确认后使用当前安装版本的 CLI 完成配置并回读。不要改变已有会话，不要输出密钥，也不要未经授权调用真实模型或查询账户额度。",
    provider: "请帮我添加或调整模型 Provider。先运行 yui models guide --json，核对已有通用 Provider、CPA 和 metabridge 配置，确认目标服务、Base URL、认证方式及使用范围。优先复用已有服务，保留 Agent 原生配置；添加 Provider 不等于切换 Agent 或角色的默认模型。密钥只使用私有文件引用，不要贴到对话中。说明改动并获得确认后预览、备份、执行和回读。不要默认安装、托管、重启服务，不要未经授权调用真实模型或查询账户额度。"
  },
  en: {
    agent: "Help me connect an Agent to Yui. Inspect supported Agents, configured instances and Role profiles, then confirm the execution tool and instance. Reuse its existing model, authentication and reasoning settings. Do not register Providers or manage metabridge just to connect an Agent. Explain the scope for new Sessions and Roles, obtain confirmation, configure through the installed CLI and read back. Preserve existing Sessions; never expose secrets or run real inference or quota requests without authorization.",
    provider: "Help me add or change a model Provider. Run yui models guide --json and inspect existing general Providers, CPA and metabridge configuration. Confirm the service, Base URL, authentication and scope. Reuse existing services and preserve native Agent settings; adding a Provider does not switch an Agent or Role default. Use private credential-file references, never secrets in chat. Explain changes, obtain confirmation, preview, back up, apply and read back. Do not install, adopt or restart services by default, or run real inference or quota requests without authorization."
  }
};

export function openOperatorHandoff(options) {
  const { t, topic, onReadback } = options;
  const previous = document.activeElement;
  const prompt = PROMPTS[options.locale().startsWith("zh") ? "zh" : "en"][topic];
  const input = h("textarea.models-operator-prompt", { readOnly: true, rows: 10, spellcheck: false,
    "aria-label": t("models.operatorPrompt"), dataset: { operatorPrompt: topic } });
  input.value = prompt;
  const result = h("p.faint", { role: "status", "aria-live": "polite" });
  const close = h("button.btn", { type: "button", onclick: () => dialog.close() }, t("models.closePanel"));
  const copy = h("button.btn.btn-primary", { type: "button", onclick: async () => {
    try {
      if (options.copyText) await options.copyText(prompt);
      else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(prompt);
      else { input.focus(); input.select(); if (!document.execCommand("copy")) throw new Error("Clipboard unavailable"); }
      result.textContent = t("models.operatorPromptCopied");
    } catch { input.focus(); input.select(); result.textContent = t("models.copyPromptManually"); }
  } }, t("models.copyOperatorPrompt"));
  const read = h("button.btn", { type: "button", onclick: async () => {
    read.disabled = true;
    try { await onReadback?.(); result.textContent = t("models.readbackComplete"); }
    catch (error) { result.textContent = error.message; }
    finally { read.disabled = false; }
  } }, t("models.operatorReadback"));
  const dialog = h("dialog.models-handoff", { "aria-labelledby": "operator-handoff-title" },
    h("header.manage-head", null, h("h2", { id: "operator-handoff-title" }, t("models.configure." + topic)), close),
    h("p", null, t("models.operatorHandoffHelp")), input,
    h("div.settings-actions", null, copy, read), result, h("p.faint", null, t("models.operatorNoEffect")));
  dialog.addEventListener("close", () => { dialog.remove(); previous?.focus?.(); });
  document.body.append(dialog);
  dialog.showModal();
  close.focus();
  return dialog;
}
`;
